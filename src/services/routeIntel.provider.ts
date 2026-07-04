// apps/backend/src/services/routeIntel.provider.ts
//
// Provider interface for route intelligence. The only LIVE implementation is
// FareObservation-backed. Amadeus is greenfield (Step 0 #4 — no client/creds in
// the repo), so it is a clearly-marked TODO stub behind the same interface: the
// cold-start backfill point for when observation counts are thin.

import { getRouteInsights, type RouteInsights, type RouteInsightsArgs } from "./routeInsights.js";

export interface RouteIntelProvider {
  name: string;
  getRouteInsights(args: RouteInsightsArgs): Promise<RouteInsights>;
}

// LIVE: fares from this workspace's FareObservation history.
export const fareObservationProvider: RouteIntelProvider = {
  name: "fare_observations",
  getRouteInsights,
};

// TODO(amadeus cold-start): backfill route facts from Amadeus when observation
// count is thin. No Amadeus client/creds exist yet — this stub returns
// "insufficient" so the grounding rule (never invent) holds until it is built.
export const amadeusProviderStub: RouteIntelProvider = {
  name: "amadeus_stub",
  async getRouteInsights(args) {
    return {
      typicalFareRange: null,
      cheapestAirlineRecent: null,
      observationCount: 0,
      dataWindowDays: args.windowDays ?? 0,
      sufficient: false,
    };
  },
};

export function getRouteIntelProvider(): RouteIntelProvider {
  return fareObservationProvider; // Amadeus deferred
}
