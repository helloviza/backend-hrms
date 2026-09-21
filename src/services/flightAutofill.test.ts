// Pure mapping from an extracted flight voucher to the create form's fields
// (services/flightAutofill.ts). No I/O, no model — hand-written vouchers in
// the shapes the extractor actually emits.
import { describe, it, expect } from "vitest";
import { buildFlightAutofill, normalizePassengerType, parseTicketDate } from "./flightAutofill.js";
import type { PlumtripsVoucher, FlightSegment } from "../types/index.js";

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

  it("a single leg is ONE_WAY with one leg entry mirroring the scalars", () => {
    const fill = buildFlightAutofill(voucher())!;
    expect(fill.tripType).toBe("ONE_WAY");
    expect(fill.legs).toEqual([
      {
        origin: "DEL", destination: "BOM", flightNo: "6E 201", airline: "IndiGo",
        departDate: "2026-10-15", departDateRaw: "15 Oct 2026", departTime: "06:30",
        arriveDate: "2026-10-15", arriveDateRaw: "15 Oct 2026", arriveTime: "08:40",
        cabinClass: "Economy", layover: null,
      },
    ]);
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
    expect(fill.tripType).toBeNull();
    expect(fill.legs).toEqual([]);
    expect(fill.passengers).toHaveLength(2);
  });
});

/* ── Multi-leg (Step 4): every segment becomes a leg, 1:1 ───────────── */


function seg(
  o: string, d: string, dep: string, arr: string,
  over: Partial<FlightSegment> & { layover?: string | null } = {},
): FlightSegment {
  const { layover = null, ...rest } = over;
  return {
    airline: "Air India", flight_no: "AI 101", class: "Economy", duration: null,
    origin: { city: null, code: o, time: "06:30", date: dep, terminal: null },
    destination: { city: null, code: d, time: "08:40", date: arr, terminal: null },
    layover_duration: layover,
    ...rest,
  };
}

describe("buildFlightAutofill — multi-leg: legs[] + tripType, leg-0 scalars kept", () => {
  it("2-segment round trip → ROUND_TRIP; returnDate is the RETURN leg's DEPARTURE (the fix), destination the turnaround", () => {
    const v = voucher({
      flight_details: {
        segments: [
          seg("DEL", "BOM", "15 Oct 2026", "15 Oct 2026", { flight_no: "AI 101" }),
          seg("BOM", "DEL", "20 Oct 2026", "20 Oct 2026", { flight_no: "AI 102" }),
        ],
      },
    });
    const fill = buildFlightAutofill(v)!;
    expect(fill.tripType).toBe("ROUND_TRIP");
    expect(fill.segmentCount).toBe(2);
    expect(fill.legs.map((l) => `${l.origin}-${l.destination}/${l.flightNo}`)).toEqual([
      "DEL-BOM/AI 101",
      "BOM-DEL/AI 102",
    ]);
    // Leg-0 scalars still present for the single-itinerary form.
    expect(fill).toMatchObject({ origin: "DEL", flightNo: "AI 101", airline: "Air India", travelDate: "2026-10-15" });
    // Destination is where the trip turned around — NOT DEL.
    expect(fill.destination).toBe("BOM");
    // Was 2026-10-15 (leg-0 arrival) before Step 4.
    expect(fill.returnDate).toBe("2026-10-20");
    expect(fill.returnDateRaw).toBe("20 Oct 2026");
  });

  it("3-segment multi-city → MULTI_CITY; destination + returnDate from the LAST leg", () => {
    const v = voucher({
      flight_details: {
        segments: [
          seg("DEL", "BOM", "15 Oct 2026", "15 Oct 2026"),
          seg("BOM", "GOI", "18 Oct 2026", "18 Oct 2026"),
          seg("GOI", "BLR", "22 Oct 2026", "23 Oct 2026"),
        ],
      },
    });
    const fill = buildFlightAutofill(v)!;
    expect(fill.tripType).toBe("MULTI_CITY");
    expect(fill.legs).toHaveLength(3);
    expect(fill.origin).toBe("DEL");
    expect(fill.destination).toBe("BLR");
    expect(fill.travelDate).toBe("2026-10-15");
    expect(fill.returnDate).toBe("2026-10-23");
  });

  it("2-segment one-way via a hub (layover printed) → ONE_WAY; destination is the final arrival", () => {
    const v = voucher({
      flight_details: {
        segments: [
          seg("DEL", "BOM", "15 Oct 2026", "15 Oct 2026", { layover: "2h 15m" }),
          seg("BOM", "DXB", "15 Oct 2026", "15 Oct 2026"),
        ],
      },
    });
    const fill = buildFlightAutofill(v)!;
    expect(fill.tripType).toBe("ONE_WAY");
    expect(fill.legs[0].layover).toBe("2h 15m");
    expect(fill.legs[1].layover).toBeNull();
    expect(fill.origin).toBe("DEL");
    expect(fill.destination).toBe("DXB");
    expect(fill.flightNo).toBe("AI 101"); // leg 0, never joined
  });

  it("4-segment round trip via a hub each way: turnaround + return leg found from the layover pattern", () => {
    const v = voucher({
      flight_details: {
        segments: [
          seg("DEL", "BOM", "15 Oct 2026", "15 Oct 2026", { layover: "1h 30m" }),
          seg("BOM", "DXB", "15 Oct 2026", "15 Oct 2026"),
          seg("DXB", "BOM", "22 Oct 2026", "22 Oct 2026", { layover: "3h" }),
          seg("BOM", "DEL", "22 Oct 2026", "23 Oct 2026"),
        ],
      },
    });
    const fill = buildFlightAutofill(v)!;
    expect(fill.tripType).toBe("ROUND_TRIP");
    expect(fill.destination).toBe("DXB");
    expect(fill.returnDate).toBe("2026-10-22");
    expect(fill.legs).toHaveLength(4);
  });
});
