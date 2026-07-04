import { describe, it, expect, vi, beforeEach } from "vitest";

const { findMock } = vi.hoisted(() => ({ findMock: vi.fn() }));
vi.mock("../models/FareObservation.js", () => ({ default: { find: findMock } }));

import { computeRouteInsights, getRouteInsights, MIN_OBSERVATIONS } from "./routeInsights.js";

describe("computeRouteInsights (pure)", () => {
  it("< MIN_OBSERVATIONS → insufficient, ranges null", () => {
    const obs = Array.from({ length: MIN_OBSERVATIONS - 1 }, () => ({ fareINR: 5000, airline: "6E" }));
    const r = computeRouteInsights(obs, 90);
    expect(r.sufficient).toBe(false);
    expect(r.typicalFareRange).toBeNull();
    expect(r.cheapestAirlineRecent).toBeNull();
    expect(r.observationCount).toBe(MIN_OBSERVATIONS - 1);
  });

  it(">= MIN_OBSERVATIONS → p25/p75 + cheapest airline", () => {
    // fares 1000..10000 (10 obs), airline AI carries the 1000 (cheapest).
    const obs = [
      { fareINR: 1000, airline: "AI" },
      ...Array.from({ length: 9 }, (_, i) => ({ fareINR: 2000 + i * 1000, airline: "6E" })),
    ];
    const r = computeRouteInsights(obs, 90);
    expect(r.sufficient).toBe(true);
    expect(r.observationCount).toBe(10);
    // sorted: [1000,2000,...,10000]; p25≈3250, p75≈7750 (interp on 10 points)
    expect(r.typicalFareRange!.p25).toBeGreaterThan(r.typicalFareRange!.p25 - 1); // sanity
    expect(r.typicalFareRange!.p25).toBeLessThan(r.typicalFareRange!.p75);
    expect(r.cheapestAirlineRecent).toBe("AI");
  });

  it("percentiles are correct for a known set", () => {
    const fares = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
    const r = computeRouteInsights(fares.map((f) => ({ fareINR: f, airline: "6E" })), 60);
    // idx p25 = 0.25*9=2.25 → 3000 + 0.25*1000 = 3250; p75 = 0.75*9=6.75 → 7000+0.75*1000=7750
    expect(r.typicalFareRange).toEqual({ p25: 3250, p75: 7750 });
    expect(r.dataWindowDays).toBe(60);
  });
});

describe("getRouteInsights (tenant-scoped read)", () => {
  beforeEach(() => findMock.mockReset());

  it("scopes the query to the requesting workspace + route", async () => {
    findMock.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
    await getRouteInsights({ origin: "DEL", destination: "BOM", workspaceObjectId: "ws1" });
    const filter = findMock.mock.calls[0][0];
    expect(filter.workspaceId).toBe("ws1");
    expect(filter.origin).toBe("DEL");
    expect(filter.destination).toBe("BOM");
    expect(filter.observedAt.$gte).toBeInstanceOf(Date);
  });

  it("no workspace → insufficient, no query", async () => {
    const r = await getRouteInsights({ origin: "DEL", destination: "BOM", workspaceObjectId: null });
    expect(r.sufficient).toBe(false);
    expect(findMock).not.toHaveBeenCalled();
  });

  it("DB error → insufficient (fail-safe)", async () => {
    findMock.mockReturnValue({ select: () => ({ lean: () => Promise.reject(new Error("down")) }) });
    const r = await getRouteInsights({ origin: "DEL", destination: "BOM", workspaceObjectId: "ws1" });
    expect(r.sufficient).toBe(false);
  });
});
