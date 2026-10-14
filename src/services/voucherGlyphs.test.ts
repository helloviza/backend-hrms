// Every character the voucher templates print must be drawable by the fonts
// the PDF Lambda actually has: the self-hosted Latin subsets of Manrope and
// Playfair Display (services/voucher-render-lambda/fonts.mjs). Anything else
// — emoji, ✓ ✈ ⚠ →, the 🏢 behind the hotel name — prints as a solid box
// (audit §9 H-08). Icons are inline SVG instead; this test keeps it that way.
import { describe, it, expect } from "vitest";
import { adaptHotel } from "./voucherAdapter.js";
import { generateHotelVoucherHTML, type HotelVoucherParams } from "@plumtrips/shared/voucher-templates/hotelVoucherGenerator";
import { generateTicketHTML, type TicketBooking, type OfferItem } from "@plumtrips/shared/voucher-templates/ticketGenerator";
import type { PlumtripsVoucher } from "../types/index.js";

// unicode-range of the @fontsource "latin" subset both families ship:
// U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,
// U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD
// plus ₹ (U+20B9), which the templates may print for fares.
const RANGES: [number, number][] = [
  [0x0000, 0x00ff], [0x0131, 0x0131], [0x0152, 0x0153], [0x02bb, 0x02bc], [0x02c6, 0x02c6],
  [0x02da, 0x02da], [0x02dc, 0x02dc], [0x0304, 0x0304], [0x0308, 0x0308], [0x0329, 0x0329],
  [0x2000, 0x206f], [0x20ac, 0x20ac], [0x2122, 0x2122], [0x2191, 0x2191], [0x2193, 0x2193],
  [0x2212, 0x2212], [0x2215, 0x2215], [0xfeff, 0xfeff], [0xfffd, 0xfffd], [0x20b9, 0x20b9],
];
const drawable = (c: string) => {
  const n = c.codePointAt(0)!;
  return RANGES.some(([a, b]) => n >= a && n <= b);
};

/** Visible text: tags, styles and SVG removed, entities decoded. */
function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<svg[\s\S]*?<\/svg>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&rarr;/g, "→").replace(/&larr;/g, "←").replace(/&check;/g, "✓")
    .replace(/&[a-z]+;/gi, " ");
}
const undrawable = (html: string) => [...new Set([...visibleText(html)].filter((c) => !drawable(c)))];

const offers: OfferItem[] = [
  { enabled: true, title: "Lounge access", description: "On your next booking.", ctaText: "Claim", ctaUrl: "https://plumtrips.com/x", bgColor: "#003366", imageUrl: "" },
];

const extracted: PlumtripsVoucher = {
  type: "hotel",
  booking_info: { booking_id: "261014802640", booking_date: "14 Oct, 2026", voucher_no: "CT_1", supplier_conf_no: "HTL-1" },
  hotel_details: { name: "Perch Service Apartments", address: "DLF Phase 3, Gurugram", city: "Gurugram", country: null, contact: "+91-8800461053" },
  stay_details: { check_in_date: "OCT 15", check_in_time: "01 PM", check_out_date: "16 OCT", check_out_time: "12 PM", total_nights: "1" },
  guest_details: { primary_guest: "Mr Samved Patil", total_pax: null, adults: 2, children: 1, all_guest_names: ["Mr Samved Patil", "Asha Patil"] },
  room_details: { room_type: "Studio", no_of_rooms: "1", inclusions: ["Complimentary Wifi"], special_requests: "Twin beds" },
  policies: { cancellation_deadline: "2026-10-10", is_non_refundable: false, important_notes: ["Late check-out up to 2 hours (subject to availability)"] },
};

describe("voucher templates print only glyphs the PDF fonts have", () => {
  it("hotel — extracted", async () => {
    const html = await generateHotelVoucherHTML(adaptHotel(extracted, { createdAt: "2026-10-14T08:00:00Z" }));
    expect(undrawable(html)).toEqual([]);
  });

  it("hotel — SBT, every chip tone, fees, offers, print button", async () => {
    const params: HotelVoucherParams = {
      ...adaptHotel(extracted, { createdAt: "2026-10-14T08:00:00Z" }),
      source: "sbt",
      showPrintButton: true,
      offers,
      tboReferenceNo: "TBO-1",
      amenities: ["Pool", "Spa"],
      roomDescription: "A room.",
      rateConditions: ["Breakfast included"],
      additionalConditions: { optionalFees: "Resort fee", cardsAccepted: "Visa", earlyCheckOutNote: "Early check-out charged." },
      hotelPolicies: { checkInTime: "14:00", checkOutTime: "12:00", minimumAge: null },
      cancelPolicies: [
        { FromDate: "01-10-2026 00:00:00", ChargeType: "Percentage", CancellationCharge: 0, Currency: "INR" },
        { FromDate: "05-10-2026 00:00:00", ChargeType: "Percentage", CancellationCharge: 50, Currency: "INR" },
        { FromDate: "10-10-2026 00:00:00", ChargeType: "Percentage", CancellationCharge: 100, Currency: "INR" },
      ],
    };
    expect(undrawable(await generateHotelVoucherHTML(params))).toEqual([]);
    // and the empty-chips fallback
    expect(undrawable(await generateHotelVoucherHTML({ ...params, cancelPolicies: [{ FromDate: "01-01-2031 00:00:00", ChargeType: "Percentage", CancellationCharge: 0 }] }))).toEqual([]);
  });

  it("flight e-ticket — round trip with offers, and one-way LCC with the default offer", async () => {
    const out: TicketBooking = {
      pnr: "ABC123", bookingId: "PT-1", ticketId: "TKT-1", status: "CONFIRMED",
      origin: { code: "DEL", city: "Delhi" }, destination: { code: "BOM", city: "Mumbai" },
      departureTime: "2026-06-01T08:30:00", arrivalTime: "2026-06-01T10:45:00",
      airlineCode: "AI", airlineName: "Air India", flightNumber: "AI-440", cabin: 4,
      passengers: [{ title: "Mr", firstName: "Arjun", lastName: "Mehta", paxType: "adult", isLead: true }],
      baseFare: 0, taxes: 0, extras: 0, totalFare: 0, currency: "INR", isLCC: false, createdAt: "2026-05-20T00:00:00",
    };
    const ret: TicketBooking = { ...out, origin: out.destination, destination: out.origin, departureTime: "2026-06-08T19:10:00", arrivalTime: "2026-06-08T21:25:00" };
    expect(undrawable(await generateTicketHTML(out, offers, ret, undefined, true))).toEqual([]);
    expect(undrawable(await generateTicketHTML({ ...out, isLCC: true }, [], undefined, undefined, false))).toEqual([]);
  });
});
