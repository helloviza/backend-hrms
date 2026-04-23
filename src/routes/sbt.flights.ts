import express from "express";
import mongoose from "mongoose";
import { readFileSync } from "fs";
import { writeFile as fsWriteFile, mkdir as fsMkdir } from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";
import { requireAuth } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/rbac.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { sbtLogger } from "../utils/logger.js";
import SBTBooking from "../models/SBTBooking.js";
import SBTRequest from "../models/SBTRequest.js";
import SBTConfig from "../models/SBTConfig.js";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import Customer from "../models/Customer.js";
import { scopedFindById } from "../middleware/scopedFindById.js";
import { requireFeature } from "../middleware/requireFeature.js";
import { sendMail } from "../utils/mailer.js";
import { buildEmailShell, eRow, eCard, eBtn, eLabel, escapeHtml } from "./approvals.email.js";
import { clearTBOToken, logoutTBO, getTBOTokenStatus, getAgencyBalance, getTBOToken } from "../services/tbo.auth.service.js";
import { getMarginConfig, applyMargin, isDomestic } from "../utils/margin.js";
import { listTBOLogs, readTBOLog, logTBOCall } from "../utils/tboFileLogger.js";
import {
  searchFlights,
  searchMultiCity,
  getFareQuote,
  getFareRule,
  bookFlight,
  ticketFlight,
  ticketLCC,
  getBookingDetails,
  getBookingDetailsByPNR,
  getSSR,
  releasePNR,
  cancelFlight,
  getPriceRBD,
  isNDCFlight,
  reissueSearch,
  ticketReissue,
} from "../services/tbo.flight.service.js";
import { consolidateCertificationLogs } from "../services/tbo.log.consolidator.js";

const router = express.Router();

/* ── Duplicate booking prevention (24-hour window) ─────────────────────── */
async function checkDuplicateBooking(params: {
  userId: string;
  workspaceId: any;
  originCode: string;
  destinationCode: string;
  departureDate: string;
  airlineCode: string;
  flightNumber: string;
  passengerNames: string[];
}): Promise<string | null> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const existing = await SBTBooking.findOne({
    userId: params.userId,
    workspaceId: params.workspaceId,
    "origin.code": params.originCode,
    "destination.code": params.destinationCode,
    airlineCode: params.airlineCode,
    flightNumber: params.flightNumber,
    status: { $in: ["CONFIRMED", "PENDING"] },
    createdAt: { $gte: cutoff },
  }).lean();

  if (!existing) return null;

  // Check if at least one passenger name matches
  const existingNames = ((existing as any).passengers || []).map(
    (p: any) => `${(p.firstName || "").trim()} ${(p.lastName || "").trim()}`.toUpperCase()
  );
  const hasMatchingPax = params.passengerNames.some(
    name => existingNames.includes(name.toUpperCase())
  );
  if (!hasMatchingPax) return null;

  return `Potential duplicate booking detected — a ${(existing as any).status} booking for ${params.airlineCode} ${params.flightNumber} (${params.originCode}→${params.destinationCode}) was made within the last 24 hours (PNR: ${(existing as any).pnr || "pending"}). If this is intentional, cancel the previous booking first.`;
}

/* ── Timeout recovery: poll GetBookingDetails after TBO timeout ─────────── */
async function pollBookingOnTimeout(
  bookingId: string | undefined,
  traceId: string | undefined,
): Promise<{ found: boolean; data?: any }> {
  if (!bookingId) return { found: false };

  const MAX_POLLS = 5;
  const POLL_INTERVAL_MS = 15_000;
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  for (let i = 0; i < MAX_POLLS; i++) {
    if (i > 0) await delay(POLL_INTERVAL_MS);
    try {
      const details = await getBookingDetails({ bookingId: String(bookingId) }) as any;
      const status = details?.Response?.ResponseStatus;
      const innerStatus = details?.Response?.Response?.BookingStatus;

      logTBOCall({
        method: "GetBookingDetails_TimeoutPoll",
        traceId: traceId || "timeout-recovery",
        request: { BookingId: bookingId, pollAttempt: i + 1 },
        response: details,
      });

      // BookingStatus 1 = Confirmed
      if (status === 1 && innerStatus === 1) {
        sbtLogger.info("Timeout recovery: booking confirmed via polling", { bookingId, pollAttempt: i + 1 });
        return { found: true, data: details };
      }
    } catch (pollErr: any) {
      sbtLogger.warn("Timeout recovery poll failed", { bookingId, pollAttempt: i + 1, error: pollErr?.message });
    }
  }
  return { found: false };
}

function isTBOTimeoutError(err: any): boolean {
  return err?.name === "AbortError" || err?.message?.includes("aborted") || err?.code === "ABORT_ERR";
}

/* ── Dynamic TBO certification case label ─────────────────────────────── */
function resolveCaseLabel(params: {
  isLCC: boolean;
  isNDC: boolean;
  isReturn: boolean;
  isSpecialReturn: boolean;
  isMultiCity: boolean;
  isInternational: boolean;
  isCalendarFare: boolean;
  isPriceRBD: boolean;
}): string {
  const {
    isLCC, isNDC, isReturn, isSpecialReturn,
    isMultiCity, isInternational, isCalendarFare, isPriceRBD,
  } = params;

  if (isPriceRBD)                              return "Case10_GDS_PriceRBD";
  if (isNDC && isReturn)                       return "Case12_NDC_Intl_Return";
  if (isNDC && !isReturn)                      return "Case11_NDC_Intl_OneWay";
  if (isMultiCity)                             return "Case8_GDS_MultiCity";
  if (isCalendarFare)                          return "Case9_Calendar_OneWay";
  if (isSpecialReturn && !isLCC)               return "Case7_GDS_SpecialReturn";
  if (isSpecialReturn && isLCC)                return "Case6_LCC_SpecialReturn";
  if (!isLCC && isReturn && isInternational)   return "Case5_GDS_Intl_Return";
  if (isLCC && isReturn && !isInternational)   return "Case3_LCC_Domestic_Return";
  if (isLCC && !isReturn && isInternational)   return "Case4_LCC_Intl_SSR";
  if (isLCC && !isReturn && !isInternational)  return "Case2_LCC_Domestic_SSR";
  if (!isLCC && !isReturn && !isInternational) return "Case1_GDS_OneWay";
  return "Case_Unknown";
}

/* ── TBO pre-booking validation (seat/meal/PAN/passport) ─────────────── */
function validateTBOBookingRequirements(
  fareResults: any,
  passengers: any[],
): string | null {
  // Seat mandatory (e.g. SpiceMax, Super6E)
  if (fareResults?.isseatmandatory && !passengers.some((p: any) => p.SeatDynamic?.length || p.SeatPreference?.length)) {
    return "Seat selection is mandatory for this fare type (e.g. SpiceMax/Super6E)";
  }
  // Meal mandatory
  if (fareResults?.ismealmandatory && !passengers.some((p: any) => p.MealDynamic?.length)) {
    return "Meal selection is mandatory for this fare type";
  }
  // PAN / Passport per passenger
  for (const pax of passengers) {
    const name = `${pax.FirstName || ""} ${pax.LastName || ""}`.trim();
    const paxType = Number(pax.PaxType) || 1;
    if (fareResults?.IsPanRequiredAtBook) {
      if (paxType === 1 && !pax.PAN) {
        return `PAN required for passenger: ${name}`;
      }
      if ((paxType === 2 || paxType === 3) && !pax.guardianDetails?.PAN) {
        return `Guardian PAN required for Child/Infant: ${name}`;
      }
    }
    if (fareResults?.IsPassportRequiredAtBook) {
      if (!pax.PassportNo && !(paxType !== 1 && pax.guardianDetails?.PassportNo)) {
        return `Passport required for passenger: ${name}`;
      }
    }
  }
  return null;
}

/* ── TBO pre-ticket validation (PAN/passport at ticket time) ───────────── */
function validateTBOTicketRequirements(
  fareResults: any,
  passengers: any[],
): string | null {
  for (const pax of passengers) {
    const name = `${pax.FirstName || ""} ${pax.LastName || ""}`.trim();
    const paxType = Number(pax.PaxType) || 1;
    if (fareResults?.IsPanRequiredAtTicket) {
      if (paxType === 1 && !pax.PAN) {
        return `PAN required at ticketing for passenger: ${name}`;
      }
      if ((paxType === 2 || paxType === 3) && !pax.guardianDetails?.PAN) {
        return `Guardian PAN required at ticketing for Child/Infant: ${name}`;
      }
    }
    if (fareResults?.IsPassportRequiredAtTicket) {
      if (!pax.PassportNo && !(paxType !== 1 && pax.guardianDetails?.PassportNo)) {
        return `Passport required at ticketing for passenger: ${name}`;
      }
    }
  }
  return null;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function loadJson<T>(filename: string): T {
  const file = path.join(__dirname, "../data", filename);
  return JSON.parse(readFileSync(file, "utf-8")) as T;
}

type Airport = {
  code: string; name: string; city: string;
  cityCode: string; country: string; countryCode: string; label: string;
};

/* ── Public endpoints — no auth / workspace / feature gate ────────────── */

// GET /api/sbt/flights/airports?q=del
router.get("/airports", (req, res) => {
  try {
    const airports = loadJson<Airport[]>("airports.json");
    const q = (req.query.q as string || "").toLowerCase().trim();
    if (!q || q.length < 2) return res.json([]);
    const codeExact = airports.filter(a => a.code?.toLowerCase() === q);
    const cityStarts = airports.filter(a => a.city?.toLowerCase().startsWith(q) && a.code?.toLowerCase() !== q);
    const nameStarts = airports.filter(
      a => a.name?.toLowerCase().startsWith(q) &&
        !a.city?.toLowerCase().startsWith(q) &&
        a.code?.toLowerCase() !== q
    );
    const matches = [...codeExact, ...cityStarts, ...nameStarts];
    res.json(matches.slice(0, 10));
  } catch (err: any) {
    sbtLogger.error("Airport search failed", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sbt/flights/airlines
router.get("/airlines", (_req, res) => {
  try {
    const airlines = loadJson<Record<string, string>>("airlines.json");
    res.json(airlines);
  } catch (err: any) {
    sbtLogger.error("Airlines list failed", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/* ── Auth + workspace + feature middleware (all subsequent routes) ─────── */
router.use(requireAuth);
router.use(requireWorkspace);
router.use(requireFeature("flightBookingEnabled"));

// ─── Privileged SBT user check ───────────────────────────────────────────────
// ADMIN / SUPERADMIN / HR / WORKSPACE_LEADER are never blocked by SBT guards.
function isPrivilegedSBTUser(req: any): boolean {
  const roles = (req.user?.roles || [])
    .map((r: string) => String(r).toUpperCase().replace(/[\s_-]/g, ""));
  return (
    roles.includes("SUPERADMIN") ||
    roles.includes("ADMIN") ||
    roles.includes("HR") ||
    roles.includes("WORKSPACELEADER") ||
    req.user?.customerMemberRole === "WORKSPACE_LEADER"
  );
}

// ─── SBT access guard ────────────────────────────────────────────────────────
// Verifies the user has sbtEnabled=true in the DB.
// Privileged users (ADMIN/SUPERADMIN/HR/WORKSPACE_LEADER) always bypass.
async function requireSBT(req: any, res: any, next: any) {
  try {
    if (isPrivilegedSBTUser(req)) return next();

    const userId = req.user?.id || req.user?._id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const user = await User.findById(userId).select("sbtEnabled customerId").lean();

    const wsCustomerId = req.workspace?.customerId?.toString();
    const userCustomerId = (user as any)?.customerId?.toString();
    if (wsCustomerId && userCustomerId && wsCustomerId !== userCustomerId) {
      return res.status(403).json({ error: "Access denied" });
    }

    if (!user || !(user as any).sbtEnabled) {
      return res.status(403).json({ error: "SBT access not enabled for this account" });
    }
    next();
  } catch {
    return res.status(500).json({ error: "Authorization check failed" });
  }
}

// ─── Travel-mode / booking-type guard for flights ────────────────────────────
async function requireFlightAccess(req: any, res: any, next: any) {
  try {
    if (isPrivilegedSBTUser(req)) return next();

    const userId = req.user?.id || req.user?._id;
    const user = await User.findById(userId)
      .select("sbtBookingType customerId")
      .lean();

    if (!user) return res.status(401).json({ error: "User not found" });

    // Check user-level sbtBookingType
    if ((user as any).sbtBookingType &&
        (user as any).sbtBookingType !== "flight" &&
        (user as any).sbtBookingType !== "both") {
      return res.status(403).json({
        error: "Flight booking not permitted for your account",
        code: "FLIGHT_ACCESS_DENIED",
      });
    }

    // Check workspace-level travelMode
    if ((user as any).customerId) {
      const workspace = await CustomerWorkspace.findOne({ customerId: (user as any).customerId })
        .select("travelMode")
        .lean();

      if (workspace?.travelMode === "HOTELS_ONLY") {
        return res.status(403).json({
          error: "Flight booking not enabled for your company",
          code: "COMPANY_FLIGHT_ACCESS_DENIED",
        });
      }

      if (workspace?.travelMode === "APPROVAL_FLOW") {
        return res.status(403).json({
          error: "Direct booking not permitted. Please use the approval flow.",
          code: "APPROVAL_FLOW_REQUIRED",
        });
      }
    }

    next();
  } catch {
    return res.status(500).json({ error: "Access check failed" });
  }
}

// GET /api/sbt/flights/token/status — show current TBO token state (ADMIN only)
router.get("/token/status", requireAdmin, (_req: any, res: any) => {
  res.json({ ok: true, ...getTBOTokenStatus() });
});

// POST /api/sbt/flights/token/clear — clear in-memory cache (ADMIN only)
router.post("/token/clear", requireAdmin, (_req: any, res: any) => {
  clearTBOToken();
  res.json({ ok: true, message: "TBO token cache cleared. Will re-authenticate on next search." });
});

// POST /api/sbt/flights/token/logout — kill token on TBO side + clear cache (ADMIN only)
router.post("/token/logout", requireAdmin, async (_req: any, res: any) => {
  await logoutTBO();
  res.json({ ok: true, message: "TBO token logged out and cache cleared." });
});

// GET /api/sbt/flights/agency-balance — TBO wallet balance (ADMIN only)
router.get("/agency-balance", requireAdmin, async (_req: any, res: any) => {
  try {
    const data = await getAgencyBalance();
    res.json({ ok: true, ...(data as object) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to fetch agency balance";
    res.status(500).json({ error: msg });
  }
});

// GET /api/sbt/flights/logs/:traceId — list TBO API logs for a session (ADMIN only)
router.get("/logs/:traceId", requireAdmin, async (req: any, res: any) => {
  try {
    const { traceId } = req.params;
    const logs = await listTBOLogs(traceId);
    res.json({ ok: true, traceId, count: logs.length, logs });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sbt/flights/logs/:traceId/:filename — read a single TBO log file (ADMIN only)
router.get("/logs/:traceId/:filename", requireAdmin, async (req: any, res: any) => {
  try {
    const { traceId, filename } = req.params;
    if (!filename.endsWith(".json")) {
      return res.status(400).json({ error: "Invalid filename" });
    }
    const data = await readTBOLog(traceId, filename);
    res.json({ ok: true, data });
  } catch (err: any) {
    res.status(404).json({ error: "Log file not found" });
  }
});

// POST /api/sbt/flights/search-multi-city
// Fires N parallel one-way searches (one per leg) and returns per-leg results + traceIds
router.post("/search-multi-city", requireSBT, requireFlightAccess, async (req: any, res: any) => {
  try {
    const { legs } = req.body;
    if (!Array.isArray(legs) || legs.length < 2) {
      return res.status(400).json({ error: "At least 2 legs required" });
    }

    // Build payloads first for debug logging
    const tboPayloads = legs.map((leg: any) => ({
      origin: leg.Origin,
      destination: leg.Destination,
      departDate: leg.PreferredDepartureTime?.split("T")[0] || leg.departDate,
      adults: leg.AdultCount ?? leg.adults,
      children: leg.ChildCount ?? leg.children,
      infants: leg.InfantCount ?? leg.infants,
      JourneyType: 1 as const,
      cabinClass: leg.FlightCabinClass ?? leg.cabinClass,
    }));

    const searchLeg = async (payload: typeof tboPayloads[number]) => {
      try {
        const result: any = await searchFlights(payload);
        const tboStatus = result?.Response?.ResponseStatus ?? result?.Response?.Status;
        if (tboStatus !== undefined && tboStatus !== 1) {
          const errMsg = result?.Response?.Error?.ErrorMessage || "Unknown TBO error";
          return { results: [] as any[], traceId: "", error: errMsg };
        }
        const rawResults = result?.Response?.Results ?? [];
        const flights: any[] = Array.isArray(rawResults)
          ? rawResults.flatMap((item: any) => (Array.isArray(item) ? item : [item]))
          : [];
        return {
          results: flights,
          traceId: result?.Response?.TraceId ?? "",
        };
      } catch (err: any) {
        return { results: [] as any[], traceId: "", error: err.message || "Search failed" };
      }
    };

    const legResults = await Promise.all(tboPayloads.map(searchLeg));

    // Single retry for any leg that failed or returned 0 results
    const failedIndexes = legResults
      .map((r, i) => (r.error || r.results.length === 0) ? i : -1)
      .filter((i) => i !== -1);

    if (failedIndexes.length > 0) {
      const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      await delay(2000);

      const retries = await Promise.all(
        failedIndexes.map((i) => searchLeg(tboPayloads[i]))
      );

      for (let j = 0; j < failedIndexes.length; j++) {
        legResults[failedIndexes[j]] = retries[j];
      }
    }

    res.json({ legs: legResults });
  } catch (err: any) {
    sbtLogger.error("Multi-city parallel search failed", { userId: req.user?.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/calendar — GetCalendarFare (1 call = full month of lowest fares)
router.post("/calendar", requireSBT, requireFlightAccess, async (req: any, res: any) => {
  try {
    const { origin, destination, month, cabinClass } = req.body;
    if (!origin || !destination || !month) {
      return res.status(400).json({ error: "origin, destination, and month are required" });
    }

    const token = await getTBOToken();
    const todayStr = new Date().toISOString().split("T")[0];
    const requestedFirst = `${month}-01`;
    const effectiveFromDate = requestedFirst < todayStr ? `${todayStr}T00:00:00` : `${requestedFirst}T00:00:00`;
    const firstDay = effectiveFromDate;
    const [yearStr, monthStr] = month.split("-");
    const lastDayDate = new Date(+yearStr, +monthStr, 0); // last day of month
    const lastDay = `${yearStr}-${monthStr}-${String(lastDayDate.getDate()).padStart(2, "0")}T00:00:00`;

    const payload = {
      EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
      TokenId: token,
      JourneyType: "1",
      PreferredAirlines: null,
      Sources: null,
      Segments: [{
        Origin: origin.toUpperCase(),
        Destination: destination.toUpperCase(),
        FlightCabinClass: cabinClass || 1,
        PreferredDepartureTime: firstDay,
        PreferredArrivalTime: lastDay,
      }],
    };

    const response = await fetch(
      "http://api.tektravels.com/BookingEngineService_Air/AirService.svc/rest/GetCalendarFare",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    const data = await response.json();

    // Log for TBO certification / debugging
    logTBOCall({
      method: "CalendarFare",
      traceId: "calendar",
      request: payload,
      response: data,
    });

    // Persist calendar fare log for Case 9 certification consolidation
    const calDir = path.resolve(__dirname, "../logs/tbo/calendar");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    fsMkdir(calDir, { recursive: true })
      .then(() => fsWriteFile(
        path.join(calDir, `GetCalendarFare_${ts}.json`),
        JSON.stringify({ request: payload, response: data }, null, 2),
        "utf-8",
      ))
      .catch(() => { /* fire-and-forget — never break the response */ });

    // Transform SearchResults into a date-keyed map
    const body = data as { Response?: { SearchResults?: Array<{ DepartureDate?: string; Fare: number; IsLowestFareOfMonth?: boolean; AirlineCode: string; AirlineName: string }> } };
    const results = body?.Response?.SearchResults ?? [];
    const fareMap: Record<string, { fare: number; isLowest: boolean; airline: string; airlineName: string }> = {};

    for (const r of results) {
      const dateKey = r.DepartureDate?.slice(0, 10);
      if (dateKey) {
        fareMap[dateKey] = {
          fare: Math.round(r.Fare),
          isLowest: r.IsLowestFareOfMonth === true,
          airline: r.AirlineCode,
          airlineName: r.AirlineName,
        };
      }
    }

    res.json({ fareMap, month });
  } catch (err: any) {
    sbtLogger.error("Calendar fare fetch failed", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/search
router.post("/search", requireSBT, requireFlightAccess, async (req: any, res: any) => {
  try {
    if (process.env.TBO_ENV === "mock") {
      const { mockFlightSearch } = await import("../data/mock-flights.js");
      return res.json(mockFlightSearch);
    }
    const { JourneyType, segments, Sources, ...rest } = req.body;
    if (JourneyType === 3 || JourneyType === "3") {
      const result: any = await searchMultiCity({ segments, adults: rest.adults, children: rest.children, infants: rest.infants });
      const mcStatus = result?.Response?.ResponseStatus ?? result?.Response?.Status;
      if (mcStatus !== undefined && mcStatus !== 1) {
        const errMsg = result?.Response?.Error?.ErrorMessage || "Unknown TBO error";
        const errCode = result?.Response?.Error?.ErrorCode ?? "unknown";
        return res.status(502).json({
          error: `TBO Error ${errCode}: ${errMsg}`,
          tboStatus: mcStatus,
          tboResponse: result?.Response,
        });
      }
      return res.json(result);
    }
    const jt = Number(JourneyType) || 1;
    // JT=4 (AdvanceSearch): don't force Sources — let TBO return all results,
    // frontend filters to GDS (IsLCC=false) client-side
    const resolvedSources = Sources ?? null;
    const tboSearchPayload = { ...rest, JourneyType: jt as 1 | 2 | 4 | 5, Sources: resolvedSources };
    console.log('[TBO SEARCH PAYLOAD]', JSON.stringify({ SearchType: tboSearchPayload.SearchType, Pnr: tboSearchPayload.Pnr, Bookingid: tboSearchPayload.Bookingid, BookingId: tboSearchPayload.BookingId }, null, 2));
    const result: any = await searchFlights(tboSearchPayload);

    // Temporary logging for Advance Search debugging
    if (jt === 4) {
      const tboResults = result?.Response?.Results;
      const flat = Array.isArray(tboResults?.[0]) ? tboResults[0] : (Array.isArray(tboResults) ? tboResults : []);
      const lccCount = flat.filter((f: any) => f?.IsLCC).length;
      const gdsCount = flat.filter((f: any) => f && !f.IsLCC).length;
      sbtLogger.info("[ADV-SEARCH] TBO raw result count", {
        total: flat.length,
        lcc: lccCount,
        gds: gdsCount,
        firstSource: flat[0]?.Source ?? "N/A",
        firstIsLCC: flat[0]?.IsLCC ?? "N/A",
      });
    }

    const tboStatus = result?.Response?.ResponseStatus ?? result?.Response?.Status;
    if (tboStatus !== undefined && tboStatus !== 1) {
      // If TBO returned results despite non-success status, pass them through
      const hasResults = Array.isArray(result?.Response?.Results) && result.Response.Results.length > 0;
      if (hasResults) {
        sbtLogger.warn("TBO search returned results with non-success status", { tboStatus });
        return res.json(result);
      }
      const errMsg = result?.Response?.Error?.ErrorMessage || "Unknown TBO error";
      const errCode = result?.Response?.Error?.ErrorCode ?? "unknown";
      return res.status(502).json({
        error: `TBO Error ${errCode}: ${errMsg}`,
        tboStatus,
        tboResponse: result?.Response,
      });
    }

    // Apply margin to flight fares (server-side only)
    const flightMargins = await getMarginConfig();
    if (flightMargins.enabled) {
      const originCountry = (req.body as any).originCountry;
      const destCountry = (req.body as any).destCountry;
      const isFlightDomestic = isDomestic(originCountry, destCountry);
      const marginPct = isFlightDomestic
        ? flightMargins.flight.domestic
        : flightMargins.flight.international;

      if (marginPct > 0 && result?.Response?.Results) {
        const applyToFlightArray = (arr: any[]): any[] =>
          arr.map((flight: any) => {
            const fare = flight?.Fare;
            if (!fare) return flight;
            const netPublished = fare.PublishedFare ?? 0;
            const netOffered = fare.OfferedFare ?? 0;
            return {
              ...flight,
              Fare: {
                ...fare,
                _netPublishedFare: netPublished,
                _netOfferedFare: netOffered,
                PublishedFare: applyMargin(netPublished, marginPct),
                OfferedFare: applyMargin(netOffered, marginPct),
                _marginPercent: marginPct,
                _marginAmount: applyMargin(netOffered, marginPct) - netOffered,
              },
            };
          });

        const raw = result.Response.Results;
        if (Array.isArray(raw[0])) {
          // Round-trip: [[outbound], [inbound]]
          result.Response.Results = raw.map((leg: any[]) => applyToFlightArray(leg));
        } else {
          result.Response.Results = applyToFlightArray(raw);
        }
      }
    }

    res.json(result);
  } catch (err: any) {
    sbtLogger.error("Flight search failed", { userId: req.user?.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/special-return-check
// Quick probe: does TBO have LCC Special Return (JT5) results for a given route/date?
router.post("/special-return-check", requireSBT, requireFlightAccess, async (req: any, res: any) => {
  try {
    const { origin, destination, departDate, returnDate } = req.body;
    if (!origin || !destination || !departDate || !returnDate) {
      return res.status(400).json({ error: "origin, destination, departDate, returnDate are required" });
    }

    const result: any = await searchFlights({
      origin,
      destination,
      departDate,
      returnDate,
      adults: 1,
      children: 0,
      infants: 0,
      JourneyType: 5,
      Sources: null,
    });

    const tboResults = result?.Response?.Results;
    const obArray: any[] = Array.isArray(tboResults?.[0]) ? tboResults[0] : [];
    const ibArray: any[] = Array.isArray(tboResults?.[1]) ? tboResults[1] : [];

    // Extract unique airline codes from ALL outbound results (full picture from TBO)
    const airlineSet = new Set<string>();
    const lccAirlineSet = new Set<string>();
    for (const flight of obArray) {
      const code = flight?.Segments?.[0]?.[0]?.Airline?.AirlineCode;
      if (code) {
        airlineSet.add(code);
        if (flight.IsLCC) lccAirlineSet.add(code);
      }
    }

    const lccCount = obArray.filter((f: any) => f.IsLCC).length;

    res.json({
      hasLCCResults: lccCount > 0,
      airlines: Array.from(airlineSet),
      lccAirlines: Array.from(lccAirlineSet),
      totalResults: obArray.length + ibArray.length,
      obCount: obArray.length,
      ibCount: ibArray.length,
      lccObCount: lccCount,
    });
  } catch (err: any) {
    sbtLogger.error("Special return check failed", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/farequote
router.post("/farequote", requireAuth, requireSBT, async (req: any, res: any) => {
  try {
    if (process.env.TBO_ENV === "mock") {
      return res.json({
        Response: {
          ResponseStatus: 1,
          Results: {
            IsLCC: true,
            NonRefundable: false,
            ResultIndex: req.body.ResultIndex,
            IsPriceChanged: false,
            Fare: {
              BaseFare: 3500,
              Tax: 800,
              TotalFare: 4300,
              PublishedFare: 4300,
              Currency: "INR",
            },
            Segments: [],
          },
        },
      });
    }
    const result = await getFareQuote(req.body) as any;
    const fareResults = result?.Response?.Results;
    const corporateBookingAllowed =
      fareResults?.CorporateBookingAllowed || false;
    res.json({
      ...result,
      isPriceChanged: fareResults?.IsPriceChanged || false,
      isTimeChanged: fareResults?.IsTimeChanged || false,
      flightDetailChangeInfo: fareResults?.FlightDetailChangeInfo || null,
      isseatmandatory: fareResults?.isseatmandatory || false,
      ismealmandatory: fareResults?.ismealmandatory || false,
      corporateBookingAllowed,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/price-rbd
router.post("/price-rbd", requireAuth, requireSBT, async (req: any, res: any) => {
  try {
    const segments = req.body?.AirSearchResult?.[0]?.Segments ?? [];
    const fareClasses = segments.flat().map((s: any) => s?.Airline?.FareClass);
    const result = await getPriceRBD(req.body);
    logTBOCall({
      method: "PriceRBD",
      traceId: req.body?.TraceId || "unknown",
      request: req.body,
      response: result,
    });
    res.json(result);
  } catch (err: any) {
    sbtLogger.error("[PRICE-RBD] error", { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/farerule
router.post("/farerule", requireAuth, requireSBT, async (req: any, res: any) => {
  try {
    if (process.env.TBO_ENV === "mock") {
      return res.json({
        Response: {
          ResponseStatus: 1,
          FareRules: [
            {
              Origin: req.body.Origin || "DEL",
              Destination: req.body.Destination || "BOM",
              FareRuleDetail:
                "Cancellation: ₹3,500 fee applies 0-24 hrs before departure.\nDate Change: ₹2,000 fee + fare difference.\nNo-show: Non-refundable.",
            },
          ],
        },
      });
    }
    const result = await getFareRule(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/book
router.post("/book", requireSBT, requireFlightAccess, async (req: any, res: any) => {
  try {
    // Guard: LCC flights must use /ticket-lcc, not /book
    if (req.body?.isLCC === true) {
      return res.status(400).json({
        error: "Use /ticket-lcc for LCC flights",
        isLCC: true,
        code: "LCC_USE_TICKET",
      });
    }

    // Validate seat/meal/PAN/passport requirements from stored FareQuote
    const bookFareResults = req.body?.fareQuoteResults || req.body?.fareResults;
    const bookPassengers: any[] = req.body?.Passengers ?? [];
    const bookValErr = validateTBOBookingRequirements(bookFareResults, bookPassengers);
    if (bookValErr) return res.status(400).json({ error: bookValErr });

    // NDC detection — primary signal is req.body.isNDC (set by frontend),
    // airlineCode is secondary insurance
    const bookAirlineCode = req.body?.airlineCode
      || req.body?.Passengers?.[0]?.Fare?.AirlineCode
      || "";
    const bookIsNDCFlag = req.body?.isNDC === true;
    const bookIsNDC = isNDCFlight(bookAirlineCode, bookIsNDCFlag);
    if (bookIsNDC) sbtLogger.info("[NDC BOOK]", { airlineCode: bookAirlineCode });

    // Duplicate booking prevention (24hr window)
    const userId = req.user?.id || req.user?._id;
    if (userId && bookAirlineCode && req.body?.flightNumber) {
      const paxNames = bookPassengers.map((p: any) => `${p.FirstName || ""} ${p.LastName || ""}`.trim());
      const dupErr = await checkDuplicateBooking({
        userId,
        workspaceId: req.workspaceObjectId,
        originCode: req.body?.originCode || "",
        destinationCode: req.body?.destinationCode || "",
        departureDate: req.body?.departureDate || "",
        airlineCode: bookAirlineCode,
        flightNumber: req.body.flightNumber,
        passengerNames: paxNames,
      });
      if (dupErr) return res.status(409).json({ error: dupErr, code: "DUPLICATE_BOOKING" });
    }

    // Resolve corporate PAN from workspace
    const bookCustomerId = (req as any).workspace?.customerId?.toString() || (req.user as any)?.customerId;
    const bookWorkspace = bookCustomerId
      ? await CustomerWorkspace.findOne({ customerId: bookCustomerId }).select("pan").lean()
      : null;
    let bookCorporatePAN = (bookWorkspace as any)?.pan || "";
    if (!bookCorporatePAN && (bookWorkspace as any)?.customerId) {
      const bookCustomer = await Customer.findOne({ _id: (bookWorkspace as any).customerId }).select("pan").lean();
      bookCorporatePAN = (bookCustomer as any)?.pan || "";
    }
    const bookIsCorporate = req.body.corporateBookingAllowed === true && !!bookCorporatePAN;

    const data = await bookFlight({ ...req.body, isNDC: bookIsNDC, airlineCode: bookAirlineCode, destinationCode: req.body?.destinationCode, isCorporate: bookIsCorporate, corporatePAN: bookCorporatePAN }) as any;

    // Check for TBO-level failure
    const responseStatus = data?.Response?.ResponseStatus;
    if (responseStatus !== undefined && responseStatus !== 1) {
      const tboErr = data?.Response?.Error?.ErrorMessage || "Booking failed from supplier side";
      const tboCode = data?.Response?.Error?.ErrorCode;
      sbtLogger.warn("TBO Book rejected", { responseStatus, tboCode, tboErr });
      return res.status(400).json({
        error: tboErr,
        tboStatus: responseStatus,
        tboErrorCode: tboCode,
      });
    }

    // Check if price changed during booking
    const bookIsPriceChanged = data?.Response?.IsPriceChanged === true
      || data?.Response?.Response?.IsPriceChanged === true;

    // TBO Book response is double-nested: { Response: { Response: { PNR, BookingId, ... } } }
    const inner = data?.Response?.Response;
    const pnr = inner?.PNR ?? "";
    const bookingId = inner?.BookingId ?? "";
    const bookedPassengers = inner?.FlightItinerary?.Passenger ?? [];

    sbtLogger.info("TBO Book result", { pnr, bookingId, passengerCount: bookedPassengers.length, isPriceChanged: bookIsPriceChanged });

    // Compute certification case label while full payload is available
    const bookLeadPax = (req.body?.Passengers ?? [])[0] ?? {};
    const bookIsIntl = !!(bookLeadPax.PassportNo && bookLeadPax.PassportNo.length > 3);
    const bookCaseLabel = resolveCaseLabel({
      isLCC: false,
      isNDC: bookIsNDC,
      isReturn: req.body?.isReturn === true,
      isSpecialReturn: req.body?.isSpecialReturn === true,
      isMultiCity: req.body?.isMultiCity === true,
      isInternational: bookIsIntl,
      isCalendarFare: req.body?.isCalendarFare === true,
      isPriceRBD: req.body?.isPriceRBD === true || req.body?.isAdvanceSearch === true,
    });

    res.json({
      ...(data as object),
      // Surface extracted fields at top level for easy frontend access
      PNR: pnr,
      BookingId: bookingId,
      BookedPassengers: bookedPassengers,
      caseLabel: bookCaseLabel,
      isPriceChanged: bookIsPriceChanged,
    });
  } catch (err: any) {
    // Timeout recovery: poll GetBookingDetails to check if TBO processed it
    if (isTBOTimeoutError(err)) {
      sbtLogger.warn("TBO Book timeout — starting polling recovery", { traceId: req.body?.TraceId });
      const pollResult = await pollBookingOnTimeout(req.body?.lastKnownBookingId, req.body?.TraceId);
      if (pollResult.found) {
        return res.json({ ...pollResult.data, recoveredFromTimeout: true });
      }
      return res.status(504).json({
        status: "timeout_unconfirmed",
        message: "Booking may be pending — check My Bookings",
        traceId: req.body?.TraceId,
      });
    }
    sbtLogger.error("[BOOK ERROR]", { error: err?.message });
    res.status(500).json({ error: err?.message || "Book failed" });
  }
});

// POST /api/sbt/flights/ticket
router.post("/ticket", requireAuth, requireSBT, async (req: any, res: any) => {
  try {
    // Validate ticket-level PAN/passport requirements
    const ticketFareResults = req.body?.fareQuoteResults || req.body?.fareResults;
    if (ticketFareResults) {
      const ticketValErr = validateTBOTicketRequirements(ticketFareResults, req.body?.Passengers ?? []);
      if (ticketValErr) return res.status(400).json({ error: ticketValErr });
    }

    const result = await ticketFlight(req.body) as any;

    // TBO certification: call GetBookingDetails after successful Ticket
    const ticketStatus = result?.Response?.ResponseStatus;
    const traceId = result?.Response?.TraceId || req.body?.TraceId;
    const bookingId = result?.Response?.Response?.BookingId
      ?? result?.Response?.Response?.FlightItinerary?.BookingId;
    if (ticketStatus === 1 && bookingId) {
      const pnr = result?.Response?.Response?.PNR
        ?? result?.Response?.Response?.FlightItinerary?.PNR ?? "";
      const gdsCaseLabel = req.body?.caseLabel || "Case1_GDS_OneWay";
      let bookingDetails = null;
      try {
        const start = Date.now();
        bookingDetails = await getBookingDetails({ bookingId: String(bookingId) });
        logTBOCall({
          method: "GetBookingDetails",
          traceId,
          request: { EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1", TokenId: "***", BookingId: bookingId },
          response: bookingDetails,
          durationMs: Date.now() - start,
        });
      } catch (detailsErr: any) {
        sbtLogger.warn("GetBookingDetails after GDS Ticket failed", { bookingId, error: detailsErr?.message });
      } finally {
        consolidateCertificationLogs(traceId, bookingId, pnr, gdsCaseLabel).catch(() => {});
      }
      return res.json({ ...result, BookingDetails: bookingDetails });
    }

    res.json(result);
  } catch (err: any) {
    if (isTBOTimeoutError(err)) {
      sbtLogger.warn("TBO Ticket timeout — starting polling recovery", { bookingId: req.body?.BookingId });
      const pollResult = await pollBookingOnTimeout(req.body?.BookingId?.toString(), req.body?.TraceId);
      if (pollResult.found) {
        return res.json({ ...pollResult.data, recoveredFromTimeout: true });
      }
      return res.status(504).json({
        status: "timeout_unconfirmed",
        message: "Booking may be pending — check My Bookings",
        bookingId: req.body?.BookingId,
        traceId: req.body?.TraceId,
      });
    }
    sbtLogger.error("[TICKET ERROR]", { error: err?.message });
    res.status(500).json({ error: err?.message || "Ticket failed" });
  }
});

// GET /api/sbt/flights/booking/:id
router.get("/booking/:id", requireAuth, requireSBT, async (req: any, res: any) => {
  try {
    const result = await getBookingDetails({ bookingId: req.params.id });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/ssr
router.post("/ssr", requireSBT, async (req: any, res: any) => {
  try {
    // Multi-city flights have no SSR support per TBO
    if (Number(req.body?.JourneyType) === 3) {
      return res.json({
        Response: {
          MealDynamic: [], SeatDynamic: [], Baggage: [],
          ResponseStatus: 1, Error: { ErrorCode: 0, ErrorMessage: "" },
        },
      });
    }
    if (process.env.TBO_ENV === "mock") {
      return res.json({
        Response: {
          ResponseStatus: 1,
          SeatDynamic: [],
          Baggage: [],
          MealDynamic: [],
        },
      });
    }
    const result = await getSSR(req.body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/ticket-lcc
router.post("/ticket-lcc", requireAuth, requireSBT, async (req: any, res: any) => {
  try {
    const { isReturn, returnResultIndex, returnTraceId, returnPassengers, isSpecialReturn, isReturnGDS } = req.body;

    // NDC detection for ticket-lcc — primary signal is req.body.isNDC,
    // airlineCode is secondary insurance
    const ticketAirlineCode = req.body?.airlineCode
      || req.body?.Passengers?.[0]?.Fare?.AirlineCode
      || "";
    const ticketIsNDCFlag = req.body?.isNDC === true;
    const ticketIsNDC = isNDCFlight(ticketAirlineCode, ticketIsNDCFlag);
    if (ticketIsNDC) sbtLogger.info("[NDC TICKET-LCC]", { airlineCode: ticketAirlineCode });

    // Resolve dynamic certification case label
    const lccLeadPax = (req.body?.Passengers ?? [])[0] ?? {};
    const lccIsIntl = !!(lccLeadPax.PassportNo && lccLeadPax.PassportNo.length > 3);
    const lccCaseLabel = resolveCaseLabel({
      isLCC: true,
      isNDC: ticketIsNDC,
      isReturn: !!isReturn,
      isSpecialReturn: !!isSpecialReturn,
      isMultiCity: req.body?.isMultiCity === true,
      isInternational: lccIsIntl,
      isCalendarFare: req.body?.isCalendarFare === true,
      isPriceRBD: req.body?.isPriceRBD === true || req.body?.isAdvanceSearch === true,
    });

    sbtLogger.info('[TICKET-LCC ENTRY]', {
      passengerCount: req.body?.Passengers?.length,
      isReturn: !!isReturn,
      isNDC: ticketIsNDC,
    });

    // Validate seat/meal/PAN/passport requirements from stored FareQuote
    const lccFareResults = req.body?.fareQuoteResults || req.body?.fareResults;
    const lccPassengers: any[] = req.body?.Passengers ?? [];
    const lccValErr = validateTBOBookingRequirements(lccFareResults, lccPassengers);
    if (lccValErr) return res.status(400).json({ error: lccValErr });

    // Duplicate booking prevention (24hr window)
    const lccUserId = req.user?.id || req.user?._id;
    if (lccUserId && ticketAirlineCode && req.body?.flightNumber) {
      const paxNames = lccPassengers.map((p: any) => `${p.FirstName || ""} ${p.LastName || ""}`.trim());
      const dupErr = await checkDuplicateBooking({
        userId: lccUserId,
        workspaceId: req.workspaceObjectId,
        originCode: req.body?.originCode || "",
        destinationCode: req.body?.destinationCode || "",
        departureDate: req.body?.departureDate || "",
        airlineCode: ticketAirlineCode,
        flightNumber: req.body.flightNumber,
        passengerNames: paxNames,
      });
      if (dupErr) return res.status(409).json({ error: dupErr, code: "DUPLICATE_BOOKING" });
    }

    // Validate ticket-level PAN/passport requirements
    const lccTicketValErr = validateTBOTicketRequirements(lccFareResults, lccPassengers);
    if (lccTicketValErr) return res.status(400).json({ error: lccTicketValErr });

    // Resolve corporate PAN from workspace
    const lccCustomerId = (req as any).workspace?.customerId?.toString() || (req.user as any)?.customerId;
    const lccWorkspace = lccCustomerId
      ? await CustomerWorkspace.findOne({ customerId: lccCustomerId }).select("pan").lean()
      : null;
    let lccCorporatePAN = (lccWorkspace as any)?.pan || "";
    if (!lccCorporatePAN && (lccWorkspace as any)?.customerId) {
      const lccCustomer = await Customer.findOne({ _id: (lccWorkspace as any).customerId }).select("pan").lean();
      lccCorporatePAN = (lccCustomer as any)?.pan || "";
    }
    const lccIsCorporate = req.body.corporateBookingAllowed === true && !!lccCorporatePAN;
    const corpParams = lccIsCorporate ? { isCorporate: true as const, corporatePAN: lccCorporatePAN } : {};

    const lccIsInternational = req.body.isInternational ?? lccIsIntl;
    const lccSegments = lccFareResults?.Segments ?? req.body.Segments ?? [];
    const lccFreeBaggage = (req.body.FreeBaggage ?? []).filter((b: any) => b.Price === 0);
    const lccAirlineCode = ticketAirlineCode || req.body?.airlineCode || "";
    const lccDestCode = req.body?.destinationCode || "";

    // Convert SeatPreference → SeatDynamic (flat array) if frontend sent old format
    function convertSeatPreferences(passengers: any[]) {
      for (const pax of passengers) {
        if (pax.SeatPreference && !pax.SeatDynamic) {
          const items = Array.isArray(pax.SeatPreference) ? pax.SeatPreference : [pax.SeatPreference];
          pax.SeatDynamic = items.map((sp: any) => ({
            AirlineCode: sp.AirlineCode || "",
            FlightNumber: sp.FlightNumber || "",
            CraftType: sp.CraftType || "",
            Origin: sp.Origin || "",
            Destination: sp.Destination || "",
            AvailablityType: sp.AvailablityType ?? 0,
            Description: Number(sp.Description) || 2,
            Code: sp.Code || "",
            RowNo: sp.RowNo || (sp.Code?.replace(/[A-Z]/gi, "") || "0"),
            SeatNo: sp.Code || "",
            SeatType: sp.SeatType ?? 0,
            SeatWayType: sp.WayType || sp.SeatWayType || 2,
            Compartment: sp.Compartment ?? 0,
            Deck: sp.Deck ?? 0,
            Currency: sp.Currency || "INR",
            Price: sp.Price || 0,
          }));
          delete pax.SeatPreference;
        }
      }
    }

    const obPassengers: any[] = req.body?.Passengers ?? [];
    convertSeatPreferences(obPassengers);

    // Log full payload for debugging before any ticketLCC call
    sbtLogger.info("[TBO TICKET PRE-CALL]", {
      module: "sbt",
      TraceId: req.body.TraceId,
      ResultIndex: req.body.ResultIndex?.substring(0, 30) + "...",
      isSpecialReturn,
      isReturn,
      isNDC: ticketIsNDC,
      isInternational: lccIsInternational,
      airlineCode: lccAirlineCode,
      passengers: obPassengers.map((p: any) => ({
        name: `${p.FirstName} ${p.LastName}`,
        PaxType: p.PaxType,
        SeatDynamic: p.SeatDynamic,
        MealDynamic: p.MealDynamic,
        Baggage: p.Baggage,
      })),
    });

    // ── Special Return: single ticketLCC call, TBO returns one PNR for both legs ──
    if (isSpecialReturn && isReturn) {

      const result = await ticketLCC({
        TraceId: req.body.TraceId,
        ResultIndex: req.body.ResultIndex,
        Passengers: obPassengers,
        IsPriceChangeAccepted: true,
        isNDC: ticketIsNDC,
        isInternational: lccIsInternational,
        airlineCode: lccAirlineCode,
        destinationCode: lccDestCode,
        Segments: lccSegments,
        FreeBaggage: lccFreeBaggage,
        ...(req.body.GSTCompanyInfo ? { GSTCompanyInfo: req.body.GSTCompanyInfo } : {}),
        ...(req.body.IsGSTMandatory != null ? { IsGSTMandatory: req.body.IsGSTMandatory } : {}),
        ...corpParams,
      }) as any;

      const ticketStatus = result?.Response?.ResponseStatus;
      const traceId = result?.Response?.TraceId || req.body?.TraceId;
      const bookingId = result?.Response?.Response?.BookingId
        ?? result?.Response?.Response?.FlightItinerary?.BookingId;
      const pnr = result?.Response?.Response?.PNR
        ?? result?.Response?.Response?.FlightItinerary?.PNR ?? "";

      if (ticketStatus === 1 && bookingId) {
        let bookingDetails = null;
        try {
          const start = Date.now();
          bookingDetails = await getBookingDetails({ bookingId: String(bookingId) });
          logTBOCall({
            method: "GetBookingDetails",
            traceId,
            request: { EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1", TokenId: "***", BookingId: bookingId },
            response: bookingDetails,
            durationMs: Date.now() - start,
          });
        } catch (detailsErr: any) {
          sbtLogger.warn("GetBookingDetails after Special Return LCC Ticket failed", { bookingId, error: detailsErr?.message });
        } finally {
          consolidateCertificationLogs(traceId, bookingId, pnr, lccCaseLabel).catch(() => {});
        }
        return res.json({ ...result, isSpecialReturn: true, BookingDetails: bookingDetails });
      }
      return res.json({ ...result, isSpecialReturn: true });
    }

    // ── Return LCC: two separate ticketLCC calls (OB + IB) ──
    if (isReturn && returnResultIndex) {
      const ibPassengers: any[] = returnPassengers ?? [];
      convertSeatPreferences(ibPassengers);

      // 1. Ticket OB leg
      sbtLogger.info('[TICKET-LCC] Ticketing OB leg...');
      const obPayload = {
        TraceId: req.body.TraceId,
        ResultIndex: req.body.ResultIndex,
        Passengers: obPassengers,
        IsPriceChangeAccepted: true,
        isNDC: ticketIsNDC,
        isInternational: lccIsInternational,
        airlineCode: lccAirlineCode,
        destinationCode: lccDestCode,
        Segments: lccSegments,
        FreeBaggage: lccFreeBaggage,
        ...(req.body.GSTCompanyInfo ? { GSTCompanyInfo: req.body.GSTCompanyInfo } : {}),
        ...(req.body.IsGSTMandatory != null ? { IsGSTMandatory: req.body.IsGSTMandatory } : {}),
        ...corpParams,
      };
      let obResult = await ticketLCC(obPayload) as any;

      // Retry 1: strip seat only, keep meal — TBO may accept meal without seat
      const obErr = obResult?.Response?.Error?.ErrorMessage
        ?? obResult?.Response?.Response?.Error?.ErrorMessage ?? "";
      if (obResult?.Response?.ResponseStatus !== 1 && (/invalid meal/i.test(obErr) || /meal.*mandatory/i.test(obErr) || /mandatory.*meal/i.test(obErr) || /seat/i.test(obErr))) {
        sbtLogger.info('[TICKET-LCC] OB SSR error — retry 1: strip seat, keep meal', { module: 'sbt', error: obErr });
        const obPassengersNoSeat = obPassengers.map((p: any) => ({ ...p, SeatDynamic: [] }));
        obResult = await ticketLCC({
          ...obPayload,
          Passengers: obPassengersNoSeat,
        }) as any;

        // Retry 2: strip both seat and meal if still failing
        const obErr2 = obResult?.Response?.Error?.ErrorMessage
          ?? obResult?.Response?.Response?.Error?.ErrorMessage ?? "";
        if (obResult?.Response?.ResponseStatus !== 1 && (/invalid meal/i.test(obErr2) || /meal.*mandatory/i.test(obErr2) || /mandatory.*meal/i.test(obErr2) || /seat/i.test(obErr2))) {
          sbtLogger.info('[TICKET-LCC] OB SSR error — retry 2: strip seat and meal', { module: 'sbt', error: obErr2 });
          const obPassengersNoSSR = obPassengers.map((p: any) => ({
            ...p, SeatDynamic: [], MealDynamic: [], Baggage: [],
          }));
          obResult = await ticketLCC({
            ...obPayload,
            Passengers: obPassengersNoSSR,
            FreeBaggage: [],
          }) as any;
        }
      }

      const obStatus = obResult?.Response?.ResponseStatus;
      const obBookingId = obResult?.Response?.Response?.BookingId
        ?? obResult?.Response?.Response?.FlightItinerary?.BookingId;
      const obPNR = obResult?.Response?.Response?.PNR
        ?? obResult?.Response?.Response?.FlightItinerary?.PNR ?? "";

      if (obStatus !== 1 || !obBookingId) {
        const obError = obResult?.Response?.Error?.ErrorMessage
          ?? obResult?.Response?.Response?.Error?.ErrorMessage ?? "OB ticketing failed";
        sbtLogger.error('[TICKET-LCC] OB leg failed', { error: obError });
        return res.json(obResult);
      }
      sbtLogger.info('[TICKET-LCC] OB leg success');

      // 2. Ticket IB leg
      const ibTraceId = returnTraceId || req.body.TraceId;
      let ibResult: any;
      let ibBookingId: any;
      let ibPNR: string = "";

      if (isReturnGDS) {
        // ── Mixed carrier: IB is GDS → Book first, then Ticket ──
        sbtLogger.info('[TICKET-LCC] IB leg is GDS — using Book + Ticket flow');

        const ibBookResult = await bookFlight({
          TraceId: ibTraceId,
          ResultIndex: returnResultIndex,
          Passengers: ibPassengers,
          isNDC: ticketIsNDC,
          ...(req.body.IsGSTMandatory != null ? { IsGSTMandatory: req.body.IsGSTMandatory } : {}),
          ...(req.body.GSTCompanyInfo ? { GSTCompanyInfo: req.body.GSTCompanyInfo } : {}),
          ...corpParams,
        }) as any;

        ibPNR = ibBookResult?.Response?.Response?.PNR
          ?? ibBookResult?.Response?.PNR ?? "";
        ibBookingId = ibBookResult?.Response?.Response?.BookingId
          ?? ibBookResult?.Response?.BookingId;

        if (!ibPNR || !ibBookingId) {
          const ibBookError = ibBookResult?.Response?.Error?.ErrorMessage
            ?? ibBookResult?.Response?.Response?.Error?.ErrorMessage ?? "IB GDS Book failed";
          sbtLogger.error('[TICKET-LCC] IB GDS Book failed', { error: ibBookError });
          // OB succeeded but IB Book failed — return OB result with IB error
          return res.json({
            ...obResult,
            isReturn: true,
            returnPnr: "",
            returnBookingId: "",
            returnError: ibBookError,
            ibBookFailed: true,
          });
        }

        sbtLogger.info('[TICKET-LCC] IB GDS Book success');

        const ibTicketResult = await ticketFlight({
          TraceId: ibTraceId,
          PNR: ibPNR,
          BookingId: Number(ibBookingId),
        }) as any;

        sbtLogger.info('[TICKET-LCC] IB GDS Ticket complete', {
          status: ibTicketResult?.Response?.ResponseStatus,
        });

        ibResult = ibTicketResult;
      } else {
        // ── Both legs LCC → ticketLCC for IB ──
        sbtLogger.info('[TICKET-LCC] Ticketing IB LCC leg...');
        const ibSegments = req.body.ReturnSegments ?? [];
        const ibFreeBaggage = (req.body.ReturnFreeBaggage ?? []).filter((b: any) => b.Price === 0);
        const ibPayload = {
          TraceId: ibTraceId,
          ResultIndex: returnResultIndex,
          Passengers: ibPassengers,
          IsPriceChangeAccepted: true,
          isNDC: ticketIsNDC,
          isInternational: lccIsInternational,
          airlineCode: lccAirlineCode,
          destinationCode: req.body?.returnDestinationCode || lccDestCode,
          Segments: ibSegments,
          FreeBaggage: ibFreeBaggage,
          ...(req.body.GSTCompanyInfo ? { GSTCompanyInfo: req.body.GSTCompanyInfo } : {}),
          ...(req.body.IsGSTMandatory != null ? { IsGSTMandatory: req.body.IsGSTMandatory } : {}),
          ...corpParams,
        };
        ibResult = await ticketLCC(ibPayload) as any;

        // Retry 1: strip seat only, keep meal — TBO may accept meal without seat
        const ibErr = ibResult?.Response?.Error?.ErrorMessage
          ?? ibResult?.Response?.Response?.Error?.ErrorMessage ?? "";
        if (ibResult?.Response?.ResponseStatus !== 1 && (/invalid meal/i.test(ibErr) || /meal.*mandatory/i.test(ibErr) || /mandatory.*meal/i.test(ibErr) || /seat/i.test(ibErr))) {
          sbtLogger.info('[TICKET-LCC] IB SSR error — retry 1: strip seat, keep meal', { module: 'sbt', error: ibErr });
          const ibPassengersNoSeat = ibPassengers.map((p: any) => ({ ...p, SeatDynamic: [] }));
          ibResult = await ticketLCC({
            ...ibPayload,
            Passengers: ibPassengersNoSeat,
          }) as any;

          // Retry 2: strip both seat and meal if still failing
          const ibErr2 = ibResult?.Response?.Error?.ErrorMessage
            ?? ibResult?.Response?.Response?.Error?.ErrorMessage ?? "";
          if (ibResult?.Response?.ResponseStatus !== 1 && (/invalid meal/i.test(ibErr2) || /meal.*mandatory/i.test(ibErr2) || /mandatory.*meal/i.test(ibErr2) || /seat/i.test(ibErr2))) {
            sbtLogger.info('[TICKET-LCC] IB SSR error — retry 2: strip seat and meal', { module: 'sbt', error: ibErr2 });
            const ibPassengersNoSSR = ibPassengers.map((p: any) => ({
              ...p, SeatDynamic: [], MealDynamic: [], Baggage: [],
            }));
            ibResult = await ticketLCC({
              ...ibPayload,
              Passengers: ibPassengersNoSSR,
              FreeBaggage: [],
            }) as any;
          }
        }

        ibBookingId = ibResult?.Response?.Response?.BookingId
          ?? ibResult?.Response?.Response?.FlightItinerary?.BookingId;
        ibPNR = ibResult?.Response?.Response?.PNR
          ?? ibResult?.Response?.Response?.FlightItinerary?.PNR ?? "";
      }

      const ibStatus = ibResult?.Response?.ResponseStatus;

      sbtLogger.info('[TICKET-LCC] IB leg result', {
        ibStatus, isReturnGDS: !!isReturnGDS,
      });

      // 3. GetBookingDetails for both
      const endUserIp = process.env.TBO_EndUserIp || "1.1.1.1";
      let obDetails: any = null;
      let ibDetails: any = null;
      const obTraceId = obResult?.Response?.TraceId || req.body.TraceId;
      try {
        const start = Date.now();
        obDetails = await getBookingDetails({ bookingId: String(obBookingId) });
        logTBOCall({
          method: "GetBookingDetails",
          traceId: obTraceId,
          request: { EndUserIp: endUserIp, TokenId: "***", BookingId: obBookingId },
          response: obDetails,
          durationMs: Date.now() - start,
        });
      } catch (err: any) {
        sbtLogger.warn("GetBookingDetails after OB LCC Ticket failed", { obBookingId, error: err?.message });
      }
      if (ibBookingId) {
        try {
          const start = Date.now();
          ibDetails = await getBookingDetails({ bookingId: String(ibBookingId) });
          logTBOCall({
            method: "GetBookingDetails",
            traceId: ibTraceId,
            request: { EndUserIp: endUserIp, TokenId: "***", BookingId: ibBookingId },
            response: ibDetails,
            durationMs: Date.now() - start,
          });
        } catch (err: any) {
          sbtLogger.warn("GetBookingDetails after IB LCC Ticket failed", { ibBookingId, error: err?.message });
        }
      }

      // 4. Consolidate certification logs for both OB + IB legs
      consolidateCertificationLogs(
        obTraceId, obBookingId, obPNR, lccCaseLabel,
        { traceId: ibTraceId, bookingId: ibBookingId, pnr: ibPNR },
      ).catch(() => {});

      // Return combined response
      return res.json({
        ...obResult,
        isReturn: true,
        returnPnr: ibPNR,
        returnBookingId: ibBookingId,
        returnTraceId: ibTraceId,
        returnTicketResult: ibResult,
        BookingDetails: obDetails,
        ReturnBookingDetails: ibDetails,
      });
    }

    // ── One-way LCC (existing logic) ──
    let result = await ticketLCC({
      ...req.body,
      isInternational: lccIsInternational,
      airlineCode: lccAirlineCode,
      destinationCode: lccDestCode,
      Segments: lccSegments,
      FreeBaggage: lccFreeBaggage,
      ...corpParams,
    }) as any;

    // Retry 1: strip seat only, keep meal — TBO may accept meal without seat
    const onewayErr = result?.Response?.Error?.ErrorMessage
      ?? result?.Response?.Response?.Error?.ErrorMessage ?? "";
    if (
      result?.Response?.ResponseStatus !== 1 &&
      (/invalid meal/i.test(onewayErr) || /meal.*mandatory/i.test(onewayErr) || /mandatory.*meal/i.test(onewayErr) || /seat/i.test(onewayErr))
    ) {
      sbtLogger.info('[TICKET-LCC] One-way SSR error — retry 1: strip seat, keep meal', { module: 'sbt', error: onewayErr });
      const passengersNoSeat = obPassengers.map((p: any) => ({ ...p, SeatDynamic: [] }));
      result = await ticketLCC({
        ...req.body,
        Passengers: passengersNoSeat,
        isInternational: lccIsInternational,
        airlineCode: lccAirlineCode,
        destinationCode: lccDestCode,
        Segments: lccSegments,
        FreeBaggage: lccFreeBaggage,
        ...corpParams,
      }) as any;

      // Retry 2: strip both seat and meal if still failing
      const onewayErr2 = result?.Response?.Error?.ErrorMessage
        ?? result?.Response?.Response?.Error?.ErrorMessage ?? "";
      if (
        result?.Response?.ResponseStatus !== 1 &&
        (/invalid meal/i.test(onewayErr2) || /meal.*mandatory/i.test(onewayErr2) || /mandatory.*meal/i.test(onewayErr2) || /seat/i.test(onewayErr2))
      ) {
        sbtLogger.info('[TICKET-LCC] One-way SSR error — retry 2: strip seat and meal', { module: 'sbt', error: onewayErr2 });
        const passengersNoSSR = obPassengers.map((p: any) => ({
          ...p, SeatDynamic: [], MealDynamic: [], Baggage: [],
        }));
        result = await ticketLCC({
          ...req.body,
          Passengers: passengersNoSSR,
          isInternational: lccIsInternational,
          airlineCode: lccAirlineCode,
          destinationCode: lccDestCode,
          Segments: lccSegments,
          FreeBaggage: [],
          ...corpParams,
        }) as any;
      }
    }

    // TBO certification: call GetBookingDetails after successful LCC Ticket
    const ticketStatus = result?.Response?.ResponseStatus;
    const traceId = result?.Response?.TraceId || req.body?.TraceId;
    const bookingId = result?.Response?.Response?.BookingId
      ?? result?.Response?.Response?.FlightItinerary?.BookingId;
    if (ticketStatus === 1 && bookingId) {
      const pnr = result?.Response?.Response?.PNR
        ?? result?.Response?.Response?.FlightItinerary?.PNR ?? "";
      let bookingDetails = null;
      try {
        const start = Date.now();
        bookingDetails = await getBookingDetails({ bookingId: String(bookingId) });
        logTBOCall({
          method: "GetBookingDetails",
          traceId,
          request: { EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1", TokenId: "***", BookingId: bookingId },
          response: bookingDetails,
          durationMs: Date.now() - start,
        });
      } catch (detailsErr: any) {
        sbtLogger.warn("GetBookingDetails after LCC Ticket failed", { bookingId, error: detailsErr?.message });
      } finally {
        consolidateCertificationLogs(traceId, bookingId, pnr, lccCaseLabel).catch(() => {});
      }
      return res.json({ ...result, BookingDetails: bookingDetails });
    }

    res.json(result);
  } catch (err: any) {
    if (isTBOTimeoutError(err)) {
      sbtLogger.warn("TBO TicketLCC timeout — starting polling recovery", { traceId: req.body?.TraceId });
      const pollResult = await pollBookingOnTimeout(req.body?.lastKnownBookingId, req.body?.TraceId);
      if (pollResult.found) {
        return res.json({ ...pollResult.data, recoveredFromTimeout: true });
      }
      return res.status(504).json({
        status: "timeout_unconfirmed",
        message: "Booking may be pending — check My Bookings",
        traceId: req.body?.TraceId,
      });
    }
    sbtLogger.error("[TICKET-LCC ERROR]", { error: err?.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/release
// Supports both JSON and text/plain (sendBeacon from browser tab close)
router.post("/release", requireAuth, requireSBT, async (req: any, res: any) => {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const result = await releasePNR(body);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sbt/flights/booking/pnr/:pnr?firstName=X&lastName=Y
router.get("/booking/pnr/:pnr", requireAuth, async (req: any, res: any) => {
  try {
    const firstName = String(req.query.firstName || "").trim().slice(0, 50);
    const lastName = String(req.query.lastName || "").trim().slice(0, 50);
    if (!firstName || !lastName) {
      return res.status(400).json({ error: "firstName and lastName are required" });
    }
    const result = await getBookingDetailsByPNR({
      PNR: req.params.pnr,
      FirstName: firstName,
      LastName: lastName,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Booking persistence routes ──────────────────────────────────────────────

// POST /api/sbt/flights/bookings/save — persist a confirmed booking
router.post("/bookings/save", requireAuth, requireSBT, async (req: any, res: any) => {
  try {
    const rawId = req.user?._id ?? req.user?.id ?? req.user?.sub;
    if (!rawId) return res.status(401).json({ error: "Not authenticated" });
    const bookerId = mongoose.Types.ObjectId.isValid(rawId)
      ? new mongoose.Types.ObjectId(String(rawId)) : rawId;

    const b = req.body;

    // When booking on behalf of an L1 requester, use their ID as the owner
    let bookingUserId: any = bookerId;
    if (b.sbtRequestId) {
      const sbtReqForUser = await scopedFindById(SBTRequest, b.sbtRequestId, req.workspaceObjectId);
      if (sbtReqForUser?.requesterId) bookingUserId = sbtReqForUser.requesterId;
    }

    // Task 7: Check if webhook already created/confirmed this booking
    if (b.razorpayOrderId) {
      const existing = await SBTBooking.findOne({ razorpayOrderId: b.razorpayOrderId });
      if (existing && existing.status === "CONFIRMED") {
        // Webhook beat the frontend — update with any missing details
        existing.pnr = b.pnr || existing.pnr;
        existing.bookingId = b.bookingId || existing.bookingId;
        existing.ticketId = b.ticketId || existing.ticketId;
        (existing as any).traceId = b.traceId || (existing as any).traceId;
        existing.passengers = b.passengers?.length ? b.passengers : existing.passengers;
        existing.contactEmail = b.contactEmail || existing.contactEmail;
        existing.contactPhone = b.contactPhone || existing.contactPhone;
        existing.raw = b.raw ?? existing.raw;
        await existing.save();
        return res.json({ ok: true, booking: existing, webhookRecovered: true });
      }
    }

    if (!b.pnr || !b.bookingId) {
      return res.status(400).json({ error: "Missing PNR or BookingId — booking not saved" });
    }

    const doc = await SBTBooking.create({
      userId: bookingUserId,
      customerId: (req.user as any)?.customerId ?? undefined,
      sbtRequestId: b.sbtRequestId || undefined,
      workspaceId: req.workspaceObjectId,
      traceId: b.traceId || "",
      pnr: b.pnr,
      bookingId: b.bookingId,
      ticketId: b.ticketId ?? "",
      status: b.status ?? "CONFIRMED",
      origin: b.origin,
      destination: b.destination,
      departureTime: b.departureTime,
      arrivalTime: b.arrivalTime,
      airlineCode: b.airlineCode,
      airlineName: b.airlineName,
      flightNumber: b.flightNumber,
      cabin: b.cabin ?? 2,
      passengers: b.passengers ?? [],
      contactEmail: b.contactEmail ?? "",
      contactPhone: b.contactPhone ?? "",
      baseFare: b.baseFare,
      taxes: b.taxes ?? 0,
      extras: b.extras ?? 0,
      totalFare: b.totalFare,
      currency: b.currency ?? "INR",
      isLCC: b.isLCC ?? false,
      razorpayPaymentId: b.razorpayPaymentId ?? "",
      razorpayOrderId: b.razorpayOrderId ?? "",
      razorpayAmount: b.razorpayAmount ?? 0,
      paymentStatus: b.paymentStatus ?? "pending",
      paymentTimestamp: b.paymentTimestamp ? new Date(b.paymentTimestamp) : undefined,
      paymentMode: b.paymentMode === "official" ? "official" : "personal",
      fareBreakdown: b.fareBreakdown || undefined,
      ticketingStatus: b.ticketingStatus || "NOT_ATTEMPTED",
      bookedAt: new Date(),
      raw: (() => {
        const r = b.raw as any;
        if (!r || typeof r !== 'object') return r;
        const fi = r?.Response?.Response?.FlightItinerary
          ?? r?.Response?.FlightItinerary
          ?? {};
        return {
          ...r,
          MiniFareRules: fi.MiniFareRules ?? r?.MiniFareRules ?? [],
          OnlineReissueAllowed: fi.OnlineReissueAllowed ?? r?.OnlineReissueAllowed,
        };
      })(),
      cancelPolicies: (() => {
        const raw = b.raw as any;
        return raw?.Response?.Response?.FlightItinerary?.FareRules
          ?? raw?.Response?.FlightItinerary?.FareRules
          ?? [];
      })(),
      isRefundable: (() => {
        const raw = b.raw as any;
        const v = raw?.Response?.Response?.FlightItinerary?.IsRefundable
          ?? raw?.Response?.FlightItinerary?.IsRefundable;
        return v != null ? Boolean(v) : undefined;
      })(),
    });

    // Increment workspace monthly spend for official bookings
    if (b.paymentMode === "official" && req.workspaceObjectId) {
      try {
        await CustomerWorkspace.findOneAndUpdate(
          { _id: req.workspaceObjectId },
          { $inc: { 'sbtOfficialBooking.currentMonthSpend': b.totalFare ?? 0 } },
          { runValidators: false },
        );
      } catch (spendErr) {
        sbtLogger.error('[OfficialBooking] Failed to track spend', {
          workspaceId: req.workspaceObjectId,
          amount: b.totalFare,
          error: spendErr,
        });
      }
    }

    // If this booking fulfils an SBT request, mark it as BOOKED and notify L1
    if (b.sbtRequestId) {
      try {
        const sbtReq = await scopedFindById(SBTRequest, b.sbtRequestId, req.workspaceObjectId);
        if (sbtReq && sbtReq.status === "PENDING") {
          sbtReq.status = "BOOKED";
          (sbtReq as any).bookingId = doc._id;
          sbtReq.actedAt = new Date();
          await sbtReq.save();

          // Send confirmation email to L1 requester
          const requester = await User.findById(sbtReq.requesterId)
            .select("name email customerId").lean() as any;
          sbtLogger.info("[SBT EMAIL] Attempting to send to:", { userId: sbtReq.requesterId, email: requester?.email, event: "booking_saved" });
          if (!requester) {
            sbtLogger.warn("[SBT EMAIL] User not found:", { userId: sbtReq.requesterId, event: "booking_saved" });
          }
          if (requester?.email) {
            const frontendUrl = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
            const confirmedBody = `
              ${eLabel('Booking Confirmed')}
              ${eCard(`
                <table cellpadding="0" cellspacing="0" width="100%">
                  ${eRow('PNR', escapeHtml(doc.pnr || b.pnr || '—'))}
                  ${eRow('Route', escapeHtml(`${b.origin?.city || b.searchParams?.origin || '?'} → ${b.destination?.city || b.searchParams?.destination || '?'}`))}
                  ${eRow('Departure', escapeHtml(b.departureTime || b.searchParams?.departDate || '—'))}
                  ${eRow('Passenger', escapeHtml(requester?.name || requester?.email || '—'))}
                  ${eRow('Booked by', escapeHtml(req.user?.email || '—'))}
                </table>
              `)}
              ${eBtn(
                'View My Requests',
                frontendUrl + '/sbt/my-requests',
                '#4f46e5', '#ffffff'
              )}
            `;
            const html = buildEmailShell(confirmedBody, {
              title: 'Your Trip is Confirmed',
              subtitle: 'Your flight has been booked successfully',
              badgeText: 'CONFIRMED',
              badgeColor: '#10b981',
            });
            await sendMail({
              to: requester.email,
              subject: `Your flight has been booked — PNR ${doc.pnr}`,
              kind: "CONFIRMATIONS",
              html,
            }).catch((e: any) => sbtLogger.error("[SBT EMAIL FAILED]", { event: "booking_saved", recipient: requester.email, error: e?.message || e }));
          }
          sbtLogger.info("SBT request marked BOOKED via flight booking", {
            sbtRequestId: b.sbtRequestId, bookingDocId: doc._id,
          });
        }
      } catch (reqErr: any) {
        sbtLogger.warn("Failed to update SBT request after booking", { error: reqErr?.message });
      }
    }

    res.json({ ok: true, booking: doc });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Failed to save booking";
    res.status(500).json({ error: msg });
  }
});

// GET /api/sbt/flights/bookings — list current user's bookings
// GET /api/sbt/flights/my-bookings — lightweight endpoint for any authenticated
// user to fetch their own bookings (used by MyProfile dashboard widget).
// Does NOT require SBT access so non-SBT users get an empty list instead of 403.
router.get("/my-bookings", requireAuth, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id ?? req.user?.sub;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const { limit, status } = req.query;
    const filter: any = { userId };
    if (status) filter.status = String(status).toUpperCase();

    const lim = Math.min(50, Math.max(1, parseInt(limit as string, 10) || 10));
    const bookings = await SBTBooking.find(filter).sort({ createdAt: -1 }).limit(lim).lean();
    res.json({ ok: true, bookings });
  } catch (err: any) {
    sbtLogger.error("my-bookings failed", { userId: req.user?.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

router.get("/bookings", requireSBT, async (req: any, res: any) => {
  try {
    const rawId = req.user?._id ?? req.user?.id ?? req.user?.sub;
    if (!rawId) return res.status(401).json({ error: "Not authenticated" });

    const isWL = (req.user?.roles || [])
      .map((r: string) => String(r).toUpperCase().replace(/[\s_-]/g, ''))
      .includes('WORKSPACELEADER') ||
      req.user?.customerMemberRole === 'WORKSPACE_LEADER';

    let bookings;
    if (isWL) {
      const customerId = (req as any).workspace?.customerId || req.user?.customerId;
      bookings = await SBTBooking.find({ customerId }).sort({ createdAt: -1 }).lean();
    } else {
      const userId = mongoose.Types.ObjectId.isValid(rawId)
        ? new mongoose.Types.ObjectId(rawId)
        : rawId;
      bookings = await SBTBooking.find({ userId }).sort({ createdAt: -1 }).lean();
    }

    const bookingsWithReissue = bookings.map((booking: any) => {
      const miniFareRules = (booking.raw as any)?.MiniFareRules || [];
      const onlineReissueAllowed = miniFareRules.some(
        (ruleSet: any) => Array.isArray(ruleSet) &&
          ruleSet.some((r: any) => r.OnlineReissueAllowed === true)
      );
      return { ...booking, onlineReissueAllowed };
    });

    res.json({ ok: true, bookings: bookingsWithReissue });
  } catch (err: any) {
    sbtLogger.error("Bookings list failed", { userId: req.user?.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sbt/flights/bookings/fix-zero-fares — one-time admin backfill for ₹0 bookings
// Must be registered BEFORE /bookings/:id to avoid ":id" catching "fix-zero-fares"
router.get("/bookings/fix-zero-fares", requireAuth, requireAdmin, async (req: any, res: any) => {
  try {
    const docs = await SBTBooking.find({ totalFare: 0 }).lean();
    let fixed = 0;
    let skipped = 0;

    for (const doc of docs) {
      const raw = doc.raw as any;
      const tboFare =
        raw?.Response?.Response?.FlightItinerary?.Fare ??
        raw?.Response?.FlightItinerary?.Fare ??
        raw?.FlightItinerary?.Fare ??
        raw?.Fare ??
        null;

      const pubFare =
        tboFare?.PublishedFare ||
        tboFare?.OfferedFare ||
        tboFare?.TotalFare ||
        0;

      if (pubFare > 0) {
        await SBTBooking.updateOne(
          { _id: doc._id },
          {
            $set: {
              totalFare: pubFare,
              baseFare: tboFare?.BaseFare || 0,
              taxes: tboFare?.Tax || 0,
            },
          },
        );
        fixed++;
      } else {
        skipped++;
      }
    }

    res.json({ ok: true, fixed, skipped, total: fixed + skipped });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sbt/flights/bookings/orphaned — list orphaned flight bookings (ADMIN)
router.get("/bookings/orphaned", requireAuth, requireAdmin, async (_req: any, res: any) => {
  try {
    const docs = await SBTBooking.find({
      status: { $in: ["FAILED", "PENDING"] },
      razorpayPaymentId: { $ne: "" },
      razorpayAmount: { $gt: 0 },
    }).sort({ createdAt: -1 }).lean();
    res.json({ ok: true, count: docs.length, bookings: docs });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/bookings/refund-orphaned — refund orphaned flight payments (ADMIN)
router.post("/bookings/refund-orphaned", requireAuth, requireAdmin, async (req: any, res: any) => {
  try {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      return res.status(503).json({ error: "Razorpay not configured" });
    }

    // Optionally target a single booking
    const { bookingId, razorpayPaymentId } = req.body || {};
    const filter: Record<string, any> = {
      status: { $in: ["FAILED", "PENDING"] },
      razorpayPaymentId: { $ne: "" },
      razorpayAmount: { $gt: 0 },
    };
    if (bookingId) filter._id = bookingId;
    if (razorpayPaymentId) filter.razorpayPaymentId = razorpayPaymentId;

    const orphaned = await SBTBooking.find(filter);
    if (orphaned.length === 0) {
      return res.json({ ok: true, refunded: 0, failed: 0, details: [], message: "No orphaned bookings found" });
    }

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const details: { pnr: string; amount: number; refundId?: string; error?: string }[] = [];
    let refunded = 0;
    let failed = 0;

    for (const doc of orphaned) {
      try {
        const refundRes = await fetch(
          `https://api.razorpay.com/v1/payments/${doc.razorpayPaymentId}/refund`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Basic ${auth}`,
            },
            body: JSON.stringify({
              amount: Math.round((doc.razorpayAmount || doc.totalFare) * 100), // paise
            }),
          },
        );
        const refundData = (await refundRes.json()) as any;

        if (refundData?.id) {
          await SBTBooking.findByIdAndUpdate(doc._id, {
            status: "CANCELLED",
            refundId: refundData.id,
            refundStatus: "initiated",
            refundProcessedAt: new Date(),
            failureReason: `Payment refunded: ${refundData.id}`,
          });
          details.push({ pnr: doc.pnr, amount: doc.razorpayAmount || doc.totalFare, refundId: refundData.id });
          refunded++;
          sbtLogger.info("Flight orphan refund OK", { pnr: doc.pnr, refundId: refundData.id });
        } else {
          const errMsg = refundData?.error?.description || JSON.stringify(refundData);
          await SBTBooking.findByIdAndUpdate(doc._id, {
            failureReason: `Refund attempt failed: ${errMsg}`,
          });
          details.push({ pnr: doc.pnr, amount: doc.razorpayAmount || doc.totalFare, error: errMsg });
          failed++;
          sbtLogger.warn("Flight orphan refund failed", { pnr: doc.pnr, error: errMsg });
        }
      } catch (e: any) {
        details.push({ pnr: doc.pnr, amount: doc.razorpayAmount || doc.totalFare, error: e.message });
        failed++;
        sbtLogger.error("Flight orphan refund error", { pnr: doc.pnr, error: e.message });
      }
    }

    res.json({ ok: true, refunded, failed, details });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sbt/flights/bookings/:id — single booking detail
router.get("/bookings/:id", requireSBT, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id ?? req.user?.sub;
    const doc = await SBTBooking.findOne({ _id: req.params.id, userId }).lean();
    if (!doc) return res.status(404).json({ error: "Booking not found" });
    res.json({ ok: true, booking: doc });
  } catch (err: any) {
    sbtLogger.error("Booking detail failed", { userId: req.user?.id, bookingId: req.params.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sbt/flights/bookings/:id/cancel-preview — preview cancellation charges
router.get("/bookings/:id/cancel-preview", requireAuth, requireSBT, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id ?? req.user?.sub;
    const booking = await SBTBooking.findOne({ _id: req.params.id, userId }).lean();
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status === "CANCELLED") return res.status(400).json({ error: "Already cancelled" });

    const isPast = booking.departureTime
      ? new Date(booking.departureTime) < new Date()
      : false;

    if (isPast) {
      return res.json({ canCancel: false, reason: "Flight has already departed" });
    }

    // Read fare rules from the stored raw TBO response
    const raw = booking.raw as any;
    const fareRules: any[] =
      (booking as any).cancelPolicies?.length
        ? (booking as any).cancelPolicies
        : raw?.Response?.Response?.FlightItinerary?.FareRules
          ?? raw?.Response?.FlightItinerary?.FareRules
          ?? [];

    const totalFare = booking.totalFare || 0;
    let cancellationCharge = 0;
    let isRefundable = true;
    let policyText = "";

    const fareRuleText = fareRules
      .map((r: any) => r.FareRuleDetail || "")
      .join(" ")
      .toUpperCase();

    if (
      fareRuleText.includes("NON REFUNDABLE") ||
      fareRuleText.includes("NON-REFUNDABLE") ||
      fareRuleText.includes("NO REFUND") ||
      (booking as any).isRefundable === false
    ) {
      isRefundable = false;
      cancellationCharge = totalFare;
      policyText = "This fare is non-refundable";
    } else {
      const isLCC = booking.isLCC || false;
      cancellationCharge = isLCC
        ? Math.min(3000, totalFare)
        : Math.round(totalFare * 0.1);
      isRefundable = true;
      policyText = isLCC
        ? "LCC cancellation charges apply (approx)"
        : "Cancellation charges as per fare rules";
    }

    const refundAmount = Math.max(0, totalFare - cancellationCharge);

    return res.json({
      canCancel: true,
      isRefundable,
      cancellationCharge,
      refundAmount,
      totalFare,
      policyText,
      isPast,
      currency: booking.currency || "INR",
      ticketingStatus: booking.ticketingStatus,
      pnr: booking.pnr,
      airlineName: booking.airlineName,
    });
  } catch (err: any) {
    sbtLogger.error("Flight cancel-preview failed", { userId: req.user?.id, bookingId: req.params.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/bookings/:id/cancel — cancel a booking
router.post("/bookings/:id/cancel", requireSBT, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id ?? req.user?.sub;
    const doc = await SBTBooking.findOne({ _id: req.params.id, userId });
    if (!doc) return res.status(404).json({ error: "Booking not found" });
    if (doc.status === "CANCELLED") return res.status(400).json({ error: "Already cancelled" });

    // Call TBO CancelPNR if the booking has a real PNR and was ticketed
    if (doc.pnr && doc.bookingId && doc.ticketingStatus === "TICKETED") {
      const t0 = Date.now();
      let cancelResult: any;
      try {
        cancelResult = await cancelFlight({
          BookingId: Number(doc.bookingId) || doc.bookingId,
          PNR: doc.pnr,
        });
        logTBOCall({
          method: "CancelPNR",
          traceId: (doc as any).traceId || doc.bookingId,
          request: { BookingId: doc.bookingId, PNR: doc.pnr },
          response: cancelResult,
          durationMs: Date.now() - t0,
        });
      } catch (tboErr: any) {
        sbtLogger.error("[CancelFlight] TBO CancelPNR threw", { bookingId: doc._id, error: tboErr?.message });
        return res.status(502).json({ error: `TBO cancellation failed: ${tboErr?.message || "Unknown error"}` });
      }

      const cancelStatus = cancelResult?.Response?.ResponseStatus;
      const tboError = cancelResult?.Response?.Error?.ErrorMessage;

      if (cancelStatus !== 1) {
        sbtLogger.error("[CancelFlight] TBO returned non-success", { bookingId: doc._id, cancelStatus, tboError });
        return res.status(409).json({ error: tboError || "TBO did not confirm cancellation" });
      }

      sbtLogger.info("[CancelFlight] TBO CancelPNR success", { bookingId: doc._id, pnr: doc.pnr });
    } else {
      sbtLogger.info("[CancelFlight] Skipping TBO call — not ticketed or missing PNR", {
        bookingId: doc._id, ticketingStatus: doc.ticketingStatus, pnr: doc.pnr,
      });
    }

    // Compute cancellation charge to store (mirrors cancel-preview logic)
    const totalFare = doc.totalFare || 0;
    const raw = doc.raw as any;
    const fareRules: any[] =
      (doc as any).cancelPolicies?.length
        ? (doc as any).cancelPolicies
        : raw?.Response?.Response?.FlightItinerary?.FareRules
          ?? raw?.Response?.FlightItinerary?.FareRules
          ?? [];
    const fareRuleText = fareRules.map((r: any) => r.FareRuleDetail || "").join(" ").toUpperCase();
    const nonRefundable =
      fareRuleText.includes("NON REFUNDABLE") ||
      fareRuleText.includes("NON-REFUNDABLE") ||
      fareRuleText.includes("NO REFUND") ||
      (doc as any).isRefundable === false;
    const charge = nonRefundable
      ? totalFare
      : doc.isLCC
        ? Math.min(3000, totalFare)
        : Math.round(totalFare * 0.1);

    doc.status = "CANCELLED";
    doc.cancelledAt = new Date();
    (doc as any).cancellationCharge = charge;
    (doc as any).refundedAmount = Math.max(0, totalFare - charge);
    await doc.save();

    // Decrement spend if official booking in same calendar month
    if ((doc as any).paymentMode === "official" && (doc as any).workspaceId) {
      const bookingMonth = doc.createdAt.toISOString().slice(0, 7);
      const currentMonth = new Date().toISOString().slice(0, 7);
      if (bookingMonth === currentMonth) {
        try {
          await CustomerWorkspace.findOneAndUpdate(
            { _id: (doc as any).workspaceId },
            [{ $set: {
              "sbtOfficialBooking.currentMonthSpend": {
                $max: [0, { $subtract: ["$sbtOfficialBooking.currentMonthSpend", totalFare] }],
              },
            }}],
            { runValidators: false },
          );
          sbtLogger.info("[OfficialBooking] Spend reversed on cancellation", {
            bookingId: doc._id, amount: totalFare, workspaceId: (doc as any).workspaceId,
          });
        } catch (err) {
          sbtLogger.error("[OfficialBooking] Failed to reverse spend on cancellation", { bookingId: doc._id, error: err });
        }
      }
    }

    res.json({ ok: true, booking: doc });
  } catch (err: any) {
    sbtLogger.error("Booking cancel failed", { userId: req.user?.id, bookingId: req.params.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Re-Issuance (Reschedule) ────────────────────────────────────────────────

// GET /api/sbt/flights/bookings/:id/reissue-charges — preview reissue charges from stored MiniFareRules
router.get("/bookings/:id/reissue-charges", requireAuth, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id ?? req.user?.sub;
    const booking = await SBTBooking.findOne({ _id: req.params.id, userId }).lean();
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (!booking.isLCC) return res.status(400).json({ error: "Reissue is only supported for LCC bookings" });

    const raw = booking.raw as any;
    const miniFareRules: any[][] =
      raw?.Response?.Response?.FlightItinerary?.MiniFareRules
      ?? raw?.Response?.FlightItinerary?.MiniFareRules
      ?? [];

    const reissueRules = miniFareRules
      .flat()
      .filter((r: any) => r?.Type?.toLowerCase()?.includes("reissue") || r?.Type?.toLowerCase()?.includes("date change"));

    return res.json({
      pnr: booking.pnr,
      bookingId: booking.bookingId,
      totalFare: booking.totalFare,
      currency: booking.currency || "INR",
      reissueRules,
      hasRules: reissueRules.length > 0,
    });
  } catch (err: any) {
    sbtLogger.error("Reissue-charges failed", { bookingId: req.params.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sbt/flights/bookings/:id/reissue-search — initiate reissue search for new date
router.get("/bookings/:id/reissue-search", requireAuth, requireSBT, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id ?? req.user?.sub;
    const booking = await SBTBooking.findOne({ _id: req.params.id, userId }).lean();
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (!booking.isLCC) return res.status(400).json({ error: "Reissue is only supported for LCC bookings" });
    if (!["CONFIRMED"].includes(booking.status)) {
      return res.status(400).json({ error: "Only confirmed bookings can be reissued" });
    }
    if (booking.ticketingStatus !== "TICKETED") {
      return res.status(400).json({ error: "Booking must be ticketed before reissue" });
    }

    const departDate = (req.query.departDate as string) || "";
    if (!departDate) return res.status(400).json({ error: "departDate query param is required (YYYY-MM-DD)" });

    // Derive pax counts from stored passengers
    const passengers = (booking as any).passengers ?? [];
    let adults = 0; let children = 0; let infants = 0;
    for (const p of passengers) {
      const pt = String(p.paxType || "").toUpperCase();
      if (pt === "ADT" || pt === "1") adults++;
      else if (pt === "CHD" || pt === "2") children++;
      else if (pt === "INF" || pt === "3") infants++;
      else adults++; // default to adult
    }
    if (adults === 0) adults = 1;

    const rawData: any = (booking as any).rawResponse || (booking as any).raw || {};
    const miniFareRules = rawData?.MiniFareRules || rawData?.Results?.MiniFareRules || [];
    const reissueAllowed = miniFareRules.some((ruleSet: any[]) =>
      Array.isArray(ruleSet) && ruleSet.some((rule: any) =>
        rule?.Type === "Reissue" || rule?.OnlineReissueAllowed === true
      )
    );
    const onlineReissueAllowed = rawData?.OnlineReissueAllowed || rawData?.Results?.OnlineReissueAllowed;
    if (!reissueAllowed && !onlineReissueAllowed) {
      console.log('[REISSUE] OnlineReissueAllowed not found in raw data');
    }

    const searchResult = await reissueSearch({
      origin: booking.origin.code,
      destination: booking.destination.code,
      departDate,
      adults,
      children,
      infants,
      cabinClass: booking.cabin || 2,
      Pnr: booking.pnr,
      BookingId: booking.bookingId,
    });

    return res.json({
      searchResult,
      originalBooking: {
        _id: booking._id,
        pnr: booking.pnr,
        bookingId: booking.bookingId,
        origin: booking.origin,
        destination: booking.destination,
        departureTime: booking.departureTime,
        totalFare: booking.totalFare,
        currency: booking.currency,
        cabin: booking.cabin,
        passengers: booking.passengers,
      },
    });
  } catch (err: any) {
    sbtLogger.error("Reissue-search failed", { bookingId: req.params.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/bookings/:id/reissue-farequote — farequote for a reissue result
router.post("/bookings/:id/reissue-farequote", requireAuth, requireSBT, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id ?? req.user?.sub;
    const booking = await SBTBooking.findOne({ _id: req.params.id, userId }).lean();
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (!booking.isLCC) return res.status(400).json({ error: "Reissue is only supported for LCC bookings" });
    if (booking.ticketingStatus !== "TICKETED") {
      return res.status(400).json({ error: "Booking must be ticketed before reissue" });
    }

    const { ResultIndex, TraceId } = req.body;
    if (!ResultIndex || !TraceId) {
      return res.status(400).json({ error: "ResultIndex and TraceId are required" });
    }

    const fareQuoteResult = await getFareQuote({ TraceId, ResultIndex });
    return res.json({ fareQuoteResult, originalBooking: { pnr: booking.pnr, bookingId: booking.bookingId } });
  } catch (err: any) {
    sbtLogger.error("Reissue-farequote failed", { bookingId: req.params.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sbt/flights/bookings/:id/reissue-preview — original booking info + estimated reissue charges
router.get("/bookings/:id/reissue-preview", requireAuth, requireSBT, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id ?? req.user?.sub;
    const booking = await SBTBooking.findOne({ _id: req.params.id, userId }).lean();
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const raw = booking.raw as any;
    const miniFareRules: any[][] =
      raw?.Response?.Response?.FlightItinerary?.MiniFareRules
      ?? raw?.Response?.FlightItinerary?.MiniFareRules
      ?? [];
    const reissueRules = miniFareRules
      .flat()
      .filter((r: any) => r?.Type?.toLowerCase()?.includes("reissue") || r?.Type?.toLowerCase()?.includes("date change"));

    const reissueCharges = reissueRules.reduce(
      (sum: number, r: any) => sum + Number(r?.StructuredFare?.Amount ?? r?.Amount ?? 0),
      0,
    );

    return res.json({
      originalBooking: {
        pnr: booking.pnr,
        paidFare: booking.totalFare,
        paymentMode: (booking as any).paymentMode === "official" ? "WALLET" : "GATEWAY",
        segments: [{
          originCode: booking.origin.code,
          origin: booking.origin.city,
          destCode: booking.destination.code,
          destination: booking.destination.city,
          departureTime: booking.departureTime,
        }],
        passengers: booking.passengers,
      },
      reissueCharges,
    });
  } catch (err: any) {
    sbtLogger.error("Reissue-preview failed", { bookingId: req.params.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/bookings/:id/reissue-order — create Razorpay order for price difference
router.post("/bookings/:id/reissue-order", requireAuth, requireSBT, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id ?? req.user?.sub;
    const booking = await SBTBooking.findOne({ _id: req.params.id, userId }).lean();
    if (!booking) return res.status(404).json({ error: "Booking not found" });

    const { priceDiff } = req.body;
    if (!priceDiff || Number(priceDiff) <= 0) {
      return res.status(400).json({ error: "Invalid price difference — must be positive" });
    }

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) return res.status(503).json({ error: "Payment gateway not configured" });

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const orderRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${auth}` },
      body: JSON.stringify({
        amount: Math.round(Number(priceDiff) * 100),
        currency: "INR",
        receipt: `reissue_${req.params.id}_${Date.now()}`,
      }),
    });
    const order = await orderRes.json() as any;
    if (!orderRes.ok) {
      return res.status(502).json({ error: order?.error?.description || "Razorpay order creation failed" });
    }
    res.json({ ok: true, orderId: order.id, amount: order.amount, currency: order.currency, keyId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Reissue order creation failed";
    res.status(500).json({ error: msg });
  }
});

// POST /api/sbt/flights/bookings/:id/reissue — execute reissue (TicketReissue)
router.post("/bookings/:id/reissue", requireAuth, requireSBT, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id ?? req.user?.sub;
    const workspaceId = (req as any).workspace?._id ?? (req.user as any)?.workspaceId;
    const doc = await SBTBooking.findOne({ _id: req.params.id, userId });
    if (!doc) return res.status(404).json({ error: "Booking not found" });
    if (!doc.isLCC) return res.status(400).json({ error: "Reissue is only supported for LCC bookings" });
    if (!["CONFIRMED"].includes(doc.status)) {
      return res.status(400).json({ error: "Only confirmed bookings can be reissued" });
    }
    if (doc.ticketingStatus !== "TICKETED") {
      return res.status(400).json({ error: "Booking must be ticketed before reissue" });
    }

    const { ResultIndex, TraceId, paymentMode, razorpayPaymentId, razorpayOrderId, razorpaySignature, priceDiff } = req.body;
    if (!ResultIndex || !TraceId) {
      return res.status(400).json({ error: "ResultIndex and TraceId are required" });
    }

    // Use full passenger data from original booking (stored at ticket time)
    const fullPassengers: any[] = (doc as any).passengers || [];
    const leadPax = fullPassengers.find((p: any) => p.isLead) || fullPassengers[0];
    const leadContactNo = leadPax?.contactNo || leadPax?.phone || doc.contactPhone || "";
    const leadEmail = leadPax?.email || doc.contactEmail || "";

    const tboPassengers = fullPassengers.map((p: any) => {
      const pt = String(p.paxType || "adult").toLowerCase();
      const paxTypeNum = pt === "adult" || pt === "1" ? 1 : pt === "child" || pt === "2" ? 2 : pt === "infant" || pt === "3" ? 3 : 1;
      return {
        Title: p.title || "Mr",
        FirstName: p.firstName || "",
        LastName: p.lastName || "",
        PaxType: paxTypeNum,
        IsLeadPax: p.isLead || false,
        ContactNo: p.contactNo || p.phone || leadContactNo,
        Email: p.email || leadEmail,
        DateOfBirth: p.dob || p.dateOfBirth || "",
        PassportNo: p.passportNo || "",
        PassportExpiry: p.passportExpiry || "",
        PassportIssueDate: p.passportIssueDate || "",
        Nationality: p.nationality || "IN",
        AddressLine1: p.address || "India",
        AddressLine2: "",
        City: p.city || "Delhi",
        CountryCode: p.countryCode || "IN",
        CountryName: p.countryName || "India",
        CellCountryCode: p.cellCountryCode || "+91",
        Fare: {
          BaseFare: p.fare?.BaseFare || 0,
          Tax: p.fare?.Tax || 0,
          YQTax: p.fare?.YQTax || 0,
          AdditionalTxnFeeOfrd: p.fare?.AdditionalTxnFeeOfrd || 0,
          AdditionalTxnFeePub: p.fare?.AdditionalTxnFeePub || 0,
          OtherCharges: p.fare?.OtherCharges || 0,
          SupplierReissueCharges: 0,
        },
        SSR_Meal: [],
        SSR_Baggage: [],
        SSR_MealDynamic: [],
        SSR_SeatPref: [],
        SeatDynamic: [],
      };
    });

    if (tboPassengers.length === 0) {
      return res.status(400).json({ error: "No passenger data found for this booking" });
    }

    const numericPriceDiff = Number(priceDiff ?? 0);

    // ── Payment handling for reissue ──────────────────────────────────
    if (numericPriceDiff > 0 && paymentMode) {
      if (paymentMode === "GATEWAY") {
        if (!razorpayPaymentId || !razorpayOrderId || !razorpaySignature) {
          return res.status(400).json({ error: "Payment details required for gateway payment" });
        }
        const keySecret = process.env.RAZORPAY_KEY_SECRET;
        if (!keySecret) return res.status(503).json({ error: "Payment gateway not configured" });
        const { createHmac } = await import("crypto");
        const expectedSig = createHmac("sha256", keySecret)
          .update(`${razorpayOrderId}|${razorpayPaymentId}`)
          .digest("hex");
        if (expectedSig !== razorpaySignature) {
          return res.status(400).json({ error: "Payment verification failed — signature mismatch" });
        }
      } else if (paymentMode === "WALLET") {
        const wsId = workspaceId ?? (doc as any).workspaceId;
        const workspace = await CustomerWorkspace.findById(wsId).lean();
        const ob = (workspace as any)?.sbtOfficialBooking;
        if (!ob?.enabled) {
          return res.status(400).json({ error: "Official booking (wallet) is not enabled for this workspace" });
        }
        const monthKey = new Date().toISOString().slice(0, 7);
        let currentSpend = ob.currentMonthSpend ?? 0;
        if (ob.lastResetMonth !== monthKey) currentSpend = 0;
        const monthlyLimit = ob.monthlyLimit ?? 0;
        if (monthlyLimit > 0 && currentSpend + numericPriceDiff > monthlyLimit) {
          return res.status(400).json({ error: "This reissue would exceed your monthly travel limit" });
        }
        await CustomerWorkspace.findOneAndUpdate(
          { _id: wsId },
          { $inc: { "sbtOfficialBooking.currentMonthSpend": numericPriceDiff } },
          { runValidators: false },
        );
      }
    }

    // Extract TicketData from the original booking's raw TBO response if available
    const raw = doc.raw as any;
    const itinerary = raw?.Response?.Response?.FlightItinerary ?? raw?.Response?.FlightItinerary;
    const ticketData = {
      TourCode: itinerary?.TourCode || "",
      Endorsement: itinerary?.Endorsement || "",
      CorporateCode: itinerary?.CorporateCode || "",
      AgentDealCode: itinerary?.AgentDealCode || "",
    };

    const t0 = Date.now();
    const reissueResult = await ticketReissue({ TraceId, ResultIndex, Passengers: tboPassengers, TicketData: ticketData }) as any;
    logTBOCall({
      method: "TicketReissue",
      traceId: TraceId,
      request: { TraceId, ResultIndex, BookingId: doc.bookingId, PNR: doc.pnr },
      response: reissueResult,
      durationMs: Date.now() - t0,
    });

    const respStatus = reissueResult?.Response?.ResponseStatus ?? reissueResult?.Response?.Response?.ResponseStatus;
    if (respStatus !== 1) {
      const tboErr = reissueResult?.Response?.Error?.ErrorMessage
        ?? reissueResult?.Response?.Response?.Error?.ErrorMessage
        ?? "Reissue failed from supplier side";
      sbtLogger.error("TicketReissue TBO error", { bookingId: doc._id, tboErr });
      return res.status(400).json({ error: tboErr, tboStatus: respStatus });
    }

    const inner = reissueResult?.Response?.Response ?? reissueResult?.Response;
    const newPnr = inner?.PNR ?? inner?.FlightItinerary?.PNR ?? doc.pnr;
    const newBookingId = String(inner?.BookingId ?? inner?.FlightItinerary?.BookingId ?? "");
    const newItinerary = inner?.FlightItinerary ?? {};

    // Mark original booking as reissued
    const originalPNR = doc.pnr;
    doc.status = "REISSUED" as any;
    (doc as any).isReissued = true;
    await doc.save();

    // Create new booking record for the reissued ticket
    const newBookingData: Record<string, unknown> = {
      userId: doc.userId,
      workspaceId: workspaceId ?? (doc as any).workspaceId,
      traceId: TraceId,
      pnr: newPnr,
      bookingId: newBookingId,
      ticketId: newBookingId,
      isReturn: false,
      status: "CONFIRMED",
      origin: doc.origin,
      destination: doc.destination,
      departureTime: newItinerary.Segments?.[0]?.[0]?.Origin?.DepTime ?? doc.departureTime,
      arrivalTime: newItinerary.Segments?.[0]?.[0]?.Destination?.ArrTime ?? doc.arrivalTime,
      airlineCode: doc.airlineCode,
      airlineName: doc.airlineName,
      flightNumber: doc.flightNumber,
      cabin: doc.cabin,
      passengers: doc.passengers,
      contactEmail: doc.contactEmail,
      contactPhone: doc.contactPhone,
      baseFare: Number(inner?.Fare?.BaseFare ?? doc.baseFare),
      taxes: Number(inner?.Fare?.Tax ?? doc.taxes),
      extras: 0,
      totalFare: Number(inner?.Fare?.TotalFare ?? doc.totalFare),
      currency: doc.currency,
      isLCC: true,
      ticketingStatus: "TICKETED",
      paymentMode: (doc as any).paymentMode || "personal",
      reissuePaymentMode: paymentMode === "GATEWAY" || paymentMode === "WALLET" ? paymentMode : undefined,
      reissuedFromBookingId: doc._id,
      isReissued: false,
      originalPNR,
      raw: reissueResult,
      bookedAt: new Date(),
    };

    const newBooking = new SBTBooking(newBookingData);
    await newBooking.save();

    sbtLogger.info("Reissue complete", {
      originalBookingId: doc._id, originalPNR, newPnr, newBookingId,
    });

    return res.json({ ok: true, newBooking, originalBookingId: doc._id });
  } catch (err: any) {
    sbtLogger.error("Reissue failed", { bookingId: req.params.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ─── Razorpay Payment ───────────────────────────────────────────────────────

// POST /api/sbt/flights/payment/create-order
router.post("/payment/create-order", requireAuth, async (req: any, res: any) => {
  try {
    const { amount, currency = "INR", receipt } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: "Invalid amount" });

    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      return res.status(503).json({ error: "Payment gateway not configured" });
    }

    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const orderRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify({
        amount: Math.round(amount * 100), // paise
        currency,
        receipt: receipt || `sbt_${Date.now()}`,
      }),
    });
    const order = await orderRes.json() as any;
    if (!orderRes.ok) {
      return res.status(502).json({ error: order?.error?.description || "Razorpay order creation failed" });
    }
    res.json({ ok: true, orderId: order.id, amount: order.amount, currency: order.currency, keyId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Payment order creation failed";
    res.status(500).json({ error: msg });
  }
});

// POST /api/sbt/flights/payment/verify
router.post("/payment/verify", requireAuth, async (req: any, res: any) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: "Missing payment verification fields" });
    }

    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) {
      return res.status(503).json({ error: "Payment gateway not configured" });
    }

    const { createHmac } = await import("crypto");
    const expectedSignature = createHmac("sha256", keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Payment verification failed — signature mismatch" });
    }

    res.json({ ok: true, verified: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Payment verification failed";
    res.status(500).json({ error: msg });
  }
});

// GET /api/sbt/flights/offer — public-ish (auth only, no admin) offer config for tickets
router.get("/offer", async (_req: any, res: any) => {
  try {
    const doc = await SBTConfig.findOne({ key: "offer" }).lean();
    if (!doc) return res.json({ ok: true, enabled: false });
    res.json({ ok: true, ...((doc.value as any) ?? {}), enabled: (doc.value as any)?.enabled ?? false });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
