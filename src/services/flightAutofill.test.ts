// Pure mapping from an extracted flight voucher to the create form's fields
// (services/flightAutofill.ts). No I/O, no model — hand-written vouchers in
// the shapes the extractor actually emits.
import { describe, it, expect } from "vitest";
import { buildFlightAutofill, normalizePassengerType, parseTicketDate } from "./flightAutofill.js";
import type { PlumtripsVoucher } from "../types/index.js";

function voucher(over: Partial<PlumtripsVoucher> = {}): PlumtripsVoucher {
  return {
    type: "flight",
    booking_info: { booking_id: "PORTAL-77", booking_date: null, voucher_no: null, supplier_conf_no: null, pnr: "X9K2LQ" },
    flight_details: {
      segments: [
        {
          airline: "IndiGo", flight_no: "6E 201", class: "Economy", duration: "2h 10m",
          origin: { city: "Delhi", code: "del", time: "06:30", date: "15 Oct 2026", terminal: "T3" },
          destination: { city: "Mumbai", code: "BOM", time: "08:40", date: "15 Oct 2026", terminal: "T2" },
        },
      ],
    },
    passengers: [
      { name: "Priya Sharma", type: "Adult", ticket_no: "T1", phone: "+91 98xxxx", email: "priya@co.com", baggage_check_in: null, baggage_cabin: null },
      { name: "Aarav Sharma", type: "CHD", ticket_no: "T2", phone: null, email: null, baggage_check_in: null, baggage_cabin: null },
    ],
    policies: { is_non_refundable: false, important_notes: [] },
    ...over,
  };
}

describe("parseTicketDate — the shapes tickets actually print", () => {
  const cases: [string, string | null][] = [
    ["2026-10-15", "2026-10-15"],
    ["2026-10-15T06:30:00", "2026-10-15"],
    ["15/10/2026", "2026-10-15"],
    ["15-10-2026", "2026-10-15"],
    ["15.10.2026", "2026-10-15"],
    ["15/10/26", "2026-10-15"],
    ["10/15/2026", "2026-10-15"],          // month-first only when day-first is impossible
    ["05/10/2026", "2026-10-05"],          // ambiguous → day-first (Indian tickets)
    ["15 Oct 2026", "2026-10-15"],
    ["15 October 2026", "2026-10-15"],
    ["15-Oct-2026", "2026-10-15"],
    ["15Oct26", "2026-10-15"],
    ["15 Oct 26", "2026-10-15"],
    ["Oct 15, 2026", "2026-10-15"],
    ["Wed, 15 Oct 2026", "2026-10-15"],
    ["Wednesday 15 October 2026", "2026-10-15"],
    ["15 Oct 2026 06:30", "2026-10-15"],
    ["15 Oct 2026, 06:30 hrs", "2026-10-15"],
    ["31 Feb 2026", null],
    ["someday", null],
    ["", null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => expect(parseTicketDate(input)).toBe(expected));
  }
  it("null/undefined → null", () => {
    expect(parseTicketDate(null)).toBeNull();
    expect(parseTicketDate(undefined)).toBeNull();
  });
});

describe("normalizePassengerType", () => {
  it("maps the airline vocabularies onto the form's enum", () => {
    expect(normalizePassengerType("Adult")).toBe("ADULT");
    expect(normalizePassengerType("ADT")).toBe("ADULT");
    expect(normalizePassengerType("child")).toBe("CHILD");
    expect(normalizePassengerType("CHD")).toBe("CHILD");
    expect(normalizePassengerType("Infant")).toBe("INFANT");
    expect(normalizePassengerType("INF")).toBe("INFANT");
    expect(normalizePassengerType("Mr")).toBeNull();
    expect(normalizePassengerType(null)).toBeNull();
  });
});

describe("buildFlightAutofill — single leg into the form's own field names", () => {
  it("maps segment 0 + booking_info + passengers", () => {
    const fill = buildFlightAutofill(voucher())!;
    expect(fill).toMatchObject({
      travelDate: "2026-10-15", travelDateRaw: "15 Oct 2026",
      returnDate: "2026-10-15",
      origin: "DEL", destination: "BOM",     // uppercased airport codes
      flightNo: "6E 201", airline: "IndiGo",
      supplierPNR: "X9K2LQ",
      supplierName: null,                    // no source on the voucher — never invented
      segmentCount: 1,
    });
    expect(fill.passengers).toEqual([
      { name: "Priya Sharma", type: "ADULT", email: "priya@co.com", phone: "+91 98xxxx" },
      { name: "Aarav Sharma", type: "CHILD", email: null, phone: null },
    ]);
  });

  it("PNR falls back to the document's booking id; unparseable dates surface the raw text", () => {
    const v = voucher();
    v.booking_info.pnr = null;
    v.flight_details!.segments[0].origin.date = "sometime in October";
    const fill = buildFlightAutofill(v)!;
    expect(fill.supplierPNR).toBe("PORTAL-77");
    expect(fill.travelDate).toBeNull();
    expect(fill.travelDateRaw).toBe("sometime in October");
  });

  it("reports segmentCount but fills only the first leg (multi-leg is a later step)", () => {
    const v = voucher();
    v.flight_details!.segments.push({
      airline: "IndiGo", flight_no: "6E 202", class: null, duration: null,
      origin: { city: "Mumbai", code: "BOM", time: null, date: "20 Oct 2026", terminal: null },
      destination: { city: "Delhi", code: "DEL", time: null, date: "20 Oct 2026", terminal: null },
    });
    const fill = buildFlightAutofill(v)!;
    expect(fill.segmentCount).toBe(2);
    expect(fill.origin).toBe("DEL");
    expect(fill.travelDate).toBe("2026-10-15");
  });

  it("drops nameless passengers, keeps the rest", () => {
    const v = voucher();
    v.passengers!.push({ name: null, type: "Adult", ticket_no: null, phone: null, email: null, baggage_check_in: null, baggage_cabin: null });
    expect(buildFlightAutofill(v)!.passengers).toHaveLength(2);
  });

  it("returns null for a hotel voucher or an empty flight voucher", () => {
    expect(buildFlightAutofill(voucher({ type: "hotel" }))).toBeNull();
    expect(buildFlightAutofill(voucher({ flight_details: { segments: [] }, passengers: [] }))).toBeNull();
    expect(buildFlightAutofill(null)).toBeNull();
  });

  it("a passengers-only voucher still fills the traveller rows", () => {
    const fill = buildFlightAutofill(voucher({ flight_details: { segments: [] } }))!;
    expect(fill.segmentCount).toBe(0);
    expect(fill.origin).toBeNull();
    expect(fill.passengers).toHaveLength(2);
  });
});
