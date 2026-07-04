// Phase 5 Step 1 — pure assembly + policy rollup.
import { describe, it, expect } from "vitest";
import {
  assembleItinerary,
  assembleItem,
  rollupPolicy,
  computeTotal,
  normalizeItemPolicy,
} from "./itineraryAssembly.js";

const flight = (kind: any, price: number, status?: string) => ({
  kind,
  payload: { flightNo: "AI-101", fare: { offered: price } },
  policy: status ? { status, reasons: status === "IN_POLICY" ? [] : ["price_above_cap"] } : null,
  priceINR: price,
});
const hotel = (price: number, status?: string) => ({
  kind: "HOTEL" as const,
  payload: { HotelName: "Taj", totalFare: price },
  policy: status ? { status, reasons: [] } : null,
  priceINR: price,
});

describe("normalizeItemPolicy", () => {
  it("passes through valid statuses + reasons; defaults unknown → IN_POLICY", () => {
    expect(normalizeItemPolicy({ status: "OUT_OF_POLICY", reasons: ["x"] })).toEqual({ status: "OUT_OF_POLICY", reasons: ["x"] });
    expect(normalizeItemPolicy(null)).toEqual({ status: "IN_POLICY", reasons: [] });
    expect(normalizeItemPolicy({ status: "weird" })).toEqual({ status: "IN_POLICY", reasons: [] });
  });
});

describe("assembleItem", () => {
  it("throws loudly on an invalid kind", () => {
    expect(() => assembleItem({ kind: "TRAIN" as any, payload: {} })).toThrow(/Invalid itinerary item kind/);
  });
});

describe("rollupPolicy (worst-of) + computeTotal", () => {
  it("worst wins", () => {
    expect(rollupPolicy([{ policy: { status: "IN_POLICY" } }, { policy: { status: "NEEDS_APPROVAL" } }])).toBe("NEEDS_APPROVAL");
    expect(rollupPolicy([{ policy: { status: "OUT_OF_POLICY" } }, { policy: { status: "NEEDS_APPROVAL" } }])).toBe("OUT_OF_POLICY");
    expect(rollupPolicy([])).toBe("IN_POLICY");
  });
  it("sums prices", () => {
    expect(computeTotal([{ priceINR: 5000 }, { priceINR: 3000 }])).toBe(8000);
  });
});

describe("assembleItinerary", () => {
  it("builds ordered items, total, and worst-of summary", () => {
    const r = assembleItinerary([], [
      hotel(9000, "OUT_OF_POLICY"),
      flight("FLIGHT_OUTBOUND", 5000, "IN_POLICY"),
      flight("FLIGHT_INBOUND", 4000, "NEEDS_APPROVAL"),
    ]);
    expect(r.items.map((i) => i.kind)).toEqual(["FLIGHT_OUTBOUND", "FLIGHT_INBOUND", "HOTEL"]); // canonical order
    expect(r.totalPriceINR).toBe(18000);
    expect(r.policySummary).toBe("OUT_OF_POLICY"); // worst item
    expect(r.items[0].policy).toEqual({ status: "IN_POLICY", reasons: [] });
  });

  it("same-kind add REPLACES (one outbound / inbound / hotel)", () => {
    const first = assembleItinerary([], [flight("FLIGHT_OUTBOUND", 5000, "IN_POLICY")]);
    const second = assembleItinerary(first.items, [flight("FLIGHT_OUTBOUND", 7000, "NEEDS_APPROVAL")]);
    expect(second.items.length).toBe(1);
    expect(second.items[0].priceINR).toBe(7000);
    expect(second.totalPriceINR).toBe(7000);
    expect(second.policySummary).toBe("NEEDS_APPROVAL");
  });

  it("merges a new kind into the existing draft without dropping others", () => {
    const first = assembleItinerary([], [flight("FLIGHT_OUTBOUND", 5000, "IN_POLICY")]);
    const merged = assembleItinerary(first.items, [hotel(9000, "IN_POLICY")]);
    expect(merged.items.map((i) => i.kind)).toEqual(["FLIGHT_OUTBOUND", "HOTEL"]);
    expect(merged.totalPriceINR).toBe(14000);
  });
});
