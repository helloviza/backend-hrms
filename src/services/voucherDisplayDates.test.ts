// The Summary's dates must be the PDF's dates: compare voucherDisplayDates
// with the adapter's own output on the same records.
import { describe, it, expect } from "vitest";
import { voucherDisplayDates } from "./voucherDisplayDates.js";
import { adaptFlight, adaptHotel } from "./voucherAdapter.js";

const createdAt = new Date("2026-10-13T10:00:00Z");
const day = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1]} ${y}`;
};

describe("voucherDisplayDates matches the PDF adapter", () => {
  const hotels = [
    { check_in_date: "18 Oct", check_out_date: "20 Oct", total_nights: 2 }, // no year → assumed
    { check_in_date: "30 Dec", check_out_date: "2 Jan", total_nights: 3 }, // rolls over the year
    { check_in_date: "12 Nov 2026", check_out_date: "15 Nov 2026", total_nights: 3 }, // stated
    { check_in_date: "03/04/26", check_out_date: "04/04/26", total_nights: 1 }, // DD/MM/YY
  ];
  for (const stay of hotels) {
    it(`hotel ${stay.check_in_date} → ${stay.check_out_date}`, () => {
      const v: any = { type: "hotel", stay_details: stay, booking_info: {}, hotel_details: {}, guest_details: {}, room_details: {}, policies: {} };
      const pdf = adaptHotel(v, { createdAt, warnings: [] }) as any;
      const shown: any = voucherDisplayDates({ docType: "hotel", extractedJson: v, createdAt });
      expect(shown.checkIn?.date).toBe(day(pdf.checkIn));
      expect(shown.checkOut?.date).toBe(day(pdf.checkOut));
    });
  }

  it("flags only year-less dates as assumed", () => {
    const v: any = { type: "hotel", stay_details: hotels[0], booking_info: {} };
    const a: any = voucherDisplayDates({ docType: "hotel", extractedJson: v, createdAt });
    expect(a.checkIn).toEqual({ date: "18 Oct 2026", yearAssumed: true });
    const b: any = voucherDisplayDates({ docType: "hotel", extractedJson: { ...v, stay_details: hotels[2] }, createdAt });
    expect(b.checkIn).toEqual({ date: "12 Nov 2026", yearAssumed: false });
  });

  it("a booking date with a year anchors the inference, as on the PDF", () => {
    const v: any = { type: "hotel", stay_details: { check_in_date: "5 Jan", check_out_date: "6 Jan" }, booking_info: { booking_date: "20 Dec 2026" } };
    const shown: any = voucherDisplayDates({ docType: "hotel", extractedJson: v, createdAt });
    expect(shown.checkIn.date).toBe(day((adaptHotel(v, { createdAt, warnings: [] }) as any).checkIn));
    expect(shown.checkIn.date).toBe("5 Jan 2027");
  });

  it("flight legs resolve in order, as on the PDF", () => {
    const seg = (from: string, fd: string, to: string, td: string) => ({ flight_no: "X1", origin: { code: from, date: fd, time: "10:00" }, destination: { code: to, date: td, time: "12:00" } });
    const v: any = {
      type: "flight",
      booking_info: {},
      flight_details: { segments: [seg("BOM", "31 Dec", "DXB", "31 Dec"), seg("DXB", "1 Jan", "BOM", "1 Jan")] },
      passengers: [],
    };
    const pdf = adaptFlight(v, { createdAt, warnings: [] });
    const ret: any = Array.isArray(pdf.returnBooking) ? pdf.returnBooking[0] : pdf.returnBooking;
    const shown: any = voucherDisplayDates({ docType: "flight", extractedJson: v, createdAt });
    expect(shown.segments[0].departure.date).toBe(day(pdf.booking.departureTime));
    expect(shown.segments[0].arrival.date).toBe(day(pdf.booking.arrivalTime));
    expect(shown.segments[1].departure.date).toBe(day(ret.departureTime));
    expect(shown.segments[1].departure).toEqual({ date: "1 Jan 2027", yearAssumed: true });
  });

  it("nothing extracted → null", () => {
    expect(voucherDisplayDates({ docType: "hotel" })).toBeNull();
  });
});
