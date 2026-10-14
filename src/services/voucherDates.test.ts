// Date reading for extracted vouchers (services/voucherDates.ts) and the
// adapter paths that use it. The inputs are real shapes from prod
// VoucherExtraction records: Cleartrip prints "OCT 15" / "16 OCT", airline
// e-tickets print "Thu, Aug 20", and some suppliers write "10/09/26".
import { describe, it, expect } from "vitest";
import {
  buildDateContext,
  isoDate,
  parseDateParts,
  resolveStayDates,
  resolveVoucherDate,
} from "./voucherDates.js";
import { adaptFlight, adaptHotel } from "./voucherAdapter.js";
import type { PlumtripsVoucher } from "../types/index.js";

const ctxFrom = (bookingDate: string | null, createdAt = "2026-10-14T08:08:21Z") =>
  buildDateContext(bookingDate, createdAt, []);
const iso = (d: Date | null) => (d ? isoDate(d) : null);

describe("parseDateParts — never guesses a year", () => {
  it.each([
    ["OCT 15", { y: null, m: 9, d: 15, weekday: null }],
    ["16 OCT", { y: null, m: 9, d: 16, weekday: null }],
    ["Thu, Aug 20", { y: null, m: 7, d: 20, weekday: 4 }],
    ["THU 15 Oct", { y: null, m: 9, d: 15, weekday: 4 }],
    ["15/10/2026", { y: 2026, m: 9, d: 15, weekday: null }],
    ["2026-10-15", { y: 2026, m: 9, d: 15, weekday: null }],
    ["14 Oct, 2026", { y: 2026, m: 9, d: 14, weekday: null }],
    ["15th October 2026", { y: 2026, m: 9, d: 15, weekday: null }],
    ["Tue 29 Sept", { y: null, m: 8, d: 29, weekday: 2 }],
    // A time of day is not a year ("11:59" once read as 2011).
    ["25 Dec, 11:59 PM IST", { y: null, m: 11, d: 25, weekday: null }],
    ["Mon, 14 Sep 2026, 12:59 PM", { y: 2026, m: 8, d: 14, weekday: 1 }],
    ["15 Oct, 2 PM", { y: null, m: 9, d: 15, weekday: null }],
  ])("%s", (input, expected) => {
    expect(parseDateParts(input)).toMatchObject(expected);
  });

  it("reads DD/MM/YY day-first as 20YY and remembers the parts for a retry", () => {
    expect(parseDateParts("10/09/26")).toEqual({
      y: 2026, m: 8, d: 10, weekday: null, twoDigitYear: { first: 10, second: 9 },
    });
  });

  it("returns null for strings with no day and month", () => {
    expect(parseDateParts("")).toBeNull();
    expect(parseDateParts("TBA")).toBeNull();
  });
});

describe("resolveVoucherDate — year inference", () => {
  it("OCT 15 with a 14 Oct 2026 booking date is 15 Oct 2026 (Thursday), no warning", () => {
    const ctx = ctxFrom("14 Oct, 2026");
    const d = resolveVoucherDate("OCT 15", ctx, { label: "Check-in date" });
    expect(iso(d)).toBe("2026-10-15");
    expect(d!.getUTCDay()).toBe(4);
    expect(ctx.warnings).toEqual([]);
  });

  it("falls back to the upload date when the voucher shows no booking date, and says so", () => {
    const ctx = ctxFrom(null, "2026-07-10T09:00:00Z");
    const d = resolveVoucherDate("Aug 20", ctx, { label: "Departure date" });
    expect(iso(d)).toBe("2026-08-20");
    expect(ctx.warnings).toHaveLength(1);
    expect(ctx.warnings[0]).toMatch(/no year.*upload date/);
  });

  it("does not flag an upload-date year that the printed weekday confirms", () => {
    const ctx = ctxFrom(null, "2026-07-10T09:00:00Z");
    expect(iso(resolveVoucherDate("Thu, Aug 20", ctx, { label: "Departure date" }))).toBe("2026-08-20");
    expect(ctx.warnings).toEqual([]);
  });

  it("treats placeholder strings as empty", () => {
    const ctx = ctxFrom("14 Oct, 2026");
    expect(resolveVoucherDate("null", ctx, { label: "Cancellation deadline" })).toBeNull();
    expect(ctx.warnings).toEqual([]);
  });

  it("accepts a date up to a week before the anchor (booking made after check-in was printed)", () => {
    const ctx = ctxFrom("20 Oct 2026");
    expect(iso(resolveVoucherDate("15 Oct", ctx, { label: "x" }))).toBe("2026-10-15");
    expect(iso(resolveVoucherDate("10 Oct", ctx, { label: "x" }))).toBe("2027-10-10");
  });

  it("flags a printed weekday that disagrees with the resolved date", () => {
    const ctx = ctxFrom("14 Oct, 2026");
    const d = resolveVoucherDate("Mon 15 Oct", ctx, { label: "Check-in date" });
    expect(iso(d)).toBe("2026-10-15"); // the date wins; the weekday is only checked
    expect(ctx.warnings).toHaveLength(1);
    expect(ctx.warnings[0]).toMatch(/says Monday.*is a Thursday/);
  });

  it("does not flag a matching weekday", () => {
    const ctx = ctxFrom("14 Oct, 2026");
    resolveVoucherDate("THU 15 Oct", ctx, { label: "Check-in date" });
    expect(ctx.warnings).toEqual([]);
  });

  it("flags an unreadable non-empty date and leaves it blank", () => {
    const ctx = ctxFrom("14 Oct, 2026");
    expect(resolveVoucherDate("TBA", ctx, { label: "Check-in date" })).toBeNull();
    expect(ctx.warnings[0]).toMatch(/could not be read/);
  });

  it("is silent for an empty date", () => {
    const ctx = ctxFrom("14 Oct, 2026");
    expect(resolveVoucherDate(null, ctx, { label: "Check-in date" })).toBeNull();
    expect(ctx.warnings).toEqual([]);
  });
});

describe("resolveStayDates", () => {
  it("Cleartrip OCT 15 / 16 OCT, 1 night", () => {
    const ctx = ctxFrom("14 Oct, 2026");
    const r = resolveStayDates("OCT 15", "16 OCT", "1", ctx);
    expect([iso(r.checkIn), iso(r.checkOut)]).toEqual(["2026-10-15", "2026-10-16"]);
    expect(ctx.warnings).toEqual([]);
  });

  it("Dec → Jan stay: the check-out rolls into the next year", () => {
    const ctx = ctxFrom("01 Dec 2026");
    const r = resolveStayDates("30 Dec", "2 Jan", "3", ctx);
    expect([iso(r.checkIn), iso(r.checkOut)]).toEqual(["2026-12-30", "2027-01-02"]);
    expect(ctx.warnings).toEqual([]);
  });

  it("10/09/26 → day-first agrees with 1 night: 9 Sep → 10 Sep 2026, no warning", () => {
    const ctx = ctxFrom(null, "2026-09-08T10:00:00Z");
    const r = resolveStayDates("09/09/26", "10/09/26", "1", ctx);
    expect([iso(r.checkIn), iso(r.checkOut)]).toEqual(["2026-09-09", "2026-09-10"]);
    expect(ctx.warnings).toEqual([]);
  });

  it("09/10/26 with 1 night only fits month-first: read MM/DD and flag", () => {
    const ctx = ctxFrom(null, "2026-09-09T10:00:00Z");
    const r = resolveStayDates("09/09/26", "09/10/26", "1", ctx);
    expect([iso(r.checkIn), iso(r.checkOut)]).toEqual(["2026-09-09", "2026-09-10"]);
    expect(ctx.warnings).toHaveLength(1);
    expect(ctx.warnings[0]).toMatch(/month-first/);
  });

  it("ambiguous with no reading that fits: keep day-first and flag", () => {
    const ctx = ctxFrom(null, "2026-09-09T10:00:00Z");
    const r = resolveStayDates("03/04/26", "05/06/26", "7", ctx);
    expect(iso(r.checkIn)).toBe("2026-04-03");
    expect(ctx.warnings[0]).toMatch(/ambiguous/);
  });

  it("flags a night count that disagrees with the dates", () => {
    const ctx = ctxFrom("14 Oct, 2026");
    resolveStayDates("15 Oct 2026", "18 Oct 2026", "1", ctx);
    expect(ctx.warnings[0]).toMatch(/1 night\(s\).*is 3/);
  });

  it("15/10/2026 with a year stays day-first", () => {
    const ctx = ctxFrom("14 Oct, 2026");
    const r = resolveStayDates("15/10/2026", "16/10/2026", "1", ctx);
    expect([iso(r.checkIn), iso(r.checkOut)]).toEqual(["2026-10-15", "2026-10-16"]);
  });
});

/* ── adapter level: what the templates actually receive ── */

function hotel(over: Partial<PlumtripsVoucher> = {}): PlumtripsVoucher {
  return {
    type: "hotel",
    booking_info: { booking_id: "261014802640", booking_date: "14 Oct, 2026", voucher_no: "CT_261014643196", supplier_conf_no: null },
    hotel_details: { name: "Perch Service Apartments", address: "DLF Phase 3, Gurugram", city: "Gurugram", country: null, contact: "+91-8800461053" },
    stay_details: { check_in_date: "OCT 15", check_in_time: "01 PM", check_out_date: "16 OCT", check_out_time: "12 PM", total_nights: "1" },
    guest_details: { primary_guest: "Mr Samved Patil", total_pax: null, adults: 1, children: 0, all_guest_names: ["Mr Samved Patil"] },
    room_details: { room_type: "Classic Studio Apartment", no_of_rooms: "1", inclusions: ["Complimentary Wifi", "Room Only"], special_requests: null },
    policies: { cancellation_deadline: null, is_non_refundable: false, important_notes: [] },
    ...over,
  };
}

describe("adaptHotel — stay dates", () => {
  it("the Perch voucher gets 2026 dates (was 2001 → Monday/Tuesday)", () => {
    const warnings: string[] = [];
    const p = adaptHotel(hotel(), { createdAt: "2026-10-14T08:08:21Z", warnings });
    expect([p.checkIn, p.checkOut]).toEqual(["2026-10-15", "2026-10-16"]);
    expect(warnings).toEqual([]);
  });
});

describe("adaptFlight — leg dates", () => {
  const flight = (dates: [string, string][]): PlumtripsVoucher => ({
    type: "flight",
    booking_info: { booking_id: null, booking_date: null, voucher_no: null, supplier_conf_no: null, pnr: "8RLUYX" },
    flight_details: {
      segments: dates.map(([dep, arr]) => ({
        airline: "Air India", flight_no: "AI 2361", class: "Economy", duration: null,
        origin: { city: "Manila", code: "MNL", time: "22:55", date: dep, terminal: null },
        destination: { city: "Delhi", code: "DEL", time: "03:10", date: arr, terminal: null },
      })),
    },
    passengers: [],
    policies: { cancellation_deadline: null, is_non_refundable: false, important_notes: [] },
  });

  it("'15 October' uploaded 12 Oct 2026 departs 2026-10-15 (was 2001)", () => {
    const { booking } = adaptFlight(flight([["15 October", "16 October"]]), { createdAt: "2026-10-12T20:19:29Z" });
    expect(booking.departureTime).toBe("2026-10-15T22:55:00");
    expect(booking.arrivalTime).toBe("2026-10-16T03:10:00");
  });

  it("'Thu, Aug 20' resolves to Thursday 20 Aug 2026 with no weekday warning", () => {
    const warnings: string[] = [];
    const { booking } = adaptFlight(flight([["Thu, Aug 20", "Thu, Aug 20"]]), { createdAt: "2026-07-10T09:00:00Z", warnings });
    expect(booking.departureTime.startsWith("2026-08-20")).toBe(true);
    expect(warnings.some((w) => /says/.test(w))).toBe(false);
  });

  it("a Dec 31 → Jan 1 itinerary rolls the later legs into the next year", () => {
    const { booking, returnBooking } = adaptFlight(
      flight([["31 Dec", "31 Dec"], ["1 Jan", "1 Jan"]]),
      { createdAt: "2026-12-20T00:00:00Z" },
    );
    expect(booking.departureTime.startsWith("2026-12-31")).toBe(true);
    expect((returnBooking as any).departureTime.startsWith("2027-01-01")).toBe(true);
  });
});

describe("a weekday printed with the date (voucher prompt keeps it)", () => {
  const ctxFor = (bookingDate: string | null, createdAt = "2026-09-15T10:00:00Z") => buildDateContext(bookingDate, createdAt, []);

  it("'Tue 29 Sept' with no year: the year is inferred and the Tuesday confirms it — no warning", () => {
    const ctx = ctxFor(null);
    const d = resolveVoucherDate("Tue 29 Sept", ctx, { label: "Departure date" });
    expect(d!.toISOString().slice(0, 10)).toBe("2026-09-29");
    expect(ctx.warnings).toEqual([]);
  });

  it("a weekday that doesn't match the inferred year is flagged for ops", () => {
    const ctx = ctxFor("1 Sep 2026");
    const d = resolveVoucherDate("Sun 29 Sept", ctx, { label: "Departure date" });
    expect(d!.toISOString().slice(0, 10)).toBe("2026-09-29");
    expect(ctx.warnings.join(" ")).toMatch(/says Sunday, but .* is a Tuesday — check the date/);
  });

  it("a weekday with a printed year is checked too ('Fri, Oct 02 2026' ok; 'Mon, Oct 02 2026' flagged)", () => {
    const ok = ctxFor(null);
    expect(resolveVoucherDate("Fri, Oct 02 2026", ok, { label: "Departure date" })!.toISOString().slice(0, 10)).toBe("2026-10-02");
    expect(ok.warnings).toEqual([]);
    const bad = ctxFor(null);
    resolveVoucherDate("Mon, Oct 02 2026", bad, { label: "Departure date" });
    expect(bad.warnings.join(" ")).toMatch(/says Monday/);
  });

  it("parseDateParts reads the weekday and no year from 'Tue 29 Sept' / 'Wed, 30 September'", () => {
    expect(parseDateParts("Tue 29 Sept")).toMatchObject({ y: null, m: 8, d: 29, weekday: 2 });
    expect(parseDateParts("Wed, 30 September")).toMatchObject({ y: null, m: 8, d: 30, weekday: 3 });
  });
});
