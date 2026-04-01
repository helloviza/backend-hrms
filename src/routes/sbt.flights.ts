import express from "express";
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
import { scopedFindById } from "../middleware/scopedFindById.js";
import { requireFeature } from "../middleware/requireFeature.js";
import { sendMail } from "../utils/mailer.js";
import { clearTBOToken, logoutTBO, getTBOTokenStatus, getAgencyBalance, getTBOToken } from "../services/tbo.auth.service.js";
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
  getPriceRBD,
  isNDCFlight,
} from "../services/tbo.flight.service.js";
import { consolidateCertificationLogs } from "../services/tbo.log.consolidator.js";

const router = express.Router();

/* ── Duplicate booking prevention (24-hour window) ─────────────────────── */
async function checkDuplicateBooking(params: {
  userId: string;
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

// ─── SBT access guard ────────────────────────────────────────────────────────
// Verifies the user has sbtEnabled=true in the DB.
// Admin/SuperAdmin/HR users bypass this check so they can always inspect SBT data.
async function requireSBT(req: any, res: any, next: any) {
  try {
    const roles: string[] = (req.user?.roles || []).map((r: string) =>
      String(r).toUpperCase()
    );
    if (roles.includes("ADMIN") || roles.includes("SUPERADMIN") || roles.includes("HR")) {
      return next();
    }

    const userId = req.user?.id || req.user?._id;
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const user = await User.findOne({ _id: userId, workspaceId: req.workspaceObjectId }).select("sbtEnabled").lean();
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
    const roles: string[] = (req.user?.roles || []).map((r: string) =>
      String(r).toUpperCase()
    );
    if (roles.includes("ADMIN") || roles.includes("SUPERADMIN") || roles.includes("HR")) {
      return next();
    }

    const userId = req.user?.id || req.user?._id;
    const user = await User.findOne({ _id: userId, workspaceId: req.workspaceObjectId })
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
    const firstDay = `${month}-01T00:00:00`;
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
    const result: any = await searchFlights({ ...rest, JourneyType: jt as 1 | 2 | 4 | 5, Sources: resolvedSources });

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
    res.json({
      ...result,
      isPriceChanged: fareResults?.IsPriceChanged || false,
      isTimeChanged: fareResults?.IsTimeChanged || false,
      flightDetailChangeInfo: fareResults?.FlightDetailChangeInfo || null,
      isseatmandatory: fareResults?.isseatmandatory || false,
      ismealmandatory: fareResults?.ismealmandatory || false,
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
        originCode: req.body?.originCode || "",
        destinationCode: req.body?.destinationCode || "",
        departureDate: req.body?.departureDate || "",
        airlineCode: bookAirlineCode,
        flightNumber: req.body.flightNumber,
        passengerNames: paxNames,
      });
      if (dupErr) return res.status(409).json({ error: dupErr, code: "DUPLICATE_BOOKING" });
    }

    const data = await bookFlight({ ...req.body, isNDC: bookIsNDC, airlineCode: bookAirlineCode, destinationCode: req.body?.destinationCode }) as any;

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
router.get("/booking/:id", requireAuth, async (req: any, res: any) => {
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

    const lccIsInternational = req.body.isInternational ?? lccIsIntl;
    const lccSegments = lccFareResults?.Segments ?? req.body.Segments ?? [];
    const lccFreeBaggage = (req.body.FreeBaggage ?? []).filter((b: any) => b.Price === 0);
    const lccAirlineCode = ticketAirlineCode || req.body?.airlineCode || "";
    const lccDestCode = req.body?.destinationCode || "";

    // Convert SeatPreference → SeatDynamic if frontend sent old format
    function convertSeatPreferences(passengers: any[]) {
      for (const pax of passengers) {
        if (pax.SeatPreference && !pax.SeatDynamic) {
          const items = Array.isArray(pax.SeatPreference) ? pax.SeatPreference : [pax.SeatPreference];
          pax.SeatDynamic = items.map((sp: any) => ({
            SegmentSeat: [{
              RowSeats: [{
                Seats: [{
                  AirlineCode: sp.AirlineCode || "",
                  FlightNumber: sp.FlightNumber || "",
                  CraftType: sp.CraftType || "",
                  Origin: sp.Origin || "",
                  Destination: sp.Destination || "",
                  AvailablityType: 0,
                  Description: 2,
                  Code: sp.Code || "",
                  RowNo: sp.RowNo || (sp.Code?.replace(/[A-Z]/gi, "") || "0"),
                  SeatNo: sp.Code || null,
                  SeatType: sp.SeatType || 0,
                  SeatWayType: sp.WayType || 2,
                  Compartment: 0,
                  Deck: 0,
                  Currency: sp.Currency || "INR",
                  Price: sp.Price || 0,
                }],
              }],
            }],
          }));
          delete pax.SeatPreference;
        }
      }
    }

    const obPassengers: any[] = req.body?.Passengers ?? [];
    convertSeatPreferences(obPassengers);

    // ── Special Return: single ticketLCC call, TBO returns one PNR for both legs ──
    if (isSpecialReturn && isReturn) {

      const result = await ticketLCC({
        TraceId: req.body.TraceId,
        ResultIndex: req.body.ResultIndex,
        Passengers: obPassengers,
        IsPriceChangedAccepted: true,
        isNDC: ticketIsNDC,
        isInternational: lccIsInternational,
        airlineCode: lccAirlineCode,
        destinationCode: lccDestCode,
        Segments: lccSegments,
        FreeBaggage: lccFreeBaggage,
        ...(req.body.GSTCompanyInfo ? { GSTCompanyInfo: req.body.GSTCompanyInfo } : {}),
        ...(req.body.IsGSTMandatory != null ? { IsGSTMandatory: req.body.IsGSTMandatory } : {}),
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
        IsPriceChangedAccepted: true,
        isNDC: ticketIsNDC,
        isInternational: lccIsInternational,
        airlineCode: lccAirlineCode,
        destinationCode: lccDestCode,
        Segments: lccSegments,
        FreeBaggage: lccFreeBaggage,
        ...(req.body.GSTCompanyInfo ? { GSTCompanyInfo: req.body.GSTCompanyInfo } : {}),
        ...(req.body.IsGSTMandatory != null ? { IsGSTMandatory: req.body.IsGSTMandatory } : {}),
      };
      let obResult = await ticketLCC(obPayload) as any;

      // Retry without meals/baggage if TBO rejects meal data (expired SSR session)
      const obErr = obResult?.Response?.Error?.ErrorMessage
        ?? obResult?.Response?.Response?.Error?.ErrorMessage ?? "";
      if (obResult?.Response?.ResponseStatus !== 1 && (/invalid meal/i.test(obErr) || /meal.*mandatory/i.test(obErr) || /mandatory.*meal/i.test(obErr))) {
        sbtLogger.info('[TICKET-LCC] OB "Invalid Meal" — retrying without meals/baggage');
        const obPassengersNoMeal = obPassengers.map((p: any) => ({
          ...p, MealDynamic: [], Baggage: [],
        }));
        obResult = await ticketLCC({
          ...obPayload,
          Passengers: obPassengersNoMeal,
          FreeBaggage: [],
        }) as any;
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
          IsPriceChangedAccepted: true,
          isNDC: ticketIsNDC,
          isInternational: lccIsInternational,
          airlineCode: lccAirlineCode,
          destinationCode: req.body?.returnDestinationCode || lccDestCode,
          Segments: ibSegments,
          FreeBaggage: ibFreeBaggage,
          ...(req.body.GSTCompanyInfo ? { GSTCompanyInfo: req.body.GSTCompanyInfo } : {}),
          ...(req.body.IsGSTMandatory != null ? { IsGSTMandatory: req.body.IsGSTMandatory } : {}),
        };
        ibResult = await ticketLCC(ibPayload) as any;

        // Retry without meals/baggage if TBO rejects meal data
        const ibErr = ibResult?.Response?.Error?.ErrorMessage
          ?? ibResult?.Response?.Response?.Error?.ErrorMessage ?? "";
        if (ibResult?.Response?.ResponseStatus !== 1 && (/invalid meal/i.test(ibErr) || /meal.*mandatory/i.test(ibErr) || /mandatory.*meal/i.test(ibErr))) {
          sbtLogger.info('[TICKET-LCC] IB "Invalid Meal" — retrying without meals/baggage');
          const ibPassengersNoMeal = ibPassengers.map((p: any) => ({
            ...p, MealDynamic: [], Baggage: [],
          }));
          ibResult = await ticketLCC({
            ...ibPayload,
            Passengers: ibPassengersNoMeal,
            FreeBaggage: [],
          }) as any;
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
    }) as any;

    // Retry without meals/baggage if TBO rejects meal data
    const onewayErr = result?.Response?.Error?.ErrorMessage
      ?? result?.Response?.Response?.Error?.ErrorMessage ?? "";
    if (
      result?.Response?.ResponseStatus !== 1 &&
      (/invalid meal/i.test(onewayErr) || /meal.*mandatory/i.test(onewayErr) || /mandatory.*meal/i.test(onewayErr))
    ) {
      sbtLogger.info('[TICKET-LCC] One-way meal error — retrying without meals/baggage');
      const passengersNoMeal = (req.body.Passengers ?? []).map((p: any) => {
        const { MealDynamic, Baggage, ...rest } = p;
        return rest;
      });
      result = await ticketLCC({
        ...req.body,
        Passengers: passengersNoMeal,
        isInternational: lccIsInternational,
        Segments: lccSegments,
        FreeBaggage: [],
      }) as any;
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
    const result = await getBookingDetailsByPNR({
      PNR: req.params.pnr,
      FirstName: req.query.firstName || "",
      LastName: req.query.lastName || "",
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Booking persistence routes ──────────────────────────────────────────────

// POST /api/sbt/flights/bookings/save — persist a confirmed booking
router.post("/bookings/save", requireAuth, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const b = req.body;

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

    const doc = await SBTBooking.create({
      userId,
      customerId: (req.user as any)?.customerId ?? undefined,
      sbtRequestId: b.sbtRequestId || undefined,
      workspaceId: req.workspaceObjectId,
      traceId: b.traceId || "",
      pnr: b.pnr || `MOCK-${Date.now()}`,
      bookingId: b.bookingId || `BK-${Date.now()}`,
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
      raw: b.raw,
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
          const requester = await User.findOne({ _id: sbtReq.requesterId, workspaceId: req.workspaceObjectId })
            .select("name email").lean() as any;
          if (requester?.email) {
            const frontendUrl = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
            await sendMail({
              to: requester.email,
              subject: `Your flight has been booked — PNR ${doc.pnr}`,
              kind: "CONFIRMATIONS",
              html: `
                <h3>Booking Confirmed</h3>
                <p>Your flight request has been booked successfully.</p>
                <p><strong>PNR:</strong> ${doc.pnr}</p>
                <p><strong>Route:</strong> ${b.origin?.city || ""} → ${b.destination?.city || ""}</p>
                <p><strong>Departure:</strong> ${b.departureTime || ""}</p>
                <p><a href="${frontendUrl}/sbt/my-requests">View My Requests</a></p>
              `,
            }).catch((e: any) => sbtLogger.warn("Failed to send SBT booked email", { error: e?.message }));
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
    const userId = req.user?._id ?? req.user?.id;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    const bookings = await SBTBooking.find({ userId }).sort({ createdAt: -1 }).lean();
    res.json({ ok: true, bookings });
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
    const userId = req.user?._id ?? req.user?.id;
    const doc = await SBTBooking.findOne({ _id: req.params.id, userId }).lean();
    if (!doc) return res.status(404).json({ error: "Booking not found" });
    res.json({ ok: true, booking: doc });
  } catch (err: any) {
    sbtLogger.error("Booking detail failed", { userId: req.user?.id, bookingId: req.params.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sbt/flights/bookings/:id/cancel-charges — estimate cancellation charges
router.get("/bookings/:id/cancel-charges", requireAuth, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id;
    const doc = await SBTBooking.findOne({ _id: req.params.id, userId }).lean();
    if (!doc) return res.status(404).json({ error: "Booking not found" });
    if (doc.status === "CANCELLED") return res.status(400).json({ error: "Already cancelled" });

    // Estimate: cancellation fee is ~15% of base fare (placeholder logic)
    const cancellationFee = Math.round(doc.baseFare * 0.15);
    const refundAmount = Math.max(0, doc.totalFare - cancellationFee);
    res.json({
      ok: true,
      bookingId: doc.bookingId,
      pnr: doc.pnr,
      cancellationFee,
      refundAmount,
      currency: doc.currency,
    });
  } catch (err: any) {
    sbtLogger.error("Cancel charges failed", { userId: req.user?.id, bookingId: req.params.id, error: err.message });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sbt/flights/bookings/:id/cancel — cancel a booking
router.post("/bookings/:id/cancel", requireSBT, async (req: any, res: any) => {
  try {
    const userId = req.user?._id ?? req.user?.id;
    const doc = await SBTBooking.findOne({ _id: req.params.id, userId });
    if (!doc) return res.status(404).json({ error: "Booking not found" });
    if (doc.status === "CANCELLED") return res.status(400).json({ error: "Already cancelled" });

    doc.status = "CANCELLED";
    doc.cancelledAt = new Date();
    await doc.save();

    // Decrement spend if official booking in same calendar month
    if ((doc as any).paymentMode === 'official' && (doc as any).workspaceId) {
      const bookingMonth = doc.createdAt.toISOString().slice(0, 7);
      const currentMonth = new Date().toISOString().slice(0, 7);
      if (bookingMonth === currentMonth) {
        try {
          await CustomerWorkspace.findOneAndUpdate(
            { _id: (doc as any).workspaceId },
            [{ $set: {
              'sbtOfficialBooking.currentMonthSpend': {
                $max: [0, { $subtract: ['$sbtOfficialBooking.currentMonthSpend', (doc as any).totalFare || 0] }],
              },
            }}],
            { runValidators: false },
          );
          sbtLogger.info('[OfficialBooking] Spend reversed on cancellation', {
            bookingId: doc._id,
            amount: (doc as any).totalFare,
            workspaceId: (doc as any).workspaceId,
          });
        } catch (err) {
          sbtLogger.error('[OfficialBooking] Failed to reverse spend on cancellation', {
            bookingId: doc._id,
            error: err,
          });
        }
      }
    }

    res.json({ ok: true, booking: doc });
  } catch (err: any) {
    sbtLogger.error("Booking cancel failed", { userId: req.user?.id, bookingId: req.params.id, error: err.message });
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
