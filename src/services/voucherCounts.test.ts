// Counts as printed ("1 night", "2 adults") through the one reader, leadingCount,
// everywhere a count is consumed: the date resolver, the PDF stay row, the
// queue card. And the hotel phone skips known agency support lines.
import { describe, it, expect } from "vitest";
import { leadingCount } from "@plumtrips/shared/voucher-templates/counts";
import { generateHotelVoucherHTML } from "@plumtrips/shared/voucher-templates/hotelVoucherGenerator";
import { adaptHotel, hotelPhoneFrom, AGENCY_SUPPORT_NUMBERS } from "./voucherAdapter.js";
import { buildDateContext, resolveStayDates, isoDate } from "./voucherDates.js";
import { listSummary } from "./voucherQueue.js";

describe("leadingCount", () => {
  it.each([
    ["1 night", 1],
    ["3 Nights", 3],
    ["2 adults, 1 child", 2],
    ["1", 1],
    [1, 1],
    [null, null],
    [undefined, null],
    ["one night", null],
    ["", null],
    ["0", null],
    [0, null],
    ["Nights: 2", null],
    ["2.5 nights", null],
    [" 4 rooms ", 4],
  ] as const)("%j → %j", (input, expected) => {
    expect(leadingCount(input)).toBe(expected);
  });
});

const hotel = (stay: any, guest: any = {}, room: any = {}) =>
  ({
    type: "hotel",
    booking_info: { booking_date: "1 Oct 2026" },
    hotel_details: { name: "H", contact: null },
    stay_details: stay,
    guest_details: { primary_guest: "Mr A", ...guest },
    room_details: { room_type: "Deluxe", inclusions: [], ...room },
    policies: { is_non_refundable: null, important_notes: [] },
  }) as any;

const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<svg[\s\S]*?<\/svg>/g, " ").replace(/<[^>]+>/g, " ").replace(/&middot;/g, "·").replace(/\s+/g, " ");

describe("the PDF stay row reads printed counts", () => {
  it("'1 night' / '2 adults, 1 child' / '1 room' print as numbers, never '1 night night'", async () => {
    const v = hotel({ check_in_date: "15 Oct 2026", check_out_date: "16 Oct 2026", total_nights: "1 night" }, { adults: "2 adults, 1 child", children: "1 child", total_pax: "3 guests" }, { no_of_rooms: "1 room" });
    const p = adaptHotel(v, { createdAt: "2026-10-01" });
    expect(p.stayFacts).toEqual({ nights: 1, adults: 2, children: 1, guests: 3, rooms: 1 });
    const t = text(await generateHotelVoucherHTML(p));
    expect(t).toContain("1 night ·");
    expect(t).not.toMatch(/night night|nights night|adults adults|room room/i);
  });

  it("a count in words is not guessed: no nights in the stay row", () => {
    const p = adaptHotel(hotel({ check_in_date: "15 Oct 2026", check_out_date: "16 Oct 2026", total_nights: "one night" }), { createdAt: "2026-10-01" });
    expect(p.stayFacts?.nights).toBeNull();
  });
});

describe("the date resolver uses the printed night count", () => {
  it("'3 Nights' breaks the day-first / month-first tie on 04/03/26 → 04/06/26", () => {
    const w: string[] = [];
    const { checkIn, checkOut } = resolveStayDates("04/03/26", "04/06/26", "3 Nights", buildDateContext("1 Mar 2026", null, w));
    expect(isoDate(checkIn!)).toBe("2026-04-03");
    expect(isoDate(checkOut!)).toBe("2026-04-06");
    expect(w.join(" ")).toMatch(/read month-first .* 3 night\(s\)/);
  });

  it("'1 night' cross-checks check-out: a 2-day gap is flagged", () => {
    const w: string[] = [];
    resolveStayDates("12 Nov 2026", "14 Nov 2026", "1 night", buildDateContext("1 Oct 2026", null, w));
    expect(w.join(" ")).toMatch(/night/i);
  });
});

describe("the queue card reads printed counts", () => {
  it("nights and guests from '1 night' / '2 guests'", () => {
    const s: any = listSummary({ docType: "hotel", extractedJson: { stay_details: { total_nights: "1 night" }, guest_details: { total_pax: "2 guests" } } });
    expect(s.nights).toBe(1);
    expect(s.paxCount).toBe(2);
  });
  it("nothing readable → null, not 0", () => {
    const s: any = listSummary({ docType: "hotel", extractedJson: { stay_details: { total_nights: "one night" }, guest_details: {} } });
    expect(s.nights).toBeNull();
    expect(s.paxCount).toBeNull();
  });
});

describe("hotel phone skips booking-agency support lines", () => {
  it("TBO's 0124-4998999 is never the hotel's phone, in any spelling", () => {
    expect(AGENCY_SUPPORT_NUMBERS["1244998999"]).toBeTruthy();
    expect(hotelPhoneFrom("0124-4998999")).toBeNull();
    expect(hotelPhoneFrom("+91 124 4998999")).toBeNull();
    expect(hotelPhoneFrom("+971 4 5551234, 0124-4998999")).toBe("+971 4 5551234");
  });
  it("the Plumtrips line is skipped even without the email beside it", () => {
    expect(hotelPhoneFrom("8826843266")).toBeNull();
  });
  it("a real hotel number still prints", () => {
    expect(hotelPhoneFrom("+91-8800461053")).toBe("+91-8800461053");
  });
});
