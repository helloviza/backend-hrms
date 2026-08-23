// Coverage for deriveFlightRows — the flattening every row in the ops review
// table comes from. Pure function, no Mongo and no model call, so it's tested
// directly against hand-built vouchers.
//
// The two things that must never regress are the ones this caught during
// development: identity-bearing ancillaries (seat/meal/barcode) must not leak
// between passengers via the per-segment fallback, and an empty voucher must
// produce no rows rather than one all-null row.

import { describe, it, expect } from "vitest";
import { deriveFlightRows } from "./documentExtraction.service.js";
import type { PlumtripsVoucher } from "../types/index.js";

function voucher(over: Partial<PlumtripsVoucher> = {}): PlumtripsVoucher {
  return {
    type: "flight",
    booking_info: {
      pnr: "QK7L2M",
      booking_id: "PT-98217",
      booking_date: null,
      voucher_no: null,
      supplier_conf_no: null,
      fare_type: null,
      ocr_data_line: null,
      custom_logo: "logo",
    },
    policies: { cancellation_deadline: null, is_non_refundable: true, important_notes: [] },
    flight_details: {
      segments: [
        {
          airline: "IndiGo",
          flight_no: "6E-2134",
          class: "Economy",
          duration: "2h 45m",
          layover_duration: null,
          origin: { city: "Mumbai", code: "BOM", time: "08:20", date: "2026-09-04", terminal: "T2" },
          destination: { city: "Dubai", code: "DXB", time: "10:05", date: "2026-09-04", terminal: "T3" },
          // Seat/meal here belong to whoever the document was issued to — with
          // two passengers listed, the document does not say which one.
          ancillaries: {
            cabin_bag: "7 Kg",
            checkin_bag: "20 Kg",
            seat: "12A",
            meal: "Veg",
            barcode_string: "M1SAIRAM",
          },
        },
      ],
    },
    passengers: [
      {
        name: "Mr Sairam",
        type: "ADULT",
        ticket_no: "6E-8823410",
        phone: null,
        email: null,
        baggage_cabin: null,
        baggage_check_in: "25 Kg",
        seat: "14C",
        meal: "Jain",
        barcode_string: null,
      },
      {
        name: "Mrs Latha",
        type: "ADULT",
        ticket_no: "6E-8823411",
        phone: null,
        email: null,
        baggage_cabin: null,
        baggage_check_in: null,
        seat: null,
        meal: null,
        barcode_string: null,
      },
    ],
    ...over,
  } as PlumtripsVoucher;
}

describe("deriveFlightRows", () => {
  it("emits one row per passenger per segment", () => {
    const rows = deriveFlightRows(voucher());
    expect(rows).toHaveLength(2); // 2 passengers x 1 segment
    expect(rows.map((r) => r.passengerName)).toEqual(["Mr Sairam", "Mrs Latha"]);
  });

  it("carries booking-level refs onto every row, keeping the document's own ref separate from the PNR", () => {
    const [row] = deriveFlightRows(voucher());
    expect(row.pnr).toBe("QK7L2M");
    expect(row.documentBookingRef).toBe("PT-98217");
    expect(row.ticketNo).toBe("6E-8823410");
    expect(row.depAirport).toBe("BOM");
    expect(row.arrAirport).toBe("DXB");
    expect(row.cabinClass).toBe("Economy");
  });

  it("does NOT attribute a segment's seat/meal to a passenger when several are listed", () => {
    const rows = deriveFlightRows(voucher());
    const latha = rows.find((r) => r.passengerName === "Mrs Latha")!;
    // The segment states 12A/Veg, but that is Mr Sairam's — Latha's own
    // passenger record says nothing, so hers must stay blank.
    expect(latha.seat).toBeNull();
    expect(latha.meal).toBeNull();
    expect(latha.barcode).toBeNull();
  });

  it("falls back to the segment's ancillaries when there is exactly one passenger", () => {
    const single = voucher({ passengers: [voucher().passengers![1]] }); // Latha, all ancillaries null
    const [row] = deriveFlightRows(single);
    expect(row.seat).toBe("12A");
    expect(row.meal).toBe("Veg");
    expect(row.barcode).toBe("M1SAIRAM");
  });

  it("treats baggage as a fare-level allowance that applies to everyone", () => {
    const rows = deriveFlightRows(voucher());
    const latha = rows.find((r) => r.passengerName === "Mrs Latha")!;
    expect(latha.cabinBaggage).toBe("7 Kg"); // from the segment
    expect(latha.checkinBaggage).toBe("20 Kg"); // from the segment
    const sairam = rows.find((r) => r.passengerName === "Mr Sairam")!;
    expect(sairam.checkinBaggage).toBe("25 Kg"); // his own overrides it
  });

  it("leaves checkinStatus null — the extractor has no source for it", () => {
    for (const row of deriveFlightRows(voucher())) {
      expect(row.checkinStatus).toBeNull();
    }
  });

  it("still emits rows for one-sided documents", () => {
    expect(deriveFlightRows(voucher({ passengers: [] }))).toHaveLength(1); // segment only
    expect(deriveFlightRows(voucher({ flight_details: { segments: [] } }))).toHaveLength(2); // passengers only
  });

  it("emits nothing for an empty voucher rather than one all-null row", () => {
    expect(deriveFlightRows(voucher({ passengers: [], flight_details: { segments: [] } }))).toEqual([]);
  });

  it("emits nothing for a hotel voucher", () => {
    expect(deriveFlightRows(voucher({ type: "hotel" }))).toEqual([]);
  });
});
