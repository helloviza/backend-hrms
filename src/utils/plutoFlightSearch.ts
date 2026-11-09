// apps/backend/src/utils/plutoFlightSearch.ts
//
// Concierge (Pluto) chat flight-search helpers. Extracted from
// routes/copilot.travel.ts so the mapping + search logic is unit-testable
// without importing the full route (which pulls in the OpenAI/Gemini clients
// that construct at import time).
//
// The hardened POST /flights/search path imports CABIN_LABELS,
// dedupeRawTBOFlights and mapTBOFlight from here, so both endpoints map rows
// identically. One deliberate change since extraction (Pluto Hotfix A, F-04):
// `duration` now includes layovers and every row carries `durationMin`.

import { searchFlights as tboSearchFlights } from "../services/tbo.flight.service.js";
import {
  evaluateFlightPolicy,
  flightForPolicyFromTBO,
  type PolicyRules,
} from "../services/policyEvaluator.js";
import { recordFareObservations } from "../services/fareObservations.js";
import { sellingFlight } from "../services/sbtQuote.js";
import { flightRouteMargins, type RouteMargins } from "../services/sbtMargin.js";
import { airportAnnotation, partitionRowsByAirport } from "./plutoAirportMatch.js";

/** Rows kept per group after the airport split (MATCH rows are what tiers see). */
export const MATCH_ROW_CAP = 30;
export const OTHER_AIRPORT_ROW_CAP = 10;

/**
 * Dedupe one leg's raw rows, then split them by airport (plutoAirportMatch)
 * BEFORE capping, so rows into a nearby airport can never crowd the requested
 * airport's rows out of the 30. `legOrigin`/`legDest` are the leg's own
 * direction — for the return leg that is destination → origin.
 */
export function splitLegRows(
  raw: any[],
  legOrigin: string,
  legDest: string,
): { match: any[]; other: any[] } {
  const { match, other } = partitionRowsByAirport(dedupeRawTBOFlights(raw), legOrigin, legDest);
  return { match: match.slice(0, MATCH_ROW_CAP), other: other.slice(0, OTHER_AIRPORT_ROW_CAP) };
}

/** Additive airport fields on a mapped row (airportMatch + labels). */
export function withAirportFields(mapped: any, raw: any, legOrigin: string, legDest: string): any {
  if (!mapped) return mapped;
  return Object.assign(mapped, airportAnnotation(raw, legOrigin, legDest));
}

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

/**
 * Door-to-door elapsed minutes for one leg, from TBO's own durations — which
 * are time-zone-correct, unlike subtracting the offset-less local DepTime and
 * ArrTime. Multi-segment: the last segment's AccumulatedDuration (TBO's total
 * including layovers) when TBO sends it; otherwise each segment's Duration plus
 * the GroundTime (layover) before every segment after the first. The old sum
 * of Durations alone dropped the layovers.
 */
export function tboElapsedMinutes(segs: any[]): number {
  const list = Array.isArray(segs) ? segs : [];
  if (list.length === 0) return 0;
  const num = (v: unknown): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  if (list.length > 1) {
    const acc = num(list[list.length - 1]?.AccumulatedDuration);
    if (acc > 0) return acc;
  }
  return list.reduce(
    (s: number, seg: any, i: number) => s + num(seg?.Duration) + (i > 0 ? num(seg?.GroundTime) : 0),
    0,
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
  const totalMin = tboElapsedMinutes(segs);
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

  // Mirror isoTimeOf for the DATE (Amendment W). TBO timestamps are
  // local-with-no-offset, so new Date(raw).toISOString() converts to UTC and can
  // shift the calendar date by a day (an early-morning IST departure rolls back;
  // a late-evening departure on a behind-UTC server rolls forward). Read the raw
  // YYYY-MM-DD portion — the same source the time uses — so the booked/displayed
  // date is stable regardless of the server timezone.
  const isoDateOf = (raw: string, d: Date): string => {
    const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
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
      date: isoDateOf(depRawIso, depDt),
    },
    arrival: {
      time: isoTimeOf(arrRawIso, arrDt),
      date: isoDateOf(arrRawIso, arrDt),
    },
    duration: `${h}h ${m}m`,
    // The one duration every surface renders and "Fastest" ranks on. Never
    // re-derive it from DepTime/ArrTime: those are airport-LOCAL times with no
    // offset, so BLR 20:55 → AUH 23:45 subtracts to 2h50m for a 4h20m flight.
    durationMin: totalMin,
    stops: segs.length - 1,
    fare: {
      // Both carry the SELLING total: TBO's OfferedFare is our net-of-commission
      // cost and is never shown (callers pass rows through sellingFlight first).
      published: r.Fare?.PublishedFare || r.Fare?.TotalFare || r.FareBreakdown?.[0]?.BaseFare || 0,
      offered: r.Fare?.PublishedFare || r.Fare?.TotalFare || 0,
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
  /** Rows that depart the requested origin city and land in the requested destination city. */
  flights: any[];
  inbound: any[];
  /** Rows into (or out of) a different airport — never tiered, shown as their own group. */
  otherAirportFlights: any[];
  inboundOtherAirport: any[];
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
 * Prices are SELLING prices: `margins` (the workspace's flight percents, as SBT
 * search applies them — resolved from `workspaceObjectId` when not given) are
 * folded in and every net / commission field dropped before mapping
 * (services/sbtQuote.ts sellingFlight).
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
  workspaceObjectId?: any;
  margins?: number | RouteMargins;
}): Promise<ChatFlightSearchResult> {
  const {
    origin, destination, departDate, returnDate,
    journeyType = 1,
    adults = 1, children = 0, infants = 0,
    cabinClass = 2,
    cabinLabel = CABIN_LABELS[cabinClass] || "Economy",
    requestId = "",
    policyRules = null,
    workspaceObjectId = null,
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
      return { ok: false, reason: "TBO_ERROR", flights: [], inbound: [], otherAirportFlights: [], inboundOtherAirport: [], traceId };
    }

    const resultsArr: any[] = Array.isArray(tboResult?.Response?.Results)
      ? tboResult.Response.Results
      : [];
    const margins = params.margins ?? (await flightRouteMargins(workspaceObjectId));
    const sell = (rows: unknown): any[] => (Array.isArray(rows) ? rows.map((r: any) => sellingFlight(r, margins)) : []);
    const outboundRaw: any[] = sell(resultsArr[0]);
    const inboundRaw: any[] = sell(resultsArr[1]);

    const opts = { traceId, originIATA: origin, destIATA: destination, cabinLabel };
    // Dedupe by SBT's exact key (airline + flightNo + DepTime + ArrTime),
    // cheapest fare-class wins. Then cap. Without dedupe a busy route like
    // CCU→DEL returns 100+ rows with massive fare-class duplication that
    // would crowd the chat panel with identical-looking cards and bias the
    // top-by-fare slice toward a single low-cost airline.
    // Each mapped flight is ANNOTATED with an additive `policy` field
    // (never filtered), then chat results are sorted in-policy first.
    // Rows are also split by airport (plutoAirportMatch): only rows serving the
    // requested airports are `flights`/`inbound`; the rest come back separately.
    const mapAnnotate = (rows: any[], legOrigin: string, legDest: string): any[] =>
      rows
        .map((r: any) => {
          const f = withAirportFields(mapTBOFlight(r, opts), r, legOrigin, legDest);
          if (f) f.policy = evaluateFlightPolicy(flightForPolicyFromTBO(r), policyRules);
          return f;
        })
        .filter(Boolean);

    const out = splitLegRows(outboundRaw, origin, destination);
    const flights = sortInPolicyFirst(mapAnnotate(out.match, origin, destination));
    const otherAirportFlights = sortInPolicyFirst(mapAnnotate(out.other, origin, destination));

    // Passive fare logging (fire-and-forget; never affects this search). MATCH
    // rows only: an AUH fare is not a DXB fare and must not shape DXB history.
    recordFareObservations({
      workspaceObjectId,
      origin,
      destination,
      departDate,
      requestId,
      rawRows: out.match,
    });
    const back = journeyType === 2
      ? splitLegRows(inboundRaw, destination, origin)
      : { match: [], other: [] };
    const inbound = sortInPolicyFirst(mapAnnotate(back.match, destination, origin));
    const inboundOtherAirport = sortInPolicyFirst(mapAnnotate(back.other, destination, origin));

    return { ok: true, reason: null, flights, inbound, otherAirportFlights, inboundOtherAirport, traceId };
  } catch (err: any) {
    console.error("[ConciergeFlights] TBO search failed", {
      requestId,
      message: err?.message,
      origin,
      destination,
      departDate,
    });
    return { ok: false, reason: "SEARCH_EXCEPTION", flights: [], inbound: [], otherAirportFlights: [], inboundOtherAirport: [], traceId: "" };
  }
}
