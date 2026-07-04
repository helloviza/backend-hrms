// apps/backend/src/services/routeInsights.ts
//
// Route intelligence computed ONLY from this workspace's FareObservation
// history. Grounding rule: never invent fares — return "insufficient" when
// there are fewer than MIN_OBSERVATIONS data points.
//
// Cross-workspace aggregation is a product decision we have NOT made, so reads
// are scoped to the requesting workspace only (see Step 6 report note).

import FareObservation from "../models/FareObservation.js";

export interface RouteInsights {
  typicalFareRange: { p25: number; p75: number } | null;
  cheapestAirlineRecent: string | null;
  observationCount: number;
  dataWindowDays: number;
  sufficient: boolean;
}

export const MIN_OBSERVATIONS = 10;
const DEFAULT_WINDOW_DAYS = 90;

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return Math.round(sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo));
}

/** PURE: aggregate observations into route insights. */
export function computeRouteInsights(
  observations: Array<{ fareINR: number; airline?: string }>,
  windowDays: number,
): RouteInsights {
  const fares = observations
    .map((o) => o.fareINR)
    .filter((n) => typeof n === "number" && n > 0)
    .sort((a, b) => a - b);
  const observationCount = fares.length;

  if (observationCount < MIN_OBSERVATIONS) {
    return {
      typicalFareRange: null,
      cheapestAirlineRecent: null,
      observationCount,
      dataWindowDays: windowDays,
      sufficient: false,
    };
  }

  // Cheapest airline recently = airline with the lowest observed fare.
  const minByAirline = new Map<string, number>();
  for (const o of observations) {
    if (!o.airline || typeof o.fareINR !== "number" || o.fareINR <= 0) continue;
    const cur = minByAirline.get(o.airline);
    if (cur === undefined || o.fareINR < cur) minByAirline.set(o.airline, o.fareINR);
  }
  let cheapestAirlineRecent: string | null = null;
  let best = Infinity;
  for (const [airline, min] of minByAirline) {
    if (min < best) { best = min; cheapestAirlineRecent = airline; }
  }

  return {
    typicalFareRange: { p25: percentile(fares, 25), p75: percentile(fares, 75) },
    cheapestAirlineRecent,
    observationCount,
    dataWindowDays: windowDays,
    sufficient: true,
  };
}

export interface RouteInsightsArgs {
  origin: string;
  destination: string;
  departDate?: string;
  workspaceObjectId: any;
  windowDays?: number;
}

/**
 * Tenant-scoped read + compute. Fail-safe: any error → insufficient (chat never
 * blocks on this). Aggregates route-level fares by recency (observedAt window),
 * across departDates.
 */
export async function getRouteInsights(args: RouteInsightsArgs): Promise<RouteInsights> {
  const windowDays = args.windowDays ?? DEFAULT_WINDOW_DAYS;
  const empty: RouteInsights = {
    typicalFareRange: null,
    cheapestAirlineRecent: null,
    observationCount: 0,
    dataWindowDays: windowDays,
    sufficient: false,
  };
  if (!args.workspaceObjectId || !args.origin || !args.destination) return empty;

  try {
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const obs = (await FareObservation.find({
      workspaceId: args.workspaceObjectId, // tenant-scoped ONLY
      origin: args.origin,
      destination: args.destination,
      observedAt: { $gte: since },
    })
      .select("fareINR airline")
      .lean()) as any[];
    return computeRouteInsights(obs, windowDays);
  } catch (e: any) {
    console.error("[routeInsights] read failed", { message: e?.message });
    return empty;
  }
}
