// Multi-leg (Step 4, Piece 3): a flight booking with legs[] bills exactly like
// a single-leg booking of the same price — ONE line (or the ON_MARKUP pair),
// identical qty/rate/GST/amount — with only the sub-description growing to
// the full route + every carrier. Legacy rows print the flat fields as before.
import { describe, it, expect } from "vitest";
import { buildLineItemsForBooking } from "./invoiceLineItems.js";

const pricing = { quotedPrice: 50000, actualPrice: 42000, diff: 8000, markupAmount: 8000, gstPercent: 18, gstMode: "ON_FULL", grandTotal: 59000 };

const single = {
  bookingRef: "MB-1", type: "FLIGHT", travelDate: new Date("2026-10-15T00:00:00Z"),
  passengers: [{ name: "Priya Sharma" }],
  itinerary: { origin: "DEL", destination: "BOM", flightNo: "AI 302", airline: "Air India" },
  pricing,
};
const roundTrip = {
  ...single,
  bookingRef: "MB-2",
  itinerary: {
    origin: "DEL", destination: "BOM", flightNo: "AI 302", airline: "Air India",
    tripType: "ROUND_TRIP",
    legs: [
      { origin: "DEL", destination: "BOM", flightNo: "AI 302", airline: "Air India" },
      { origin: "BOM", destination: "DEL", flightNo: "AI 303", airline: "Air India" },
    ],
  },
};

const money = (li: any) => ({ rowType: li.rowType, qty: li.qty, rate: li.rate, igst: li.igst, amount: li.amount });

describe("invoice line items — multi-leg is description-only", () => {
  it("ON_FULL: a round trip is ONE line with the full route + both carriers; money identical to the single-leg twin", () => {
    const a = buildLineItemsForBooking(single);
    const b = buildLineItemsForBooking(roundTrip);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(money(b[0])).toEqual(money(a[0]));
    expect(b[0].amount).toBe(59000);
    expect(a[0].subDescription).toContain("DEL-BOM");
    expect(a[0].subDescription).toContain("Air India AI 302");
    expect(b[0].subDescription).toContain("DEL-BOM-DEL");
    expect(b[0].subDescription).toContain("Air India AI 302 / Air India AI 303");
    expect(b[0].subDescription).not.toMatch(/DEL-BOM-DEL.*DEL-BOM-DEL/); // route printed once
  });

  it("ON_MARKUP: still the COST + SERVICE_FEE pair, never a line per leg", () => {
    const p = { ...pricing, gstMode: "ON_MARKUP" };
    const a = buildLineItemsForBooking({ ...single, pricing: p });
    const b = buildLineItemsForBooking({ ...roundTrip, pricing: p });
    expect(b.map((l: any) => l.rowType)).toEqual(a.map((l: any) => l.rowType));
    expect(b.map(money)).toEqual(a.map(money));
  });

  it("legacy (no legs) prints the flat route exactly as before", () => {
    const [li] = buildLineItemsForBooking(single);
    expect(li.subDescription).toMatch(/DEL-BOM(?!-)/);
  });
});
