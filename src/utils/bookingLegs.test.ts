// utils/bookingLegs.ts — the one place the staff export, the customer export
// and the invoice sub-description agree on how a multi-leg trip prints.
import { describe, it, expect } from "vitest";
import { bookingLegs, bookingTripType, bookingLegRoute, bookingLegCarriers, bookingLegDetail } from "./bookingLegs.js";

const rt = {
  type: "FLIGHT",
  itinerary: {
    origin: "DEL", destination: "BOM", flightNo: "AI 302", airline: "Air India",
    tripType: "ROUND_TRIP",
    legs: [
      { origin: "DEL", destination: "BOM", flightNo: "AI 302", airline: "Air India", departDate: new Date("2026-10-15T00:00:00Z") },
      { origin: "BOM", destination: "DEL", flightNo: "AI 303", airline: "Air India", departDate: "2026-10-20T00:00:00.000Z" },
    ],
  },
};
const legacy = { type: "FLIGHT", itinerary: { origin: "BLR", destination: "HYD", flightNo: "6E 77", airline: "IndiGo" } };

describe("bookingLegs helpers", () => {
  it("round trip: type, route through the turnaround, carriers per leg, one-cell detail", () => {
    expect(bookingTripType(rt)).toBe("ROUND_TRIP");
    expect(bookingLegRoute(rt)).toBe("DEL→BOM→DEL");
    expect(bookingLegRoute(rt, "-")).toBe("DEL-BOM-DEL");
    expect(bookingLegCarriers(rt)).toBe("Air India AI 302 / Air India AI 303");
    expect(bookingLegDetail(rt)).toBe("1. DEL→BOM AI 302 Air India 15/10/2026 | 2. BOM→DEL AI 303 Air India 20/10/2026");
  });

  it("legacy (no legs) and empty legs[] print nothing — the flat columns carry the row", () => {
    for (const b of [legacy, { itinerary: { legs: [] } }, { itinerary: undefined }, null]) {
      expect(bookingLegs(b)).toEqual([]);
      expect(bookingTripType(b)).toBe("");
      expect(bookingLegRoute(b)).toBe("");
      expect(bookingLegCarriers(b)).toBe("");
      expect(bookingLegDetail(b)).toBe("");
    }
  });

  it("multi-city with a surface break prints both airports at the break; codes uppercased", () => {
    const b = { itinerary: { tripType: "MULTI_CITY", legs: [
      { origin: "del", destination: "bom" },
      { origin: "goi", destination: "blr", flightNo: null, airline: undefined },
    ] } };
    expect(bookingLegRoute(b)).toBe("DEL→BOM→GOI→BLR");
    expect(bookingLegDetail(b)).toBe("1. DEL→BOM | 2. GOI→BLR");
    expect(bookingLegCarriers(b)).toBe("");
  });

  it("tripType is only reported when legs exist (a stray tripType on a legless row is ignored)", () => {
    expect(bookingTripType({ itinerary: { tripType: "ROUND_TRIP" } })).toBe("");
  });
});
