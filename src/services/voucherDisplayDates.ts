// apps/backend/src/services/voucherDisplayDates.ts
//
// The dates the PDF prints, for the voucher page's Summary. Same resolver,
// same arguments, same order as voucherAdapter.ts (adaptHotel / adaptFlight):
// a date context anchored on the booking date or the upload time, stay dates
// through resolveStayDates, flight legs resolved in order with each leg's
// "not before" the previous one. voucherDisplayDates.test.ts pins this to the
// adapter's own output, so the page can't drift from the PDF.
//
// `yearAssumed` = the voucher printed no year and the resolver inferred one.
import {
  cancellationPolicyLines,
  type CancellationLine,
} from "@plumtrips/shared/voucher-templates/hotelVoucherGenerator";
import { adapterInput, adaptHotel } from "./voucherAdapter.js";
import {
  buildDateContext,
  fmtDay,
  parseDateParts,
  resolveStayDates,
  resolveVoucherDate,
  type DateContext,
} from "./voucherDates.js";

export type DisplayDate = { date: string; yearAssumed: boolean } | null;

/**
 * The hotel PDF's Cancellation Policy section, line for line: the same
 * adapter input, adaptHotel and cancellationPolicyLines the PDF renders from.
 * `deadlineYearAssumed` marks a stated deadline printed with a year the
 * voucher didn't give. null lines = the PDF prints no such section.
 */
export type DisplayCancellation = { lines: CancellationLine[] | null; deadlineYearAssumed: boolean };

export type VoucherDisplayDates =
  | { kind: "hotel"; checkIn: DisplayDate; checkOut: DisplayDate; cancellation: DisplayCancellation }
  | { kind: "flight"; segments: { departure: DisplayDate; arrival: DisplayDate }[] };

function shown(raw: unknown, day: Date | null): DisplayDate {
  if (!day) return null;
  const parts = parseDateParts(typeof raw === "string" ? raw : raw == null ? null : String(raw));
  return { date: fmtDay(day), yearAssumed: !!parts && parts.y === null };
}

function shownCancellation(record: any): DisplayCancellation {
  // The render's own warnings are its business; collected here and dropped.
  const params = adaptHotel(adapterInput(record), { createdAt: record?.createdAt ?? null, warnings: [] });
  const raw = record?.extractedJson?.policies?.cancellation_deadline;
  const parts = typeof raw === "string" ? parseDateParts(raw) : null;
  return {
    lines: cancellationPolicyLines(params),
    deadlineYearAssumed: !!params.cancellationDeadline && !!parts && parts.y === null,
  };
}

export function voucherDisplayDates(record: any): VoucherDisplayDates | null {
  const v = record?.extractedJson;
  if (!v || typeof v !== "object") return null;
  // Warnings are the render's business; collected here and dropped.
  const dctx: DateContext = buildDateContext(v?.booking_info?.booking_date, record?.createdAt, []);

  if (record?.docType === "flight") {
    const segs: any[] = Array.isArray(v?.flight_details?.segments) ? v.flight_details.segments : [];
    let prev: Date | null = null;
    const segments = segs.map((seg, i) => {
      const n = segs.length > 1 ? ` (segment ${i + 1})` : "";
      const dep = resolveVoucherDate(seg?.origin?.date, dctx, { label: `Departure date${n}`, notBefore: prev });
      const arr = resolveVoucherDate(seg?.destination?.date, dctx, { label: `Arrival date${n}`, notBefore: dep ?? prev });
      prev = arr ?? dep ?? prev;
      return {
        departure: shown(seg?.origin?.date, dep),
        arrival: shown(seg?.destination?.date, arr),
      };
    });
    return { kind: "flight", segments };
  }

  const stay = v?.stay_details || {};
  const { checkIn, checkOut } = resolveStayDates(stay.check_in_date, stay.check_out_date, stay.total_nights, dctx);
  return {
    kind: "hotel",
    checkIn: shown(stay.check_in_date, checkIn),
    checkOut: shown(stay.check_out_date, checkOut),
    cancellation: shownCancellation(record),
  };
}
