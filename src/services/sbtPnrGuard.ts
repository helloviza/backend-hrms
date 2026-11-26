// apps/backend/src/services/sbtPnrGuard.ts
//
// Duplicate guard (docs/specs/sbt-to-manual-booking-spec.md §3.4): a Manual
// Booking whose PNR / confirmation number is already an SBT booking would
// count the same trip twice. On create, on a PNR change and on bulk import the
// routes ask here first and answer 409 SBT_PNR_DUPLICATE unless the operator
// acknowledged it (acknowledgeSbtDuplicate: true / ackDuplicate = YES).
//
// Matching
//   - The PNR field is split on "/", ",", whitespace; tokens are upper-cased;
//     tokens shorter than 5 characters are ignored (too generic).
//   - Flights: SBTBooking.pnr or returnPnr. Hotels: SBTHotelBooking
//     confirmationNo or bookingRefNo. Test bookings are ignored. Both fields
//     are indexed (pnr, confirmationNo); returnPnr / bookingRefNo are rare.
//   - Airlines reuse PNRs: a match counts only when the SBT travel date is
//     within ±365 days of the booking's travel date (when both are known).
//   - The ManualBooking already linked to that SBT booking is reported as
//     linkedBookingRef; a booking is never its own duplicate (excludeBookingId).
//
// Behind SBTConfig "global".manualLinkEnabled with the rest of P1: while it is
// off the guard reports nothing.
import mongoose from "mongoose";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import ManualBooking from "../models/ManualBooking.js";
import { manualLinkSettings } from "./sbtManualLink.js";

export const SBT_PNR_DUPLICATE = "SBT_PNR_DUPLICATE";
export const PNR_MATCH_WINDOW_DAYS = 365;
const DAY_MS = 86_400_000;

export interface SbtPnrMatch {
  kind: "FLIGHT" | "HOTEL";
  sbtBookingId: string;
  pnr: string;
  status: string;
  travelDate: string | null;
  linkedBookingRef: string | null;
  linkedBookingId: string | null;
}

export function pnrTokens(raw: unknown): string[] {
  const out = new Set<string>();
  for (const t of String(raw ?? "").split(/[\s,/]+/)) {
    const v = t.trim().toUpperCase();
    if (v.length >= 5) out.add(v);
  }
  return [...out];
}

function dayOf(raw: unknown): number | null {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.getTime();
  const m = String(raw ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}

export function withinWindow(sbtDate: unknown, bookingDate: unknown): boolean {
  const a = dayOf(sbtDate);
  const b = dayOf(bookingDate);
  if (a == null || b == null) return true; // can't tell → warn
  return Math.abs(a - b) <= PNR_MATCH_WINDOW_DAYS * DAY_MS;
}

export async function findSbtPnrMatches(
  pnrRaw: unknown,
  opts: { travelDate?: unknown; excludeBookingId?: unknown; force?: boolean } = {},
): Promise<SbtPnrMatch[]> {
  const tokens = pnrTokens(pnrRaw);
  if (!tokens.length) return [];
  if (!opts.force && !(await manualLinkSettings()).enabled) return [];

  // Both cases of each token: TBO PNRs are upper-case, hotel confirmation
  // numbers are stored as sent.
  const values = [...new Set(tokens.flatMap((t) => [t, t.toLowerCase()]))];
  const [flights, hotels] = await Promise.all([
    SBTBooking.find({ isTest: { $ne: true }, $or: [{ pnr: { $in: values } }, { returnPnr: { $in: values } }] })
      .select("pnr returnPnr status departureTime")
      .limit(20)
      .lean(),
    SBTHotelBooking.find({ isTest: { $ne: true }, $or: [{ confirmationNo: { $in: values } }, { bookingRefNo: { $in: values } }] })
      .select("confirmationNo bookingRefNo status checkIn")
      .limit(20)
      .lean(),
  ]);

  const raw: Array<Omit<SbtPnrMatch, "linkedBookingRef" | "linkedBookingId">> = [
    ...(flights as any[])
      .filter((f) => withinWindow(f.departureTime, opts.travelDate))
      .map((f) => ({
        kind: "FLIGHT" as const,
        sbtBookingId: String(f._id),
        pnr: tokens.includes(String(f.pnr || "").toUpperCase()) ? f.pnr : f.returnPnr,
        status: String(f.status || ""),
        travelDate: f.departureTime ? String(f.departureTime).slice(0, 10) : null,
      })),
    ...(hotels as any[])
      .filter((h) => withinWindow(h.checkIn, opts.travelDate))
      .map((h) => ({
        kind: "HOTEL" as const,
        sbtBookingId: String(h._id),
        pnr: tokens.includes(String(h.confirmationNo || "").toUpperCase()) ? h.confirmationNo : h.bookingRefNo,
        status: String(h.status || ""),
        travelDate: h.checkIn ? String(h.checkIn).slice(0, 10) : null,
      })),
  ];
  if (!raw.length) return [];

  const ids = raw.map((m) => new mongoose.Types.ObjectId(m.sbtBookingId));
  const linked: any[] = await ManualBooking.find({
    $or: [{ "sbtLink.bookingId": { $in: ids } }, { sourceBookingId: { $in: ids }, source: { $in: ["SBT", "SBT_AUTO"] } }],
  })
    .select("_id bookingRef sbtLink.bookingId sourceBookingId")
    .lean();
  const linkOf = new Map<string, any>();
  for (const b of linked) linkOf.set(String(b.sbtLink?.bookingId ?? b.sourceBookingId), b);

  const exclude = opts.excludeBookingId ? String(opts.excludeBookingId) : "";
  return raw
    .map((m) => {
      const b = linkOf.get(m.sbtBookingId);
      return { ...m, linkedBookingRef: b?.bookingRef ?? null, linkedBookingId: b ? String(b._id) : null };
    })
    .filter((m) => !exclude || m.linkedBookingId !== exclude);
}

/** The 409 body the routes send. */
export function duplicateResponse(matches: SbtPnrMatch[]) {
  const first = matches[0];
  const where = first?.linkedBookingRef ? ` (${first.linkedBookingRef}, linked automatically)` : "";
  return {
    error: `This PNR is already an SBT booking${where}. Saving creates a second record and the trip will count twice.`,
    code: SBT_PNR_DUPLICATE,
    matches,
  };
}
