// apps/backend/src/services/requestBookings.ts
//
// The live Book Now bookings of approval requests (ManualBooking with source
// ADMIN_QUEUE, sourceBookingId = the request, not deleted), as a staff-only
// summary: what the Admin Queue's buttons need (Book Now / Open booking /
// Booked – View booking / + Add another booking) and what the manual booking
// create route checks before a second booking for the same request.
//
// Summary only — id, reference, type, status, sub status, created — never
// prices, people or files.
import mongoose from "mongoose";
import ManualBooking from "../models/ManualBooking.js";

type AnyObj = Record<string, any>;

export type RequestBookingSummary = {
  _id: string;
  bookingRef: string;
  type: string;
  status: string;
  subStatus: string;
  createdAt: string | null;
};

const summary = (b: AnyObj): RequestBookingSummary => ({
  _id: String(b._id),
  bookingRef: String(b.bookingRef || ""),
  type: String(b.type || ""),
  status: String(b.status || ""),
  subStatus: String(b.subStatus || ""),
  createdAt: b.createdAt ? new Date(b.createdAt).toISOString() : null,
});

/** sourceBookingId is stored as an ObjectId; match the string form too. */
const idForms = (ids: string[]) => ids.flatMap((id) => (mongoose.isValidObjectId(id) ? [id, new mongoose.Types.ObjectId(id)] : [id]));

/** Live bookings of each request, oldest first, keyed by request id. */
export async function bookingsByRequest(requestIds: unknown[], extraFields = ""): Promise<Map<string, AnyObj[]>> {
  const ids = Array.from(new Set(requestIds.map((v) => String(v ?? "")).filter(Boolean)));
  const out = new Map<string, AnyObj[]>();
  if (!ids.length) return out;
  const rows: AnyObj[] = await ManualBooking.find({
    source: "ADMIN_QUEUE",
    sourceBookingId: { $in: idForms(ids) },
    isActive: { $ne: false },
  })
    .select(`_id bookingRef type status subStatus createdAt sourceBookingId ${extraFields}`.trim())
    .sort({ createdAt: 1, _id: 1 })
    .lean();
  for (const b of rows) {
    const key = String(b.sourceBookingId);
    out.set(key, [...(out.get(key) || []), b]);
  }
  return out;
}

/** One request's live bookings as summaries, oldest first. */
export async function requestBookingSummaries(requestId: string): Promise<RequestBookingSummary[]> {
  return ((await bookingsByRequest([requestId])).get(String(requestId)) || []).map(summary);
}

/**
 * Staff list rows: each gets `_bookings` (summaries, oldest first). Mutates
 * and returns the rows. The summary only drives buttons, so it never holds up
 * or fails the list: with no live database connection (a query would wait in
 * Mongoose's buffer) or on any error, the rows go out without it.
 */
export async function withRequestBookings<T extends AnyObj>(rows: T[]): Promise<T[]> {
  if (!rows.length || mongoose.connection.readyState !== 1) return rows;
  try {
    const map = await bookingsByRequest(rows.map((r) => r?._id));
    for (const r of rows) (r as AnyObj)._bookings = (map.get(String(r?._id)) || []).map(summary);
  } catch (err: any) {
    console.error("[requestBookings] booking summary failed", err?.message || err);
  }
  return rows;
}

export { summary as requestBookingSummary };
