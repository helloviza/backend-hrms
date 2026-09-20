// Pure mapping from an extracted HOTEL voucher to the create form's hotel
// fields (services/hotelAutofill.ts). No I/O, no model — vouchers in the
// shapes the normalizer actually emits (types/voucher.ts), across the
// layout variety hotel vouchers come in.
import { describe, it, expect } from "vitest";
import { buildHotelAutofill, parseCount } from "./hotelAutofill.js";
import type { PlumtripsVoucher } from "../types/index.js";

function voucher(over: Partial<PlumtripsVoucher> = {}): PlumtripsVoucher {
  return {
    type: "hotel",
    booking_info: { booking_id: "HB-55120", booking_date: "20 Sep 2026", voucher_no: "V-9001", supplier_conf_no: "CONF-77AB" },
    hotel_details: { name: "The Leela Palace", address: "Old Airport Road", city: "Bengaluru", country: "India", contact: "+91 80 1234 5678" },
    stay_details: { check_in_date: "12 Nov 2026", check_in_time: "14:00", check_out_date: "15 Nov 2026", check_out_time: "12:00", total_nights: "3" },
    guest_details: { primary_guest: "Rahul Verma", total_pax: "3", adults: 2, children: 1, all_guest_names: ["Rahul Verma", "Meera Verma", "Ishaan Verma"] },
    room_details: { room_type: "Deluxe King", no_of_rooms: "2", inclusions: ["Breakfast"], special_requests: null },
    policies: { is_non_refundable: false, important_notes: [] },
    ...over,
  };
}

describe("parseCount — rooms / nights as printed", () => {
  const cases: [string | number | null, number | null][] = [
    ["2", 2], ["02", 2], ["2 rooms", 2], ["Rooms: 3", 3], ["1 Night", 1], [3, 3], [0, null], ["0", null], ["", null], [null, null], ["two", null],
  ];
  for (const [i, o] of cases) it(`${JSON.stringify(i)} → ${o}`, () => expect(parseCount(i)).toBe(o));
});

describe("buildHotelAutofill — voucher into the form's hotel field names", () => {
  it("maps hotel/stay/room/guest/booking blocks", () => {
    const fill = buildHotelAutofill(voucher())!;
    expect(fill).toMatchObject({
      travelDate: "2026-11-12", travelDateRaw: "12 Nov 2026",
      returnDate: "2026-11-15", returnDateRaw: "15 Nov 2026",
      hotelName: "The Leela Palace", city: "Bengaluru", roomType: "Deluxe King",
      roomCount: 2, nights: 3,
      supplierPNR: "CONF-77AB",       // supplier confirmation first
      supplierName: null,             // no source — never invented
    });
    expect(fill.guests).toEqual([{ name: "Rahul Verma" }, { name: "Meera Verma" }, { name: "Ishaan Verma" }]);
  });

  it("primary guest leads, duplicates (any case) collapse, blanks drop", () => {
    const v = voucher();
    v.guest_details!.primary_guest = "MEERA VERMA";
    v.guest_details!.all_guest_names = ["Rahul Verma", "meera verma", "", "Ishaan Verma"];
    expect(buildHotelAutofill(v)!.guests.map((g) => g.name)).toEqual(["MEERA VERMA", "Rahul Verma", "Ishaan Verma"]);
  });

  it("confirmation number falls back booking_id → voucher_no", () => {
    const v = voucher();
    v.booking_info.supplier_conf_no = null;
    expect(buildHotelAutofill(v)!.supplierPNR).toBe("HB-55120");
    v.booking_info.booking_id = null;
    expect(buildHotelAutofill(v)!.supplierPNR).toBe("V-9001");
  });

  it("accepts the date shapes hotel vouchers print (same parser as flights)", () => {
    const shapes: [string, string][] = [
      ["2026-11-12", "2026-11-12"], ["12/11/2026", "2026-11-12"], ["12-Nov-2026", "2026-11-12"],
      ["Thu, 12 Nov 2026", "2026-11-12"], ["Nov 12, 2026", "2026-11-12"], ["12 November 2026 14:00", "2026-11-12"],
    ];
    for (const [raw, iso] of shapes) {
      const v = voucher();
      v.stay_details!.check_in_date = raw;
      expect(buildHotelAutofill(v)!.travelDate, raw).toBe(iso);
    }
  });

  it("an unparseable date comes back null with the raw text kept", () => {
    const v = voucher();
    v.stay_details!.check_out_date = "after the conference";
    const fill = buildHotelAutofill(v)!;
    expect(fill.returnDate).toBeNull();
    expect(fill.returnDateRaw).toBe("after the conference");
  });

  it("missing blocks → nulls, never guesses (sparse voucher)", () => {
    const fill = buildHotelAutofill(voucher({
      hotel_details: { name: "Ibis Navi Mumbai", address: null, city: null, country: null, contact: null },
      stay_details: { check_in_date: null, check_in_time: null, check_out_date: null, check_out_time: null, total_nights: null },
      guest_details: { primary_guest: null, total_pax: null, adults: 0, children: 0, all_guest_names: [] },
      room_details: { room_type: null, no_of_rooms: null, inclusions: [], special_requests: null },
      booking_info: { booking_id: null, booking_date: null, voucher_no: null, supplier_conf_no: null },
    }))!;
    expect(fill).toMatchObject({ hotelName: "Ibis Navi Mumbai", city: null, roomType: null, roomCount: null, nights: null, travelDate: null, returnDate: null, supplierPNR: null, guests: [] });
  });

  it("returns null for a flight voucher, or a hotel voucher with nothing usable", () => {
    expect(buildHotelAutofill(voucher({ type: "flight" }))).toBeNull();
    expect(buildHotelAutofill(voucher({
      hotel_details: { name: null, address: null, city: null, country: null, contact: null },
      stay_details: { check_in_date: null, check_in_time: null, check_out_date: null, check_out_time: null, total_nights: null },
      guest_details: { primary_guest: null, total_pax: null, adults: 0, children: 0, all_guest_names: [] },
    }))).toBeNull();
    expect(buildHotelAutofill(null)).toBeNull();
  });
});
