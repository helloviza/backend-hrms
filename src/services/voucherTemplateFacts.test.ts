// What the hotel voucher template prints for an extracted voucher, checked on
// the rendered text: nothing the source didn't state (audit §9 H-02, H-04–H-08).
import { describe, it, expect } from "vitest";
import { adaptHotel, isPriceNote } from "./voucherAdapter.js";
import { generateHotelVoucherHTML, type HotelVoucherParams } from "@plumtrips/shared/voucher-templates/hotelVoucherGenerator";
import type { PlumtripsVoucher } from "../types/index.js";

function perch(over: { stay?: Partial<PlumtripsVoucher["stay_details"]> } = {}): PlumtripsVoucher {
  return {
    type: "hotel",
    booking_info: { booking_id: "261014802640", booking_date: "14 Oct, 2026", voucher_no: "CT_261014643196", supplier_conf_no: null },
    hotel_details: { name: "Perch Service Apartments | DLF Cyber City", address: "House No-36, Moulsari Avenue Road, DLF Phase 3, Gurugram, 122022", city: "Gurugram", country: null, contact: "+91-8800461053" },
    stay_details: { check_in_date: "OCT 15", check_in_time: "01 PM", check_out_date: "16 OCT", check_out_time: "12 PM", total_nights: "1", ...over.stay },
    guest_details: { primary_guest: "Mr Samved Patil", total_pax: null, adults: 1, children: 0, all_guest_names: ["Mr Samved Patil"] },
    room_details: { room_type: "Classic Studio Apartment", no_of_rooms: "1", inclusions: ["Complimentary Wifi", "Room Only"], special_requests: null },
    policies: {
      cancellation_deadline: null,
      is_non_refundable: null,
      important_notes: [
        "Early check-in up to 2 hours (subject to availability)",
        "Late check-out up to 2 hours (subject to availability)",
      ],
    },
  };
}

const text = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<svg[\s\S]*?<\/svg>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&bull;|&#8226;/g, "•")
    .replace(/&middot;/g, "·")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ");

const render = async (v: PlumtripsVoucher, extra: Partial<HotelVoucherParams> = {}) =>
  text(await generateHotelVoucherHTML({ ...adaptHotel(v, { createdAt: "2026-10-14T08:08:21Z" }), ...extra }));

describe("details the voucher states (H-04, H-05)", () => {
  it("prints the hotel phone, and the stay row from the stated counts", async () => {
    const t = await render(perch());
    expect(t).toContain("Tel: +91-8800461053");
    expect(t).toContain("1 night · 1 adult · 1 room");
  });

  it.each([
    ["9151915166, 05224606555, reservations@hoteldamsonplum.com, 0124-4628747", "Tel: 9151915166, 05224606555"],
    ["9880888999, +919880888999, contact@vistharahotel.com", "Tel: 9880888999 "],
    ["Phone: +919033051513;E-mail: info@krishnawaterpark.in; URL: https://krishnawaterpark.in", "Tel: +919033051513 "],
  ])("phones are picked out of a mixed contact line: %s", async (contact, expected) => {
    const v = perch();
    v.hotel_details!.contact = contact;
    expect(await render(v)).toContain(expected);
  });

  it.each([["null"], ["avni@plumtrips.com"], ["Phone: 8826843266, Email: neelb@plumtrips.com"]])("a contact field holding %s prints no phone", async (contact) => {
    const v = perch();
    v.hotel_details!.contact = contact;
    expect(await render(v)).not.toContain("Tel:");
  });

  it("children and plurals only when stated; special requests when present", async () => {
    const v = perch();
    v.guest_details!.adults = 2;
    v.guest_details!.children = 1;
    v.room_details!.no_of_rooms = "2";
    v.stay_details!.total_nights = "3";
    v.room_details!.special_requests = "Twin beds";
    const t = await render(v);
    expect(t).toContain("3 nights · 2 adults · 1 child · 2 rooms");
    expect(t).toContain("Special requests Twin beds");
  });

  it("no counts on the voucher → no stay row", async () => {
    const v = perch();
    v.stay_details!.total_nights = null;
    v.guest_details!.adults = 0;
    v.room_details!.no_of_rooms = null;
    expect(await render(v)).not.toMatch(/Stay \d+ (night|adult|guest|room)/);
  });
});

describe("ID labels (H-06)", () => {
  it("extracted: honest labels, the supplier voucher no. printed, no 'Plumtrips booking ID'", async () => {
    const t = await render(perch());
    expect(t).not.toMatch(/plumtrips booking id/i);
    expect(t).toContain("Supplier voucher no. CT_261014643196");
    expect(t).toContain("Need help? hello@plumtrips.com — quote booking ID 261014802640");
    expect(t.split("261014802640").length - 1).toBe(2); // card + help line, nothing else
  });

  it("extracted: a hotel confirmation no. equal to the booking ID is shown once", async () => {
    const v = perch();
    v.booking_info.supplier_conf_no = "261014802640";
    const t = await render(v);
    expect(t).not.toContain("Hotel confirmation no.");
    expect(t.split("261014802640").length - 1).toBe(2);
  });

  it("extracted: a distinct hotel confirmation no. gets its own box", async () => {
    const v = perch();
    v.booking_info.supplier_conf_no = "HTL-7781";
    expect(await render(v)).toContain("Hotel confirmation no. — show at check-in HTL-7781");
  });

  it("SBT keeps its labels", async () => {
    const t = await render(perch(), { source: "sbt", tboReferenceNo: "TBO-1" });
    expect(t).toContain("PLUMTRIPS BOOKING ID — FOR SUPPORT INQUIRIES");
    expect(t).toContain("HOTEL REFERENCE — SHOW AT CHECK-IN TBO-1");
  });
});

describe("perks and the notes section (H-07)", () => {
  it("early check-in / late check-out perks print under What's included; no 'Rate Conditions'", async () => {
    const t = await render(perch());
    const included = t.slice(t.indexOf("What's Included"), t.indexOf("Check-in Information"));
    expect(included).toContain("Early check-in up to 2 hours (subject to availability)");
    expect(included).toContain("Late check-out up to 2 hours (subject to availability)");
    expect(included).toContain("Complimentary Wifi");
    expect(t).not.toContain("Rate Conditions");
  });

  it("other notes print as 'Important information' on the T&C page — a lone short one too", async () => {
    const v = perch();
    v.policies.important_notes = ["Pets not allowed."];
    const t = await render(v);
    const tnc = t.slice(t.indexOf("TERMS & CONDITIONS"));
    expect(tnc).toContain("Important information • Pets not allowed.");
  });

  it.each([
    "Special requests (bed type, early check-in, late check-out, smoking rooms) are not guaranteed.",
    "Optional Fees: Early check-in (CHF 20, subject to availability), Late check-out (CHF 20).",
    "Late check-out is chargeable at 50% of the room rate.",
    "Early check-out will attract full cancellation charges unless otherwise specified.",
    "Early Check-in and Late Check-out will attract 50% of room tariff.",
    "Early check-in and late check-out are subject to availability and hotel policy.",
    "Early check-in is available for a fee (subject to availability).",
  ])("stays a note, not a perk: %s", async (note) => {
    const v = perch();
    v.policies.important_notes = [note];
    const t = await render(v);
    const included = t.slice(t.indexOf("What's Included"), t.indexOf("Check-in Information"));
    expect(included).not.toContain(note.slice(0, 25));
    expect(t.slice(t.indexOf("Important information"))).toContain(note.slice(0, 25));
  });

  it("SBT keeps 'Rate Conditions' on page 1", async () => {
    const t = await render(perch(), { source: "sbt", rateConditions: ["Breakfast included"] });
    expect(t).toContain("Rate Conditions • Breakfast included");
    expect(t).not.toContain("Important information");
  });
});

describe("check-in / check-out times (H-02)", () => {
  it("the hero and info card print the voucher's own times", async () => {
    const t = await render(perch());
    expect(t).toContain("Thursday, 01 PM");
    expect(t).toContain("Friday, 12 PM");
    expect(t).toContain("Check-in from 01 PM onwards");
    expect(t).not.toContain("14:00");
  });

  it("no time on the voucher → date only, no time claimed anywhere", async () => {
    const t = await render(perch({ stay: { check_in_time: null, check_out_time: null } }));
    expect(t).toContain("15 Oct 2026");
    expect(t).not.toMatch(/14:00|12:00|Check-in from/);
    expect(t).not.toContain("Early check-in subject to availability");
    expect(t).toContain("Carry a government photo ID");
    expect(t).toContain("Present this voucher at reception");
  });

  it("SBT: no hotelPolicies → no invented 14:00 either", async () => {
    const t = await render(perch(), { source: "sbt", hotelPolicies: null });
    expect(t).not.toMatch(/14:00|12:00/);
  });
});

describe("price and payment notes (extracted only)", () => {
  it.each([
    "Complete payment to avoid auto cancellation. Amount \n₹ 58,530 by 25 Dec, 11:59 PM IST.",
    "Booking.com paid \n716.67 of this booking. The property invoice will show \n10,035.57 as the total price.",
    "Total booking amount: INR 12,400 (paid).",
  ])("drops %s", (note) => {
    expect(isPriceNote(note)).toBe(true);
  });

  it.each([
    "Mandatory city tax: CHF 4.20 per person, per night.",
    "Tourism Fee: INR 391.07 is payable at the property.",
    "Estimated total amount of taxes & fees for this booking: 5.53 Euro payable on arrival.",
    "Property will charge extra INR 3000 for Security Deposit (Refundable).",
    "The price 71.44 USD is per person per night and must be paid at the hotel.",
    "100% advance payment is required to confirm your booking.",
    "Cancellation on 09-Aug-2026 incurs a charge of 8,219.",
  ])("keeps %s", (note) => {
    expect(isPriceNote(note)).toBe(false);
  });

  it("the price line never reaches the voucher; the pay-at-hotel fee does", async () => {
    const v = perch();
    v.policies.important_notes = [
      "Complete payment to avoid auto cancellation. Amount ₹ 58,530 by 25 Dec, 11:59 PM IST.",
      "City Tax of AED 100.00 to be paid directly to the hotel.",
    ];
    const out = await render(v);
    expect(out).not.toContain("58,530");
    expect(out).toContain("City Tax of AED 100.00 to be paid directly to the hotel.");
  });
});
