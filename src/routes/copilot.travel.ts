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
import { sendHandoffPayload } from "../utils/plutoHandoffSink.js";

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
} from "../utils/plutoMemory.js";
import { invokePlutoGemini, GEMINI_FALLBACK_INVALID } from "../utils/plutoGeminiInvoke.js";
import {
  PLUTO_AI_SYSTEM_PROMPT as PLUTO_SYSTEM_PROMPT,
} from "../prompts/plutoSystemPrompt.js";
import {
  getDelightfulFlightStatus as fetchFlightFromApi,
} from "../services/flightService.js";

import { searchFlights as tboSearchFlights } from "../services/tbo.flight.service.js";
import { searchHotels, isHotelSearchError } from "../services/tbo.hotel.search.service.js";
import {
  CABIN_LABELS,
  dedupeRawTBOFlights,
  mapTBOFlight,
  searchFlightsForChat,
} from "../utils/plutoFlightSearch.js";
import { parseDateToISO } from "../utils/plutoDate.js";
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
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import User from "../models/User.js";
import Itinerary from "../models/Itinerary.js";
import { assembleItinerary, type ItineraryItemInput } from "../services/itineraryAssembly.js";
import { sendMail } from "../utils/mailer.js";
import { scopedFindById } from "../middleware/scopedFindById.js";
import { getMarginConfig, applyMargin, isDomestic } from "../utils/margin.js";

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
} from "../utils/plutoMetricsBuilder.js";
import { emitMetric } from "../utils/plutoMetricsSink.js";

// CABIN_LABELS, dedupeRawTBOFlights, mapTBOFlight and searchFlightsForChat now
// live in ../utils/plutoFlightSearch.ts (extracted for unit-testability). The
// hardened /flights/search path imports the first three; behaviour unchanged.

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

    // Apply workspace margin parity with SBT (sbt.flights.ts:649-687) so
    // the same TBO ResultIndex is quoted at the same price via concierge
    // and via SBT. Mutates resultsArr in place so the mapping below reads
    // margin-applied PublishedFare / OfferedFare.
    const flightMargins = await getMarginConfig();
    if (flightMargins.enabled) {
      const originCountry = (req.body as any).originCountry;
      const destCountry = (req.body as any).destCountry;
      const isFlightDomestic = isDomestic(originCountry, destCountry);
      const marginPct = isFlightDomestic
        ? flightMargins.flight.domestic
        : flightMargins.flight.international;

      if (marginPct > 0) {
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

        for (let i = 0; i < resultsArr.length; i++) {
          if (Array.isArray(resultsArr[i])) {
            resultsArr[i] = applyToFlightArray(resultsArr[i]);
          }
        }
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
    const annotate = (rows: any[]): any[] =>
      rows
        .map((r: any) => {
          const f = mapTBOFlight(r, mapperOpts);
          if (f) f.policy = evaluateFlightPolicy(flightForPolicyFromTBO(r), policyRules);
          return f;
        })
        .filter(Boolean);

    // Dedupe + cap mirrors searchFlightsForChat; both endpoints must produce
    // the same set so the FlightSearchPanel renders identically regardless of
    // trigger (chat NLP vs explicit Search button).
    const outboundTop = dedupeRawTBOFlights(outboundRaw).slice(0, 30);
    const results = annotate(outboundTop);
    const inbound = annotate(dedupeRawTBOFlights(inboundRaw).slice(0, 30));

    // Passive fare logging (fire-and-forget; never affects the response).
    recordFareObservations({
      workspaceObjectId: (req as any).workspaceObjectId,
      origin: originIATA,
      destination: destIATA,
      departDate: date,
      requestId,
      rawRows: outboundTop,
    });

    const inPolicyCount = results.filter((f: any) => f?.policy?.status === "IN_POLICY").length;
    await emitMetric(
      policyEvaluated({ workspaceId, requestId, inPolicyCount, totalCount: results.length })
    );

    const response: any = { ok: true, results, traceId };
    if (inbound.length > 0) response.inbound = inbound;
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
    const annotatedHotels = (result.hotels || []).map((h: any) => ({
      ...h,
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
async function runConciergeTurn(req: any, res: any, onStage?: (stage: string) => void) {
  // Per-request correlation id + tenant, threaded into every log line, metric
  // event and error response for this concierge turn.
  const requestId = crypto.randomUUID();
  const workspaceId = String((req as any).workspaceObjectId || "");
  try {
    const { prompt, context, lastReply, videoAnalysisId } = req.body;
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
    const isFollowUp = Boolean(context?.id || req.body?.conversationId);

    // Establish a stable conversation id up front so EVERY reply — including the
    // pre-AI gather-phase gate below — carries it. Without this, a details-
    // gathering conversation never gets an identity: the client round-trips an
    // id-less context, the next turn's isFollowUp stays false, and the whole
    // conversation resets. Reusing an existing id is a no-op for follow-ups.
    const conversationId =
      context?.id || req.body?.conversationId || crypto.randomUUID();

    // 1️⃣ Must be travel-related at all (skip for follow-ups).
    // Off-domain (clearly HR/payroll/admin) → graceful concierge redirect
    // in the SAME PlutoReplyV1 shape the frontend renders. Never a 500.
    // A travel question that merely contains a flagged substring
    // (e.g. "leave for the airport", "baggage policy") is NOT redirected.
    if (!isFollowUp && isOffDomainQuery(prompt)) {
      // Carry the stable id even on the redirect so no reply is ever id-less.
      return res.json({
        ok: true,
        reply: buildOffDomainRedirect(),
        context: { ...(context && typeof context === "object" ? context : {}), id: conversationId },
      });
    }

    /* ───────── Flight Route Search Detector ───────── */
    // Intercepts ALL flight route search requests — explicit and contextual follow-ups.
    // Returns a rich card with real booking links. Never passes to Pluto (no flight search there).

    // Match explicit AND implicit follow-up flight search requests
    const isFlightRouteSearch = Boolean(
      /(find|search|show|get|look up|check).{0,30}flight/i.test(prompt) ||
      /flights?\s+(from|between|on|available|for)/i.test(prompt) ||
      /flight\s+(option|price|fare|deal|available)/i.test(prompt) ||
      /available.*flight/i.test(prompt) ||
      /fly(ing)?\s+from\s+.{2,30}\s+to\s+/i.test(prompt)
    );

    if (isFlightRouteSearch) {
      // ── Multi-city: not supported in the chat path yet → LOUD downgrade ──
      // Detect BEFORE single-leg extraction: a "to A to B" prompt would make the
      // destination regex capture "A to B", which then fails IATA resolution and
      // would wrongly hit the unknown-city clarify. Detect up front, emit the
      // metric, and offer a single-leg search or a full-trip request instead.
      if (isMultiCityIntent(prompt)) {
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
      // Origin: "from <city> to/on/for/,"
      const promptOriginMatch = prompt.match(/\bfrom\s+([A-Za-z][a-zA-Z ]{1,25}?)(?:\s+to\b|\s+on\b|\s+for\b|,|\.|$)/i);
      // Destination: "to <city> on/by/for/,"  — includes "for" so "to Delhi for 8th March" works
      const promptDestMatch   = prompt.match(/\bto\s+([A-Za-z][a-zA-Z ]{1,25}?)(?:\s+on\b|\s+by\b|\s+for\b|\s+and\b|,|\.|$)/i);
      // Date: natural language or numeric
      const dateMatch = prompt.match(/(\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/i);

      // ── Context fallback — ONLY use locked trip data, NOT user profile/device location ──
      // locked.origin = explicitly set trip origin (e.g. "Delhi" from "plan trip from Delhi")
      // Do NOT use assumed.origin — that may be device/profile location (causes BLR bug)
      const ctxOrigin = context?.locked?.origin?.city  || null;
      const ctxDest   = context?.locked?.destination?.name || context?.assumed?.destination?.name || null;
      const ctxDate   = context?.locked?.dates?.start  || null;

      // Extract passenger count
      const paxMatch = prompt.match(
        /\bfor\s+(\d+)\s*(?:people|persons?|pax|passengers?|travell?ers?|adults?)/i
      ) || prompt.match(
        /(\d+)\s*(?:people|persons?|pax|passengers?|travell?ers?|adults?)/i
      );
      const extractedAdults = paxMatch ? Math.min(parseInt(paxMatch[1]), 9) : 1;

      // Extract cabin class
      const cabinMatch = prompt.match(
        /\b(business|first\s*class|premium\s*economy|economy)\b/i
      );
      const extractedCabin = cabinMatch
        ? cabinMatch[1].toLowerCase().includes("business") ? "Business"
        : cabinMatch[1].toLowerCase().includes("first") ? "First"
        : cabinMatch[1].toLowerCase().includes("premium") ? "Premium Economy"
        : "Economy"
        : "Economy";

      const cabinClassMap_chat: Record<string, number> = {
        Economy: 2, "Premium Economy": 3, Business: 4, First: 6,
      };
      const extractedCabinClass = cabinClassMap_chat[extractedCabin] ?? 2;

      const rawOrigin      = promptOriginMatch?.[1]?.trim() || ctxOrigin || null;
      const rawDestination = promptDestMatch?.[1]?.trim()   || ctxDest   || null;
      const travelDate     = dateMatch?.[0]?.trim()         || ctxDate   || null;

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
          context: context || {},
        });
      }

      // Parse any date format to YYYY-MM-DD. Missing-year dates resolve to the
      // nearest future occurrence (see utils/plutoDate.ts) — no hardcoded year.
      const isoDate = parseDateToISO(travelDate);

      // ── Round-trip: search both legs (JourneyType 2) when a return date is
      // known. (Multi-city was already handled + returned at the top.) ──
      const { wantsRoundTrip, returnDateRaw } =
        resolveRoundTripIntent(prompt, context?.locked?.dates?.end || null);
      const isoReturnDate = returnDateRaw ? parseDateToISO(returnDateRaw) : "";
      const journeyType: 1 | 2 = wantsRoundTrip && isoReturnDate ? 2 : 1;

      // Round-trip intent but no usable return date → ASK for it. Never fall
      // through to a silent one-way search (the prior behaviour).
      if (wantsRoundTrip && isoDate && !isoReturnDate) {
        return res.json({
          ok: true,
          reply: {
            title: `Round trip: ${origin} → ${destination}`,
            context: `You mentioned a round trip. What's your return date? Once I have it I'll search both the outbound and return legs.`,
            nextSteps: [
              `Tell me your return date (e.g. "20 May 2026")`,
              `Or say "one way" and I'll search just the outbound`,
            ],
            handoff: false,
          },
          context: context || {},
        });
      }

      let chatFlights: any[] = [];
      let chatInbound: any[] = [];
      let chatTraceId = "";
      // Distinguishes a genuine upstream outage (searchUnavailable = true) from
      // a genuine zero-results route (searchUnavailable = false, flights empty).
      let searchUnavailable = false;

      // Load the workspace travel policy once for this request (tenant-scoped,
      // fail-safe → null when absent). Flights are annotated, never filtered.
      const chatPolicyRules = await loadWorkspacePolicyRules((req as any).workspaceObjectId);

      onStage?.("searching_flights");
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
        });
        if (chatResult.ok) {
          chatFlights = chatResult.flights;
          chatInbound = chatResult.inbound;
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

      // Use the SBT-aligned shape (fare.offered, duration "Xh Ym") for sort.
      const parseDurationMins = (d: string): number => {
        const m = (d || "").match(/(\d+)h\s*(\d+)?m?/);
        return m ? parseInt(m[1]) * 60 + parseInt(m[2] || "0") : 9999;
      };
      const chatCheapest = chatFlights.length
        ? chatFlights.reduce((a: any, b: any) => ((a.fare?.offered || a.fare?.published || 0) < (b.fare?.offered || b.fare?.published || 0)) ? a : b)
        : null;
      const chatFastest = chatFlights.length
        ? chatFlights.reduce((a: any, b: any) => (parseDurationMins(a.duration) < parseDurationMins(b.duration) ? a : b))
        : null;

      const hasLiveFlights = chatFlights.length > 0;

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

      onStage?.("assembling");
      const nextSteps = searchUnavailable ? [
        "Retry the search in a few minutes",
        "Or use the flight search panel above for full results",
      ] : hasLiveFlights ? [
        "Click Book on a flight to continue in our booking flow",
        "I'll pre-fill the search and take you straight to passenger details",
      ] : [
        "Try a slightly different date or route",
        "Or use the flight search panel above for full results",
      ];

      return res.json({
        ok: true,
        reply: {
          title: `Flights: ${origin} → ${destination}${travelDate ? "  ·  " + travelDate : ""}`,
          context: searchUnavailable
            ? `Flight search is temporarily unavailable for ${originIATA} → ${destIATA} right now. Please retry in a few minutes.`
            : hasLiveFlights
              ? zeroInPolicyNote + `Found ${chatFlights.length} flights for ${originIATA} → ${destIATA} on ${travelDate}. Fares are live, shown in INR.` + roundTripNote + routeInsightsNote + weatherNote
              : !isoDate
                ? `I couldn't parse the date for ${originIATA} → ${destIATA}. Try a date like "20 May 2026" and I'll pull live fares.`
                : `I couldn't find any live flights for ${originIATA} → ${destIATA}${travelDate ? " on " + travelDate : ""}. Try a different date or a nearby route.`,
          flightSearch: {
            origin:      { city: origin,      iata: originIATA },
            destination: { city: destination, iata: destIATA   },
            date:        travelDate,
            isoDate,
            journeyType,
            flights:     chatFlights,
            inbound:     chatInbound,
            cheapest:    chatCheapest,
            fastest:     chatFastest,
            traceId:     chatTraceId,
            source:      searchUnavailable ? "unavailable" : hasLiveFlights ? "tbo" : "none",
            tipLines:    buildFlightTipLines(originIATA, destIATA, travelDate),
          },
          // Additive: tenant-scoped route history (null when thin data).
          routeInsights,
          nextSteps,
          handoff: false,
        },
        context: { ...(context && typeof context === "object" ? context : {}), id: conversationId },
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
    let conversationContext: any;

    const existingId = context?.id || req.body?.conversationId;

    if (existingId) {
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
      const MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
      const parseLooseDate = (token: string): string | null => {
        const m = token.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:\s+(\d{4}))?/i);
        if (!m) return null;
        const day = parseInt(m[1], 10);
        const monthIdx = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
        if (monthIdx < 0) return null;
        const year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
        const d = new Date(Date.UTC(year, monthIdx, day));
        return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
      };

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
        // Compact range sharing one month first: "12-15 Sep", "12 to 15 September".
        const compact = prompt.match(/\b(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+(\d{4}))?/i);
        let start: string | null = null;
        let end: string | null = null;
        if (compact) {
          const yr = compact[4] ? ` ${compact[4]}` : "";
          start = parseLooseDate(`${compact[1]} ${compact[3]}${yr}`);
          end = parseLooseDate(`${compact[2]} ${compact[3]}${yr}`);
        } else {
          const tokens = prompt.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{4})?/gi) || [];
          if (tokens.length >= 1) {
            start = parseLooseDate(tokens[0]);
            end = tokens[1] ? parseLooseDate(tokens[1]) : null;
          }
        }
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
    const isHotelOnlyFollowup =
      /hotel|stay|accommodation/i.test(prompt) &&
      typeof lastReply === "object" &&
      Array.isArray(lastReply?.itinerary);

    const lockedContext =
      Object.keys(conversationContext.locked).length > 0
        ? `\nLOCKED DECISIONS:\n${JSON.stringify(
            conversationContext.locked,
            null,
            2
          )}\n`
        : "";

    /* ───────── Real-Time Data Injection (CRITICAL) ───────── */
    let liveFlightData: any = null;

    // ✅ FIX: Improved flight number regex — handles "6E-2582", "6E 2582", "6E2582"
    const flightMatch = prompt.match(/\b(\d?[A-Z]{1,2})[-\s]?(\d{2,4})\b/gi);
    const detectedFlightNumber = flightMatch?.[0]?.replace(/[-\s]/g, "").toUpperCase() || null;

    if (detectedFlightNumber) {
      try {
        // ✅ Diagnostic log — confirms API key + flight number being used

        liveFlightData = await fetchFlightFromApi(detectedFlightNumber);

        // ✅ If API returned an error object (not a throw), treat as failure
        if (liveFlightData?.error) {
          console.error("[FlightService] API returned error:", liveFlightData.error);
          liveFlightData = null;
        } else {

        }
      } catch (err: any) {
        console.error("[FlightService] Flight fetch failed:", err?.message || err);
        liveFlightData = null;
      }
    }

    // ✅ FIX: When flight data is unavailable, explicitly instruct AI NOT to hallucinate
    // Old code: passed empty string → AI invented fake status, gate, terminal, arrival time
    // New code: passes explicit NO-HALLUCINATE instruction when real data is missing
    const flightDataString = liveFlightData
      ? `\n[VERIFIED LIVE FLIGHT DATA - USE THIS AS ABSOLUTE TRUTH]:\n${JSON.stringify(
          liveFlightData,
          null,
          2
        )}\n`
      : detectedFlightNumber
      ? `\n[FLIGHT DATA UNAVAILABLE FOR ${detectedFlightNumber}]:
CRITICAL INSTRUCTION: You were unable to fetch live flight data for this flight.
DO NOT invent, estimate, or assume ANY flight details (status, gate, terminal, time, airline).
DO NOT say the flight is "On Time" or provide any gate/terminal/arrival information.
Instead, tell the user clearly:
- Live flight data could not be retrieved at this moment
- They should check the IndiGo app, DGCA website, or FlightAware.com for real-time status
- Provide the direct link: https://www.goindigo.in/flight-status.html (if IndiGo) or https://www.flightaware.com
\n`
      : "";

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
      `${missingFieldsString}\n` +
      `${lockedContext}\n` +
      `${assumedContext}\n` +
      `${flightDataString}\n` +
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
    /* ───────── Invoke AI (OpenAI with Gemini Fallback) ───────── */
    let deltaReply: PlutoDeltaReply;

    // Step 3 — substance enforcement: only when the trip is already plannable
    // (destination + duration known). A thin reply then earns ONE corrective
    // retry inside invokePluto; if still thin it is ACCEPTED (never an error)
    // and this metric fires so we can tune the prompt.
    const substanceOpts = {
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
    };

    try {
      deltaReply = await invokePluto(effectivePrompt, substanceOpts);
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
        deltaReply = await invokePlutoGemini(effectivePrompt, substanceOpts);
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
    await saveConversationContext({
      workspaceObjectId: (req as any).workspaceObjectId,
      userId: (req as any).user?._id,
      conversationId: conversationContext.id,
      context: conversationContext,
    });

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
    await runConciergeTurn(req, captureRes, (stage: string) => write("status", { stage }));
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
      itinerary = await Itinerary.findOne({ _id: itineraryId, workspaceId: (req as any).workspaceObjectId });
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

    // Resolve workspace
    const workspace = user.customerId
      ? await CustomerWorkspace.findById(user.customerId).lean() as any
      : null;

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

    // Fallback: workspace leader
    if (!assignedBookerId) {
      const leader = await User.findOne({
        customerId: workspace._id,
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
      customerId: workspace._id,
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
      const subject = itineraryId
        ? `New Concierge Trip Request from ${user.name || user.email} — ${route}`
        : `New Concierge Flight Request from ${user.name || user.email} — ${route}`;

      await sendMail({
        to: booker.email,
        subject,
        kind: "REQUESTS",
        html: `
          <h3>New ${itineraryId ? "Trip" : "Flight"} Request (via Concierge)</h3>
          <p><strong>From:</strong> ${user.name || user.email}</p>
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
      ? await Itinerary.findOne({ workspaceId: workspaceObjectId, conversationId, status: "DRAFT" })
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
    const doc = await Itinerary.findOne({ _id: req.params.id, workspaceId: workspaceObjectId });
    if (!doc) return res.status(404).json({ error: "Itinerary not found" });
    return res.status(200).json({ ok: true, itinerary: doc });
  } catch (err: any) {
    // A malformed ObjectId is a not-found from the caller's perspective.
    return res.status(404).json({ error: "Itinerary not found" });
  }
});

export default router;