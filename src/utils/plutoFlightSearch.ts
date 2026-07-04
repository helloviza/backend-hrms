// apps/backend/src/utils/plutoFlightSearch.ts
//
// Concierge (Pluto) chat flight-search helpers. Extracted from
// routes/copilot.travel.ts so the mapping + search logic is unit-testable
// without importing the full route (which pulls in the OpenAI/Gemini clients
// that construct at import time).
//
// The hardened POST /flights/search path imports CABIN_LABELS,
// dedupeRawTBOFlights and mapTBOFlight from here — their behaviour is
// byte-for-byte the same as before extraction. Do NOT change it.

import { searchFlights as tboSearchFlights } from "../services/tbo.flight.service.js";
import {
  evaluateFlightPolicy,
  flightForPolicyFromTBO,
  type PolicyRules,
} from "../services/policyEvaluator.js";

// In-policy first, then needs-approval, then out-of-policy. Stable, so the
// within-rank fare ordering from dedupeRawTBOFlights is preserved.
const POLICY_RANK: Record<string, number> = { IN_POLICY: 0, NEEDS_APPROVAL: 1, OUT_OF_POLICY: 2 };
function sortInPolicyFirst(flights: any[]): any[] {
  return flights
    .map((f, i) => ({ f, i }))
    .sort((a, b) => {
      const ra = POLICY_RANK[a.f?.policy?.status] ?? 0;
      const rb = POLICY_RANK[b.f?.policy?.status] ?? 0;
      return ra - rb || a.i - b.i;
    })
    .map((x) => x.f);
}

// CABIN_LABELS — shared between the chat path and the structured /flights/search
// path so both produce identical `cabin` strings.
export const CABIN_LABELS: Record<number, string> = {
  1: "All", 2: "Economy", 3: "Premium Economy",
  4: "Business", 5: "Premium Business", 6: "First",
};

// Group raw TBO Result rows by SBT's dedup key — airlineCode + flightNumber +
// DepTime + ArrTime (mirrors SBTFlightSearch.groupByFlight, lines 753-772).
// Returns the cheapest fare-class per physical routing, sorted ascending by
// fare. Drops duplicate fare classes that would otherwise render as multiple
// identical-looking cards.
export function dedupeRawTBOFlights(rawResults: any[]): any[] {
  const map = new Map<string, any>();
  for (const r of rawResults) {
    const segs: any[] = r?.Segments?.[0] || [];
    const first = segs[0];
    const last = segs[segs.length - 1];
    if (!first) continue;
    const key = [
      first.Airline?.AirlineCode ?? "",
      first.Airline?.FlightNumber ?? "",
      first.Origin?.DepTime ?? "",
      last?.Destination?.ArrTime ?? "",
    ].join("|");
    const fare = r?.Fare?.OfferedFare ?? r?.Fare?.PublishedFare ?? r?.Fare?.TotalFare ?? 0;
    const prev = map.get(key);
    if (!prev || fare < (prev._fareKey ?? Infinity)) {
      (r as any)._fareKey = fare;
      map.set(key, r);
    }
  }
  return Array.from(map.values()).sort(
    (a, b) => (a._fareKey ?? 0) - (b._fareKey ?? 0),
  );
}

// Single source of truth: maps one TBO Result row → SBT-aligned flight object
// that the concierge UI's `toSBTFlight` mapper can consume.
// Used by BOTH the structured /flights/search endpoint AND the chat NLP
// endpoint, so the panel renders identically regardless of trigger.
//
// `time` is emitted in 24-hour HH:mm:ss (NOT "07:20 am") so the frontend's
// `toSBTFlight` mapper can concatenate `${date}T${time}` into a valid ISO
// datetime. FlightResultCard's formatTime then re-formats for display.
export function mapTBOFlight(
  r: any,
  opts: { traceId: string; originIATA: string; destIATA: string; cabinLabel: string },
): any | null {
  const segs: any[] = r?.Segments?.[0] || [];
  const first = segs[0];
  const last = segs[segs.length - 1];
  if (!first || !r?.Fare) return null;

  const airlineCode = first.Airline?.AirlineCode || "";
  const depRawIso = first.Origin?.DepTime || "";
  const arrRawIso = last.Destination?.ArrTime || "";
  const depDt = new Date(depRawIso);
  const arrDt = new Date(arrRawIso);
  const totalMin = segs.reduce((s: number, seg: any) => s + (seg.Duration || 0), 0);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;

  const isoTimeOf = (raw: string, d: Date): string => {
    if (!isNaN(d.getTime())) {
      // Use the raw TBO ISO time portion (HH:mm:ss) so we don't introduce a
      // timezone shift. TBO timestamps are local-with-no-offset; new Date()
      // interprets them as local, toLocaleTimeString would reformat which
      // round-trips fine but the raw string is the cleanest source.
      const m = raw.match(/T(\d{2}:\d{2}(?::\d{2})?)/);
      if (m) return m[1].length === 5 ? `${m[1]}:00` : m[1];
      return d.toTimeString().slice(0, 8);
    }
    return "";
  };

  return {
    ResultIndex: r.ResultIndex,
    TraceId: opts.traceId,
    airline: {
      name: first.Airline?.AirlineName || airlineCode,
      code: airlineCode,
      logo: airlineCode ? `https://pics.avs.io/60/60/${airlineCode}.png` : "",
    },
    flightNo: `${airlineCode}-${first.Airline?.FlightNumber || ""}`,
    origin: {
      code: first.Origin?.Airport?.AirportCode || opts.originIATA,
      city: first.Origin?.Airport?.CityName || "",
      terminal: first.Origin?.Airport?.Terminal || "",
    },
    destination: {
      code: last.Destination?.Airport?.AirportCode || opts.destIATA,
      city: last.Destination?.Airport?.CityName || "",
      terminal: last.Destination?.Airport?.Terminal || "",
    },
    departure: {
      time: isoTimeOf(depRawIso, depDt),
      date: isNaN(depDt.getTime()) ? "" : depDt.toISOString().slice(0, 10),
    },
    arrival: {
      time: isoTimeOf(arrRawIso, arrDt),
      date: isNaN(arrDt.getTime()) ? "" : arrDt.toISOString().slice(0, 10),
    },
    duration: `${h}h ${m}m`,
    stops: segs.length - 1,
    fare: {
      published: r.Fare?.PublishedFare || r.Fare?.TotalFare || r.FareBreakdown?.[0]?.BaseFare || 0,
      offered: r.Fare?.OfferedFare || r.Fare?.PublishedFare || r.Fare?.TotalFare || 0,
      currency: r.Fare?.Currency || "INR",
    },
    cabin: CABIN_LABELS[first.CabinClass] || opts.cabinLabel,
    baggage: first.Baggage || "",
    isLCC: r.IsLCC ?? false,
    isRefundable: r.IsRefundable === true,
  };
}

/**
 * Result for the chat flight search.
 *
 *  - ok:true  → the search ran; `flights` may be empty (genuine zero results),
 *               and `reason` is null.
 *  - ok:false → the search itself failed; `reason` distinguishes an upstream
 *               TBO error (`TBO_ERROR`) from a thrown exception / transport
 *               failure (`SEARCH_EXCEPTION`). The caller must render an
 *               explicit "temporarily unavailable" state — NOT a zero-results
 *               reply.
 *
 * Flat (non-discriminated) shape on purpose: this backend compiles with
 * `strictNullChecks: false`, under which TypeScript does not narrow
 * discriminated unions, so every field is always present.
 */
export type ChatFlightSearchReason = "TBO_ERROR" | "SEARCH_EXCEPTION";

export interface ChatFlightSearchResult {
  ok: boolean;
  reason: ChatFlightSearchReason | null;
  flights: any[];
  inbound: any[];
  traceId: string;
}

/**
 * TBO-only flight search for the concierge chat endpoint.
 *
 * Failures are NO LONGER collapsed to an empty array — that made a real
 * upstream outage indistinguishable from a genuine zero-results route. The
 * result is a discriminated union (see ChatFlightSearchResult).
 *
 * Round-trip: pass journeyType:2 with a returnDate to search both legs; the
 * inbound options are mapped from TBO Results[1] exactly as the hardened
 * /flights/search path does. One-way (journeyType:1, the default) is unchanged.
 * No workspace margin is applied here — margin parity remains owned by the
 * hardened /flights/search path only.
 */
export async function searchFlightsForChat(params: {
  origin: string;
  destination: string;
  departDate: string;
  returnDate?: string;
  journeyType?: 1 | 2;
  adults?: number;
  children?: number;
  infants?: number;
  cabinClass?: number;
  cabinLabel?: string;
  requestId?: string;
  policyRules?: PolicyRules | null;
}): Promise<ChatFlightSearchResult> {
  const {
    origin, destination, departDate, returnDate,
    journeyType = 1,
    adults = 1, children = 0, infants = 0,
    cabinClass = 2,
    cabinLabel = CABIN_LABELS[cabinClass] || "Economy",
    requestId = "",
    policyRules = null,
  } = params;

  try {
    const tboResult: any = await tboSearchFlights({
      origin,
      destination,
      departDate,
      returnDate: journeyType === 2 ? returnDate : undefined,
      JourneyType: journeyType,
      adults,
      children,
      infants,
      cabinClass,
    });

    const traceId = tboResult?.Response?.TraceId || "";
    const status = tboResult?.Response?.ResponseStatus ?? tboResult?.Response?.Status;

    if (status !== undefined && status !== 1) {
      console.error("[ConciergeFlights] TBO non-success", {
        requestId,
        status,
        errCode: tboResult?.Response?.Error?.ErrorCode,
        errMsg: tboResult?.Response?.Error?.ErrorMessage,
        traceId,
        origin,
        destination,
        departDate,
      });
      return { ok: false, reason: "TBO_ERROR", flights: [], inbound: [], traceId };
    }

    const resultsArr: any[] = Array.isArray(tboResult?.Response?.Results)
      ? tboResult.Response.Results
      : [];
    const outboundRaw: any[] = Array.isArray(resultsArr[0]) ? resultsArr[0] : [];
    const inboundRaw: any[] = Array.isArray(resultsArr[1]) ? resultsArr[1] : [];

    const opts = { traceId, originIATA: origin, destIATA: destination, cabinLabel };
    // Dedupe by SBT's exact key (airline + flightNo + DepTime + ArrTime),
    // cheapest fare-class wins. Then cap. Without dedupe a busy route like
    // CCU→DEL returns 100+ rows with massive fare-class duplication that
    // would crowd the chat panel with identical-looking cards and bias the
    // top-by-fare slice toward a single low-cost airline.
    // Each mapped flight is ANNOTATED with an additive `policy` field
    // (never filtered), then chat results are sorted in-policy first.
    const mapAnnotate = (rows: any[]): any[] =>
      rows
        .map((r: any) => {
          const f = mapTBOFlight(r, opts);
          if (f) f.policy = evaluateFlightPolicy(flightForPolicyFromTBO(r), policyRules);
          return f;
        })
        .filter(Boolean);

    const flights = sortInPolicyFirst(
      mapAnnotate(dedupeRawTBOFlights(outboundRaw).slice(0, 30)),
    );
    const inbound = journeyType === 2
      ? sortInPolicyFirst(mapAnnotate(dedupeRawTBOFlights(inboundRaw).slice(0, 30)))
      : [];

    return { ok: true, reason: null, flights, inbound, traceId };
  } catch (err: any) {
    console.error("[ConciergeFlights] TBO search failed", {
      requestId,
      message: err?.message,
      origin,
      destination,
      departDate,
    });
    return { ok: false, reason: "SEARCH_EXCEPTION", flights: [], inbound: [], traceId: "" };
  }
}
