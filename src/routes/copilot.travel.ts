// apps/backend/src/routes/copilot.travel.ts

import { Router } from "express";
import { Types } from "mongoose";
import crypto from "crypto";
import { optionalAuth } from "../middleware/optionalAuth.js";
// requireAuth is applied at the mount (server.ts) for the whole router, so no
// route in this file re-declares it. requireWorkspace is likewise mount-applied;
// it is kept on /raise-request only as a defensive local guard.
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import VideoAnalysis from "../models/VideoAnalysis.js";
import { invokePluto } from "../utils/plutoInvoke.js";

import { isOffDomainQuery, buildOffDomainRedirect } from "../utils/plutoIntentGuard.js";
import { classifyPlutoIntent } from "../utils/plutoIntentClassifier.js";
import { resolvePlutoState } from "../utils/plutoStateResolver.js";
import { lockDecisions } from "../utils/plutoDecisionLocker.js";
import { reduceToDelta } from "../utils/plutoDeltaReducer.js";
import { isHandoffReady } from "../utils/plutoHandoffEvaluator.js";

import { buildHandoffPayload } from "../utils/plutoHandoffBuilder.js";
import { sendHandoffPayload, legacyCustomerIdOf } from "../utils/plutoHandoffSink.js";

import { emitPlutoDebug } from "../utils/plutoDebugSink.js";

import type { PlutoDeltaReply } from "../types/plutoDelta.js";
import type { PlutoReplyV1 } from "../types/pluto.js";
import type { PlutoConversationState } from "../types/plutoConversationState.js";

// Memory & Gemini Imports
import {
  getConversationContext,
  saveConversationContext,
  claimHandoffDelivery,
  releaseHandoffDelivery,
  loadConversationForUser,
} from "../utils/plutoMemory.js";
import {
  isStateV2Enabled,
  FLIGHT_ROWS_FRESH_MS,
  parseFlightRefinement,
  mergeFlightFilters,
  applyFlightFilters,
  describeFlightFilters,
  flightFilterWords,
  matchXToYRoute,
  parseParkTask,
  isResumeFlights,
  projectForClient,
  type FlightFilters,
} from "../utils/plutoTurnState.js";
import {
  stripFiller,
  parseTripEdit,
  tripEditBranch,
  parseStayAnswer,
  resolveStayWindow,
  roomsFor,
  nearLabel,
  stayLabel,
  dayLabel,
  addDaysISO,
  nightsBetweenISO,
} from "../utils/plutoTripEdit.js";
import { invokePlutoGemini, GEMINI_FALLBACK_INVALID } from "../utils/plutoGeminiInvoke.js";
import { parseBudget, describeBudget } from "../utils/plutoBudget.js";
import {
  PLUTO_AI_SYSTEM_PROMPT as PLUTO_SYSTEM_PROMPT,
} from "../prompts/plutoSystemPrompt.js";
import {
  getFlightOccurrences,
  isFlightLookupError,
} from "../services/flightService.js";

import { searchFlights as tboSearchFlights } from "../services/tbo.flight.service.js";
import { searchHotels, isHotelSearchError } from "../services/tbo.hotel.search.service.js";
import { sellingFlight, customerHotelResults } from "../services/sbtQuote.js";
import { flightRouteMargins } from "../services/sbtMargin.js";
import {
  CABIN_LABELS,
  mapTBOFlight,
  searchFlightsForChat,
  splitLegRows,
  withAirportFields,
} from "../utils/plutoFlightSearch.js";
import { airportLabel } from "../utils/plutoAirportMatch.js";
import { parseDateToISO, extractPromptDateRange, resolveRelativeDate } from "../utils/plutoDate.js";
import {
  mentionsOffice,
  mentionsNearMe,
  isOfficePlace,
  resolveOfficeCity,
  suggestCurrentCity,
  suggestFlightOrigin,
  flightOriginChip,
  officeDisclosure,
  parseCityAnswer,
  spliceFlightAnswer,
  OFFICE_ASK_TEXT,
  OFFICE_ASK_CHIP,
  OTHER_CITY_CHIP,
  FLIGHT_ORIGIN_ASK_CHIP,
} from "../utils/plutoUserLocation.js";
import {
  isHotelRequest,
  extractHotelCity,
  extractNamedPlaceCandidate,
  extractStarFilter,
  searchHotelsForChat,
  nightsBetween,
  resolveHotelSearchWindow,
} from "../utils/plutoHotelSearch.js";
import {
  resolveHotelDestination,
  type HotelDestination,
} from "../utils/plutoHotelDestination.js";
import { countryFor, lookupDestination } from "../data/destinationLookup.js";
import {
  extractFlightDesignator,
  extractStatusDate,
  isFlightStatusQuery,
} from "../utils/flightDesignator.js";
import { isMultiCityIntent, resolveRoundTripIntent } from "../utils/plutoTripIntent.js";
import { resolveIATA } from "../utils/plutoIata.js";
import { loadWorkspacePolicyRules } from "../services/policyService.js";
import { renderTripSummaryHtml } from "../services/conciergeHandoff.js";
import { recordFareObservations } from "../services/fareObservations.js";
import { getRouteIntelProvider } from "../services/routeIntel.provider.js";
import { isValidWhatsAppNumber } from "../utils/waNumber.js";
import { getDestinationWeather } from "../services/weatherService.js";
import {
  evaluateFlightPolicy,
  evaluateHotelPolicy,
  flightForPolicyFromTBO,
  hotelForPolicyFromResult,
  type PolicyRules,
} from "../services/policyEvaluator.js";

// Whole nights between two ISO dates; 0 when unparseable (per-night price then
// left null so hotel price rules don't fire on bad data).
function hotelNights(checkIn?: string, checkOut?: string): number {
  if (!checkIn || !checkOut) return 0;
  const a = new Date(checkIn).getTime();
  const b = new Date(checkOut).getTime();
  if (isNaN(a) || isNaN(b) || b <= a) return 0;
  return Math.round((b - a) / 86400000);
}

// Plain-language "clear why" copy when zero live flights are in policy.
function buildZeroInPolicyNote(rules: PolicyRules): string {
  if (rules.maxFlightPriceINR != null) {
    return `All options exceed your company's ₹${rules.maxFlightPriceINR.toLocaleString("en-IN")} flight cap — showing them anyway; approval will be required.`;
  }
  if (rules.approvalAbovePriceINR != null) {
    return `All options are above your company's ₹${rules.approvalAbovePriceINR.toLocaleString("en-IN")} approval threshold — showing them anyway; approval will be required.`;
  }
  return "None of these options are within your company travel policy — showing them anyway; approval may be required.";
}
import SBTRequest from "../models/SBTRequest.js";
import TripWatch from "../models/TripWatch.js";
import TripAlert from "../models/TripAlert.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import User from "../models/User.js";
import Itinerary from "../models/Itinerary.js";
import { assembleItinerary, type ItineraryItemInput } from "../services/itineraryAssembly.js";
import { sendMail } from "../utils/mailer.js";
import { scopedFindById } from "../middleware/scopedFindById.js";

// ✅ VIDEO CONTEXT ADAPTER (AUTHORITATIVE)
import {
  attachVideoContext,
} from "../services/video/videoContextAdapter.js";

import {
  conversationStarted,
  stateTransition,
  handoffTriggered,
  multicityDowngraded,
  searchError,
  aiFallback,
  aiError,
  aiFallbackInvalid,
  policyEvaluated,
  routeInsightsServed,
  handoffDelivered,
  handoffFailed,
  replyThinAccepted,
  replyReaskedLocked,
  turnBranch,
} from "../utils/plutoMetricsBuilder.js";
import { emitMetric } from "../utils/plutoMetricsSink.js";
import { personName } from "../services/actorNames.js";

// CABIN_LABELS, mapTBOFlight, splitLegRows (dedupe + airport split + cap) and
// searchFlightsForChat live in ../utils/plutoFlightSearch.ts (extracted for
// unit-testability); the hardened /flights/search path uses the same helpers.

const router = Router();

// ✅ PHASE 4 — VIDEO CONSENT ROUTE (TOP-LEVEL, AUTHORITATIVE)
// Auth + workspace are enforced at the mount (server.ts) — see requireAuth,
// requireWorkspace, requireFeature("sbtEnabled") on /api/v1/copilot/travel.
router.post(
  "/video/:videoId/consent",
  async (req, res) => {
    try {
      const { videoId } = req.params;
      const { consent } = req.body;

      if (!Types.ObjectId.isValid(videoId)) {
        return res.status(400).json({
          ok: false,
          message: "Invalid video id",
        });
      }

      if (!["yes", "no"].includes(consent)) {
        return res.status(400).json({
          ok: false,
          message: "Consent must be 'yes' or 'no'",
        });
      }

      const video = await scopedFindById(VideoAnalysis, videoId, (req as any).workspaceObjectId);
      if (!video) {
        return res.status(404).json({
          ok: false,
          message: "Video not found",
        });
      }

      // 🔒 Must be analyzed
      if (video.status !== "analyzed") {
        return res.json({
          ok: true,
          reply: {
            title: "Video still processing",
            context: "Please wait a moment.",
          },
        });
      }

      // 🔒 Must be travel
      if (video.classification !== "confirmed-travel") {
        return res.json({
          ok: true,
          reply: {
            title: "Planning unavailable",
            context:
              "This video doesn't contain enough travel signals to plan a trip.",
          },
        });
      }

      // Persist consent
      video.userConsent = consent;
      await video.save();

      // ❌ User declined
      if (consent === "no") {
        return res.json({
          ok: true,
          reply: {
            title: "Got it 👍",
            context:
              "I won't plan a trip from this video. You can still ask questions.",
            nextSteps: [],
          },
        });
      }

      // ✅ User accepted — PATCH CONTEXT (THIS IS THE KEY)
      return res.json({
        ok: true,
        readyForPlanning: true,

        // 🔑 THIS FIXES "Awaiting destination"
        contextPatch: {
          locked: {
            destination:
              video.insights?.destinations?.[0]
                ? {
                    name: video.insights.destinations[0].city
                      ? `${video.insights.destinations[0].city}, ${video.insights.destinations[0].country}`
                      : video.insights.destinations[0].country,
                    source: "video",
                    confidence: video.insights.destinations[0].confidence,
                  }
                : undefined,

            duration: video.insights?.idealDays
              ? {
                  days: video.insights.idealDays,
                  source: "video",
                }
              : undefined,

            tripStyle: video.insights?.tripStyle
              ? {
                  value: video.insights.tripStyle,
                  source: "video",
                }
              : undefined,
          },
        },

        reply: {
          title: "Great — I'll plan this trip for you",
          context:
            "I've locked key details from the video. You can now refine budget, dates, or pace.",
          nextSteps: [
            "Create a detailed itinerary",
            "Adjust budget or dates",
          ],
        },
      });
    } catch (err: any) {
      console.error("Video consent error:", err);
      return res.status(500).json({
        ok: false,
        message: "Failed to process consent",
      });
    }
  }
);

/* ─────────────────────────────────────────────
 * Flight Utilities — shared by route search and TBO API phase
 * IATA resolution lives in ../utils/plutoIata.ts (resolveIATA), which returns
 * null for unknown cities instead of guessing a code.
 * ───────────────────────────────────────────── */

/** Generate contextual, route-aware tip lines — no hardcoded Japan text */
function buildFlightTipLines(originIATA: string, destIATA: string, date: string | null): string[] {
  const tips: string[] = [];

  // Route-specific airline tip
  const isIndia   = ["DEL","BOM","BLR","MAA","HYD","CCU","PNQ","AMD","GOI"].includes(originIATA);
  const isJapan   = ["NRT","KIX","NGO","CTS","FUK","OKA"].includes(destIATA);
  const isGulf    = ["DXB","AUH","DOH","MCT","RUH","JED"].includes(destIATA);
  const isSEAsia  = ["SIN","BKK","KUL","CGK","DPS","SGN","MNL"].includes(destIATA);
  const isEurope  = ["LHR","CDG","AMS","FRA","FCO","MXP","MAD"].includes(destIATA);

  if (isIndia && isJapan) {
    tips.push(`Air India and IndiGo operate ${originIATA}→${destIATA}, typically via Singapore, Bangkok, or Seoul`);
    tips.push("ANA and JAL offer premium economy on India–Japan routes — worth comparing");
  } else if (isIndia && isGulf) {
    tips.push(`Air India, IndiGo, and SpiceJet all operate ${originIATA}→${destIATA} with frequent daily flights`);
    tips.push("Emirates, Etihad, and Air Arabia are strong options for Gulf routes");
  } else if (isIndia && isSEAsia) {
    tips.push(`IndiGo and Air Asia India have the most competitive fares on ${originIATA}→${destIATA}`);
    tips.push("Singapore Airlines and Thai Airways offer premium alternatives");
  } else if (isIndia && isEurope) {
    tips.push(`Air India Direct operates ${originIATA}→${destIATA} — avoiding the layover`);
    tips.push("Lufthansa, British Airways, and Air France offer frequent connections via their hubs");
  } else {
    tips.push(`Search all airlines for ${originIATA}→${destIATA} — prices vary significantly by carrier`);
  }

  // Booking timing tip based on actual date
  if (date) {
    const isPeakJune = /jun/i.test(date);
    const isPeakDec  = /dec/i.test(date);
    const isEarly    = /jan|feb|mar/i.test(date);
    if (isPeakJune || isPeakDec) {
      tips.push(`${isPeakJune ? "June" : "December"} is peak travel season — book at least 60–90 days ahead for best fares`);
    } else if (isEarly) {
      tips.push("Early year travel often has lower fares — flexible dates of ±2 days can save significantly");
    } else {
      tips.push("Book 45–60 days ahead for the best balance of availability and price");
    }
  } else {
    tips.push("Book as early as possible — fares typically rise 30–45 days before departure");
  }

  // Fare class tip
  tips.push("Compare Economy, Premium Economy, and Business — the gap narrows for long-haul routes");

  return tips;
}

/**
 * POST /api/v1/copilot/flights/search
 * Dedicated structured flight search — called by FlightSearchPanel
 * Accepts IATA codes + ISO date directly, no NLP parsing needed
 */
router.post("/flights/search", async (req, res) => {
  const requestId = crypto.randomUUID();
  const workspaceId = String((req as any).workspaceObjectId || "");
  try {
    const {
      origin,
      destination,
      date,           // YYYY-MM-DD
      adults    = 1,
      children  = 0,
      infants   = 0,
      cabin     = "Economy",
      tripType  = "one-way",
      returnDate,
    } = req.body;

    // Validate required fields
    if (!origin || !destination || !date) {
      return res.status(400).json({
        ok: false,
        error: "origin, destination, and date are required",
      });
    }

    const originIATA = origin.toUpperCase().trim();
    const destIATA   = destination.toUpperCase().trim();

    // Validate IATA format (2-3 letters)
    if (!/^[A-Z]{2,3}$/.test(originIATA) || !/^[A-Z]{2,3}$/.test(destIATA)) {
      return res.status(400).json({
        ok: false,
        error: "origin and destination must be valid IATA airport codes (e.g. DEL, BLR, KIX)",
      });
    }

    // Validate ISO date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        ok: false,
        error: "date must be in YYYY-MM-DD format",
      });
    }


    const cabinClassMap: Record<string, number> = {
      Economy: 2, "Premium Economy": 3, Business: 4, First: 6,
    };
    const cabinClass = cabinClassMap[cabin as string] ?? 2;
    const journeyType = tripType === "round-trip" && returnDate ? 2 : 1;

    // ── TBO Search (direct, no SerpAPI fallback) ──
    let tboRaw: any;
    try {
      tboRaw = await tboSearchFlights({
        origin: originIATA,
        destination: destIATA,
        departDate: date,
        returnDate: journeyType === 2 ? returnDate : undefined,
        adults: Number(adults),
        children: Number(children),
        infants: Number(infants),
        JourneyType: journeyType as 1 | 2,
        cabinClass,
      });
    } catch (err: any) {
      // Transport-level failure (auth retry exhausted, timeout, non-JSON response, network).
      // Server-side log carries the detail; user sees a generic Plumtrips message.
      console.error("[FlightSearch/POST] upstream transport error", {
        message: err?.message,
        origin: originIATA,
        destination: destIATA,
        date,
      });
      return res.status(502).json({
        ok: false,
        error: "Flight search is temporarily unavailable. Please try again in a few minutes.",
      });
    }

    const traceId = tboRaw?.Response?.TraceId || "";
    const resultsArr: any[] = Array.isArray(tboRaw?.Response?.Results)
      ? tboRaw.Response.Results
      : [];

    // Upstream logical failure: non-success status code on the response.
    // Mirrors the SBT search handler — if results are still present we pass them
    // through with a warning; if not, surface as 502 with a structured server-side log.
    const tboStatus = tboRaw?.Response?.ResponseStatus ?? tboRaw?.Response?.Status;
    if (tboStatus !== undefined && tboStatus !== 1) {
      const hasResults = resultsArr.length > 0
        && Array.isArray(resultsArr[0])
        && resultsArr[0].length > 0;
      if (hasResults) {
        console.warn("[FlightSearch/POST] upstream non-success status with results", {
          tboStatus,
          traceId,
          origin: originIATA,
          destination: destIATA,
          date,
        });
        // fall through to normal mapping below
      } else {
        const errCode = tboRaw?.Response?.Error?.ErrorCode ?? "unknown";
        const errMsg = tboRaw?.Response?.Error?.ErrorMessage || "Unknown upstream error";
        console.error("[FlightSearch/POST] upstream search failed", {
          errCode,
          errMsg,
          tboStatus,
          traceId,
          origin: originIATA,
          destination: destIATA,
          date,
        });
        return res.status(502).json({
          ok: false,
          error: "Flight search is temporarily unavailable. Please try again in a few minutes.",
        });
      }
    }

    // Workspace margin parity with SBT: the same TBO ResultIndex is quoted at the
    // same SELLING price via concierge and via SBT, and nothing net, commission
    // or margin reaches the browser (services/sbtQuote.ts sellingFlight).
    // This workspace's percent, domestic or international by each result's own
    // route (services/sbtMargin.ts) — the body's originCountry/destCountry are ignored.
    const routeMargins = await flightRouteMargins((req as any).workspaceObjectId);
    for (let i = 0; i < resultsArr.length; i++) {
      if (Array.isArray(resultsArr[i])) {
        resultsArr[i] = resultsArr[i].map((flight: any) => sellingFlight(flight, routeMargins));
      }
    }

    const outboundRaw: any[] = Array.isArray(resultsArr[0]) ? resultsArr[0] : [];
    const inboundRaw: any[] = Array.isArray(resultsArr[1]) ? resultsArr[1] : [];

    if (outboundRaw.length === 0) {
      return res.json({ ok: true, results: [], traceId, message: "No flights found" });
    }

    const mapperOpts = {
      traceId,
      originIATA,
      destIATA,
      cabinLabel: typeof cabin === "string" ? cabin : (CABIN_LABELS[cabinClass] || "Economy"),
    };
    // Load the workspace policy (tenant-scoped, fail-safe → null).
    const policyRules = await loadWorkspacePolicyRules((req as any).workspaceObjectId);
    // Annotate each result with an ADDITIVE `policy` field. Order is preserved
    // (unlike the chat path) to keep the FlightSearchPanel contract stable.
    const annotate = (rows: any[], legOrigin: string, legDest: string): any[] =>
      rows
        .map((r: any) => {
          const f = withAirportFields(mapTBOFlight(r, mapperOpts), r, legOrigin, legDest);
          if (f) f.policy = evaluateFlightPolicy(flightForPolicyFromTBO(r), policyRules);
          return f;
        })
        .filter(Boolean);

    // Dedupe + airport split + cap mirrors searchFlightsForChat; both endpoints
    // must produce the same set so the FlightSearchPanel renders identically
    // regardless of trigger (chat NLP vs explicit Search button). Rows into a
    // different airport (AUH for a DXB search) come back as `otherAirport`.
    const out = splitLegRows(outboundRaw, originIATA, destIATA);
    const back = splitLegRows(inboundRaw, destIATA, originIATA);
    const results = annotate(out.match, originIATA, destIATA);
    const otherAirport = annotate(out.other, originIATA, destIATA);
    const inbound = annotate(back.match, destIATA, originIATA);
    const inboundOtherAirport = annotate(back.other, destIATA, originIATA);

    // Passive fare logging (fire-and-forget; never affects the response).
    // MATCH rows only — see searchFlightsForChat.
    recordFareObservations({
      workspaceObjectId: (req as any).workspaceObjectId,
      origin: originIATA,
      destination: destIATA,
      departDate: date,
      requestId,
      rawRows: out.match,
    });

    const inPolicyCount = results.filter((f: any) => f?.policy?.status === "IN_POLICY").length;
    await emitMetric(
      policyEvaluated({ workspaceId, requestId, inPolicyCount, totalCount: results.length })
    );

    const response: any = { ok: true, results, traceId };
    if (inbound.length > 0) response.inbound = inbound;
    if (otherAirport.length > 0) response.otherAirport = otherAirport;
    if (inboundOtherAirport.length > 0) response.inboundOtherAirport = inboundOtherAirport;
    return res.json(response);

  } catch (err: any) {
    console.error("[FlightSearch/POST] Error:", err.message);
    return res.status(500).json({
      ok: false,
      error: err.message || "Flight search failed",
    });
  }
});

/**
 * POST /api/v1/copilot/travel/hotels/search
 * Concierge hotel search — calls the SAME TBO hotel service that SBT uses.
 * Response shape mirrors /api/sbt/hotels/search so frontend code that consumes
 * SBT hotel results can render concierge results unchanged.
 */
router.post("/hotels/search", async (req, res) => {
  const requestId = crypto.randomUUID();
  const workspaceId = String((req as any).workspaceObjectId || "");
  try {
    const result = await searchHotels({
      CityCode: req.body?.CityCode,
      CityName: req.body?.CityName,
      CheckIn: req.body?.CheckIn,
      CheckOut: req.body?.CheckOut,
      Rooms: req.body?.Rooms,
      GuestNationality: req.body?.GuestNationality || (req.user as any)?.nationality || "IN",
      CountryCode: req.body?.CountryCode,
      HotelCodes: req.body?.HotelCodes,
      Filters: req.body?.Filters,
      workspaceId: (req as any).workspaceObjectId,
    });

    if (isHotelSearchError(result)) {
      if (result.status === 400) {
        return res.status(400).json({ ok: false, error: result.error });
      }
      if (result.status === 404) {
        return res.status(404).json({ ok: false, message: result.message, code: result.code });
      }
      return res.status(502).json({ ok: false, message: result.message, code: result.code });
    }

    // Additive policy annotation on each hotel (never filtered). Per-night price
    // is estimated from stay length; star cap always applies.
    const nights = hotelNights(req.body?.CheckIn, req.body?.CheckOut);
    const hotelPolicyRules = await loadWorkspacePolicyRules((req as any).workspaceObjectId);
    // Rooms from the customer allow-list (selling total only — no net TotalFare,
    // DayRates, RSP or commission); policy is evaluated before the rooms are shaped.
    // Each hotel at the percent the search service resolved for it (workspace,
    // domestic / international from the hotel master — services/sbtMargin.ts).
    const annotatedHotels = (result.hotels || []).map((h: any) => ({
      ...customerHotelResults(h, result.marginPct),
      policy: evaluateHotelPolicy(hotelForPolicyFromResult(h, nights), hotelPolicyRules),
    }));
    const inPolicyCount = annotatedHotels.filter((h: any) => h?.policy?.status === "IN_POLICY").length;
    await emitMetric(
      policyEvaluated({ workspaceId, requestId, inPolicyCount, totalCount: annotatedHotels.length })
    );

    return res.json({
      ok: true,
      TraceId: "",
      Hotels: annotatedHotels,
      SearchId: result.searchId,
      CityName: result.cityName,
    });
  } catch (err: any) {
    console.error("[HotelSearch/POST] Error:", err?.message);
    return res.status(500).json({
      ok: false,
      error: err?.message || "Hotel search failed",
    });
  }
});

/**
 * POST /api/v1/copilot/travel
 * Public / semi-auth AI concierge
 */
// The concierge turn as a reusable function. POST / calls it with no stage
// listener (behaviour byte-identical); POST /stream passes an onStage emitter.
// It still calls res.json / res.status().json exactly as before — /stream drives
// it through a capture-res shim, so no response call site changed (Amendment N:
// the getConversationContext/saveConversationContext call sites are untouched).
//
// PLUTO_STATE_V2 (default off) wraps it: the stored conversation is loaded ONCE,
// owner-scoped, before any branch runs, and committed ONCE on every exit. Off,
// the wrapper only records which branch answered (pluto.turn.branch).

/** Which branch answered, filled in by the turn as it routes. */
interface TurnTrace {
  branch: string;
  aiCalled: boolean;
}

/** The v2 state for this turn, loaded before any branch runs. */
interface LoadedTurnState {
  state: any;
  id: string;
  rev: number;
  isFollowUp: boolean;
  source: "new" | "server" | "missing" | "foreign" | "client";
}

/**
 * Load the conversation for THIS user (design §1.1). Owned → the stored bag
 * (the client's copy is ignored apart from its id). Missing → the client's
 * copy under the same id (a conversation from before the switch, or one whose
 * doc expired). Foreign → a fresh state under a NEW id, so the other user's
 * conversation is neither read nor overwritten. No store → the client's copy,
 * exactly today's behaviour.
 */
async function loadTurnState(req: any): Promise<LoadedTurnState> {
  const body = req.body || {};
  const client = body.context && typeof body.context === "object" ? body.context : {};
  const asId = (v: any) => (typeof v === "string" && v.length > 0 && v.length <= 64 ? v : null);
  const clientId = asId(client.id) || asId(body.conversationId);
  // No stored doc to prefer (new / missing / no store) → the client's copy,
  // as today; a stored doc, once one exists, always wins.
  // Search rows render as cards, so they only ever come from the server.
  const { rev: _rev, id: _id, lastSearch: _ls, ...clientState } = client;
  if (!clientId) {
    return { state: clientState, id: crypto.randomUUID(), rev: 0, isFollowUp: false, source: "new" };
  }
  const r = await loadConversationForUser({
    workspaceObjectId: (req as any).workspaceObjectId,
    userId: (req as any).user?._id,
    conversationId: clientId,
  });
  if (r.status === "owned") {
    const state = r.context && typeof r.context === "object" ? r.context : {};
    return { state, id: clientId, rev: Number(state.rev) || 0, isFollowUp: true, source: "server" };
  }
  if (r.status === "foreign") {
    return { state: {}, id: crypto.randomUUID(), rev: 0, isFollowUp: false, source: "foreign" };
  }
  return { state: clientState, id: clientId, rev: 0, isFollowUp: true, source: r.status === "missing" ? "missing" : "client" };
}

function emitTurnBranch(req: any, trace: TurnTrace, conversationId: string | undefined, stateV2: boolean) {
  void Promise.resolve(
    emitMetric(turnBranch({
      workspaceId: String((req as any).workspaceObjectId || ""),
      conversationId,
      branch: trace.branch,
      aiCalled: trace.aiCalled,
      stateV2,
    })),
  ).catch(() => {});
}

async function runConciergeTurn(
  req: any,
  res: any,
  onStage?: (stage: string, detail?: Record<string, unknown>) => void,
) {
  const trace: TurnTrace = { branch: "unknown", aiCalled: false };
  if (!isStateV2Enabled()) {
    // OWNERSHIP (switch-independent). A conversationId that belongs to another
    // user — or to nobody (a legacy doc with no owner) — starts a FRESH
    // conversation: the client's copy and the id are dropped, so this turn
    // neither reads nor writes the other conversation (the legacy branches
    // below trust the client's context and key their saves on the id).
    const body = req.body || {};
    const clientId =
      (body.context && typeof body.context === "object" && typeof body.context.id === "string" && body.context.id) ||
      (typeof body.conversationId === "string" && body.conversationId) ||
      null;
    if (clientId) {
      const owned = await loadConversationForUser({
        workspaceObjectId: (req as any).workspaceObjectId,
        userId: (req as any).user?._id,
        conversationId: clientId,
      });
      if (owned.status === "foreign") {
        req.body = { ...body, context: {}, conversationId: undefined };
      }
    }
    const captureId: { id?: string } = {};
    const tapRes: any = {
      status(code: number) { res.status(code); return tapRes; },
      json(body: any) { captureId.id = body?.context?.id; return res.json(body); },
    };
    const out = await runConciergeTurnInner(req, tapRes, onStage, null, trace);
    emitTurnBranch(req, trace, captureId.id, false);
    return out;
  }

  const loaded = await loadTurnState(req);
  const captured: { statusCode: number; body: any } = { statusCode: 200, body: undefined };
  const captureRes: any = {
    status(code: number) { captured.statusCode = code; return captureRes; },
    json(body: any) { captured.body = body; return captureRes; },
  };
  await runConciergeTurnInner(req, captureRes, onStage, loaded, trace);

  let body = captured.body;
  if (captured.statusCode < 400 && body?.ok && body.context && typeof body.context === "object") {
    // COMMIT — one awaited, owner-scoped write on every successful exit
    // (the hotel lane, the asks and the redirects never saved before).
    // `rev` counts writes; last write wins for now (design §8 Q9).
    const state = { ...body.context, v: 2, id: body.context.id || loaded.id, rev: loaded.rev + 1 };
    await saveConversationContext({
      workspaceObjectId: (req as any).workspaceObjectId,
      userId: (req as any).user?._id,
      conversationId: state.id,
      context: state,
    });
    body = { ...body, context: projectForClient(state) };
  }
  emitTurnBranch(req, trace, body?.context?.id, true);
  return res.status(captured.statusCode).json(body);
}

async function runConciergeTurnInner(
  req: any,
  res: any,
  // `detail` carries grounded context for the stage label (e.g. the route being
  // searched) so the client can render "Searching live fares BLR → DXB…" without
  // guessing. Optional and additive: POST / still passes no listener at all.
  onStage: ((stage: string, detail?: Record<string, unknown>) => void) | undefined,
  // PLUTO_STATE_V2: the state loaded for this turn; null when the switch is off.
  v2: LoadedTurnState | null,
  trace: TurnTrace,
) {
  // Per-request correlation id + tenant, threaded into every log line, metric
  // event and error response for this concierge turn.
  const requestId = crypto.randomUUID();
  const workspaceId = String((req as any).workspaceObjectId || "");
  try {
    const { prompt, context: clientContext, lastReply, videoAnalysisId } = req.body;
    // v2: every branch below reads the STORED state (loaded before this turn),
    // never the client's echo of it.
    const rawContext = v2 ? { ...v2.state, id: v2.id } : clientContext;
    // ONE-TURN "pending question" marker. Set (in the returned context) only
    // when Pluto has just asked the user for a city — the flight origin, the
    // office city, or "search here?" for a near-me hotel ask — so the short
    // answer that follows ("Pune", a tapped suggestion) is routed back to the
    // ask it answers. Consumed here and STRIPPED from the context every other
    // branch round-trips, so it can never outlive the turn that answers it.
    const pending: any =
      rawContext && typeof rawContext === "object" && (rawContext as any).pending
        ? (rawContext as any).pending
        : null;
    const context: any =
      rawContext && typeof rawContext === "object" && "pending" in rawContext
        ? (({ pending: _drop, ...rest }: any) => rest)(rawContext)
        : rawContext;
    onStage?.("understanding");

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({
        ok: false,
        message: "Prompt is required",
      });
    }

    /* ───────── Domain + Planning Intent Guard (AUTHORITATIVE) ───────── */

    // ── Is this a continuation of an existing conversation? ──
    // If context.id exists, the user is already mid-conversation.
    // NEVER gate follow-up messages — they are refinements, not new requests.
    const isFollowUp = v2 ? v2.isFollowUp : Boolean(context?.id || req.body?.conversationId);

    // Establish a stable conversation id up front so EVERY reply — including the
    // pre-AI gather-phase gate below — carries it. Without this, a details-
    // gathering conversation never gets an identity: the client round-trips an
    // id-less context, the next turn's isFollowUp stays false, and the whole
    // conversation resets. Reusing an existing id is a no-op for follow-ups.
    const conversationId = v2
      ? v2.id
      : context?.id || req.body?.conversationId || crypto.randomUUID();

    // 1️⃣ Must be travel-related at all.
    // Off-domain (clearly HR/payroll/attendance) → graceful concierge redirect
    // in the SAME PlutoReplyV1 shape the frontend renders, with a link to the
    // HRMS page that answers it. Never a 500. Runs on follow-ups too, but there
    // only on the unambiguous HR shapes ("how many leaves", "payslip") — the
    // broad words (policy, approval…) are first-turn only. A travel question
    // that merely contains a flagged word ("leave for the airport", "baggage
    // policy") is NOT redirected. The trip context round-trips untouched.
    if (isOffDomainQuery(prompt, { followUp: isFollowUp })) {
      trace.branch = "off_domain";
      // Carry the stable id even on the redirect so no reply is ever id-less.
      return res.json({
        ok: true,
        reply: buildOffDomainRedirect(prompt),
        context: { ...(context && typeof context === "object" ? context : {}), id: conversationId },
      });
    }

    /* ───────── Flight STATUS Detector (must precede route search) ─────────
     *
     * Two phrasings used to fail differently. "Check flight 6E-2582" matched the
     * route-search detector below (verb + "flight"), failed to resolve an
     * origin/destination and answered "Which airport should I search?".
     * "tell me the flight status of AI-4305" matched nothing, fell through to
     * the AI path, and had live status laundered through the model as prose.
     * Both land here now.
     *
     * The reply is composed in CODE from the AeroAPI response — no invokePluto
     * on this path — so the model can neither invent nor reword flight facts.
     *
     * A real route search wins the tie: "find flights from DEL to BOM like
     * AI 2024" carries a from…to pair and must still search, not report status.
     */
    const looksLikeRouteSearch = /\bfrom\b[\s\S]{1,40}\bto\b/i.test(prompt);
    if (isFlightStatusQuery(prompt) && !looksLikeRouteSearch) {
      trace.branch = "flight_status";
      const ident = extractFlightDesignator(prompt) as string;
      // Reuse the existing date parser rather than writing a second one; null
      // when the user named no date, which means "next upcoming".
      const askedDateRaw = extractStatusDate(prompt);
      const askedDate = askedDateRaw ? parseDateToISO(askedDateRaw) : null;

      onStage?.("checking_flight_status", { ident });

      let lookup: any;
      try {
        lookup = await getFlightOccurrences(ident, { date: askedDate, limit: 3 });
      } catch (err: any) {
        console.error("[FlightStatus] lookup failed", { requestId, ident, message: err?.message });
        return res.json({
          ok: true,
          reply: {
            title: `Flight ${ident}`,
            context: `I couldn't reach the flight-tracking service just now. You can check ${ident} directly on FlightAware or with the airline.`,
            nextSteps: ["Try again in a few minutes"],
            handoff: false,
          },
          context: { ...(context && typeof context === "object" ? context : {}), id: conversationId },
        });
      }

      // Hard miss (unknown ident / 404) — the card renders its own error state.
      if (isFlightLookupError(lookup)) {
        return res.json({
          ok: true,
          reply: {
            title: `Flight ${ident}`,
            context: lookup.message,
            flightStatus: lookup,
            nextSteps: ["Check the airline's app for the latest status"],
            handoff: false,
          },
          context: { ...(context && typeof context === "object" ? context : {}), id: conversationId },
        });
      }

      const occ = lookup.occurrences;
      const first = occ[0];

      // Asked for a date we have no occurrence for → say so; never silently
      // serve a different day (the whole bug this branch exists to kill).
      if (askedDate && occ.length === 0) {
        return res.json({
          ok: true,
          reply: {
            title: `Flight ${ident}`,
            context: `I couldn't find an ${ident} departure on ${askedDate}. It may not operate that day.`,
            flightStatus: {
              ident,
              requestedDate: askedDate,
              occurrences: [],
              tip: "Try a nearby date, or check the airline's schedule.",
            },
            nextSteps: [`Check ${ident} on a nearby date`],
            handoff: false,
          },
          context: { ...(context && typeof context === "object" ? context : {}), id: conversationId },
        });
      }

      const route = first ? `${first.departure.iata} → ${first.arrival.iata}` : "";
      const whenNote = first?.isPast
        ? `This flight has already operated — showing its most recent departure (${first.servedDate}).`
        : occ.length > 1
          ? `Showing the next ${occ.length} departures. Times are local to each airport.`
          : `Showing the ${askedDate ? "requested" : "next"} departure (${first?.servedDate}). Times are local to each airport.`;

      return res.json({
        ok: true,
        reply: {
          title: `${ident} · ${route}`.trim(),
          context: `${ident}${route ? ` ${route}` : ""} — ${first?.flight_status || "status unavailable"}. ${whenNote}`,
          // Real data, composed in code. `tip`/`airline` are populated here
          // because the model no longer emits a flightStatus object at all.
          flightStatus: {
            ident,
            requestedDate: lookup.requestedDate,
            occurrences: occ,
            airline: first?.airline?.name || "",
            tip: first?.isPast
              ? "Ask again closer to your travel date for live status."
              : "Gate and terminal can change close to departure — re-check on the day.",
          },
          nextSteps: [
            `Track ${ident} again later`,
            "Plan a trip on this route",
          ],
          handoff: false,
        },
        context: { ...(context && typeof context === "object" ? context : {}), id: conversationId },
      });
    }

    /* ───────── Flight Route Search Detector ───────── */
    // Intercepts ALL flight route search requests — explicit and contextual follow-ups.
    // Returns a rich card with real booking links. Never passes to Pluto (no flight search there).

    // Match explicit AND implicit follow-up flight search requests
    const looksLikeFlightRouteSearch = (t: string) => Boolean(
      /(find|search|show|get|look up|check).{0,30}flight/i.test(t) ||
      // "to" added 2026-11-09: "Flights to Mumbai next week" (a My Space chip)
      // is plainly a route search.
      /flights?\s+(from|between|on|available|for|to)/i.test(t) ||
      /flight\s+(option|price|fare|deal|available)/i.test(t) ||
      /available.*flight/i.test(t) ||
      /fly(ing)?\s+from\s+.{2,30}\s+to\s+/i.test(t)
    );

    /* v2 S2 hand-offs: a trip edit or a hotel-stay answer settles the facts
     * here and RE-RUNS a search through the existing flight / hotel branch
     * below, so there is one search path and one reply shape. */
    let flightForce: { prompt: string } | null = null;
    let hotelForce: {
      city: string; cityCode?: string; countryCode?: string;
      start: string; end: string; nights: number; near?: string | null;
    } | null = null;
    let editNote = "";
    let editBranch: string | null = null;
    let editChips: string[] = [];
    let carryFilters: FlightFilters | null = null;

    /* ───────── v2: PARK · RESUME · REFINE (deterministic, never the AI) ─────────
     * Design §3.1 / §3.6. Runs BEFORE the route detector: "ok leave flights for
     * now" matches its /flights?\s+for/ and used to re-run the very search the
     * user had just set aside (QC F-06). A refinement ("only non-stop",
     * "cheaper?") re-filters the rows stored with the last search — no supplier
     * call, no model — while they are fresh enough to book (12 min).
     */
    if (v2) {
      const v2Ctx: any = context && typeof context === "object" ? context : {};
      const ls: any = v2Ctx.lastSearch && typeof v2Ctx.lastSearch === "object" ? v2Ctx.lastSearch : {};
      const lockedNow: any = v2Ctx.locked || {};
      const shortDay = (iso?: string | null): string => {
        const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return "";
        const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][parseInt(m[2], 10) - 1];
        return mon ? `${parseInt(m[3], 10)} ${mon}` : "";
      };
      const destName: string =
        lockedNow.destination?.name || ls.flight?.destinationCity || ls.hotel?.city || "";

      // ── PARK — acknowledge, keep the trip, offer next steps. Never a search.
      const park = parseParkTask(prompt);
      if (park) {
        trace.branch = "park";
        const kind: "flight" | "hotel" | null = park.kind || (ls.active === "flight" || ls.active === "hotel" ? ls.active : null);
        const parked = { ...(v2Ctx.parked || {}), ...(kind ? { [kind]: Date.now() } : {}) };
        const tripBits = [
          lockedNow.origin?.city ? `from ${lockedNow.origin.city}` : "",
          shortDay(lockedNow.dates?.start),
        ].filter(Boolean).join(", ");
        const kept = destName ? ` Your ${destName} trip${tripBits ? ` (${tripBits})` : ""} is kept.` : "";
        const chips = (
          kind === "flight"
            ? [destName && `Hotels in ${destName}`, destName && `Things to do in ${destName}`, ls.flight && "Back to flights"]
            : kind === "hotel"
              ? [destName && `Flights to ${destName}`, destName && `Things to do in ${destName}`]
              : [destName ? `Flights to ${destName}` : "Search flights", destName ? `Hotels in ${destName}` : "Search hotels"]
        ).filter(Boolean) as string[];
        return res.json({
          ok: true,
          reply: {
            title: kind === "flight" ? "Flights on hold" : kind === "hotel" ? "Hotels on hold" : "No problem",
            context:
              (kind ? `Parked ${kind === "flight" ? "flights" : "hotels"} for now.` : "Okay, holding here.") +
              kept +
              " Pick it up whenever you're ready.",
            nextSteps: chips,
            handoff: false,
          },
          context: { ...v2Ctx, id: conversationId, parked },
        });
      }

      const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const longDay = (iso: string): string => {
        const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
        return `${d} ${MON3[m - 1]} ${y}`;
      };
      const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

      // ── ANSWER to "How many nights?" / "Which dates?" (S2, design §3.7).
      // The hotel search the question was for runs with the answer — never the AI.
      if (pending?.kind === "hotel" && (pending.need === "checkout" || pending.need === "dates") && pending.city) {
        const stay = parseStayAnswer(prompt, pending.need === "checkout" ? pending.checkIn || null : null, new Date());
        if (stay) {
          editBranch = "answer_pending";
          const prevDates: any = lockedNow.dates || {};
          context.locked = {
            ...lockedNow,
            dates: { ...prevDates, start: stay.start, end: stay.end, nights: stay.nights, source: "user" },
            duration: { days: stay.nights + 1, source: "derived" },
          };
          hotelForce = {
            city: pending.city, cityCode: pending.cityCode, countryCode: pending.countryCode,
            start: stay.start, end: stay.end, nights: stay.nights, near: pending.near || null,
          };
        }
      }

      // ── TRIP EDITS (S2, design §3.3): change the date / add a return / one
      // way / travellers / cabin / nights. The trip's facts change HERE, then
      // the last search re-runs with them and with its filters — the
      // destination and origin are kept (QC F-08: "change to 21 Nov" used to
      // wipe the trip and search nothing).
      if (!hotelForce) {
        const prevDates: any = lockedNow.dates || {};
        const lfx: any = ls.flight && typeof ls.flight === "object" ? ls.flight : null;
        const lhx: any = ls.hotel && typeof ls.hotel === "object" ? ls.hotel : null;
        const prevStart: string | null = prevDates.start || lfx?.date || lhx?.checkIn || null;
        const edit = parseTripEdit(prompt, { start: prevStart, now: new Date() });
        if (edit && (prevStart || lfx || lhx || edit.adults !== undefined || edit.adultsDelta || edit.cabin)) {
          editBranch = tripEditBranch(edit);
          let start: string | null = prevStart;
          if (edit.start) start = edit.start;
          if (edit.shiftDays && start) start = addDaysISO(start, edit.shiftDays);
          let returnDate: string | undefined =
            prevDates.returnDate || (lfx?.journeyType === 2 ? lfx.returnDate : undefined);
          if (edit.shiftDays && returnDate) returnDate = addDaysISO(returnDate, edit.shiftDays);
          if (edit.returnDate) returnDate = edit.returnDate;
          if (edit.oneWay) returnDate = undefined;
          const notes: string[] = [];
          if (returnDate && start && returnDate <= start) {
            notes.push(`Your return (${dayLabel(returnDate)}) was no longer after the new date, so it's one way for now.`);
            returnDate = undefined;
          }
          const prevNights =
            Number(prevDates.nights) ||
            (prevStart && prevDates.end ? nightsBetweenISO(prevStart, prevDates.end) : 0) ||
            (lhx ? nightsBetweenISO(lhx.checkIn, lhx.checkOut) : 0) ||
            0;
          let nights = prevNights;
          if (edit.nights !== undefined) nights = edit.nights;
          if (edit.nightsDelta) nights = (nights || 0) + edit.nightsDelta;
          const prevAdults: number | undefined = lockedNow.travellers?.adults ?? lfx?.adults ?? undefined;
          const adults: number | undefined =
            edit.adults ?? (edit.adultsDelta ? (prevAdults || 1) + edit.adultsDelta : prevAdults);
          const cabin: string | undefined = edit.cabin ?? lockedNow.cabin?.value ?? lfx?.cabin;
          const separate = Boolean(edit.separateRooms || lockedNow.travellers?.separateRooms);

          const L: any = { ...lockedNow };
          if (start) {
            const d: any = { ...prevDates, start, source: "user" };
            if (returnDate) d.returnDate = returnDate;
            else delete d.returnDate;
            if (nights > 0) {
              d.nights = nights;
              d.end = addDaysISO(start, nights);
              L.duration = { days: nights + 1, source: "derived" };
            } else if (prevDates.end && edit.shiftDays) {
              d.end = addDaysISO(prevDates.end, edit.shiftDays);
            }
            L.dates = d;
          }
          if (adults !== undefined || edit.separateRooms) {
            L.travellers = {
              ...(lockedNow.travellers || {}),
              ...(adults !== undefined ? { adults } : {}),
              ...(separate ? { separateRooms: true } : {}),
              source: "user",
            };
          }
          if (edit.cabin) L.cabin = { value: edit.cabin, source: "user" };
          context.locked = L;

          if ((edit.start || edit.shiftDays) && start) {
            notes.unshift(prevStart && prevStart !== start ? `Moved to ${dayLabel(start)} (was ${dayLabel(prevStart)}).` : `Date set to ${dayLabel(start)}.`);
          }
          if (edit.returnDate && returnDate) notes.push(`Return on ${dayLabel(returnDate)}.`);
          if (edit.oneWay) notes.push("One way now.");
          if ((edit.nights !== undefined || edit.nightsDelta) && start && nights > 0) {
            notes.push(`${plural(nights, "night")} (${stayLabel(start, addDaysISO(start, nights))}).`);
          }
          if ((edit.adults !== undefined || edit.adultsDelta) && adults !== undefined) notes.push(`${plural(adults, "traveller")}.`);
          if (edit.cabin) notes.push(`${edit.cabin} class.`);
          if (edit.separateRooms) notes.push("Separate rooms.");
          editNote = notes.length ? `${notes.join(" ")} ` : "";

          const datesChanged = Boolean(edit.start || edit.shiftDays);
          const flightHit = datesChanged || Boolean(edit.returnDate || edit.oneWay || edit.adults !== undefined || edit.adultsDelta || edit.cabin);
          const hotelHit = datesChanged || edit.nights !== undefined || Boolean(edit.nightsDelta || edit.adults !== undefined || edit.adultsDelta || edit.separateRooms);
          const pick: "flight" | "hotel" | null =
            ls.active === "flight" && lfx && flightHit ? "flight"
            : ls.active === "hotel" && lhx && hotelHit && nights > 0 ? "hotel"
            : lfx && flightHit ? "flight"
            : lhx && hotelHit && nights > 0 ? "hotel"
            : null;
          const destLabel: string = lockedNow.destination?.name || lfx?.destinationCity || lhx?.city || "";

          if (pick === "flight" && start) {
            const fromCity = lfx.originCity || lockedNow.origin?.city || lfx.origin;
            const toCity = lfx.destinationCity || lockedNow.destination?.name || lfx.destination;
            const n = adults || lfx.adults || 1;
            flightForce = {
              prompt:
                `flights from ${fromCity} to ${toCity} on ${longDay(start)}` +
                (returnDate ? ` returning on ${longDay(returnDate)}` : "") +
                ` for ${n} ${n === 1 ? "adult" : "adults"}` +
                (cabin && cabin !== "Economy" ? ` ${cabin.toLowerCase()} class` : ""),
            };
            carryFilters = lfx.filters || {};
            // The other search is NOT re-run on its own (§3.3) — offered.
            if (lhx && datesChanged && nights > 0 && destLabel) {
              editChips.push(`Hotels in ${destLabel} for ${stayLabel(start, addDaysISO(start, nights))}`);
            }
          } else if (pick === "hotel" && start) {
            hotelForce = {
              city: lhx.city, cityCode: lhx.cityCode, countryCode: lhx.countryCode,
              start, end: addDaysISO(start, nights), nights, near: lhx.filters?.near?.label || null,
            };
            if (lfx && datesChanged) {
              editChips.push(`Flights from ${lfx.originCity || lfx.origin} to ${lfx.destinationCity || lfx.destination} on ${longDay(start)}`);
            }
          } else {
            // Nothing to re-run: say what changed and offer the next step.
            trace.branch = editBranch;
            return res.json({
              ok: true,
              reply: {
                title: "Trip updated",
                context: `Got it. ${editNote.trim()}${destLabel ? ` Want flights or hotels${start ? ` for ${dayLabel(start)}` : ""}?` : ""}`.trim(),
                nextSteps: destLabel
                  ? [`Flights to ${destLabel}${start ? ` on ${longDay(start)}` : ""}`, `Hotels in ${destLabel}`]
                  : [],
                handoff: false,
              },
              context: { ...v2Ctx, locked: L, id: conversationId },
            });
          }
        }
      }

      // ── RESUME / REFINE the last flight search.
      const lf: any = ls.flight && typeof ls.flight === "object" ? ls.flight : null;
      const resume = isResumeFlights(prompt);
      // A message that names a place, a route or a date is a NEW search (or a
      // trip edit, slice S2) — never a filter on the old rows.
      const placeWord = prompt.match(/\b(?:to|from|via)\s+([A-Za-z]{3,}(?:\s+[A-Za-z]{3,})?)/i);
      const namesNewSearch =
        /\bfrom\b[\s\S]{1,40}\bto\b/i.test(prompt) ||
        Boolean(matchXToYRoute(prompt)) ||
        Boolean(placeWord && resolveIATA(placeWord[1])) ||
        Boolean(extractPromptDateRange(prompt)) ||
        Boolean(resolveRelativeDate(prompt));
      const aboutFlights = ls.active === "flight" || /\bflights?\b/i.test(prompt);
      if (lf && !flightForce && !hotelForce && !isHotelRequest(prompt) && (resume || (aboutFlights && !namesNewSearch))) {
        const parsed = resume ? null : parseFlightRefinement(prompt, lf.rows?.flights || []);
        if (resume || parsed) {
          trace.branch = resume ? "resume_flight" : "refine_flight";
          onStage?.("refining");
          const prevFilters: FlightFilters = lf.filters || {};
          const filters: FlightFilters = !parsed
            ? prevFilters
            : "filters" in parsed
              ? mergeFlightFilters(prevFilters, parsed.filters)
              : {};
          const all: any[] = Array.isArray(lf.rows?.flights) ? lf.rows.flights : [];
          const fromCity = lf.originCity || lf.origin;
          const toCity = lf.destinationCity || lf.destination;
          const route = `${fromCity} → ${toCity}`;
          const day = lf.displayDate || shortDay(lf.date);
          const words = flightFilterWords(filters);
          const searchChip = `Search ${words ? `${words} ` : ""}flights from ${fromCity} to ${toCity} on ${day}`;
          const parkedOut = { ...(v2Ctx.parked || {}) };
          delete parkedOut.flight;
          const baseCtx = { ...v2Ctx, id: conversationId, parked: parkedOut };
          const ageMs = Date.now() - Number(lf.at || 0);

          // Stale rows: their TraceId may no longer book, and fares move.
          if (!(ageMs >= 0 && ageMs < FLIGHT_ROWS_FRESH_MS)) {
            return res.json({
              ok: true,
              reply: {
                title: `Flights: ${route} · ${day}`,
                context: `The fares I found for ${route} on ${day} are more than 12 minutes old, so I won't filter them: prices and seats change. Shall I search again?`,
                nextSteps: [searchChip],
                handoff: false,
              },
              context: { ...baseCtx, lastSearch: { ...ls, flight: { ...lf, filters } } },
            });
          }

          const labels = describeFlightFilters(filters, all);
          const out = applyFlightFilters(all, filters, { leg: "out", legDate: lf.date });
          if (out.length === 0) {
            // Nothing matches: say so, keep the last filters that DID match.
            return res.json({
              ok: true,
              reply: {
                title: `No matches: ${route} · ${day}`,
                context: `None of the ${all.length} flights I found match ${labels.join(", ")}. I can only filter the results I already have; a fresh search may find more.`,
                nextSteps: [Object.keys(prevFilters).length ? "Clear filters" : "Show all flights", searchChip],
                handoff: false,
              },
              context: baseCtx,
            });
          }

          const inbound = applyFlightFilters(lf.rows?.inbound || [], filters, { leg: "in", legDate: lf.returnDate });
          const other = applyFlightFilters(lf.rows?.otherAirport || [], filters, { leg: "out", legDate: lf.date });
          const inboundOther = applyFlightFilters(lf.rows?.inboundOtherAirport || [], filters, { leg: "in", legDate: lf.returnDate });
          const fare = (f: any): number => Number(f?.fare?.offered ?? f?.fare?.published ?? 0) || Infinity;
          const mins = (f: any): number => (Number(f?.durationMin) > 0 ? Number(f.durationMin) : Infinity);
          const cheapest = out.reduce((a: any, b: any) => (fare(a) <= fare(b) ? a : b));
          const fastest = out.reduce((a: any, b: any) => (mins(a) <= mins(b) ? a : b));
          const overall = all.reduce((a: any, b: any) => (fare(a) <= fare(b) ? a : b));
          const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
          const dep = (f: any) => String(f?.departure?.time || "").slice(0, 5);
          const stops = (n: any) => (Number(n) === 0 ? "non-stop" : `${n} stop${Number(n) > 1 ? "s" : ""}`);
          const narrowing = labels.filter((l) => l !== "cheapest first" && l !== "fastest first");

          let text = narrowing.length
            ? `${narrowing.join(" · ").replace(/^./, (c) => c.toUpperCase())}: ${out.length} of ${all.length} flights.`
            : `All ${all.length} flights${labels.length ? `, ${labels.join(", ")}` : ""}.`;
          text += ` Cheapest${narrowing.length ? " match" : ""} ${inr(fare(cheapest))} (${cheapest.flightNo}, ${dep(cheapest)}, ${stops(cheapest.stops)}).`;
          if (filters.sort === "duration") text += ` Fastest ${fastest.duration} (${fastest.flightNo}).`;
          if (narrowing.length && fare(overall) < fare(cheapest)) {
            text += ` Without the filters, the cheapest is ${inr(fare(overall))} (${overall.flightNo}, ${stops(overall.stops)}, ${overall.duration}).`;
          }
          // "cheaper?" / "fastest" ADDS a sort on top of the filters: say so up
          // front and list everything now active (QC A3: the reply used to read
          // exactly like the previous one).
          const sortLabel = filters.sort === "price" ? "Cheapest first" : filters.sort === "duration" ? "Fastest first" : "";
          const sortAdded = Boolean(parsed && "filters" in parsed && parsed.filters.sort && parsed.filters.sort !== prevFilters.sort);
          if (sortLabel && narrowing.length) {
            text = `${sortAdded ? `${sortLabel}. ` : ""}${text} Active filters: ${labels.join(", ")}.`;
          }

          const chips: string[] = [];
          if (filters.maxStops === undefined) chips.push("Non-stop only");
          if (filters.sort !== "price") chips.push("Cheapest first");
          if (!filters.departWindow && !filters.arriveBy) chips.push("Morning departures only");
          if (Object.keys(filters).length) chips.push("Clear filters");

          return res.json({
            ok: true,
            reply: {
              title: `Flights: ${route} · ${day}`,
              context: text,
              flightSearch: {
                origin: { city: fromCity, iata: lf.origin },
                destination: { city: toCity, iata: lf.destination },
                date: day,
                isoDate: lf.date,
                isoReturnDate: lf.journeyType === 2 ? lf.returnDate : undefined,
                journeyType: lf.journeyType || 1,
                flights: out,
                inbound,
                otherAirport: other,
                inboundOtherAirport: inboundOther,
                cheapest,
                fastest,
                traceId: lf.traceId,
                source: "tbo",
                tipLines: buildFlightTipLines(lf.origin, lf.destination, day),
                activeFilters: labels,
              },
              nextSteps: chips.slice(0, 4),
              handoff: false,
            },
            context: {
              ...baseCtx,
              lastSearch: { ...ls, active: "flight", flight: { ...lf, filters, shownRefs: out.map((f: any) => f.ResultIndex) } },
            },
          });
        }
      }
    }

    // A short answer to a pending FLIGHT question (we asked for the origin, or
    // for the office city) → re-run the ORIGINAL ask with the answer spliced
    // in, so every extractor below reads one consistent sentence. The answer
    // is the user's own words (typed, or a suggestion they tapped), so it is
    // treated exactly like a city they typed in the first place.
    let flightPrompt: string = prompt;
    let flightAnswered = false;
    if (
      pending?.kind === "flight" &&
      typeof pending.prompt === "string" &&
      (pending.need === "origin" || pending.need === "destination") &&
      !looksLikeFlightRouteSearch(prompt)
    ) {
      // v2: "ok Pune please" answers as "Pune" (S2 a).
      const answer = parseCityAnswer(v2 ? stripFiller(prompt) : prompt);
      const answerCity = answer ? lookupDestination(answer)?.city || answer : null;
      if (answerCity && resolveIATA(answerCity)) {
        flightPrompt = spliceFlightAnswer(pending.prompt, pending.need, answerCity);
        flightAnswered = true;
      }
    }

    // v2: "bengaluru to mumbai on 20 nov" (no "flights", no "from") is a route
    // ask too (QC F-11). Rewritten into the "flights from X to Y …" form every
    // extractor below already reads.
    let xToY: ReturnType<typeof matchXToYRoute> = null;
    // Applied even when the legacy detector also fired ("…morning flights only"
    // matches its /flights?\s+on/) — that detector would claim the turn with no
    // origin. matchXToYRoute already refuses any message containing "from".
    if (v2 && !flightAnswered && !flightForce && !hotelForce) {
      xToY = matchXToYRoute(prompt);
      if (xToY) flightPrompt = xToY.prompt;
    }
    // v2 S2: a trip edit re-runs the last flight search with the new facts.
    if (flightForce) flightPrompt = flightForce.prompt;

    const isFlightRouteSearch =
      !hotelForce && (flightAnswered || looksLikeFlightRouteSearch(prompt) || Boolean(xToY) || Boolean(flightForce));

    if (isFlightRouteSearch) {
      trace.branch = editBranch || (flightAnswered ? "answer_pending" : "flight_route");
      // ── Multi-city: not supported in the chat path yet → LOUD downgrade ──
      // Detect BEFORE single-leg extraction: a "to A to B" prompt would make the
      // destination regex capture "A to B", which then fails IATA resolution and
      // would wrongly hit the unknown-city clarify. Detect up front, emit the
      // metric, and offer a single-leg search or a full-trip request instead.
      if (isMultiCityIntent(flightPrompt)) {
        await emitMetric(
          multicityDowngraded({ workspaceId, requestId, reason: "chat_unsupported" })
        );
        return res.json({
          ok: true,
          reply: {
            title: "Multi-city isn't supported in chat yet",
            context: `I can't plan a full multi-city trip in chat yet. I can search a single leg for you, or you can raise a request and our team will arrange the complete multi-city itinerary.`,
            nextSteps: [
              `Search one leg at a time (e.g. "flights from Delhi to Mumbai on 20 May")`,
              "Raise a request for the full multi-city trip",
            ],
            handoff: false,
          },
          context: { ...(context && typeof context === "object" ? context : {}), id: conversationId },
        });
      }

      // ── Extract from prompt with robust terminators ──
      // The city capture is lazy, so it stops at the FIRST terminator. Time
      // words are terminators: without them "flights to Mumbai next week"
      // captured "Mumbai next week" — a city that resolves to no airport, so
      // the turn asked "which airport?" about a city the user had just named.
      // A digit ("to Mumbai 20 May"), "(", "?" and "!" end the city too.
      const TIME_WORDS = String.raw`next|this|tomorrow|today|tonight|day\s+after|in|returning|return|back|week|weekend`;
      // Origin: "from <city> to/on/for/<time word>/,"
      const promptOriginMatch = flightPrompt.match(new RegExp(
        String.raw`\bfrom\s+([A-Za-z][a-zA-Z ]{1,25}?)(?=\s+to\b|\s+on\b|\s+for\b|\s+by\b|\s+(?:${TIME_WORDS})\b|\s+\d|\s*\(|,|\.|\?|!|$)`, "i"));
      // Destination: "to <city> on/by/for/and/from/<time word>/,"  — includes "for" so "to Delhi for 8th March" works
      const promptDestMatch   = flightPrompt.match(new RegExp(
        String.raw`\bto\s+([A-Za-z][a-zA-Z ]{1,25}?)(?=\s+on\b|\s+by\b|\s+for\b|\s+and\b|\s+from\b|\s+(?:${TIME_WORDS})\b|\s+\d|\s*\(|,|\.|\?|!|$)`, "i"));
      // Date: natural language or numeric
      const dateMatch = flightPrompt.match(/(\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i);
      // Relative date ("today", "tomorrow", "next week", "this weekend") → a
      // concrete IST date, ONLY when no explicit date was typed. The rule used
      // is said back to the user (relDateNote) so the choice is never silent.
      const relDate = dateMatch ? null : resolveRelativeDate(flightPrompt);
      // v2: the note was already said on the ask this turn answers — once is enough.
      const relDateNoteShown =
        Boolean(v2) && flightAnswered && Array.isArray(pending?.notesShown) && pending.notesShown.includes("rel_date");
      const relDateNote = relDate && !relDateNoteShown
        ? ` I read "${relDate.phrase}" as ${relDate.rule} (IST) — tell me if you meant another day.`
        : "";

      // ── Context fallback — ONLY use locked trip data, NOT user profile/device location ──
      // locked.origin = explicitly set trip origin (e.g. "Delhi" from "plan trip from Delhi")
      // Do NOT use assumed.origin — that may be device/profile location (causes BLR bug)
      const ctxOrigin = context?.locked?.origin?.city  || null;
      const ctxDest   = context?.locked?.destination?.name || context?.assumed?.destination?.name || null;
      const ctxDate   = context?.locked?.dates?.start  || null;

      // Extract passenger count
      const paxMatch = flightPrompt.match(
        /\bfor\s+(\d+)\s*(?:people|persons?|pax|passengers?|travell?ers?|adults?)/i
      ) || flightPrompt.match(
        /(\d+)\s*(?:people|persons?|pax|passengers?|travell?ers?|adults?)/i
      );
      // v2: travellers stated earlier are reused until the user changes them (§1.2).
      const lockedAdults = v2 ? Number(context?.locked?.travellers?.adults) || 0 : 0;
      const extractedAdults = paxMatch ? Math.min(parseInt(paxMatch[1]), 9) : lockedAdults > 0 ? Math.min(lockedAdults, 9) : 1;

      // Extract cabin class — FLIGHT-ADJACENT ONLY. A bare "business" must never
      // upgrade the search: "business hotel and cheapest flight" used to match
      // "business" and silently search Business class (₹1.7L+ fares for a
      // "cheapest" ask). Require "<cabin> class" or a flight verb before the
      // word, and never treat a cabin word glued to a lodging noun as a cabin.
      const cabinStated =
        /\bpremium\s+economy\b|\bfirst\s+class\b|\beconomy\b/i.test(flightPrompt) ||
        ((/\bbusiness\s+class\b/i.test(flightPrompt) || /\b(?:in|fly|flying|book|travel|travell?ing)\s+business\b/i.test(flightPrompt)) &&
          !/\bbusiness\s+(?:hotel|stay|accommodation|accomodation|property|resort)\b/i.test(flightPrompt));
      const lockedCabin: string | null = v2 && !cabinStated ? context?.locked?.cabin?.value || null : null;
      const extractedCabin: "Economy" | "Premium Economy" | "Business" | "First" =
        lockedCabin === "Premium Economy" || lockedCabin === "Business" || lockedCabin === "First" ? lockedCabin
        : /\bpremium\s+economy\b/i.test(flightPrompt) ? "Premium Economy"
        : /\bfirst\s+class\b/i.test(flightPrompt) ? "First"
        : (
            (/\bbusiness\s+class\b/i.test(flightPrompt) ||
             /\b(?:in|fly|flying|book|travel|travell?ing)\s+business\b/i.test(flightPrompt)) &&
            !/\bbusiness\s+(?:hotel|stay|accommodation|accomodation|property|resort)\b/i.test(flightPrompt)
          ) ? "Business"
        : "Economy";

      const cabinClassMap_chat: Record<string, number> = {
        Economy: 2, "Premium Economy": 3, Business: 4, First: 6,
      };
      const extractedCabinClass = cabinClassMap_chat[extractedCabin] ?? 2;

      let rawOrigin: string | null      = promptOriginMatch?.[1]?.trim() || ctxOrigin || null;
      let rawDestination: string | null = promptDestMatch?.[1]?.trim()   || ctxDest   || null;
      const travelDate     = dateMatch?.[0]?.trim() || relDate?.display || ctxDate || null;

      // ── OFFICE as an endpoint ("flights from my office to Mumbai") ──
      // The office comes from the PROFILE (User.jobLocation → Employee.location),
      // only when it resolves to exactly one city, and the reply SAYS so. No
      // profile city → ask for it; never a guess, never the device location.
      let officeNote = "";
      const officeEnd: "origin" | "destination" | null =
        isOfficePlace(promptOriginMatch?.[1]) ? "origin"
        : isOfficePlace(promptDestMatch?.[1]) ? "destination"
        : null;
      if (officeEnd) {
        const office = await resolveOfficeCity(req);
        const officeIATA = office.status === "RESOLVED" ? resolveIATA(office.city.cityName) : null;
        if (office.status === "RESOLVED" && officeIATA) {
          if (officeEnd === "origin") rawOrigin = office.city.cityName;
          else rawDestination = office.city.cityName;
          officeNote = officeDisclosure(
            office.city.cityName,
            officeEnd === "origin" ? "flight_origin" : "flight_destination",
          );
        } else {
          return res.json({
            ok: true,
            reply: {
              title: OFFICE_ASK_CHIP,
              context: office.status === "RESOLVED"
                ? `Your profile lists your office as ${office.city.cityName}, but I can't match it to an airport — which city should I fly ${officeEnd === "origin" ? "from" : "to"}?`
                : OFFICE_ASK_TEXT,
              nextSteps: [OFFICE_ASK_CHIP],
              handoff: false,
            },
            context: {
              ...(context && typeof context === "object" ? context : {}),
              id: conversationId,
              pending: { kind: "flight", need: officeEnd, prompt: flightPrompt },
            },
          });
        }
      }

      // ── Smart country → airport resolution ──
      // "Japan" → use most specific city from context (Osaka/Tokyo/etc.) if known
      // "India" → use origin city from context
      const COUNTRY_DEFAULT_AIRPORT: Record<string, string> = {
        japan: "NRT", india: "DEL", usa: "JFK", uk: "LHR", france: "CDG",
        australia: "SYD", singapore: "SIN", thailand: "BKK", uae: "DXB",
        germany: "FRA", italy: "FCO", spain: "MAD", canada: "YYZ",
      };

      const resolveCity = (raw: string | null, isDestination: boolean): string => {
        if (!raw) return isDestination ? "your destination" : "your origin";
        const lower = raw.toLowerCase().trim();
        // If it's a country name, try to find a specific city from context first
        if (COUNTRY_DEFAULT_AIRPORT[lower]) {
          if (isDestination) {
            // Check if context has a specific city within this country
            const ctxCity = context?.locked?.destination?.city || context?.assumed?.destination?.city;
            if (ctxCity) return ctxCity;
          }
        }
        return raw;
      };

      const origin      = resolveCity(rawOrigin,      false);
      const destination = resolveCity(rawDestination, true);

      // resolveIATA returns null for anything it can't map (and never guesses a
      // 3-letter code). If a city the user actually named can't be resolved, ask
      // them to clarify instead of searching a fabricated airport.
      const originIATA = resolveIATA(origin);
      const destIATA   = resolveIATA(destination);

      const unresolvedCities = [
        rawOrigin && !originIATA ? origin : null,
        rawDestination && !destIATA ? destination : null,
      ].filter(Boolean);

      if (!originIATA || !destIATA) {
        // ── No origin, destination known → maybe a CURRENT-LOCATION suggestion.
        // Offered as a one-tap chip the user must confirm — the origin is NOT
        // filled in (see the "BLR bug" exclusion above: device location must
        // never silently become a trip origin). Only when the IP genuinely
        // resolved (source "ip") through the strict ladder; otherwise the
        // reply is exactly today's question. Either way the turn remembers
        // what it asked (pending), so a bare "Pune" next turn is the answer.
        if (!rawOrigin && destIATA) {
          const askedContext = {
            ...(context && typeof context === "object" ? context : {}),
            id: conversationId,
            pending: {
              kind: "flight",
              need: "origin",
              prompt: flightPrompt,
              ...(v2 && relDateNote ? { notesShown: ["rel_date"] } : {}),
            },
          };
          // The destination IS known here — the reply asks for the origin
          // only, whether or not there is a location chip to offer.
          const askOrigin =
            `I can search flights to ${destination}${travelDate ? ` on ${travelDate}` : ""}.${relDateNote} ` +
            `Where are you flying from?`;
          const here = await suggestFlightOrigin(req);
          if (here && here.iata !== destIATA) {
            return res.json({
              ok: true,
              reply: {
                title: "Where are you flying from?",
                context: askOrigin,
                nextSteps: [flightOriginChip(here), OTHER_CITY_CHIP],
                handoff: false,
              },
              context: askedContext,
            });
          }
          // No usable location (unavailable, private IP, no airport nearby,
          // or the same airport as the destination): ask, with one chip that
          // ends in "?" so the concierge prefills it for the user to finish.
          return res.json({
            ok: true,
            reply: {
              title: "Where are you flying from?",
              context: `${askOrigin} A city name or 3-letter airport code works (e.g. "Delhi" or "DEL").`,
              nextSteps: [FLIGHT_ORIGIN_ASK_CHIP],
              handoff: false,
            },
            context: askedContext,
          });
        }
        const askWhich = unresolvedCities.length > 0
          ? `I couldn't match ${unresolvedCities.join(" and ")} to an airport.`
          : `I need both a departure and destination city to search flights.`;
        return res.json({
          ok: true,
          reply: {
            title: "Which airport should I search?",
            context: `${askWhich} Could you give me the city name or its 3-letter airport code (e.g. "Delhi" or "DEL")?`,
            nextSteps: [
              "Tell me the departure city or airport code",
              "Tell me the destination city or airport code",
            ],
            handoff: false,
          },
          // Carry the stable id so this clarify turn is not an id-less context
          // (which the sidebar can't dedup → a churned row). Every branch returns
          // the id now.
          context: { ...(context && typeof context === "object" ? context : {}), id: conversationId },
        });
      }

      // Parse any date format to YYYY-MM-DD. Missing-year dates resolve to the
      // nearest future occurrence (see utils/plutoDate.ts) — no hardcoded year.
      const isoDate = parseDateToISO(travelDate);

      // ── Round-trip: search both legs (JourneyType 2) when a return date is
      // known. (Multi-city was already handled + returned at the top.) ──
      // v2: the flight's own return (dates.returnDate) — never a hotel check-out
      // (dates.end), which used to turn the next flight search into a round trip.
      const { wantsRoundTrip, returnDateRaw } = resolveRoundTripIntent(
        flightPrompt,
        (v2 ? context?.locked?.dates?.returnDate : context?.locked?.dates?.end) || null,
        isoDate,
      );
      const isoReturnDate = returnDateRaw ? parseDateToISO(returnDateRaw) : "";
      const journeyType: 1 | 2 = wantsRoundTrip && isoReturnDate ? 2 : 1;

      // ── Amendment T — accumulate the route + dates the user just stated into
      // conversationContext.locked (set-if-absent) BEFORE returning. The flight
      // branch runs before the AI-path extractor, so without this the origin /
      // dates the user typed here would never reach locked: later turns would
      // lose them and the duration-consistency check (Step 4) would have nothing
      // to compare. Persisted best-effort (a miss/no-DB is a graceful no-op).
      const priorLocked =
        context && typeof context === "object" && context.locked && typeof context.locked === "object"
          ? { ...context.locked }
          : {};
      const mergedLocked: any = { ...priorLocked };
      if (!v2) {
        if (!mergedLocked.origin && rawOrigin && originIATA) {
          mergedLocked.origin = { city: origin, iata: originIATA, source: officeNote && officeEnd === "origin" ? "profile" : "user" };
        }
        if (!mergedLocked.destination && rawDestination && destIATA) {
          mergedLocked.destination = { name: destination, iata: destIATA, source: officeNote && officeEnd === "destination" ? "profile" : "user" };
        }
        if (!mergedLocked.dates && isoDate) {
          mergedLocked.dates = { start: isoDate, ...(isoReturnDate ? { end: isoReturnDate } : {}), source: "user" };
        }
      } else {
        // v2 (S2): what the user typed THIS turn replaces the lock — origin,
        // date, return, travellers, cabin (QC F-08: set-if-absent kept the old
        // date after "change to 21 Nov"). The destination stays set-if-absent
        // until S3, which also clears the old city's summary when it changes.
        const typedOrigin = Boolean(promptOriginMatch?.[1]) || officeEnd === "origin";
        const typedDate = Boolean(dateMatch || relDate);
        if (rawOrigin && originIATA && (typedOrigin || !mergedLocked.origin)) {
          mergedLocked.origin = { city: origin, iata: originIATA, source: officeNote && officeEnd === "origin" ? "profile" : "user" };
        }
        if (!mergedLocked.destination && rawDestination && destIATA) {
          mergedLocked.destination = { name: destination, iata: destIATA, source: officeNote && officeEnd === "destination" ? "profile" : "user" };
        }
        if (isoDate && (typedDate || !mergedLocked.dates?.start)) {
          const prev: any = mergedLocked.dates || {};
          const keepNights = Number(prev.nights) > 0 ? Number(prev.nights) : 0;
          mergedLocked.dates = {
            ...prev,
            start: isoDate,
            ...(keepNights ? { end: addDaysISO(isoDate, keepNights) } : {}),
            source: "user",
          };
        }
        if (mergedLocked.dates) {
          if (journeyType === 2 && isoReturnDate) mergedLocked.dates = { ...mergedLocked.dates, returnDate: isoReturnDate };
          else if (typedDate) {
            const { returnDate: _r, ...rest } = mergedLocked.dates;
            mergedLocked.dates = rest;
          }
        }
        if (paxMatch) mergedLocked.travellers = { ...(mergedLocked.travellers || {}), adults: extractedAdults, source: "user" };
        if (cabinStated) mergedLocked.cabin = { value: extractedCabin, source: "user" };
      }

      // ── Step 4 — DURATION CONSISTENCY. When the stated dates span a different
      // number of days than a locked duration word, the DATES win (they are more
      // authoritative): update locked.duration to the span and flag it in one
      // sentence so the itinerary skeleton is regenerated for the new span on the
      // next planning turn.
      let durationFlagNote = "";
      if (isoDate && isoReturnDate) {
        const spanDays = Math.round((Date.parse(isoReturnDate) - Date.parse(isoDate)) / 86400000) + 1;
        const lockedDays = priorLocked?.duration?.days;
        if (spanDays > 0 && lockedDays && lockedDays !== spanDays) {
          durationFlagNote = ` Note: ${travelDate} to ${returnDateRaw} spans ${spanDays} days, which differs from your original ${lockedDays}-day plan — I've updated the plan to ${spanDays} days (your dates take priority).`;
          mergedLocked.duration = { days: spanDays, source: "dates" };
        } else if (spanDays > 0 && !lockedDays) {
          mergedLocked.duration = { days: spanDays, source: "dates" };
        }
      }

      const lockedReturnContext = { ...(context && typeof context === "object" ? context : {}), id: conversationId, locked: mergedLocked };
      // v2 commits once at the end of the turn instead (runConciergeTurn).
      if (!v2) {
        void saveConversationContext({
          workspaceObjectId: (req as any).workspaceObjectId,
          userId: (req as any).user?._id,
          conversationId,
          context: lockedReturnContext,
        });
      }

      // Round-trip intent but no usable return date → ASK for it. Never fall
      // through to a silent one-way search (the prior behaviour).
      if (wantsRoundTrip && isoDate && !isoReturnDate) {
        return res.json({
          ok: true,
          reply: {
            title: `Round trip: ${origin} → ${destination}`,
            context: officeNote + `You mentioned a round trip. What's your return date? Once I have it I'll search both the outbound and return legs.` + relDateNote,
            nextSteps: [
              `Tell me your return date (e.g. "20 May 2026")`,
              `Or say "one way" and I'll search just the outbound`,
            ],
            handoff: false,
          },
          context: lockedReturnContext,
        });
      }

      let chatFlights: any[] = [];
      let chatInbound: any[] = [];
      // Rows into / out of a different airport than the one searched (AUH for
      // DXB, NMI for BOM). Never tiered, never "Best" — their own group.
      let chatOtherAirport: any[] = [];
      let chatInboundOtherAirport: any[] = [];
      let chatTraceId = "";
      // Distinguishes a genuine upstream outage (searchUnavailable = true) from
      // a genuine zero-results route (searchUnavailable = false, flights empty).
      let searchUnavailable = false;

      // Load the workspace travel policy once for this request (tenant-scoped,
      // fail-safe → null when absent). Flights are annotated, never filtered.
      // This await is the honest anchor for the "checking your travel policy"
      // stage — the rules are fetched here and applied inside the search below,
      // so there is no separate post-search policy step to narrate.
      onStage?.("checking_policy");
      const chatPolicyRules = await loadWorkspacePolicyRules((req as any).workspaceObjectId);

      onStage?.("searching_flights", { origin: originIATA, dest: destIATA });
      if (isoDate) {
        const chatResult = await searchFlightsForChat({
          origin: originIATA,
          destination: destIATA,
          departDate: isoDate,
          returnDate: journeyType === 2 ? isoReturnDate : undefined,
          journeyType,
          adults: extractedAdults,
          cabinClass: extractedCabinClass,
          cabinLabel: extractedCabin,
          requestId,
          policyRules: chatPolicyRules,
          workspaceObjectId: (req as any).workspaceObjectId,
          // Selling prices, the same margin SBT search / FareQuote apply.
          margins: await flightRouteMargins((req as any).workspaceObjectId),
        });
        if (chatResult.ok) {
          chatFlights = chatResult.flights;
          chatInbound = chatResult.inbound;
          chatOtherAirport = chatResult.otherAirportFlights || [];
          chatInboundOtherAirport = chatResult.inboundOtherAirport || [];
          chatTraceId = chatResult.traceId;
        } else {
          searchUnavailable = true;
          await emitMetric(
            searchError({ workspaceId, requestId, reason: chatResult.reason || "unknown" })
          );
          console.error("[FlightSearch] chat search unavailable", {
            requestId,
            reason: chatResult.reason,
            origin: originIATA,
            destination: destIATA,
            date: isoDate,
          });
        }
      } else {
        console.warn("[FlightSearch] No parseable date — skipping live search", { requestId });
      }

      // v2: remember this search (rows server-side only) so a follow-up can
      // re-filter it, and apply any filter words typed WITH the route ("…,
      // morning flights only" — QC B3). A failed / dateless search forgets the
      // previous route's rows: they no longer answer this conversation.
      let initialFilterNote = "";
      if (v2) {
        const priorSearch: any = (lockedReturnContext as any).lastSearch || {};
        const { flight: _oldFlight, ...otherSearches } = priorSearch;
        if (isoDate && !searchUnavailable && (chatFlights.length > 0 || chatOtherAirport.length > 0)) {
          // A trip edit's re-run carries the filters already chosen (B8: "change
          // to 21 Nov" keeps "morning only"); a typed route adds its own.
          const typed = flightForce ? null : parseFlightRefinement(flightPrompt, chatFlights);
          const typedFilters: FlightFilters = typed && "filters" in typed ? typed.filters : {};
          const initialFilters: FlightFilters = carryFilters ? mergeFlightFilters(carryFilters, typedFilters) : typedFilters;
          const allFlights = chatFlights;
          const allInbound = chatInbound;
          const allOther = chatOtherAirport;
          const allInboundOther = chatInboundOtherAirport;
          if (Object.keys(initialFilters).length) {
            const labels = describeFlightFilters(initialFilters, allFlights);
            const narrowed = applyFlightFilters(allFlights, initialFilters, { leg: "out", legDate: isoDate });
            if (narrowed.length > 0) {
              chatFlights = narrowed;
              chatInbound = applyFlightFilters(chatInbound, initialFilters, { leg: "in", legDate: isoReturnDate || null });
              // The "Other nearby airports" group obeys the same filters (prod
              // QC 2026-11-10: "morning only" still listed 15:10 / 22:55 NMI rows).
              chatOtherAirport = applyFlightFilters(chatOtherAirport, initialFilters, { leg: "out", legDate: isoDate });
              chatInboundOtherAirport = applyFlightFilters(chatInboundOtherAirport, initialFilters, { leg: "in", legDate: isoReturnDate || null });
              initialFilterNote = ` Filtered to ${labels.join(", ")}: ${narrowed.length} of ${allFlights.length}.`;
            } else {
              initialFilterNote = ` None of the ${allFlights.length} flights match ${labels.join(", ")}, so all are shown.`;
            }
          }
          (lockedReturnContext as any).lastSearch = {
            ...otherSearches,
            active: "flight",
            flight: {
              at: Date.now(),
              origin: originIATA,
              destination: destIATA,
              originCity: origin,
              destinationCity: destination,
              date: isoDate,
              displayDate: travelDate,
              ...(journeyType === 2 ? { returnDate: isoReturnDate } : {}),
              journeyType,
              adults: extractedAdults,
              cabin: extractedCabin,
              traceId: chatTraceId,
              filters: initialFilters,
              rows: {
                flights: allFlights,
                inbound: allInbound,
                otherAirport: allOther,
                inboundOtherAirport: allInboundOther,
              },
              shownRefs: chatFlights.map((f: any) => f.ResultIndex),
            },
          };
        } else if (Object.keys(otherSearches).length) {
          (lockedReturnContext as any).lastSearch = otherSearches;
        } else {
          delete (lockedReturnContext as any).lastSearch;
        }
      }

      // Cheapest / fastest over the rows that serve the requested airports only
      // (chatFlights). Fastest ranks on the backend's time-zone-correct
      // durationMin — the same number every card renders.
      const minsOf = (f: any): number =>
        Number.isFinite(Number(f?.durationMin)) && Number(f?.durationMin) > 0 ? Number(f.durationMin) : Infinity;
      const chatCheapest = chatFlights.length
        ? chatFlights.reduce((a: any, b: any) => ((a.fare?.offered || a.fare?.published || 0) < (b.fare?.offered || b.fare?.published || 0)) ? a : b)
        : null;
      const chatFastest = chatFlights.length
        ? chatFlights.reduce((a: any, b: any) => (minsOf(a) <= minsOf(b) ? a : b))
        : null;

      const hasLiveFlights = chatFlights.length > 0;
      // Nothing lands at the requested airport, but TBO did return rows into a
      // nearby one. Said plainly; those rows are shown as their own group.
      const otherAirportOnly = !hasLiveFlights && chatOtherAirport.length > 0;
      const otherAirportCodes = Array.from(
        new Set(
          chatOtherAirport
            .flatMap((f: any) => [f?.destination?.code, f?.origin?.code])
            .filter((c: any) => c && c !== originIATA && c !== destIATA),
        ),
      ) as string[];
      const otherAirportNames = otherAirportCodes.map((c) => airportLabel(c)).join(", ");
      const otherAirportNote = hasLiveFlights && chatOtherAirport.length > 0
        ? ` ${chatOtherAirport.length} more option${chatOtherAirport.length > 1 ? "s use" : " uses"} a different airport (${otherAirportNames}) — listed separately under "Other nearby airports".`
        : "";

      // Policy telemetry + "clear why" copy when nothing is in policy.
      const inPolicyCount = chatFlights.filter((f: any) => f?.policy?.status === "IN_POLICY").length;
      if (hasLiveFlights) {
        void Promise.resolve(
          emitMetric(policyEvaluated({ workspaceId, requestId, inPolicyCount, totalCount: chatFlights.length }))
        ).catch((e: any) => console.error("[metric] policyEvaluated failed", e?.message));
      }
      const zeroInPolicyNote =
        hasLiveFlights && chatPolicyRules && inPolicyCount === 0
          ? buildZeroInPolicyNote(chatPolicyRules) + " "
          : "";

      const roundTripNote = journeyType === 2 && chatInbound.length > 0
        ? ` Return-leg options for ${destIATA} → ${originIATA} are included below.`
        : "";

      // State the cabin searched (Amendment S) and, when the user asked for the
      // cheapest, name the lowest fare found (Step 3 qualifier passthrough).
      const wantsCheapest = /\bcheapest\b|\blowest\s+fare\b|\bbudget\b/i.test(flightPrompt);
      const cabinNote = extractedCabin !== "Economy" ? ` Cabin searched: ${extractedCabin}.` : " Cabin: Economy.";
      const cheapestNote = wantsCheapest && chatCheapest
        ? ` Cheapest fare found: ₹${(chatCheapest.fare?.offered ?? chatCheapest.fare?.published ?? 0).toLocaleString("en-IN")}.`
        : "";

      // Route insights (Know) — tenant-scoped FareObservation history. Grounded:
      // one sentence only when we have enough data; never invents fares.
      // Route insights (Know) + weather awareness. These two post-search reads
      // are provably independent (neither consumes the other), so they run
      // concurrently (Amendment L) — one RTT instead of two. The metric is
      // fire-and-forget (the sink is reject-safe). Weather silent-skips on
      // failure and never blocks.
      let routeInsights: any = null;
      let routeInsightsNote = "";
      let weatherNote = "";
      if (hasLiveFlights) {
        onStage?.("checking_weather");
        const [insightsRes, weatherRes] = await Promise.all([
          getRouteIntelProvider().getRouteInsights({
            origin: originIATA,
            destination: destIATA,
            departDate: isoDate,
            workspaceObjectId: (req as any).workspaceObjectId,
          }),
          isoDate ? getDestinationWeather(destIATA, isoDate) : Promise.resolve(null),
        ]);
        routeInsights = insightsRes;
        void Promise.resolve(
          emitMetric(routeInsightsServed({
            workspaceId,
            requestId,
            observationCount: routeInsights.observationCount,
            sufficient: routeInsights.sufficient,
          }))
        ).catch((e: any) => console.error("[metric] routeInsightsServed failed", e?.message));
        if (routeInsights.sufficient && routeInsights.typicalFareRange) {
          routeInsightsNote = ` Fares on this route have typically been ₹${routeInsights.typicalFareRange.p25.toLocaleString("en-IN")}–₹${routeInsights.typicalFareRange.p75.toLocaleString("en-IN")} recently.`;
        }
        if (weatherRes) {
          weatherNote = ` Weather in ${weatherRes.city} around then: ~${Math.round(weatherRes.tempMaxC)}°C, ${weatherRes.summary}.`;
        }
      }

      // ── Step 3 — COMPOUND INTENT (flight + hotel in one message) ──
      // The flight branch owns the turn (first-match-wins), which silently
      // dropped a hotel ask riding along ("...business hotel and cheapest
      // flight"). Never drop it: acknowledge the hotel request and carry a
      // qualifier-aware nextSteps trigger that routes to the hotel path. (A live
      // inline TBO hotel search is intentionally NOT wired here — there is no
      // chat-hotel helper and TBO hotel creds are environment-gated — so the
      // honest move is to acknowledge + hand off, never fake or drop it.)
      const hotelAsk = /\b(hotels?|stay|accommodations?|accomodations?|property|resort|lodging)\b/i.test(flightPrompt);
      const hotelQualMatch = flightPrompt.match(/\b(business|luxury|budget|boutique|premium|five[\s-]?star|5[\s-]?star|four[\s-]?star|4[\s-]?star)\s+(?:hotels?|stay|accommodations?|property|resort)/i);
      const hotelQual = hotelQualMatch ? hotelQualMatch[1].toLowerCase().replace(/[\s-]/g, "") : "";
      const hotelQualLabel = (hotelQual === "5star" || hotelQual === "fivestar") ? "5-star "
        : (hotelQual === "4star" || hotelQual === "fourstar") ? "4-star "
        : hotelQual ? `${hotelQual} ` : "";
      const hotelTrigger = hotelAsk ? `Show me ${hotelQualLabel}hotels in ${destination}` : null;
      const hotelNote = hotelAsk
        ? ` I've also noted you want a ${hotelQualLabel}hotel in ${destination} — tap "${hotelTrigger}" and I'll pull options.`
        : "";

      onStage?.("assembling");
      const baseNextSteps = searchUnavailable ? [
        "Retry the search in a few minutes",
        "Or use the flight search panel above for full results",
      ] : hasLiveFlights ? [
        "Click Book on a flight to continue in our booking flow",
        "I'll pre-fill the search and take you straight to passenger details",
      ] : otherAirportOnly ? [
        "Try a different date",
        "Or use the flight search panel above to pick another airport",
      ] : [
        "Try a slightly different date or route",
        "Or use the flight search panel above for full results",
      ];
      const nextSteps = [...editChips, ...(hotelTrigger ? [hotelTrigger, ...baseNextSteps] : baseNextSteps)];

      return res.json({
        ok: true,
        reply: {
          title: `Flights: ${origin} → ${destination}${travelDate ? "  ·  " + travelDate : ""}`,
          context: officeNote + editNote + (searchUnavailable
            ? `Flight search is temporarily unavailable for ${originIATA} → ${destIATA} right now. Please retry in a few minutes.`
            : hasLiveFlights
              ? zeroInPolicyNote + `Found ${chatFlights.length} flights for ${originIATA} → ${destIATA} on ${travelDate}. Fares are live, shown in INR.` + cabinNote + cheapestNote + roundTripNote + routeInsightsNote + weatherNote + otherAirportNote + initialFilterNote
              : otherAirportOnly
                ? `I found no flights ${originIATA} → ${destIATA}${travelDate ? " on " + travelDate : ""}. The ${chatOtherAirport.length} option${chatOtherAirport.length > 1 ? "s" : ""} I did find use ${otherAirportNames} instead — shown below under "Other nearby airports" so you can decide.`
              : !isoDate
                ? `I couldn't parse the date for ${originIATA} → ${destIATA}. Try a date like "20 May 2026" and I'll pull live fares.`
                : `I couldn't find any live flights for ${originIATA} → ${destIATA}${travelDate ? " on " + travelDate : ""}. Try a different date or a nearby route.`) + relDateNote + durationFlagNote + hotelNote,
          flightSearch: {
            origin:      { city: origin,      iata: originIATA },
            destination: { city: destination, iata: destIATA   },
            date:        travelDate,
            isoDate,
            isoReturnDate: journeyType === 2 ? isoReturnDate : undefined,
            journeyType,
            flights:     chatFlights,
            inbound:     chatInbound,
            otherAirport:        chatOtherAirport,
            inboundOtherAirport: chatInboundOtherAirport,
            cheapest:    chatCheapest,
            fastest:     chatFastest,
            traceId:     chatTraceId,
            source:      searchUnavailable ? "unavailable" : (hasLiveFlights || otherAirportOnly) ? "tbo" : "none",
            tipLines:    buildFlightTipLines(originIATA, destIATA, travelDate),
          },
          // Additive: tenant-scoped route history (null when thin data).
          routeInsights,
          nextSteps,
          handoff: false,
        },
        context: lockedReturnContext,
      });
    }

    /* ───────── LIVE Hotel Lane (Phase 2) ─────────
     *
     * Runs AFTER the flight branch, so a compound "flight + hotel" turn still
     * belongs to flights exactly as before (that branch acknowledges the hotel
     * ask and offers a chip which lands here as a pure hotel turn).
     *
     * This replaces the model-invented reply.hotels on hotel turns with REAL,
     * BOOKABLE rows from the same searchHotels service SBT uses, annotated with
     * the same policy evaluator flights use. If the search can't run or returns
     * nothing we fall back to the HONEST acknowledge-and-handoff that was here
     * before — never to fabricated hotels.
     */
    const hotelCtx = context && typeof context === "object" ? context : {};
    const hotelLocked = (hotelCtx as any).locked || {};

    // Hotel-led is now decided WITHOUT a resolved city, because "the user named
    // somewhere we can't serve" has to reach this branch to be answered
    // honestly. It used to require a city, so an unresolvable one fell to the AI
    // path and got answered with a question about dates that were already
    // locked — a dead end no answer could clear.
    let hotelIntent =
      Boolean(hotelForce) || (isHotelRequest(prompt) && !/\b(fly|flying|flight|flights)\b/i.test(prompt));
    if (hotelIntent) trace.branch = editBranch || "hotel_search";

    let hotelDest: HotelDestination = { status: "NO_CITY" };
    // Where the destination came from, and whether this branch should ask for
    // dates itself (destination settled by the profile or by an answer to our
    // own question) rather than fall through to the model.
    let hotelDestSource: "user" | "profile" = "user";
    let hotelAskDates = false;

    // Did the user name an actual place this turn? Then THEIR place wins over
    // anything we know about them ("hotels near my office in Pune" → Pune).
    const hotelNamedPlace = (() => {
      if (!hotelIntent || hotelForce) return false;
      if (extractHotelCity(prompt)) return true;
      const named = extractNamedPlaceCandidate(prompt);
      return Boolean(named && !isOfficePlace(named.raw));
    })();

    if (hotelForce) {
      // v2 S2: the city the stay question / the last hotel search was for.
      hotelDest =
        hotelForce.cityCode && hotelForce.countryCode
          ? { status: "RESOLVED", cityName: hotelForce.city, countryCode: hotelForce.countryCode, cityCode: hotelForce.cityCode }
          : await resolveHotelDestination(`hotels in ${hotelForce.city}`, {});
    } else if (hotelIntent && !hotelNamedPlace && mentionsOffice(prompt)) {
      /* ── OFFICE ("hotels near my office") — from the PROFILE, disclosed.
       * User.jobLocation (fallback Employee.location), strict ladder, exactly
       * one city. Anything else is a specific question — never UNSUPPORTED
       * ("Hotels in my office"), never a guess, never the device location. */
      const office = await resolveOfficeCity(req);
      if (office.status !== "RESOLVED" || !office.city.cityCode || !office.city.countryCode) {
        return res.json({
          ok: true,
          reply: {
            title: OFFICE_ASK_CHIP,
            context:
              office.status === "RESOLVED"
                ? `Your profile lists your office as ${office.city.cityName}, but I can't reach hotel inventory for it right now — try again shortly, or tell me another city.`
                : OFFICE_ASK_TEXT,
            nextSteps: [OFFICE_ASK_CHIP],
            handoff: false,
          },
          context: { ...hotelCtx, id: conversationId, pending: { kind: "hotel", reason: "office" } },
        });
      }
      hotelDest = {
        status: "RESOLVED",
        cityName: office.city.cityName,
        countryCode: office.city.countryCode,
        cityCode: office.city.cityCode,
      };
      hotelDestSource = "profile";
      hotelAskDates = true;
    } else if (hotelIntent && !hotelNamedPlace && mentionsNearMe(prompt)) {
      /* ── NEAR ME — a one-tap CURRENT-LOCATION suggestion, never a search.
       * Only when the IP genuinely resolved through the strict ladder; else
       * this turn behaves exactly as it did before (today's question). */
      const here = await suggestCurrentCity(req);
      if (here && here.cityCode) {
        return res.json({
          ok: true,
          reply: {
            title: "Hotels near you",
            context: `You seem to be around ${here.cityName} right now (based on your current location). Search there?`,
            nextSteps: [`Search hotels in ${here.cityName} (my current location)`, OTHER_CITY_CHIP],
            handoff: false,
          },
          context: { ...hotelCtx, id: conversationId, pending: { kind: "hotel", reason: "near_me" } },
        });
      }
      hotelDest = await resolveHotelDestination(prompt, hotelLocked);
    } else if (!hotelIntent && pending?.kind === "hotel") {
      /* ── ANSWER to our own hotel question ("which city is your office in?",
       * "other city — which one?"). The city is the user's own words, so it
       * goes through the full honest ladder (ambiguous → ask, unknown →
       * unsupported) exactly like "hotels in <city>" would. */
      const answer = parseCityAnswer(prompt);
      if (answer) {
        const answered = await resolveHotelDestination(`hotels in ${answer}`, {});
        if (answered.status !== "NO_CITY") {
          trace.branch = "answer_pending";
          hotelIntent = true;
          hotelDest = answered;
          hotelAskDates = answered.status === "RESOLVED";
        }
      }
    } else if (hotelIntent) {
      // v2: a destination named this turn never falls back to the locked city
      // (QC F-24 — "Executive stay in London Soho" became Dubai).
      hotelDest = v2
        ? await resolveHotelDestination(prompt, hotelLocked, { strictNamed: true })
        : await resolveHotelDestination(prompt, hotelLocked);
    }
    const hotelCity = hotelDest.status === "RESOLVED" ? hotelDest.cityName : null;
    const hotelCountry = hotelDest.status === "RESOLVED" ? hotelDest.countryCode : null;

    // The stay window. A locked pair wins; otherwise the dates typed THIS turn
    // count. Reading only the locked bag is what made a first-turn dated hotel
    // prompt fall through to the AI path — the locker runs ~240 lines below, so
    // on turn 1 the bag is always empty and the user had to repeat themselves.
    // Both readers now share ONE parser (resolveHotelSearchWindow), so they
    // cannot drift apart again.
    // v2 (S2): dates typed THIS turn win; then the locked start with its nights,
    // end, or the flight's return; a start alone is ASKED about below (never
    // handed to the model, which asked for dates it already had — QC F-07).
    const stayV2 = !v2
      ? null
      : hotelForce
        ? { start: hotelForce.start, end: hotelForce.end, nights: hotelForce.nights, source: "forced" as const }
        : resolveStayWindow(prompt, hotelLocked, new Date());
    const hotelWindow = v2
      ? stayV2 && stayV2.end
        ? { start: stayV2.start, end: stayV2.end, source: stayV2.source === "locked" || stayV2.source === "return" ? ("locked" as const) : ("prompt" as const) }
        : null
      : resolveHotelSearchWindow(prompt, hotelLocked);
    const checkIn = hotelWindow?.start || null;
    const checkOut = hotelWindow?.end || null;
    const hotelNear: string | null = v2 ? hotelForce?.near ?? nearLabel(prompt) : null;

    // OWNERSHIP RULE: this branch takes the turn ONLY when a real search can
    // actually run — hotel-led prompt, a city we can resolve to a country, and
    // both dates already locked.
    //
    // Anything less FALLS THROUGH to the AI path on purpose. Returning a
    // clarify from here would answer before the locked-facts extractor below
    // has run, so the destination/dates the user just typed would never be
    // locked and the next turn would re-ask them. It also stopped this branch
    // hijacking a compound planning turn: "Flying to Singapore from Delhi 12-15
    // Sep, hotel near Marina Bay" mentions a hotel but is a planning turn, and
    // must reach the extractor that locks all four facts in one go.
    const hotelLed = Boolean(hotelCity) && hotelIntent;

    /* ── UNSUPPORTED CITY — answered here, and deliberately BEFORE the dates
     * check. The user named a destination that resolves in neither the curated
     * table nor the 54k-row TBO catalog, so no date, occupancy or budget they
     * could supply would make the search runnable. Asking for one more detail
     * would be a question we already know the answer to: it still fails.
     *
     * Say it plainly, echo the name THEY used, and offer the desk. No
     * "Suggested Stays", no model fallback — an invented list of hotels for a
     * city we cannot book is the exact failure this lane exists to prevent. */
    /* ── SEVERAL REAL CITIES — ask which, never pick.
     *
     * "hotels in Springfield" matches fifteen bookable Springfields; "Santa
     * Maria" matches six rows that are byte-identical apart from the country.
     * The old code took whichever had the shortest name and never admitted a
     * choice had been made, which is a confidently wrong destination — the one
     * output this lane exists to prevent.
     *
     * Answered BEFORE the dates check, like UNSUPPORTED: no date the user could
     * supply resolves which city they meant. The destination is deliberately
     * NOT locked here — locking a guess is the same bug wearing a hat. */
    if (hotelIntent && hotelDest.status === "AMBIGUOUS") {
      await emitMetric(
        searchError({ workspaceId, requestId, reason: "hotel_city_ambiguous" }),
      );
      const options = hotelDest.candidates
        .map((c) => (c.region ? `${c.cityName}, ${c.region}` : `${c.cityName} (${c.countryCode})`));
      return res.json({
        ok: true,
        reply: {
          title: `Which ${hotelDest.query || "city"}?`,
          context:
            `There are ${hotelDest.candidates.length} places called ${hotelDest.query} I can book — ` +
            `${options.slice(0, 3).join(", ")}${options.length > 3 ? " and more" : ""}. ` +
            `Tell me which one and I'll pull live availability.`,
          hotelsAwaitingCity: {
            query: hotelDest.query,
            candidates: hotelDest.candidates,
          },
          nextSteps: [],
          handoff: false,
        },
        context: { ...hotelCtx, id: conversationId },
      });
    }

    /* ── v2 (QC F-24): a destination NAMED this turn that does not resolve.
     * Never answered about the locked city: offer the closest bookable city
     * ("London Soho" → London, around Soho) or ask which city it is in. The
     * trip itself is untouched — switching it is S3. */
    if (v2 && hotelIntent && hotelDest.status === "UNSUPPORTED" && hotelDest.named) {
      await emitMetric(
        searchError({ workspaceId, requestId, reason: "hotel_city_unresolved_named" }),
      );
      const sugg = hotelDest.suggestion;
      if (sugg) {
        return res.json({
          ok: true,
          reply: {
            title: `Did you mean ${sugg.cityName}?`,
            context:
              `I couldn't find "${hotelDest.cityName}" as a city I can book. ` +
              `Did you mean ${sugg.cityName}${sugg.rest ? `, around ${sugg.rest}` : ""}?`,
            nextSteps: [
              `Hotels in ${sugg.cityName}${sugg.rest ? ` near ${sugg.rest}` : ""}`,
              OTHER_CITY_CHIP,
            ],
            handoff: false,
          },
          context: { ...hotelCtx, id: conversationId, pending: { kind: "hotel", need: "city" } },
        });
      }
      return res.json({
        ok: true,
        reply: {
          title: `Which city is ${hotelDest.cityName} in?`,
          context:
            `I couldn't find "${hotelDest.cityName}" in the hotel inventory I can search. ` +
            `Which city is it in? I'll search there — or our travel desk can source options.`,
          nextSteps: ["Raise a request and our team will source options"],
          handoff: false,
        },
        context: { ...hotelCtx, id: conversationId, pending: { kind: "hotel", need: "city" } },
      });
    }

    if (hotelIntent && hotelDest.status === "UNSUPPORTED") {
      await emitMetric(
        searchError({ workspaceId, requestId, reason: "hotel_city_unsupported" }),
      );
      return res.json({
        ok: true,
        reply: {
          title: `Hotels in ${hotelDest.cityName}`,
          context:
            `I can't pull live hotel availability for ${hotelDest.cityName} yet — it isn't in the inventory I can search directly. ` +
            `Rather than show you options I can't actually book, I'd rather hand this to our travel desk: they can source and hold rooms there.`,
          nextSteps: [
            "Raise a request and our team will source options",
            "Search hotels in a different city",
          ],
          handoff: false,
        },
        context: { ...hotelCtx, id: conversationId },
      });
    }

    /* ── COUNTRY NAMED, NO DATES. We know where to search (the country's main
     * city by inventory) but not when. Answered HERE rather than falling
     * through, because the AI path reads locked.destination — and on exactly
     * this turn shape that produced a page of Dubai hotels, complete with an
     * itinerary, in reply to a question about Qatar. Disclose the city we chose,
     * ask only for what is genuinely missing, and lock the destination so the
     * next turn does not re-ask it. */
    if (hotelLed && hotelDest.status === "RESOLVED" && hotelDest.viaCountry && !(checkIn && checkOut)) {
      return res.json({
        ok: true,
        reply: {
          title: `Hotels in ${hotelDest.viaCountry}`,
          context:
            `${hotelDest.viaCountry} — I'd search ${hotelCity}, where we have the most properties. ` +
            `Tell me another city if you meant somewhere else. Which dates are you travelling?`,
          nextSteps: [
            `Give me your check-in and check-out dates for ${hotelCity}`,
            `Name a different city in ${hotelDest.viaCountry}`,
          ],
          handoff: false,
        },
        context: {
          ...hotelCtx,
          id: conversationId,
          locked: {
            ...(hotelLocked || {}),
            destination: { name: hotelCity, source: "user" },
          },
        },
      });
    }

    /* ── v2 (S2): a plain hotel ask without a full stay → ASK for what is
     * missing, in code, and remember the question (pending), so "3 nights" or
     * "16 to 19 nov" next turn runs this search. The check-in from the flight
     * is reused and said back (A7′, B5). A planning ask still goes to the AI. */
    const v2StartOnly = stayV2 && stayV2.source === "start_only" ? stayV2.start : null;
    if (
      v2 &&
      hotelLed &&
      hotelCountry &&
      !hotelForce &&
      !(checkIn && checkOut) &&
      // The office / our-own-city-question path keeps its disclosed dates ask
      // below when there is no check-in to offer.
      !(hotelAskDates && !v2StartOnly) &&
      !/\b(?:plan|planning|itinerary|trip|days?\s+in)\b/i.test(prompt)
    ) {
      const resolved = hotelDest as Extract<HotelDestination, { status: "RESOLVED" }>;
      const startOnly = v2StartOnly;
      const lockedOut: any = {
        ...(hotelLocked || {}),
        ...(!(hotelLocked as any)?.destination ? { destination: { name: hotelCity, source: hotelDestSource } } : {}),
      };
      const ask: any = {
        kind: "hotel",
        need: startOnly ? "checkout" : "dates",
        city: hotelCity,
        cityCode: resolved.cityCode,
        countryCode: hotelCountry,
        ...(startOnly ? { checkIn: startOnly } : {}),
        ...(hotelNear ? { near: hotelNear } : {}),
      };
      const fromFlight =
        Boolean(startOnly) && (hotelCtx as any)?.lastSearch?.flight?.date === startOnly ? " (from your flight)" : "";
      const title = `Hotels in ${hotelCity}${hotelNear ? ` near ${hotelNear}` : ""}`;
      const profileNote = hotelDestSource === "profile" ? officeDisclosure(hotelCity as string, "hotels_pending") : "";
      return res.json({
        ok: true,
        reply: startOnly
          ? {
              title,
              context: `${profileNote}Check-in ${dayLabel(startOnly)}${fromFlight}. How many nights?`,
              nextSteps: [1, 2, 3].map((n) => `${n} night${n > 1 ? "s" : ""} (till ${dayLabel(addDaysISO(startOnly, n))})`),
              handoff: false,
            }
          : {
              title,
              context: `Which dates in ${hotelCity}? For example "16 to 19 Nov".`,
              nextSteps: [],
              handoff: false,
            },
        context: { ...hotelCtx, id: conversationId, locked: lockedOut, pending: ask },
      });
    }

    /* ── DESTINATION SETTLED HERE (office profile, or an answer to our own
     * city question), NO DATES. Same shape as the country branch above: ask
     * only for the dates and lock the destination, so the next turn does not
     * re-ask it. The profile source is disclosed in the reply itself. */
    if (hotelLed && hotelAskDates && !(checkIn && checkOut)) {
      return res.json({
        ok: true,
        reply: {
          title: `Hotels in ${hotelCity}`,
          context:
            hotelDestSource === "profile"
              ? `${officeDisclosure(hotelCity as string, "hotels_pending")}Which dates are you staying?`
              : `Hotels in ${hotelCity} — which dates are you staying?`,
          nextSteps: [
            `What are your hotel check-in and check-out dates in ${hotelCity}?`,
            "Search hotels in a different city",
          ],
          handoff: false,
        },
        context: {
          ...hotelCtx,
          id: conversationId,
          locked: {
            ...(hotelLocked || {}),
            destination: { name: hotelCity, source: hotelDestSource },
          },
        },
      });
    }

    if (hotelLed && hotelCountry && checkIn && checkOut) {
      // When the gate fired on dates/city read from THIS prompt, they must be
      // locked here too. The branch returns before the locked-facts block below
      // ever runs, so without this the very thing the ownership comment protects
      // would break: the next turn would re-ask for what the user just typed.
      const hotelLockedOut: any = { ...(hotelLocked || {}) };
      if (v2) {
        // The stay the user stated (typed range, "for 3 nights", a stay answer,
        // a trip edit) replaces the lock, with nights (§1.2).
        if (stayV2 && stayV2.source !== "locked" && stayV2.source !== "return") {
          const n = nightsBetweenISO(checkIn, checkOut);
          hotelLockedOut.dates = { ...(hotelLockedOut.dates || {}), start: checkIn, end: checkOut, nights: n, source: "user" };
          hotelLockedOut.duration = { days: n + 1, source: "derived" };
        }
      } else if (hotelWindow?.source === "prompt" && !hotelLockedOut.dates) {
        hotelLockedOut.dates = { start: checkIn, end: checkOut, source: "user" };
        if (!hotelLockedOut.duration) {
          const spanDays =
            Math.round((Date.parse(checkOut) - Date.parse(checkIn)) / 86400000) + 1;
          if (spanDays > 0) hotelLockedOut.duration = { days: spanDays, source: "derived" };
        }
      }
      // A profile-office search was explicitly asked for THIS turn, so it
      // replaces any destination an earlier turn had locked.
      if (!hotelLockedOut.destination || hotelDestSource === "profile") {
        hotelLockedOut.destination = { name: hotelCity, source: hotelDestSource };
      }
      const officeHotelNote = hotelDestSource === "profile" ? officeDisclosure(hotelCity as string, "hotels") : "";
      const hotelReturnContext: any = { ...hotelCtx, id: conversationId, locked: hotelLockedOut };

      onStage?.("checking_policy");
      const hotelPolicyRules = await loadWorkspacePolicyRules((req as any).workspaceObjectId);

      // Occupancy is the one thing we assume (TBO requires PaxRooms). It is
      // DISCLOSED in the reply so the user can correct it, never silently applied.
      // v2 (S2, Q6): the trip's travellers when known; rooms = ceil(adults / 2)
      // unless they asked for separate rooms.
      const lockedTrav: any = v2 ? (hotelLockedOut as any).travellers : null;
      const knownAdults = v2 && Number(lockedTrav?.adults) > 0 ? Math.min(Number(lockedTrav.adults), 9) : 0;
      const hotelAdults = knownAdults || 2;
      const hotelRooms = v2 ? roomsFor(hotelAdults, Boolean(lockedTrav?.separateRooms)) : 1;

      // TBO prices by CityCode, never by city NAME: searchHotels rejects with a
      // 400 before any network call when it is missing, which is how this lane
      // silently never reached TBO at all. The code is already resolved — a
      // RESOLVED destination carries it, so there is no second lookup here and
      // no way for the gate and the search to disagree about which city ran.
      onStage?.("searching_hotels", { city: hotelCity });
      const hotelResult = await searchHotelsForChat({
        cityName: hotelCity,
        cityCode: (hotelDest as Extract<HotelDestination, { status: "RESOLVED" }>).cityCode,
        countryCode: hotelCountry,
        checkIn,
        checkOut,
        adults: hotelAdults,
        rooms: hotelRooms,
        starRating: extractStarFilter(prompt),
        guestNationality: (req as any).user?.nationality || "IN",
        policyRules: hotelPolicyRules,
      });

      const nights = nightsBetween(checkIn, checkOut);

      // ── Honest gap: no fabrication, no model fallback. ──
      if (!hotelResult.ok) {
        const why =
          hotelResult.reason === "NO_AVAILABILITY"
            ? `I couldn't find live availability in ${hotelCity} for ${checkIn} → ${checkOut}.`
            : hotelResult.reason === "CITY_UNRESOLVED"
              ? `I couldn't match ${hotelCity} to a bookable destination in our hotel inventory.`
              : `I couldn't pull live hotel availability for ${hotelCity} right now.`;
        await emitMetric(
          searchError({ workspaceId, requestId, reason: hotelResult.reason || "hotel_unknown" }),
        );
        return res.json({
          ok: true,
          reply: {
            title: `Hotels in ${hotelCity}`,
            context: `${officeHotelNote}${why} Rather than guess at options, I'd rather hand this to our team — they can source and hold rooms directly.`,
            nextSteps: [
              "Raise a request and our team will source options",
              "Try different dates",
            ],
            handoff: false,
          },
          context: hotelReturnContext,
        });
      }

      const inPolicyHotels = hotelResult.hotels.filter(
        (h: any) => h?.policy?.status === "IN_POLICY",
      ).length;
      await emitMetric(
        policyEvaluated({
          workspaceId,
          requestId,
          inPolicyCount: inPolicyHotels,
          totalCount: hotelResult.hotels.length,
        }),
      );

      // v2: remember this search (rows server-side only) for later turns.
      if (v2) {
        hotelReturnContext.lastSearch = {
          ...((hotelCtx as any).lastSearch || {}),
          active: "hotel",
          hotel: {
            at: Date.now(),
            city: hotelResult.cityName || hotelCity,
            cityCode: (hotelDest as Extract<HotelDestination, { status: "RESOLVED" }>).cityCode,
            countryCode: hotelCountry,
            checkIn,
            checkOut,
            adults: hotelAdults,
            rooms: hotelRooms,
            searchId: hotelResult.searchId,
            filters: hotelNear ? { near: { label: hotelNear } } : {},
            rows: hotelResult.hotels,
          },
        };
      }

      onStage?.("assembling");
      const guestsWord = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
      const occupancyLine = v2
        ? `Prices are live, in INR, for ${guestsWord(hotelAdults, "guest")} in ${guestsWord(hotelRooms, "room")}` +
          (knownAdults ? "." : " — tell me if that's not right and I'll re-search.")
        : `Prices are live, in INR, for ${hotelAdults} guests in ${hotelRooms} room — tell me if that's not right and I'll re-search.`;
      const hotelChips = [
        ...editChips,
        "Tap a hotel to continue to booking",
        "Add one to your trip",
        ...(v2 && hotelRooms < hotelAdults ? ["Separate rooms"] : []),
      ];
      return res.json({
        ok: true,
        reply: {
          title: `Hotels in ${hotelResult.cityName || hotelCity}${v2 && hotelNear ? ` near ${hotelNear}` : ""}`,
          context:
            editNote +
            // The office-profile source is disclosed BEFORE the results too.
            officeHotelNote +
            // Disclose a country→city substitution BEFORE the results, so the
            // user is never left to infer that "Qatar" silently became "Doha".
            (hotelDest.status === "RESOLVED" && hotelDest.viaCountry
              ? `You asked about ${hotelDest.viaCountry}, so I searched ${hotelResult.cityName || hotelCity} — the city we have the most properties in. Tell me another city if you meant somewhere else. `
              : "") +
            `Found ${hotelResult.hotels.length} available ${hotelResult.hotels.length === 1 ? "property" : "properties"} in ${hotelResult.cityName || hotelCity} for ${checkIn} → ${checkOut} (${nights} ${nights === 1 ? "night" : "nights"}). ` +
            occupancyLine,
          hotelSearch: {
            city: hotelResult.cityName || hotelCity,
            countryCode: hotelCountry,
            checkIn,
            checkOut,
            nights,
            adults: hotelAdults,
            rooms: hotelRooms,
            assumedOccupancy: v2 ? !knownAdults : true,
            hotels: hotelResult.hotels,
            searchId: hotelResult.searchId,
            source: "tbo",
          },
          nextSteps: hotelChips,
          handoff: false,
        },
        context: hotelReturnContext,
      });
    }

    // 2️⃣ Gather phase is owned by the AI, not a regex gate.
    //
    // The old planning-intent gate (removed here) short-circuited brand-new,
    // on-domain messages into two hardcoded replies ("…a couple more details"
    // and "Ready when you are"). It was brittle — it couldn't recognise a
    // natural continuation like "flying from Delhi on 16th Aug" as planning
    // intent, so it reset the conversation. Now these messages flow straight to
    // the AI path (classifyPlutoIntent → resolvePlutoState → invokePluto), which
    // already implements DISCOVERY clarifying-question behaviour and persists +
    // returns a stable id. The off-domain guard above still protects cost/scope,
    // and the flight-search / flight-status branches still run before the AI.
    // NOTE: gather turns now reach OpenAI (an intended increase in AI calls).

    /* ───────── Normalize context (Memory Check) ───────── */
    trace.branch = "ai_path";
    let conversationContext: any;

    const existingId = context?.id || req.body?.conversationId;

    if (v2) {
      // Already loaded, owner-scoped, before any branch ran (runConciergeTurn).
      conversationContext = context && typeof context === "object" ? context : { summary: "" };
    } else if (existingId) {
      // Tenant-scoped read: identity from req (never the client body). A
      // wrong-workspace or malformed conversationId returns null, exactly like a
      // miss, and falls back to the client-supplied context.
      const saved = await getConversationContext({
        workspaceObjectId: (req as any).workspaceObjectId,
        userId: (req as any).user?._id,
        conversationId: existingId,
      });
      conversationContext =
        saved ||
        (context && typeof context === "object" ? context : { summary: "" });
    } else {
      conversationContext =
        context && typeof context === "object" ? context : { summary: "" };
    }

    if (!conversationContext.id) {
      // Reuse the id established up front (existing id, or the new uuid) so the
      // AI-path reply carries the SAME id every early gate already returns.
      conversationContext.id = conversationId;
    }

    if (!conversationContext.locked) {
      conversationContext.locked = {};
    }

    /* ───────── VIDEO CONTEXT ATTACHMENT (PRODUCTION SAFE) ───────── */
    // ✅ FIX: attachVideoContext runs FIRST (soft signals only)
    if (videoAnalysisId) {
      conversationContext = await attachVideoContext(
        conversationContext,
        videoAnalysisId
      );

      // 🔥 Reset any previous soft assumptions on new evidence
      if (!conversationContext.locked?.destination) {
        if (conversationContext.assumed?.destination) {
          delete conversationContext.assumed.destination;
        }
      }
    }

    // ✅ FIX BUG #1 & #2: Apply context patch AFTER attachVideoContext
    // Always rebuild from DB — never trust client-sent contextPatch
    // This ensures locked context wins over soft video assumptions
    if (videoAnalysisId) {
      const video = await VideoAnalysis.findOne({ _id: videoAnalysisId, workspaceId: (req as any).workspaceObjectId })
        .select("userConsent insights")
        .lean();

      if (video?.userConsent === "yes") {
        const dbPatch: any = {};

        const dest = video.insights?.destinations?.[0];
        if (dest) {
          dbPatch.destination = {
            name: dest.city
              ? `${dest.city}, ${dest.country}`
              : dest.country,
            source: "video",
            confidence: dest.confidence,
          };
        }

        if (video.insights?.idealDays) {
          dbPatch.duration = {
            days: video.insights.idealDays,
            source: "video",
          };
        }

        if (video.insights?.tripStyle) {
          dbPatch.tripStyle = {
            value: video.insights.tripStyle,
            source: "video",
          };
        }

        // ✅ DB is authoritative — merge into locked, overrides soft signals
        conversationContext.locked = {
          ...conversationContext.locked,
          ...dbPatch,
        };
      }
    }

    /* ───────── DATE RANGE NORMALIZATION (AUTHORITATIVE) ───────── */

    // Detect patterns like "2nd April to 8th April 2026"
    const dateRangeMatch = prompt.match(
      /(\d{1,2})(st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{4})?\s+(to|-)\s+(\d{1,2})(st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{4})?/i
    );

    if (dateRangeMatch && !conversationContext.locked?.dates) {
      const year =
        dateRangeMatch[4] || dateRangeMatch[9] || new Date().getFullYear();

      const start = new Date(
        `${dateRangeMatch[1]} ${dateRangeMatch[3]} ${year}`
      );
      const end = new Date(
        `${dateRangeMatch[6]} ${dateRangeMatch[8]} ${year}`
      );

      if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
        const diffDays =
          Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;

        conversationContext.locked.dates = {
          start: start.toISOString().slice(0, 10),
          end: end.toISOString().slice(0, 10),
          source: "user",
        };

        conversationContext.locked.duration = {
          days: diffDays,
          source: "derived",
        };
      }
    }

    /* ───────── LOCK USER-STATED FACTS (PRE-AI, ACCUMULATIVE) ─────────
     * lockDecisions() runs on the AI REPLY and has no home for facts the USER
     * states in prose (destination / origin / dates / duration / purpose).
     * Capture them from the prompt here so the AI sees them as LOCKED (and does
     * not re-ask), and so they PERSIST and ACCUMULATE across turns via memory /
     * the round-tripped context. Set-if-absent: a later turn ADDS new facts
     * without dropping earlier ones (turn 2's Delhi + dates never clobber turn
     * 1's Tokyo). A video-locked destination is never overridden.
     */
    {
      const L = conversationContext.locked;

      // Destination — "trip to Tokyo", "flying to Tokyo", "to Tokyo".
      // Require a capitalised token (proper-noun heuristic) to avoid capturing
      // verbs like "to go". Never override a video-locked destination.
      if (!L.destination) {
        const destM =
          prompt.match(/\b(?:trip|travel|traveling|travelling|fly|flying|go|going|head|heading|visit|visiting)\s+to\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)/) ||
          prompt.match(/\bto\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)\b/);
        if (destM) L.destination = { name: destM[1], source: "user" };
      }

      // Origin — "from Delhi", "flying from Delhi", "departing Delhi".
      if (!L.origin) {
        const origM = prompt.match(/\b(?:from|departing|departing from|flying from|leaving|leaving from)\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)/);
        if (origM) L.origin = { city: origM[1], source: "user" };
      }

      // Duration — "3-day", "3 day", "3 days", "3 nights", "5N".
      if (!L.duration) {
        const durM =
          prompt.match(/\b(\d+)\s*[-\s]?\s*(?:day|days|night|nights)\b/i) ||
          prompt.match(/\b(\d+)\s*N\b/);
        if (durM) L.duration = { days: parseInt(durM[1], 10), source: "user" };
      }

      // Dates — one or two natural-language dates NOT joined by "to"/"-" (that
      // form is handled by the range normaliser above), e.g. "16th Aug … 20th
      // Aug". First token = start, second (if any) = end; derive duration.
      if (!L.dates) {
        // ONE parser, shared with the hotel ownership gate above
        // (resolveHotelSearchWindow → extractPromptDateRange). They used to be
        // two copies running ~240 lines apart, which is what made a first-turn
        // dated hotel prompt invisible to the gate. Same patterns, same
        // missing-year rule — behaviour here is unchanged.
        const parsed = extractPromptDateRange(prompt);
        const start = parsed?.start ?? null;
        const end = parsed?.end ?? null;
        if (start) {
          L.dates = { start, ...(end ? { end } : {}), source: "user" };
          if (end && !L.duration) {
            const diff = Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
            if (diff > 0) L.duration = { days: diff, source: "derived" };
          }
        }
      }

      // Trip purpose / type — only if not already committed.
      if (!L.tripType) {
        if (/\bbusiness\b|\bwork trip\b|\bconference\b/i.test(prompt)) L.tripType = "business";
        else if (/\bholiday\b|\bleisure\b|\bvacation\b|\bhoneymoon\b|\bgetaway\b|\banniversary\b/i.test(prompt)) L.tripType = "holiday";
        else if (/\boffsite\b|\bretreat\b|\bmice\b|\bteam\s+trip\b/i.test(prompt)) L.tripType = "mice";
      }

      // v2 (S2): travellers the user states ("2 of us", "for 3 people") are
      // kept for every later search until they change them (§1.2).
      if (v2) {
        const pax =
          prompt.match(/\b(?:for\s+)?(\d)\s+(?:people|persons|pax|passengers|adults|travell?ers|guests)\b/i) ||
          prompt.match(/\b(\d)\s+of\s+us\b/i);
        if (pax && parseInt(pax[1], 10) >= 1) {
          L.travellers = { ...(L.travellers || {}), adults: parseInt(pax[1], 10), source: "user" };
        }
      }

      // Budget — "under USD 200", "beyond USD 500", "between ₹5k and ₹8k",
      // "under 15k", "around $300", + relative "cheaper"/"more premium". Unlike
      // the facts above this UPDATES on restatement (and relative terms adjust
      // off the current budget), so it is NOT set-if-absent.
      const parsedBudget = parseBudget(prompt, L.budget);
      if (parsedBudget) L.budget = parsedBudget;
    }

    /* ───────── VIDEO RELEVANCE GATE (ABSOLUTE TRUTH) ───────── */
    if (videoAnalysisId) {
      const video = await VideoAnalysis.findOne({ _id: videoAnalysisId, workspaceId: (req as any).workspaceObjectId })
        .select("classification status summaryType")
        .lean();

      if (!video) {
        return res.json({
          ok: true,
          reply: {
            title: "Video not found",
            context: "I couldn't locate the uploaded video. Please try again.",
            handoff: false,
          },
          context: conversationContext,
        });
      }

      if (video.status !== "analyzed") {
        return res.json({
          ok: true,
          reply: {
            title: "Video analysis in progress",
            context:
              "I've received the video and it's still being analyzed. Once it's ready, I can help with travel inspiration.",
            handoff: false,
          },
          context: conversationContext,
        });
      }

      /* ───────── SUMMARY-FIRST VIDEO GATE (AUTHORITATIVE) ───────── */

      // If summary exists, it is the single source of truth
      if (video.summaryType) {
        if (video.summaryType !== "travel") {
          return res.json({
            ok: true,
            reply: {
              title: "Travel planning unavailable",
              context:
                "I've analyzed the video, but it isn't about travel, so I won't plan a trip from it.",
              handoff: false,
            },
            context: conversationContext,
          });
        }
      }

      // Fallback ONLY if summary not ready (temporary safety net)
      else if (video.classification && video.classification !== "confirmed-travel") {
        return res.json({
          ok: true,
          reply: {
            title: "Travel planning unavailable",
            context:
              "The video analysis is still maturing. Once it's clearer, I can plan a trip from it.",
            handoff: false,
          },
          context: conversationContext,
        });
      }
    }

    /* ───────── VIDEO-DERIVED DESTINATION (ASSUMED, NOT LOCKED) ───────── */
    if (
      conversationContext.videoInsights &&
      Array.isArray(conversationContext.videoInsights.destinations) &&
      conversationContext.videoInsights.destinations.length > 0 &&
      !conversationContext.locked?.destination
    ) {
      const topDestination = [...conversationContext.videoInsights.destinations]
        .sort((a, b) => b.confidence - a.confidence)[0];

      // Conservative threshold to avoid hallucination
      if (
        topDestination &&
        typeof topDestination.name === "string" &&
        topDestination.confidence >= 0.85
      ) {
        conversationContext.assumed = conversationContext.assumed || {};
        conversationContext.assumed.destination = {
          name: topDestination.name,
          source: "video",
          confidence: topDestination.confidence,
        };
      }
    }

    /* ───────── Metrics: conversation start ───────── */
    if (!conversationContext.startedAt) {
      conversationContext.startedAt = Date.now();
      conversationContext.turn = 0;
      await emitMetric(conversationStarted(conversationContext.id));
    }

    conversationContext.turn += 1;

    /* ───────── State & locks ───────── */
    if (!conversationContext.state) {
      conversationContext.state = "DISCOVERY" as PlutoConversationState;
    }

    const stateBefore = conversationContext.state;
    const lockedBefore = JSON.parse(JSON.stringify(conversationContext.locked));

    /* ───────── Intent → state ───────── */
    const intent = classifyPlutoIntent(prompt);

    conversationContext.state = resolvePlutoState(
      conversationContext.state,
      intent
    );

    // Coherence: once destination AND duration are known, DISCOVERY graduates to
    // PLANNING so the PLANNING / ALWAYS-GIVE-VALUE rules (draft skeleton) apply
    // instead of DISCOVERY's "destination unknown" behaviour.
    {
      const destKnownNow = Boolean(
        conversationContext.locked?.destination?.name ||
        conversationContext.assumed?.destination?.name
      );
      const durationKnownNow = Boolean(
        conversationContext.locked?.duration?.days ||
        (conversationContext.locked?.dates?.start && conversationContext.locked?.dates?.end)
      );
      if (conversationContext.state === "DISCOVERY" && destKnownNow && durationKnownNow) {
        conversationContext.state = "PLANNING";
      }
    }

    if (stateBefore !== conversationContext.state) {
      await emitMetric(
        stateTransition(
          conversationContext.id,
          stateBefore,
          conversationContext.state,
          conversationContext.turn
        )
      );
    }

    /* ───────── RM Feedback / Human-in-the-loop Hint ───────── */
    const rmHint = conversationContext.locked.lastRmNote
      ? `\n[INTERNAL NOTE FROM HUMAN MANAGER]: ${conversationContext.locked.lastRmNote}\n(Respect this note as authoritative over previous AI suggestions.)\n`
      : "";

    /* ───────── Hotel-only refinement ───────── */
    // A prior HOTEL shortlist (lastReply.hotels[]) counts as much as an
    // itinerary[] — otherwise a hotel→hotel follow-up (e.g. "show me hotels
    // beyond USD 500") drops out of this guarded branch into the generic path
    // and the model reverts to re-asking locked facts.
    const isHotelOnlyFollowup =
      /hotel|stay|accommodation/i.test(prompt) &&
      typeof lastReply === "object" &&
      (Array.isArray(lastReply?.itinerary) || Array.isArray(lastReply?.hotels));

    const lockedContext =
      Object.keys(conversationContext.locked).length > 0
        ? `\nLOCKED DECISIONS:\n${JSON.stringify(
            conversationContext.locked,
            null,
            2
          )}\n`
        : "";

    /* ───────── Real-Time Flight Data — REMOVED (0.3) ─────────
     * A live-status fetch used to happen HERE and was injected into the model
     * prompt as "[VERIFIED LIVE FLIGHT DATA — USE THIS AS ABSOLUTE TRUTH]",
     * with a NO-HALLUCINATE fallback block when the fetch failed. That laundered
     * real flight facts through the model, and doubled the paid AeroAPI calls
     * (the frontend fetched the same status independently).
     *
     * Flight status is now owned by the dedicated branch at the top of this
     * function: one bounded AeroAPI call, correct occurrence, reply composed in
     * code, and the model is never in the loop. The prompt no longer carries any
     * flight-status block, and plutoSystemPrompt no longer asks for one.
     */

    /* ───────── VIDEO CONTEXT INJECTION (AUTHORITATIVE) ───────── */
    const videoContextString =
      conversationContext.videoInsights &&
      typeof conversationContext.videoInsights === "object"
        ? `\n[VIDEO-DERIVED TRAVEL SIGNALS — TREAT AS AUTHORITATIVE]:
The following information has already been extracted from the user's video and is reliable.
Do not say that you cannot see or access the video.
If a destination is clearly indicated here, refer to it explicitly by name unless the user contradicts it.

${JSON.stringify(conversationContext.videoInsights, null, 2)}\n`
        : "";

    /* ───────── ASSUMED CONTEXT (SOFT, OVERRIDEABLE) ───────── */
    const assumedContext =
      conversationContext.assumed &&
      conversationContext.assumed.destination
        ? `\nASSUMED CONTEXT (derived from prior signals, user can override):
Destination: ${conversationContext.assumed.destination.name}
Source: ${conversationContext.assumed.destination.source}
Confidence: ${conversationContext.assumed.destination.confidence}\n`
        : "";

    /* ───────── QUESTION PRIORITY LADDER (AUTHORITATIVE) ─────────
     * The AI used to be told only whether destination/duration were missing and
     * then free-picked low-value questions (hotel style, airport transfers) while
     * the trip-defining facts (dates, origin) went unasked. Compute the missing
     * rungs IN PRIORITY ORDER — destination → dates → origin — and hand the AI an
     * ordered, authoritative list. Every rung here is one the extractor can lock,
     * so the ladder descends turn over turn (no re-asking, no stalling).
     */
    const hasLockedDestination = Boolean(
      conversationContext.locked?.destination?.name
    );
    // ✅ FIX BUG #3: Also treat assumed destination as sufficient to proceed
    const hasAssumedDestination = Boolean(
      conversationContext.assumed?.destination?.name
    );
    const hasLockedDuration =
      Boolean(conversationContext.locked?.duration?.days) ||
      Boolean(
        conversationContext.locked?.dates?.start &&
        conversationContext.locked?.dates?.end
      );
    const hasLockedDates = Boolean(conversationContext.locked?.dates?.start);
    const hasLockedOrigin = Boolean(conversationContext.locked?.origin?.city);

    const missingFields: string[] = [];
    if (!hasLockedDestination && !hasAssumedDestination) missingFields.push("destination");
    if (!hasLockedDates) missingFields.push("dates");
    if (!hasLockedOrigin) missingFields.push("origin");

    // Persist explicitly so AI cannot guess
    if (missingFields.length > 0) {
      conversationContext.missingFields = missingFields;
    } else {
      delete conversationContext.missingFields;
    }

    // 🆕 EXPLICIT MISSING FIELDS INJECTION (AUTHORITATIVE, PRIORITY-ORDERED)
    const missingFieldsString = conversationContext.missingFields
      ? `\nMISSING_FIELDS (already in priority order — ask ONLY the top 1-2 as direct nextSteps questions, nothing else):\n${JSON.stringify(
          conversationContext.missingFields,
          null,
          2
        )}\n`
      : "";

    // Plan-readiness signal — reinforces the ALWAYS-GIVE-VALUE rule per turn and
    // gates the substance enforce-retry below.
    const canPlan = (hasLockedDestination || hasAssumedDestination) && hasLockedDuration;
    const planReadinessString = canPlan
      ? `\nPLAN_READINESS: destination and duration are KNOWN — you MUST include a draft day-by-day "itinerary" skeleton (clearly marked as a draft to refine) and a "context" of at least 2-3 substantive sentences. Do not merely echo the destination.\n`
      : "";

    // Budget steer — respect the locked budget in hotel suggestions, and (since
    // this is an INR platform) state the conversion basis when the budget is USD.
    const lockedBudget = conversationContext.locked?.budget;
    const budgetGuidanceString = lockedBudget
      ? `\nBUDGET: the user's hotel budget is ${describeBudget(lockedBudget)} (also in LOCKED DECISIONS). Keep hotel suggestions' approxPrice within this range. ${lockedBudget.currency === "USD" ? "The budget is in USD on this INR platform — state the indicative INR conversion you used (or present both USD and INR)." : ""}\n`
      : "";

    // Locked facts are ground truth — bound to EVERY turn that already has a
    // destination (fork b), not just hotel turns. A reply re-asking any locked
    // fact is invalid. Fresh gather-phase turns (no locked destination) get an
    // empty string, so the gather / spillproof behaviour is unchanged.
    const lockedGroundTruthList = [
      hasLockedDestination && "destination",
      hasLockedDates && "travel dates",
      hasLockedOrigin && "origin city",
      hasLockedDuration && "trip duration",
    ].filter(Boolean);
    const lockedGroundTruthString = hasLockedDestination
      ? `\nLOCKED FACTS ARE GROUND TRUTH: the ${lockedGroundTruthList.join(", ")} in LOCKED DECISIONS are CONFIRMED. A reply that asks the user for ANY of these is INVALID — never re-ask them; use them directly to answer the request.\n`
      : "";

    /* ───────── Detect if last reply was a flight search (suppress redundant follow-ups) ───────── */
    const lastReplyWasFlightSearch = lastReply && typeof lastReply === "object" && Boolean(lastReply.flightSearch);

    const flightSearchSuppression = lastReplyWasFlightSearch
      ? `
CRITICAL RULE — FLIGHT SEARCH CONTEXT:
The previous response already provided flight search links to the user.
DO NOT ask any more questions about: departure time, budget, stops, airline preferences, or flight parameters.
The user can open the links to see all options. 
Your nextSteps should ONLY be about completing the trip plan (itinerary refinements, hotel bookings, visa tips etc.).
`
      : "";

    /* ───────── Construct Persona-Driven Prompt ───────── */
    const promptHeader =
      `SYSTEM INSTRUCTION: ${PLUTO_SYSTEM_PROMPT}\n\n` +
      `CRITICAL: When flight data is provided, your "context" field must ONLY reflect the cities and airports in that data. Do not use your own memory for routes.\n` +
      `CURRENT CONVERSATION STATE: ${conversationContext.state}\n` +
      `${flightSearchSuppression}\n` +
      `${planReadinessString}\n` +
      `${budgetGuidanceString}\n` +
      `${lockedGroundTruthString}\n` +
      `${missingFieldsString}\n` +
      `${lockedContext}\n` +
      `${assumedContext}\n` +
      `${videoContextString}\n` +
      `${rmHint}`;

    let effectivePrompt = "";

    if (isHotelOnlyFollowup) {
      effectivePrompt = `
${promptHeader}

USER INTENT: HOTEL REFINEMENT
Request: ${prompt}
Instruction: User wants ONLY additional hotel suggestions. Do NOT modify the existing itinerary.
`;
    } else if (conversationContext.summary) {
      effectivePrompt = `
${promptHeader}

PREVIOUS TRAVEL SUMMARY:
${conversationContext.summary}

User request:
${prompt}
`;
    } else {
      effectivePrompt = `
${promptHeader}

User request:
${prompt}
`;
    }

    onStage?.("consulting_ai");
    trace.branch = "ai";
    trace.aiCalled = true;
    /* ───────── Invoke AI (OpenAI with Gemini Fallback) ───────── */
    let deltaReply: PlutoDeltaReply;

    // Locked facts (with values) the reply must not re-ask (v2 enforcement).
    // Only populated fields are passed, so the invoke loop only guards facts
    // that are actually locked.
    const L = conversationContext.locked || {};
    const lockedFacts = {
      ...(L.destination?.name ? { destination: L.destination.name } : {}),
      ...(L.dates?.start
        ? { dates: L.dates.end ? `${L.dates.start} to ${L.dates.end}` : L.dates.start }
        : {}),
      ...(L.origin?.city ? { origin: L.origin.city } : {}),
      ...(L.duration?.days ? { duration: `${L.duration.days} days` } : {}),
    };
    const hasLockedFacts = Object.keys(lockedFacts).length > 0;

    // Step 3 — substance enforcement (only when the trip is already plannable) +
    // v2 locked-fact enforcement (only when facts are locked). A thin OR
    // reask-locked reply earns ONE corrective retry inside invoke*; if it still
    // fails it is ACCEPTED (never an error) and the matching metric fires.
    const invokeOpts = {
      requireSubstance: canPlan,
      onThinAccepted: () => {
        void emitMetric(
          replyThinAccepted({
            workspaceId,
            requestId,
            conversationId: conversationContext.id,
            reason: "post_retry",
          })
        );
      },
      lockedFacts: hasLockedFacts ? lockedFacts : null,
      onReaskedLockedAccepted: () => {
        void emitMetric(
          replyReaskedLocked({
            workspaceId,
            requestId,
            conversationId: conversationContext.id,
            reason: "post_retry",
          })
        );
      },
    };

    try {
      deltaReply = await invokePluto(effectivePrompt, invokeOpts);
    } catch (openaiErr: any) {
      await emitMetric(
        aiFallback({
          workspaceId,
          requestId,
          conversationId: conversationContext.id,
          reason: openaiErr?.message || "openai_error",
        })
      );
      console.warn("[Pluto] OpenAI failed, switching to Gemini backup", { requestId });
      try {
        deltaReply = await invokePlutoGemini(effectivePrompt, invokeOpts);
      } catch (geminiErr: any) {
        // Distinguish a schema-invalid fallback (after its own retry) from a
        // transport/parse failure, so the metric is actionable.
        const invalidSchema = geminiErr?.message === GEMINI_FALLBACK_INVALID;
        await emitMetric(
          (invalidSchema ? aiFallbackInvalid : aiError)({
            workspaceId,
            requestId,
            conversationId: conversationContext.id,
            reason: geminiErr?.message || "both_engines_failed",
          })
        );
        throw geminiErr; // outer catch → loud 500 (no malformed JSON downstream)
      }
    }

    /* 🔒 Promote ONCE to full reply */
    const fullReply: PlutoReplyV1 = deltaReply as PlutoReplyV1;

    if (isHotelOnlyFollowup && Array.isArray(lastReply?.itinerary)) {
      fullReply.itinerary = lastReply.itinerary;
    }

    /* ───────── Itinerary hotel section — live lane supersedes fabrication ─────────
     * PLAN_READINESS above tells the model to draft a day-by-day itinerary
     * and, per plutoSystemPrompt.ts's schema, an optional "hotels" array —
     * which the model fills with INVENTED names/prices ("3-day business
     * trip to Tokyo" rendered a fabricated Peninsula/Park Hyatt/Mandarin
     * list even though Tokyo resolves live, 6fedd53). Same precedent
     * plutoSystemPrompt.ts already documents for flightStatus: once a
     * dedicated live path can answer a domain, the model's own answer for
     * it must never reach the user — it can only ever compete with real
     * data, never usefully supplement it.
     *
     * Hotels don't have a separate early-return branch to lean on here the
     * way flightStatus does: the deterministic hotelLed branch far above
     * only fires for a hotel-WORDED prompt ("hotels in Tokyo"), and "3-day
     * business trip to Tokyo" is a planning prompt — hotelIntent is false,
     * so hotelLed never runs and this turn falls all the way through to
     * the model. destination/dates are still available independently of
     * that, though: the PRE-AI "LOCK USER-STATED FACTS" block (~line 1594)
     * extracts them from prose generally, not just hotel-worded prompts —
     * conversationContext.locked.destination/.dates already reflect
     * whatever this conversation knows by this point, itinerary or not.
     *
     * Three outcomes, in order of preference — never fabrication:
     *   1. City resolves live AND we have real dates (this turn's or an
     *      earlier turn's, from ANY prompt shape) → run the exact same
     *      live search the hotel-led branch runs, and set hotelSearch so
     *      the SAME LiveHotelTiers renderer used everywhere else in this
     *      UI takes over — ConciergePage.tsx already prefers hotelSearch
     *      over hotels whenever both are present.
     *   2. City resolves live but no dates yet → suppress the fabricated
     *      list entirely (no partial trust) and ask for dates via
     *      nextSteps — the SAME "ask, don't guess" posture the "COUNTRY
     *      NAMED, NO DATES" branch above already uses for a different
     *      shape of this exact problem. A guessed date window would show
     *      real prices/availability for a stay nobody confirmed, which is
     *      its own kind of misleading — worse than asking. Once the user
     *      replies with dates (any wording — the LOCK block above reads
     *      prose generally), this same block reruns as outcome 1 on the
     *      very next turn.
     *   3. City doesn't resolve at all (UNSUPPORTED) → honest handoff,
     *      still no fabrication — mirrors the standalone hotel lane's own
     *      UNSUPPORTED branch above.
     *   4. NO_CITY → strip and log. canPlan gates the ITINERARY on a known
     *      destination, but nothing stops the model emitting hotels[] on a
     *      gather turn with no city at all (audit 2026-11-09); those can
     *      only be invented, so they never reach the user.
     *
     * Scope: hotels only. The itinerary skeleton (fullReply.itinerary) and
     * flight section are untouched by this block.
     * ───────────────────────────────────────────────────────────────────── */
    if (Array.isArray(fullReply.hotels) && fullReply.hotels.length > 0) {
      const itineraryDest = await resolveHotelDestination(prompt, conversationContext.locked);
      const itineraryDates = conversationContext.locked?.dates;
      const itineraryCheckIn: string | null = itineraryDates?.start || null;
      const itineraryCheckOut: string | null = itineraryDates?.end || null;
      // v2 (S2): the trip's travellers, two to a room (Q6); otherwise as before.
      const itinTrav: any = v2 ? conversationContext.locked?.travellers : null;
      const itinAdults = v2 && Number(itinTrav?.adults) > 0 ? Math.min(Number(itinTrav.adults), 9) : 2;
      const itinRooms = v2 ? roomsFor(itinAdults, Boolean(itinTrav?.separateRooms)) : 1;
      const itinAssumed = !(v2 && Number(itinTrav?.adults) > 0);

      if (itineraryDest.status === "RESOLVED" && itineraryCheckIn && itineraryCheckOut) {
        const itineraryPolicyRules = await loadWorkspacePolicyRules((req as any).workspaceObjectId);
        const itineraryHotelResult = await searchHotelsForChat({
          cityName: itineraryDest.cityName,
          cityCode: itineraryDest.cityCode,
          countryCode: itineraryDest.countryCode,
          checkIn: itineraryCheckIn,
          checkOut: itineraryCheckOut,
          adults: itinAdults,
          rooms: itinRooms,
          starRating: extractStarFilter(prompt),
          guestNationality: (req as any).user?.nationality || "IN",
          policyRules: itineraryPolicyRules,
        });

        // Cleared unconditionally the moment a live search actually ran —
        // never rendered alongside, or as a fallback under, a real result
        // (including a real "found nothing").
        fullReply.hotels = undefined;

        if (itineraryHotelResult.ok && itineraryHotelResult.hotels.length > 0) {
          if (v2) {
            conversationContext.lastSearch = {
              ...(conversationContext.lastSearch || {}),
              active: "hotel",
              hotel: {
                at: Date.now(),
                city: itineraryHotelResult.cityName || itineraryDest.cityName,
                cityCode: itineraryDest.cityCode,
                countryCode: itineraryDest.countryCode,
                checkIn: itineraryCheckIn,
                checkOut: itineraryCheckOut,
                adults: itinAdults,
                rooms: itinRooms,
                searchId: itineraryHotelResult.searchId,
                filters: {},
                rows: itineraryHotelResult.hotels,
              },
            };
          }
          fullReply.hotelSearch = {
            city: itineraryHotelResult.cityName || itineraryDest.cityName,
            countryCode: itineraryDest.countryCode,
            checkIn: itineraryCheckIn,
            checkOut: itineraryCheckOut,
            nights: nightsBetween(itineraryCheckIn, itineraryCheckOut),
            adults: itinAdults,
            rooms: itinRooms,
            assumedOccupancy: itinAssumed,
            hotels: itineraryHotelResult.hotels,
            searchId: itineraryHotelResult.searchId,
            source: "tbo",
          };
        }
        // else: live search ran and found nothing / failed — honest gap.
        // fullReply.hotels is already cleared above; nothing further to add.
      } else if (itineraryDest.status === "RESOLVED") {
        fullReply.hotels = undefined;
        // Structured, not a nextSteps string: ConciergePage.tsx renders this
        // INLINE as the "01 · Stays" section's own dates-ask (with its own
        // chip), instead of a generic bottom-row question indistinguishable
        // from the flight questions next to it.
        fullReply.hotelsAwaitingDates = { city: itineraryDest.cityName };
      } else if (itineraryDest.status === "AMBIGUOUS") {
        // Same rule as the standalone lane: several real cities, so the
        // fabricated list goes and the itinerary asks which one rather than
        // pricing a guess into a plan the user will act on.
        fullReply.hotels = undefined;
        fullReply.hotelsAwaitingCity = {
          query: itineraryDest.query,
          candidates: itineraryDest.candidates,
        };
      } else if (itineraryDest.status === "UNSUPPORTED") {
        fullReply.hotels = undefined;
      } else if (itineraryDest.status === "NO_CITY") {
        // The model listed hotels while NO city is known — not named this
        // turn, none locked. Nothing it listed can be searched or booked, so
        // it is invented by construction ("hotels near my office" with no
        // office on file was the live shape of this). Strip and log it.
        const strippedCount = fullReply.hotels?.length ?? 0;
        fullReply.hotels = undefined;
        console.warn("[Pluto] stripped model-generated hotels on a NO_CITY turn", {
          requestId,
          conversationId: conversationContext.id,
          count: strippedCount,
        });
      }
    }

    /* ───────── Context Evolution ───────── */
    if (fullReply.context) {
      conversationContext.summary = fullReply.context;
    }

    /* ───────── Decision locking ───────── */
    conversationContext.locked = lockDecisions(
      fullReply,
      conversationContext.locked,
      intent
    );

    if (conversationContext.locked.lastRmNote) {
      delete conversationContext.locked.lastRmNote;
    }

    /* ───────── Handoff readiness ───────── */
    fullReply.handoff = isHandoffReady(
      conversationContext.state,
      conversationContext.locked,
      fullReply.nextSteps
    );

    if (fullReply.handoff === true) {
      await emitMetric(
        handoffTriggered(conversationContext.id, conversationContext.turn)
      );

      // Idempotency: deliver AT MOST ONCE per conversation. The guard is now
      // SERVER-SIDE and cross-instance — an atomic claim on the Mongo conversation
      // store (handoffDelivered false→true). A stripped client flag or a second
      // App Runner instance cannot cause a duplicate; the DB flag is
      // authoritative. The context flag is kept only as a secondary UI echo.
      const claimed = await claimHandoffDelivery({
        workspaceObjectId: (req as any).workspaceObjectId,
        userId: (req as any).user?._id,
        conversationId: conversationContext.id,
      });
      if (claimed) {
        const payload = buildHandoffPayload(
          fullReply,
          conversationContext.state,
          conversationContext.locked
        );

        const reqUser = (req as any).user || {};
        const result = await sendHandoffPayload(payload, {
          workspaceObjectId: (req as any).workspaceObjectId,
          requesterId: reqUser._id,
          requesterEmail: reqUser.email,
          requesterName: reqUser.name,
          conversationId: conversationContext.id,
        });

        if (result.delivered) {
          conversationContext.handoffDelivered = true; // secondary UI echo
          conversationContext.handoffRequestId = result.requestId;
          await emitMetric(
            handoffDelivered({
              workspaceId,
              requestId,
              conversationId: conversationContext.id,
              reason: result.requestId,
            })
          );
        } else {
          // Delivery failed after claiming → release the claim so a later turn
          // can retry (never lock on failure).
          await releaseHandoffDelivery({
            workspaceObjectId: (req as any).workspaceObjectId,
            conversationId: conversationContext.id,
          });
          // Never silent: emit an error metric AND surface to the user.
          await emitMetric(
            handoffFailed({
              workspaceId,
              requestId,
              conversationId: conversationContext.id,
              reason: result.error,
            })
          );
          (fullReply as any).handoffError =
            "I couldn't reach our travel desk automatically — please tap \"Raise a request\" and we'll pick it up.";
        }
      }
    }

    /* ───────── Save to Memory (tenant-scoped upsert) ───────── */
    // v2 commits once at the end of the turn instead (runConciergeTurn).
    if (!v2) {
      await saveConversationContext({
        workspaceObjectId: (req as any).workspaceObjectId,
        userId: (req as any).user?._id,
        conversationId: conversationContext.id,
        context: conversationContext,
      });
    }

    /* ───────── Delta API response ───────── */
    const responseDelta = reduceToDelta(fullReply, lastReply);

    /* ───────── Debug snapshot ───────── */
    emitPlutoDebug({
      timestamp: new Date().toISOString(),
      prompt,
      intent,
      state: { before: stateBefore, after: conversationContext.state },
      locked: { before: lockedBefore, after: conversationContext.locked },
      reply: { full: fullReply, delta: responseDelta },
      handoff: fullReply.handoff,
    });

    onStage?.("assembling");
    return res.json({
      ok: true,
      reply: responseDelta,
      context: conversationContext,
    });
  } catch (err: any) {
    console.error("Pluto travel error:", { requestId, message: err?.message, stack: err?.stack });
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to generate travel response",
      requestId,
    });
  }
}

// POST / — delegates to runConciergeTurn with NO stage listener. Byte-identical
// to the previous handler (onStage is undefined → every onStage?.() is a no-op).
router.post("/", async (req, res) => runConciergeTurn(req, res));

/**
 * POST /stream — same request body as POST /, streamed as SSE progress events:
 *   event:status {stage} … → event:final {<same reply JSON POST / returns>}
 *   → event:done. On failure → event:error {message, requestId}. Never drops the
 *   connection without an error event.
 *
 * Flush discipline mirrors chat.ts (Amendment M): the global compression() makes
 * any un-flushed frame a silent stall, so every write is followed by res.flush().
 */
router.post("/stream", async (req: any, res: any) => {
  const streamId = crypto.randomUUID();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const socket = (res as any).socket;
  if (socket) { socket.setNoDelay(true); socket.setTimeout(0); }

  const write = (event: string, data: any) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
    if (typeof (res as any).flush === "function") (res as any).flush();
  };

  // Heartbeat comment every 15s while a stage runs (proxy keep-alive), flushed.
  // Interval is overridable (CONCIERGE_SSE_HEARTBEAT_MS) purely for tests.
  const heartbeatMs = Number(process.env.CONCIERGE_SSE_HEARTBEAT_MS) || 15_000;
  const heartbeat = setInterval(() => {
    if (res.writableEnded) { clearInterval(heartbeat); return; }
    res.write(`: keep-alive\n\n`);
    if (typeof (res as any).flush === "function") (res as any).flush();
  }, heartbeatMs);

  // Capture the turn's res.json/status without any real socket write.
  const captured: { statusCode: number; body: any } = { statusCode: 200, body: undefined };
  const captureRes: any = {
    status(code: number) { captured.statusCode = code; return captureRes; },
    json(body: any) { captured.body = body; return captureRes; },
  };

  try {
    await runConciergeTurn(req, captureRes, (stage: string, detail?: Record<string, unknown>) =>
      write("status", { stage, ...(detail || {}) }),
    );
    if (captured.statusCode >= 400) {
      write("error", {
        message: captured.body?.message || "Failed to generate travel response",
        requestId: captured.body?.requestId || streamId,
      });
    } else {
      write("final", captured.body);
      write("done", {});
    }
  } catch (err: any) {
    write("error", { message: err?.message || "Failed to generate travel response", requestId: streamId });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});

/* ────────────────────────────────────────────────────────────────
 * POST /raise-request — Concierge → SBT request pipeline
 * ──────────────────────────────────────────────────────────────── */
router.post("/raise-request", requireWorkspace, async (req: any, res: any) => {
  try {
    const user = req.user;
    if (!user?._id) return res.status(401).json({ error: "Unauthorized" });

    const { flightData, passengers, notes, tripBundle, conversationId, watchOptIn, whatsappNumber, itineraryId } = req.body;

    // Phase 5: full-context itinerary submit. When itineraryId is present the
    // (workspace-scoped) itinerary is the source of truth; otherwise this is the
    // legacy single-flight path with its strict flightData validation intact.
    let itinerary: any = null;
    if (itineraryId) {
      // Owner-scoped: a user can only submit (and mark SUBMITTED) their own.
      itinerary = await Itinerary.findOne({ _id: itineraryId, workspaceId: (req as any).workspaceObjectId, createdByUserId: user._id });
      if (!itinerary) return res.status(404).json({ error: "Itinerary not found" });
    }
    const outboundItem = itinerary ? itinerary.items.find((i: any) => i.kind === "FLIGHT_OUTBOUND") : null;
    const hotelItem = itinerary ? itinerary.items.find((i: any) => i.kind === "HOTEL") : null;
    const effectiveFlightData = flightData || outboundItem?.payload || null;

    if (!itineraryId) {
      // Legacy single-flight path — strict guard unchanged (backward compatible).
      if (!flightData || !flightData.ResultIndex || !flightData.TraceId) {
        return res.status(400).json({
          error: "flightData with ResultIndex and TraceId is required",
        });
      }
    } else if (!outboundItem && !hotelItem) {
      return res.status(400).json({ error: "Itinerary has no flight or hotel to submit" });
    }

    // Disruption-watch opt-in (Phase 3). A WhatsApp number, if given, MUST be
    // E.164-ish — reject a malformed number with a clear field error rather than
    // silently dropping the opt-in.
    if (watchOptIn && whatsappNumber && !isValidWhatsAppNumber(whatsappNumber)) {
      return res.status(400).json({
        error: "whatsappNumber must be in international format, e.g. +919876543210",
        field: "whatsappNumber",
      });
    }
    const watchConsent = watchOptIn
      ? { watchOptIn: true, whatsappNumber: whatsappNumber || null }
      : undefined;

    // Resolve workspace — the session's (requireWorkspace). Not
    // findById(user.customerId): for a customer that is a Customer._id, not a
    // CustomerWorkspace._id, so it found nothing (audit §7.2).
    const workspace = (req as any).workspaceObjectId
      ? await CustomerWorkspace.findById((req as any).workspaceObjectId).lean() as any
      : null;
    // SBTRequest.customerId is the legacy Customer._id (what the request inbox
    // filters on), i.e. the workspace's customerId — never the workspace _id.
    const legacyCustomerId = legacyCustomerIdOf(workspace);

    if (!workspace) {
      return res.status(400).json({
        error: "No workspace found for your account",
      });
    }

    // Resolve assigned booker — workspace defaultApproverEmails → find User → _id
    let assignedBookerId: string | null = null;
    const approverEmails: string[] = workspace.defaultApproverEmails || [];

    if (approverEmails.length > 0) {
      const approver = await User.findOne({
        email: { $in: approverEmails.map((e: string) => e.toLowerCase()) },
      }).select("_id name email").lean() as any;
      if (approver) assignedBookerId = approver._id;
    }

    // Fallback: workspace leader (User.customerId is a Customer._id). No
    // customerId → no lookup: an undefined filter would match any company's leader.
    if (!assignedBookerId && workspace.customerId) {
      const leader = await User.findOne({
        customerId: String(workspace.customerId),
        roles: { $in: ["WORKSPACE_LEADER"] },
        _id: { $ne: user._id },
      }).select("_id name email").lean() as any;
      if (leader) assignedBookerId = leader._id;
    }

    if (!assignedBookerId) {
      return res.status(400).json({
        error: "No approver/booker configured for this workspace. Contact your admin.",
      });
    }

    // Build searchParams for SBTRequest compatibility (from the primary flight,
    // or destination-only for a hotel-only itinerary).
    const searchParams = effectiveFlightData ? {
      origin: effectiveFlightData.origin?.code || "",
      destination: effectiveFlightData.destination?.code || "",
      departDate: effectiveFlightData.departure?.date || "",
      cabin: effectiveFlightData.cabin || "Economy",
      source: "CONCIERGE",
    } : {
      destination: itinerary?.destinationCity || itinerary?.destinationIata || "",
      source: "CONCIERGE",
    };
    const reqType: "flight" | "hotel" = effectiveFlightData ? "flight" : "hotel";
    const selectedOption = effectiveFlightData || hotelItem?.payload || {};

    // Extend the trip bundle with the full itinerary (items + rollup + total).
    const itineraryBundle = itinerary ? {
      itineraryId: String(itinerary._id),
      items: itinerary.items,
      policySummary: itinerary.policySummary,
      totalPriceINR: itinerary.totalPriceINR,
    } : {};
    const mergedBundle = (tripBundle || itinerary || watchConsent)
      ? { ...(tripBundle || {}), ...itineraryBundle, ...(watchConsent ? { consent: watchConsent } : {}) }
      : undefined;

    // Idempotency: re-submitting the same DRAFT updates the existing PENDING
    // request's bundle rather than creating a duplicate. A prior request that is
    // no longer PENDING does not match → a fresh request is created.
    if (itineraryId) {
      const existingReq = await SBTRequest.findOne({
        workspaceId: (req as any).workspaceObjectId,
        "tripBundle.itineraryId": String(itinerary._id),
        status: "PENDING",
      });
      if (existingReq) {
        existingReq.tripBundle = mergedBundle as any;
        existingReq.selectedOption = selectedOption;
        existingReq.searchParams = searchParams;
        await existingReq.save();
        itinerary.status = "SUBMITTED";
        itinerary.sbtRequestId = existingReq._id;
        await itinerary.save();
        return res.status(200).json({ success: true, requestId: existingReq._id, updated: true });
      }
    }

    const request = await SBTRequest.create({
      workspaceId: (req as any).workspaceObjectId,
      customerId: legacyCustomerId,
      requesterId: user._id,
      assignedBookerId,
      type: reqType,
      source: "CONCIERGE",
      conversationId: conversationId || null,
      searchParams,
      selectedOption,
      requesterNotes: notes || null,
      passengerDetails: passengers || [],
      contactDetails: { email: user.email },
      // Additive: optional richer bundle + watch consent. Omitted by existing
      // single-flight calls; consent read at the BOOKED transition.
      tripBundle: mergedBundle,
      status: "PENDING",
    });

    // Link the itinerary to the raised request (SUBMITTED).
    if (itinerary) {
      itinerary.status = "SUBMITTED";
      itinerary.sbtRequestId = request._id;
      await itinerary.save();
    }

    // Send email to assigned booker
    const booker = await User.findOne({ _id: assignedBookerId, workspaceId: (req as any).workspaceObjectId })
      .select("name email").lean() as any;

    if (booker?.email) {
      const route = effectiveFlightData
        ? `${effectiveFlightData.origin?.code || "?"} → ${effectiveFlightData.destination?.code || "?"}`
        : (itinerary?.destinationCity || itinerary?.destinationIata || "Trip");
      const date = effectiveFlightData?.departure?.date || "";
      const frontendUrl = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
      const fromName = personName(user) || user.email;
      const subject = itineraryId
        ? `New Concierge Trip Request from ${fromName} — ${route}`
        : `New Concierge Flight Request from ${fromName} — ${route}`;

      await sendMail({
        to: booker.email,
        subject,
        kind: "REQUESTS",
        html: `
          <h3>New ${itineraryId ? "Trip" : "Flight"} Request (via Concierge)</h3>
          <p><strong>From:</strong> ${fromName}</p>
          ${effectiveFlightData ? `<p><strong>Flight:</strong> ${effectiveFlightData.airline?.name || ""} ${effectiveFlightData.flightNo || ""}</p>` : ""}
          <p><strong>Route:</strong> ${route}</p>
          ${date ? `<p><strong>Date:</strong> ${date}</p>` : ""}
          ${effectiveFlightData ? `<p><strong>Fare:</strong> ₹${(effectiveFlightData.fare?.offered || effectiveFlightData.fare?.published || 0).toLocaleString("en-IN")}</p>` : ""}
          ${notes ? `<p><strong>Notes:</strong> ${notes}</p>` : ""}
          ${mergedBundle ? renderTripSummaryHtml(mergedBundle) : ""}
          <p><a href="${frontendUrl}/sbt/inbox">View in Booking Inbox</a></p>
        `,
      }).catch((e: any) => console.warn("[Concierge] Failed to send request email:", e?.message));
    }


    return res.status(201).json({
      success: true,
      requestId: request._id,
      message: "Request raised successfully",
    });
  } catch (err: any) {
    console.error("[Concierge/RaiseRequest] Error:", err.message);
    return res.status(500).json({ error: "Failed to raise request" });
  }
});

/**
 * POST /itinerary — create or update the DRAFT itinerary for a conversation.
 * Idempotent per (workspace, conversationId): the same conversationId updates the
 * existing DRAFT (same-kind selections replace) rather than creating a duplicate.
 * Auth + workspace are enforced at the mount.
 */
router.post("/itinerary", requireWorkspace, async (req: any, res: any) => {
  try {
    const user = req.user;
    if (!user?._id) return res.status(401).json({ error: "Unauthorized" });
    const workspaceObjectId = (req as any).workspaceObjectId;

    const { conversationId, title, destinationCity, destinationIata, dates, items } = req.body || {};
    const incoming: ItineraryItemInput[] = Array.isArray(items) ? items : [];

    // Reuse the existing DRAFT for this conversation when present (idempotent).
    let doc: any = conversationId
      // Owner-scoped: another user's DRAFT for the same conversationId is never
      // reused (it used to be updated in place — a cross-user overwrite).
      ? await Itinerary.findOne({ workspaceId: workspaceObjectId, conversationId, status: "DRAFT", createdByUserId: user._id })
      : null;

    const existing = doc ? doc.items : [];
    const assembled = assembleItinerary(existing, incoming); // pure; throws on bad kind → 400 below

    if (!doc) {
      doc = await Itinerary.create({
        workspaceId: workspaceObjectId,
        conversationId: conversationId || null,
        createdByUserId: user._id,
        title: title || "Trip",
        destinationCity: destinationCity || null,
        destinationIata: destinationIata || null,
        dates: { start: dates?.start || null, end: dates?.end || null },
        items: assembled.items,
        totalPriceINR: assembled.totalPriceINR,
        policySummary: assembled.policySummary,
        status: "DRAFT",
      });
    } else {
      doc.items = assembled.items;
      doc.totalPriceINR = assembled.totalPriceINR;
      doc.policySummary = assembled.policySummary;
      if (title) doc.title = title;
      if (destinationCity) doc.destinationCity = destinationCity;
      if (destinationIata) doc.destinationIata = destinationIata;
      if (dates?.start) doc.dates.start = dates.start;
      if (dates?.end) doc.dates.end = dates.end;
      await doc.save();
    }

    return res.status(200).json({ ok: true, itinerary: doc });
  } catch (err: any) {
    if (/Invalid itinerary item kind/.test(err?.message || "")) {
      return res.status(400).json({ error: err.message });
    }
    console.error("[Concierge/Itinerary] Error:", err?.message);
    return res.status(500).json({ error: "Failed to assemble itinerary" });
  }
});

/**
 * GET /itinerary/:id — workspace-scoped read. A wrong-workspace id → 404 (never
 * leaks another tenant's itinerary).
 */
router.get("/itinerary/:id", requireWorkspace, async (req: any, res: any) => {
  try {
    const workspaceObjectId = (req as any).workspaceObjectId;
    // Owner-only, like the conversation it came from: another user's itinerary
    // is a 404, indistinguishable from a miss. No role bypass.
    const doc = await Itinerary.findOne({ _id: req.params.id, workspaceId: workspaceObjectId, createdByUserId: req.user?._id });
    if (!doc) return res.status(404).json({ error: "Itinerary not found" });
    return res.status(200).json({ ok: true, itinerary: doc });
  } catch (err: any) {
    // A malformed ObjectId is a not-found from the caller's perspective.
    return res.status(404).json({ error: "Itinerary not found" });
  }
});

// ───────── Rehydrate a conversation's durable context (v2 — refresh/resume) ─────────
// Returns the workspace-scoped PlutoConversation context bag (incl. locked facts)
// so the frontend can restore state after a refresh or a sidebar-session click.
// getConversationContext returns null for a genuine miss, a TTL-expired doc, a
// wrong-workspace id, or a malformed id — all indistinguishable → a plain 404,
// which the client treats as "start a clean conversation".
router.get("/conversation/:id", requireWorkspace, async (req: any, res: any) => {
  if (isStateV2Enabled()) {
    // Owner-only: another user's conversation in the same workspace is a 404,
    // exactly like a miss. No role bypass (SUPERADMIN included).
    const r = await loadConversationForUser({
      workspaceObjectId: (req as any).workspaceObjectId,
      userId: (req as any).user?._id,
      conversationId: req.params.id,
    });
    if (r.status !== "owned") return res.status(404).json({ ok: false, error: "Conversation not found" });
    return res.status(200).json({ ok: true, context: projectForClient(r.context) });
  }
  const context = await getConversationContext({
    workspaceObjectId: (req as any).workspaceObjectId,
    userId: (req as any).user?._id,
    conversationId: req.params.id,
  });
  if (!context) return res.status(404).json({ ok: false, error: "Conversation not found" });
  return res.status(200).json({ ok: true, context });
});

/* ────────────────────────────────────────────────────────────────
 * GET /trips/watches — Phase 3 tracker surface (READ-ONLY)
 *
 * The disruption watcher has been live for a while (workers/tripWatchWorker)
 * writing TripWatch + TripAlert and notifying by WhatsApp/email — but nothing
 * in /concierge ever showed any of it, so a traveller could only learn about a
 * delay from the notification itself.
 *
 * This is a pure CONSUMER. It performs no writes and does not touch the
 * worker's poll / claim / notify path in any way, so it cannot destabilise a
 * worker that is already running in production.
 *
 * Workspace-scoped by construction: the filter always carries workspaceId from
 * the request (never the client body), so one workspace can never read
 * another's watches.
 * ──────────────────────────────────────────────────────────────── */
router.get("/trips/watches", requireWorkspace, async (req: any, res: any) => {
  try {
    const workspaceObjectId = (req as any).workspaceObjectId;

    const watches: any[] = await TripWatch.find({ workspaceId: workspaceObjectId })
      .sort({ departDate: 1 })
      .limit(50)
      .lean();

    if (watches.length === 0) {
      return res.status(200).json({ ok: true, watches: [] });
    }

    // Alerts are fetched workspace-scoped AND restricted to the watches we just
    // read, so a tripWatchId from another tenant can never pull an alert in.
    const watchIds = watches.map((w) => w._id);
    const alerts: any[] = await TripAlert.find({
      workspaceId: workspaceObjectId,
      tripWatchId: { $in: watchIds },
    })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    const byWatch = new Map<string, any[]>();
    for (const a of alerts) {
      const k = String(a.tripWatchId);
      if (!byWatch.has(k)) byWatch.set(k, []);
      byWatch.get(k)!.push({
        kind: a.kind,
        detail: a.detail,
        createdAt: a.createdAt,
        deliveryStatus: a.deliveryStatus,
      });
    }

    return res.status(200).json({
      ok: true,
      watches: watches.map((w) => ({
        _id: String(w._id),
        flightNo: w.flightNo,
        carrier: w.carrier,
        origin: w.origin,
        destination: w.destination,
        departDate: w.departDate,
        status: w.status,
        notifyChannel: w.notifyChannel,
        lastCheckedAt: w.lastCheckedAt ?? null,
        // The worker's own last snapshot. Rendered as-is — the tracker never
        // invents a status, and shows "not checked yet" when this is null.
        lastKnownState: w.lastKnownState ?? null,
        alerts: byWatch.get(String(w._id)) ?? [],
      })),
    });
  } catch (err: any) {
    console.error("[Concierge/TripWatches] Error:", err?.message);
    return res.status(500).json({ ok: false, error: "Failed to load tracked flights" });
  }
});

export default router;