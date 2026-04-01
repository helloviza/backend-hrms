// apps/backend/src/routes/copilot.travel.ts

import { Router } from "express";
import { Types } from "mongoose";
import crypto from "crypto";
import { optionalAuth } from "../middleware/optionalAuth.js";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import VideoAnalysis from "../models/VideoAnalysis.js";
import { invokePluto } from "../utils/plutoInvoke.js";

import { assertTravelIntent } from "../utils/plutoIntentGuard.js";
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
} from "../utils/plutoMemory.js";
import { invokePlutoGemini } from "../utils/plutoGeminiInvoke.js";
import {
  PLUTO_AI_SYSTEM_PROMPT as PLUTO_SYSTEM_PROMPT,
} from "../prompts/plutoSystemPrompt.js";
import {
  getDelightfulFlightStatus as fetchFlightFromApi,
  searchFlightRoutes,
} from "../services/flightService.js";

import { searchFlights as tboSearchFlights } from "../services/tbo.flight.service.js";
import SBTRequest from "../models/SBTRequest.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import User from "../models/User.js";
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
} from "../utils/plutoMetricsBuilder.js";
import { emitMetric } from "../utils/plutoMetricsSink.js";

// ── TBO mapper: TBO Search response → FlightListing shape for concierge UI ──
function mapTBOToFlightResults(tboResults: any[], traceId: string): any[] {
  return tboResults
    .filter(r => r?.Segments?.[0]?.[0] && r?.Fare)
    .map(r => {
      const seg = r.Segments[0][0];
      const price = r.Fare.PublishedFare || r.Fare.TotalFare || 0;
      const depTime = seg.Origin?.DepTime || "";
      const arrTime = seg.Destination?.ArrTime || "";
      const durationMins = seg.Duration || 0;
      const airlineCode = seg.Airline?.AirlineCode || "";
      const stops = r.Segments[0].length - 1;

      return {
        airline: seg.Airline?.AirlineName || airlineCode,
        flightNo: seg.Airline?.FlightNumber || "",
        airlineCode,
        logoUrl: airlineCode ? `https://pics.avs.io/60/60/${airlineCode}.png` : "",
        departure: {
          iata: seg.Origin?.Airport?.AirportCode || "",
          city: seg.Origin?.Airport?.CityName || "",
          time: new Date(depTime).toLocaleTimeString("en-IN", {
            hour: "2-digit", minute: "2-digit", hour12: true,
          }),
          isoTime: depTime,
        },
        arrival: {
          iata: seg.Destination?.Airport?.AirportCode || "",
          city: seg.Destination?.Airport?.CityName || "",
          time: new Date(arrTime).toLocaleTimeString("en-IN", {
            hour: "2-digit", minute: "2-digit", hour12: true,
          }),
          isoTime: arrTime,
        },
        duration: durationMins,
        durationLabel: `${Math.floor(durationMins / 60)}h ${durationMins % 60}m`,
        stops,
        stopDetail: stops === 0 ? "Non-stop" : `${stops} stop`,
        price: `₹${price.toLocaleString("en-IN")}`,
        fare: {
          total: price,
          base: r.Fare.BaseFare || 0,
          taxes: r.Fare.Tax || 0,
          currency: "INR",
        },
        cabin: "Economy",
        bookUrl: null,
        resultIndex: r.ResultIndex,
        traceId,
        isLcc: r.IsLCC || false,
        nonRefundable: r.NonRefundable || false,
        baggage: seg.Baggage || "15 Kg",
        cabinBaggage: seg.CabinBaggage || "7 Kg",
        seatsAvailable: seg.SeatsAvailable || 9,
        source: "tbo",
      };
    });
}

// ── TBO-first search with SerpAPI fallback ──
async function searchFlightsTBOFirst(params: {
  origin: string;
  destination: string;
  departDate: string;
  adults?: number;
  children?: number;
  infants?: number;
  cabinClass?: number;
  serpApiSearch?: () => Promise<any[]>;
}): Promise<{ flights: any[]; traceId: string; source: "tbo" | "serp" | "none" }> {
  const { origin, destination, departDate, adults = 1, children = 0, infants = 0, cabinClass = 2, serpApiSearch } = params;

  // ── TBO first ──
  try {
    const tboResult: any = await tboSearchFlights({
      origin,
      destination,
      departDate,
      adults,
      children,
      infants,
      cabinClass,
    });

    const traceId = tboResult?.Response?.TraceId || "";
    const results = tboResult?.Response?.Results?.[0] || [];

    if (Array.isArray(results) && results.length > 0) {
      console.log(`[ConciergeFlights] TBO returned ${results.length} results`);
      return { flights: mapTBOToFlightResults(results, traceId), traceId, source: "tbo" };
    }
    console.log("[ConciergeFlights] TBO returned 0 results, falling back to SerpAPI");
  } catch (err: any) {
    console.warn("[ConciergeFlights] TBO failed:", err.message, "— falling back to SerpAPI");
  }

  // ── SerpAPI fallback ──
  if (serpApiSearch) {
    try {
      const serpFlights = await serpApiSearch();
      return { flights: serpFlights || [], traceId: "", source: "serp" };
    } catch (err: any) {
      console.warn("[ConciergeFlights] SerpAPI also failed:", err.message);
    }
  }

  return { flights: [], traceId: "", source: "none" };
}

const router = Router();

// ✅ PHASE 4 — VIDEO CONSENT ROUTE (TOP-LEVEL, AUTHORITATIVE)
router.post(
  "/video/:videoId/consent",
  optionalAuth,
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
 * ───────────────────────────────────────────── */

/** IATA map — extended city/country list for Indian travellers */
const IATA_MAP: Record<string, string> = {
  // India
  "delhi": "DEL", "new delhi": "DEL", "mumbai": "BOM", "bombay": "BOM",
  "bangalore": "BLR", "bengaluru": "BLR", "chennai": "MAA", "madras": "MAA",
  "hyderabad": "HYD", "kolkata": "CCU", "calcutta": "CCU",
  "pune": "PNQ", "ahmedabad": "AMD", "goa": "GOI", "kochi": "COK",
  "jaipur": "JAI", "lucknow": "LKO", "amritsar": "ATQ", "varanasi": "VNS",
  "srinagar": "SXR", "chandigarh": "IXC", "indore": "IDR", "bhopal": "BHO",
  // Japan
  "tokyo": "NRT", "osaka": "KIX", "kyoto": "KIX", "nagoya": "NGO",
  "sapporo": "CTS", "fukuoka": "FUK", "okinawa": "OKA", "hiroshima": "HIJ",
  "japan": "NRT",
  // SE Asia
  "singapore": "SIN", "bangkok": "BKK", "phuket": "HKT", "bali": "DPS",
  "kuala lumpur": "KUL", "jakarta": "CGK", "ho chi minh": "SGN", "hanoi": "HAN",
  "manila": "MNL", "colombo": "CMB", "kathmandu": "KTM", "dhaka": "DAC",
  // Middle East
  "dubai": "DXB", "abu dhabi": "AUH", "doha": "DOH", "muscat": "MCT",
  "riyadh": "RUH", "jeddah": "JED", "kuwait": "KWI",
  // Europe
  "london": "LHR", "paris": "CDG", "amsterdam": "AMS", "frankfurt": "FRA",
  "rome": "FCO", "milan": "MXP", "madrid": "MAD", "barcelona": "BCN",
  "zurich": "ZRH", "vienna": "VIE", "istanbul": "IST", "athens": "ATH",
  // Americas / Oceania
  "new york": "JFK", "los angeles": "LAX", "chicago": "ORD", "toronto": "YYZ",
  "vancouver": "YVR", "sydney": "SYD", "melbourne": "MEL", "auckland": "AKL",
};

/** Convert any city/country name to IATA code */
export const toIATA = (city: string): string =>
  IATA_MAP[city.toLowerCase().trim()] || city.trim().toUpperCase().slice(0, 3);

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
 * TBO API replacement: swap searchFlightRoutes() for TBO SDK call
 */
router.post("/flights/search", optionalAuth, async (req, res) => {
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

    console.log(`[FlightSearch/POST] ${originIATA} → ${destIATA} on ${date} | ${adults}A ${children}C ${infants}I | ${cabin} | ${tripType}`);

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
      console.error("[FlightSearch/POST] TBO error:", err.message);
      return res.json({ ok: true, results: [], message: "No flights found" });
    }

    const traceId = tboRaw?.Response?.TraceId || "";
    const raw: any[] = tboRaw?.Response?.Results?.[0] || [];

    if (!Array.isArray(raw) || raw.length === 0) {
      console.log("[FlightSearch/POST] TBO returned 0 results");
      return res.json({ ok: true, results: [], traceId, message: "No flights found" });
    }

    const CABIN_LABELS: Record<number, string> = { 1: "All", 2: "Economy", 3: "Premium Economy", 4: "Business", 5: "Premium Business", 6: "First" };

    const results = raw.slice(0, 10).map((r: any) => {
      const segs: any[] = r.Segments?.[0] || [];
      const first = segs[0];
      const last  = segs[segs.length - 1];
      if (!first) return null;

      const airlineCode = first.Airline?.AirlineCode || "";
      const depDt = new Date(first.Origin?.DepTime || "");
      const arrDt = new Date(last.Destination?.ArrTime || "");
      const totalMin = segs.reduce((s: number, seg: any) => s + (seg.Duration || 0), 0);
      const h = Math.floor(totalMin / 60);
      const m = totalMin % 60;

      return {
        ResultIndex: r.ResultIndex,
        TraceId: traceId,
        airline: {
          name: first.Airline?.AirlineName || airlineCode,
          code: airlineCode,
          logo: airlineCode ? `https://pics.avs.io/60/60/${airlineCode}.png` : "",
        },
        flightNo: `${airlineCode}-${first.Airline?.FlightNumber || ""}`,
        origin: {
          code: first.Origin?.Airport?.AirportCode || originIATA,
          city: first.Origin?.Airport?.CityName || "",
          terminal: first.Origin?.Airport?.Terminal || "",
        },
        destination: {
          code: last.Destination?.Airport?.AirportCode || destIATA,
          city: last.Destination?.Airport?.CityName || "",
          terminal: last.Destination?.Airport?.Terminal || "",
        },
        departure: {
          time: isNaN(depDt.getTime()) ? "" : depDt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true }),
          date: isNaN(depDt.getTime()) ? "" : depDt.toISOString().slice(0, 10),
        },
        arrival: {
          time: isNaN(arrDt.getTime()) ? "" : arrDt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true }),
          date: isNaN(arrDt.getTime()) ? "" : arrDt.toISOString().slice(0, 10),
        },
        duration: `${h}h ${m}m`,
        stops: segs.length - 1,
        fare: {
          published: r.Fare?.PublishedFare || r.Fare?.TotalFare || r.FareBreakdown?.[0]?.BaseFare || 0,
          offered: r.Fare?.OfferedFare || r.Fare?.PublishedFare || r.Fare?.TotalFare || 0,
          currency: r.Fare?.Currency || "INR",
        },
        cabin: CABIN_LABELS[first.CabinClass] || cabin,
        baggage: first.Baggage || "",
        isLCC: r.IsLCC ?? false,
        isRefundable: !(r.NonRefundable ?? true),
      };
    }).filter(Boolean);

    console.log(`[FlightSearch/POST] TBO returned ${results.length} results (traceId: ${traceId.slice(0, 8)}…)`);

    return res.json({ ok: true, results, traceId });

  } catch (err: any) {
    console.error("[FlightSearch/POST] Error:", err.message);
    return res.status(500).json({
      ok: false,
      error: err.message || "Flight search failed",
    });
  }
});

/**
 * POST /api/v1/copilot/travel
 * Public / semi-auth AI concierge
 */
router.post("/", optionalAuth, async (req, res) => {
  try {
    const { prompt, context, lastReply, videoAnalysisId } = req.body;

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({
        ok: false,
        message: "Prompt is required",
      });
    }

    /**
     * PHASE 4 — VIDEO CONSENT GATE
     * ---------------------------
     * Explicit user consent before planning from video
     *
     * POST /api/v1/copilot/video/:videoId/consent
     * body: { consent: "yes" | "no" }
     */

    /* ───────── Domain + Planning Intent Guard (AUTHORITATIVE) ───────── */

    // ── Is this a continuation of an existing conversation? ──
    // If context.id exists, the user is already mid-conversation.
    // NEVER gate follow-up messages — they are refinements, not new requests.
    const isFollowUp = Boolean(context?.id || req.body?.conversationId);

    // 1️⃣ Must be travel-related at all (skip for follow-ups)
    if (!isFollowUp) {
      assertTravelIntent(prompt);
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

      const originIATA = toIATA(origin);
      const destIATA   = toIATA(destination);

      console.log(`[FlightSearch] Parsed — origin: "${origin}" (${originIATA}), dest: "${destination}" (${destIATA}), date: "${travelDate}", pax: ${extractedAdults}, cabin: ${extractedCabin}`);

      // Parse any date format to YYYY-MM-DD for SerpAPI
      const parseDateToISO = (raw: string | null): string => {
        if (!raw) return "";

        // Already ISO format YYYY-MM-DD — return as-is
        if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return raw.trim();

        const months: Record<string, string> = {
          jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",
          jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12",
        };

        // "12th June 2026" / "June 12 2026" / "12 Jun 26"
        const m = raw.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*(?:\s+(\d{2,4}))?/i)
                || raw.match(/([a-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{2,4}))?/i);
        if (m) {
          // Determine which capture group is day vs month
          const isWordFirst = /^[a-z]/i.test(raw.trim());
          const day   = isWordFirst ? m[2].padStart(2,"0") : m[1].padStart(2,"0");
          const mon   = isWordFirst ? m[1] : m[2];
          const month = months[mon.toLowerCase().slice(0,3)] || "01";
          const rawY  = isWordFirst ? m[3] : m[3];
          const year  = !rawY ? "2026" : rawY.length === 2 ? "20" + rawY : rawY;
          return `${year}-${month}-${day}`;
        }

        // DD/MM/YYYY or DD-MM-YYYY (Indian standard) — only if first segment ≤ 31
        const p = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
        if (p && parseInt(p[1]) <= 31 && parseInt(p[2]) <= 12) {
          const day   = p[1].padStart(2, "0");
          const month = p[2].padStart(2, "0");
          const year  = p[3].length === 2 ? "20" + p[3] : p[3];
          return `${year}-${month}-${day}`;
        }

        return "";
      };

      const isoDate = parseDateToISO(travelDate);

      // TBO-first with SerpAPI fallback
      let chatFlights: any[] = [];
      let chatTraceId = "";
      let chatSource: "tbo" | "serp" | "none" = "none";

      if (isoDate) {
        const chatResult = await searchFlightsTBOFirst({
          origin: originIATA,
          destination: destIATA,
          departDate: isoDate,
          adults: extractedAdults,
          cabinClass: extractedCabinClass,
          serpApiSearch: process.env.SERPAPI_API_KEY
            ? async () => {
                const r = await searchFlightRoutes(originIATA, destIATA, isoDate);
                return r.flights || [];
              }
            : undefined,
        });
        chatFlights = chatResult.flights;
        chatTraceId = chatResult.traceId;
        chatSource  = chatResult.source;
        console.log(`[FlightSearch] Live results: ${chatFlights.length} flights via ${chatSource}`);
      } else {
        console.warn("[FlightSearch] No parseable date — skipping live search");
      }

      const chatCheapest = chatFlights.length
        ? chatFlights.reduce((a: any, b: any) => (a.fare?.total || 0) < (b.fare?.total || 0) ? a : b)
        : null;
      const chatFastest = chatFlights.length
        ? chatFlights.reduce((a: any, b: any) => (a.duration || 9999) < (b.duration || 9999) ? a : b)
        : null;

      const hasLiveFlights = chatFlights.length > 0;

      // Fallback booking links (always included)
      const googleFlightsUrl = `https://www.google.com/travel/flights/search?q=flights+from+${encodeURIComponent(origin)}+to+${encodeURIComponent(destination)}${travelDate ? "+on+" + encodeURIComponent(travelDate) : ""}`;
      const makemytripUrl    = `https://www.makemytrip.com/flights/international/${originIATA.toLowerCase()}-to-${destIATA.toLowerCase()}/`;
      const skyscannerUrl    = `https://www.skyscanner.co.in/transport/flights/${originIATA.toLowerCase()}/${destIATA.toLowerCase()}/${isoDate ? isoDate.replace(/-/g,"").slice(2) : ""}/`;

      return res.json({
        ok: true,
        reply: {
          title: `Flights: ${origin} → ${destination}${travelDate ? "  ·  " + travelDate : ""}`,
          context: hasLiveFlights
            ? `Found ${chatFlights.length} flights for ${originIATA} → ${destIATA} on ${travelDate}. Fares are live, shown in INR.`
            : `Showing booking options for ${originIATA} → ${destIATA}${travelDate ? " on " + travelDate : ""}. Live pricing temporarily unavailable — use the links below for real-time fares.`,
          flightSearch: {
            origin:      { city: origin,      iata: originIATA },
            destination: { city: destination, iata: destIATA   },
            date:        travelDate,
            isoDate,
            flights:     chatFlights,
            cheapest:    chatCheapest,
            fastest:     chatFastest,
            traceId:     chatTraceId,
            source:      chatSource,
            links: {
              googleFlights: googleFlightsUrl,
              makemytrip:    makemytripUrl,
              skyscanner:    skyscannerUrl,
            },
            tipLines: buildFlightTipLines(originIATA, destIATA, travelDate),
          },
          nextSteps: [
            "Book your preferred flight and share the flight number",
            "I'll track it and alert you to any schedule changes",
            "I'll adjust your itinerary to match your arrival and departure times",
          ],
          handoff: false,
        },
        context: context || {},
      });
    }


    // 2️⃣ Planning intent gate — ONLY for brand new conversations
    if (!isFollowUp) {
      // ── Flight status queries bypass the planning gate ──
      const isFlightStatusQuery = Boolean(
        prompt.match(/\b(\d?[A-Z]{1,2})[-\s]?(\d{2,4})\b/gi) &&
        /(status|flight|where|landed|delayed|on time|arrival|departure|tell me|what is)/i.test(prompt)
      );

      const hasExplicitPlanningIntent = [
        /plan/i, /itinerary/i, /schedule/i, /create/i, /suggest/i, /recommend/i, /book/i,
        /\d+[\s-]day/i, /\d+[nN]/i,
        /trip to/i, /travel to/i, /visit/i, /fly to/i, /flight to/i,
        /holiday/i, /vacation/i, /getaway/i, /offsite/i, /retreat/i,
        /business trip/i, /work trip/i, /conference/i, /family trip/i,
        /stay in/i, /stay at/i,
        /hotel/i, /accommodation/i, /where to stay/i,
        /what to do/i, /things to do/i, /explore/i,
        /weekend/i, /honeymoon/i, /anniversary/i,
        /nights/i, /days/i,
      ].some(rx => rx.test(prompt));

      const hasDestination = /to ([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/i.test(prompt);
      const hasDuration = /\d+[\s-]day/i.test(prompt) || /\d+[nN]/i.test(prompt);
      const hasOrigin = /(from|departing|flying from|origin)[\s:]+([A-Z][a-z]+)/i.test(prompt);
      const hasDates = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{1,2}[\/\-]\d{1,2}|next week|this week|tomorrow)/i.test(prompt);

      // New conversation with destination but missing origin/dates → ask for details
      if (hasExplicitPlanningIntent && hasDestination && !hasOrigin && !hasDates) {
        const destinationMatch = prompt.match(/to ([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/i);
        const destination = destinationMatch?.[1] || "your destination";
        return res.json({
          ok: true,
          reply: {
            title: `Let's plan your trip to ${destination}`,
            context: `I have a good picture of where you want to go — ${destination}${hasDuration ? " for " + (prompt.match(/\d+[\s-]day/i)?.[0] || prompt.match(/\d+[nN]/i)?.[0] || "") : ""}. To build you the perfect itinerary, I just need a couple more details.`,
            nextSteps: [
              `Where will you be flying from?`,
              `What are your travel dates?`,
              `What's the purpose — business, leisure, or a mix?`,
            ],
            handoff: false,
          },
          context: context || {},
        });
      }

      // No planning intent at all on a fresh message
      if (!hasExplicitPlanningIntent && !isFlightStatusQuery) {
        return res.json({
          ok: true,
          reply: {
            title: "Ready when you are",
            context: "Ask me to plan a trip, create an itinerary, or check a flight status.",
            nextSteps: ["Plan a trip", "Create an itinerary"],
            handoff: false,
          },
          context: context || {},
        });
      }
    }

    /* ───────── Normalize context (Memory Check) ───────── */
    let conversationContext: any;

    const existingId = context?.id || req.body?.conversationId;

    if (existingId) {
      const saved = await getConversationContext(existingId);
      conversationContext =
        saved ||
        (context && typeof context === "object" ? context : { summary: "" });
    } else {
      conversationContext =
        context && typeof context === "object" ? context : { summary: "" };
    }

    if (!conversationContext.id) {
      conversationContext.id = existingId || crypto.randomUUID();
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
        console.log("[FlightService] Fetching live data for:", detectedFlightNumber);
        console.log("[FlightService] API Key present:", Boolean(process.env.FLIGHTAWARE_API_KEY));

        liveFlightData = await fetchFlightFromApi(detectedFlightNumber);

        // ✅ If API returned an error object (not a throw), treat as failure
        if (liveFlightData?.error) {
          console.error("[FlightService] API returned error:", liveFlightData.error);
          liveFlightData = null;
        } else {
          console.log("[FlightService] Live data fetched successfully:", detectedFlightNumber);
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

    /* ───────── AUTHORITATIVE REQUIRED-FIELDS CHECK ───────── */

    const missingFields: string[] = [];

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

    // ❌ Only ask for destination if BOTH locked AND assumed are missing
    if (!hasLockedDestination && !hasAssumedDestination) {
      missingFields.push("destination");
    }

    // ❌ Ask for duration ONLY if missing
    if (!hasLockedDuration) {
      missingFields.push("duration");
    }

    // Persist explicitly so AI cannot guess
    if (missingFields.length > 0) {
      conversationContext.missingFields = missingFields;
    } else {
      delete conversationContext.missingFields;
    }

    // 🆕 EXPLICIT MISSING FIELDS INJECTION (AUTHORITATIVE)
    const missingFieldsString = conversationContext.missingFields
      ? `\nMISSING_FIELDS (ask ONLY these, do NOT ask for anything else):\n${JSON.stringify(
          conversationContext.missingFields,
          null,
          2
        )}\n`
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

    /* ───────── Invoke AI (OpenAI with Gemini Fallback) ───────── */
    let deltaReply: PlutoDeltaReply;

    try {
      deltaReply = await invokePluto(effectivePrompt);
    } catch {
      console.warn("OpenAI failed, switching to Gemini backup...");
      deltaReply = await invokePlutoGemini(effectivePrompt);
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

      const payload = buildHandoffPayload(
        fullReply,
        conversationContext.state,
        conversationContext.locked
      );

      await sendHandoffPayload(payload);
    }

    /* ───────── Save to Memory ───────── */
    await saveConversationContext(conversationContext.id, conversationContext);

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

    return res.json({
      ok: true,
      reply: responseDelta,
      context: conversationContext,
    });
  } catch (err: any) {
    console.error("Pluto travel error:", err);
    return res.status(500).json({
      ok: false,
      message: err?.message || "Failed to generate travel response",
    });
  }
});

/* ────────────────────────────────────────────────────────────────
 * POST /raise-request — Concierge → SBT request pipeline
 * ──────────────────────────────────────────────────────────────── */
router.post("/raise-request", requireAuth, requireWorkspace, async (req: any, res: any) => {
  try {
    const user = req.user;
    if (!user?._id) return res.status(401).json({ error: "Unauthorized" });

    const { flightData, passengers, notes } = req.body;

    if (!flightData || !flightData.ResultIndex || !flightData.TraceId) {
      return res.status(400).json({
        error: "flightData with ResultIndex and TraceId is required",
      });
    }

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

    // Build searchParams from flightData for SBTRequest compatibility
    const searchParams = {
      origin: flightData.origin?.code || "",
      destination: flightData.destination?.code || "",
      departDate: flightData.departure?.date || "",
      cabin: flightData.cabin || "Economy",
      source: "CONCIERGE",
    };

    const request = await SBTRequest.create({
      customerId: workspace._id,
      requesterId: user._id,
      assignedBookerId,
      type: "flight",
      searchParams,
      selectedOption: flightData,
      requesterNotes: notes || null,
      passengerDetails: passengers || [],
      contactDetails: { email: user.email },
      status: "PENDING",
    });

    // Send email to assigned booker
    const booker = await User.findOne({ _id: assignedBookerId, workspaceId: (req as any).workspaceObjectId })
      .select("name email").lean() as any;

    if (booker?.email) {
      const route = `${flightData.origin?.code || "?"} → ${flightData.destination?.code || "?"}`;
      const date = flightData.departure?.date || "";
      const frontendUrl = process.env.FRONTEND_ORIGIN || "http://localhost:5173";

      await sendMail({
        to: booker.email,
        subject: `New Concierge Flight Request from ${user.name || user.email} — ${route}`,
        kind: "REQUESTS",
        html: `
          <h3>New Flight Request (via Concierge)</h3>
          <p><strong>From:</strong> ${user.name || user.email}</p>
          <p><strong>Flight:</strong> ${flightData.airline?.name || ""} ${flightData.flightNo || ""}</p>
          <p><strong>Route:</strong> ${route}</p>
          ${date ? `<p><strong>Date:</strong> ${date}</p>` : ""}
          <p><strong>Fare:</strong> ₹${(flightData.fare?.offered || flightData.fare?.published || 0).toLocaleString("en-IN")}</p>
          ${notes ? `<p><strong>Notes:</strong> ${notes}</p>` : ""}
          <p><a href="${frontendUrl}/sbt/inbox">View in Booking Inbox</a></p>
        `,
      }).catch((e: any) => console.warn("[Concierge] Failed to send request email:", e?.message));
    }

    console.log(`[Concierge/RaiseRequest] Created SBTRequest ${request._id} for ${user.email}`);

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

export default router;