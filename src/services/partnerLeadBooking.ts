// apps/backend/src/services/partnerLeadBooking.ts
//
// Manual bookings made for a partner lead case (Book Now on a PARTNER_LINK
// case: source ADMIN_QUEUE, sourceBookingId = the case, same customer). Every
// rule here applies to those bookings only; any other booking gets null from
// partnerCaseForBooking and is handled exactly as before.
//
//   - case history: each change of a partner booking's Status or Sub Status
//     writes one "booking_status" row on the case (status, sub status, who,
//     when) — the steps the partner tracker shows;
//   - supplier name and "given by" are optional while the booking is Pending
//     or WIP (the RM has talked to the student, not to a supplier yet) and
//     required at Confirmed;
//   - it can't be invoiced unless it is CONFIRMED;
//   - the case's rollup over its bookings (bookingRollup) for the tracker.
import mongoose from "mongoose";
import ApprovalRequest from "../models/ApprovalRequest.js";
import ManualBooking from "../models/ManualBooking.js";
import { actorStamp } from "./actorNames.js";
import { isPartnerLeadCase } from "./partnerLeadCase.js";

type AnyObj = Record<string, any>;
const str = (v: any) => String(v ?? "").trim();

/** The request a booking was made for, when it is a Book Now booking. */
function linkedCaseId(booking: AnyObj): string {
  const id = str(booking?.sourceBookingId);
  return str(booking?.source).toUpperCase() === "ADMIN_QUEUE" && mongoose.isValidObjectId(id) ? id : "";
}

/**
 * The partner lead case this booking belongs to, or null. A booking is a
 * partner booking only when its case is a PARTNER_LINK case of the same
 * customer (Book Now's CLIENT_MISMATCH guard makes them equal at create).
 */
export async function partnerCaseForBooking(booking: AnyObj | null | undefined): Promise<AnyObj | null> {
  const id = linkedCaseId(booking || {});
  if (!id) return null;
  const doc: any = await ApprovalRequest.findById(id).select("_id customerId meta.source").lean();
  if (!doc || !isPartnerLeadCase(doc)) return null;
  return str(doc.customerId) === str(booking?.workspaceId) ? doc : null;
}

/** Of these bookings, the ids that are partner lead bookings. */
export async function partnerBookingIds(bookings: AnyObj[]): Promise<Set<string>> {
  const linked = bookings.filter((b) => linkedCaseId(b));
  if (!linked.length) return new Set();
  const cases: any[] = await ApprovalRequest.find({
    _id: { $in: Array.from(new Set(linked.map(linkedCaseId))) },
    "meta.source": "PARTNER_LINK",
  })
    .select("_id customerId")
    .lean();
  const customerOf = new Map(cases.map((c) => [String(c._id), str(c.customerId)]));
  return new Set(linked.filter((b) => customerOf.get(linkedCaseId(b)) === str(b.workspaceId)).map((b) => String(b._id)));
}

/* ───────────────────────── labels ───────────────────────── */

export const BOOKING_STATUS_LABEL: Record<string, string> = {
  PENDING: "Pending",
  WIP: "WIP",
  CONFIRMED: "Done",
  INVOICED: "Done",
  CANCELLED: "Cancelled",
};

/** "Pending – Lead Not Contactable", "WIP", "Done", "Cancelled – Plan changed". */
export function bookingStepLabel(status: any, subStatus: any): string {
  const s = BOOKING_STATUS_LABEL[str(status).toUpperCase()] || str(status);
  const sub = str(subStatus);
  return sub ? `${s} – ${sub}` : s;
}

/* ───────────────────────── supplier / given-by ───────────────────────── */

const OPEN = new Set(["PENDING", "WIP"]);
const SUPPLIER_ERRORS = new Set(["Supplier Name is required", "Given By is required"]);

/**
 * The route's required-field errors, adjusted for a partner booking: supplier
 * name and given-by are dropped while it is Pending / WIP, and demanded when
 * it is Confirmed. Non-partner bookings: `errors` unchanged.
 */
export function partnerRequiredErrors(errors: string[], booking: AnyObj, isPartner: boolean): string[] {
  if (!isPartner) return errors;
  const status = str(booking?.status || "PENDING").toUpperCase();
  if (OPEN.has(status)) return errors.filter((e) => !SUPPLIER_ERRORS.has(e));
  if (status === "CONFIRMED") {
    const out = [...errors];
    if (!str(booking?.supplierName) && !out.includes("Supplier Name is required")) out.push("Supplier Name is required");
    if (!str(booking?.givenBy) && !out.includes("Given By is required")) out.push("Given By is required");
    return out;
  }
  return errors;
}

/* ───────────────────────── case history ───────────────────────── */

/**
 * After a partner booking is created or saved: one "booking_status" row on its
 * case when Status or Sub Status changed (`prev` null = just created). Never
 * throws — the booking is already saved. Returns whether a row was written.
 */
export async function recordPartnerBookingStatus(
  booking: AnyObj,
  prev: { status?: any; subStatus?: any } | null,
  actor: AnyObj,
): Promise<boolean> {
  try {
    const status = str(booking?.status).toUpperCase();
    const subStatus = str(booking?.subStatus);
    if (prev && str(prev.status).toUpperCase() === status && str(prev.subStatus) === subStatus) return false;
    const pcase = await partnerCaseForBooking(booking);
    if (!pcase) return false;
    await ApprovalRequest.updateOne(
      { _id: pcase._id },
      {
        $push: {
          history: {
            action: "booking_status",
            at: new Date(),
            by: str(actor?.sub || actor?._id || actor?.id) || "admin",
            userEmail: str(actor?.email).toLowerCase(),
            ...actorStamp(actor, "staff"),
            comment: `${["Booking", str(booking.bookingRef)].filter(Boolean).join(" ")}: ${bookingStepLabel(status, subStatus)}`,
            bookingStatus: status,
            bookingSubStatus: subStatus,
            manualBookingId: String(booking._id),
            bookingRef: str(booking.bookingRef),
          },
        },
      },
    );
    return true;
  } catch (err: any) {
    console.error("[partnerLeadBooking] history row failed", String(booking?._id || ""), err?.message || err);
    return false;
  }
}

/* ───────────────────────── rollup over a case's bookings ───────────────────────── */

export type BookingRollup =
  | { state: "none" }
  | { state: "pending" | "wip" | "done" | "closed"; status: string; subStatus: string; label: string; at: Date | null };

const RANK: Record<string, number> = { PENDING: 1, WIP: 2 };

/**
 * One state for a case from its live bookings:
 *   - any Pending / WIP → the most advanced of those (WIP over Pending; the
 *     latest-updated on a tie), so "Done" only once none is still open;
 *   - else any Confirmed / Invoiced → Done;
 *   - else (all Cancelled) → Closed;
 *   - no bookings → none.
 */
export function bookingRollup(bookings: AnyObj[]): BookingRollup {
  const live = bookings.filter((b) => b && b.isActive !== false);
  if (!live.length) return { state: "none" };
  const at = (b: AnyObj) => (b.updatedAt ? new Date(b.updatedAt) : null);
  const latest = (list: AnyObj[]) => [...list].sort((a, b) => (at(b)?.getTime() || 0) - (at(a)?.getTime() || 0))[0];
  const st = (b: AnyObj) => str(b.status).toUpperCase();
  const pick = (b: AnyObj, state: "pending" | "wip" | "done" | "closed"): BookingRollup => ({
    state,
    status: st(b),
    subStatus: str(b.subStatus),
    label: bookingStepLabel(st(b), state === "done" ? "" : b.subStatus),
    at: at(b),
  });

  const open = live.filter((b) => OPEN.has(st(b)));
  if (open.length) {
    const top = Math.max(...open.map((b) => RANK[st(b)]));
    const b = latest(open.filter((x) => RANK[st(x)] === top));
    return pick(b, st(b) === "WIP" ? "wip" : "pending");
  }
  const done = live.filter((b) => st(b) === "CONFIRMED" || st(b) === "INVOICED");
  if (done.length) return pick(latest(done), "done");
  return pick(latest(live), "closed");
}

/** A case's live bookings, scoped to its own customer (never by meta.manualBookingId). */
export async function bookingsOfCases(customerId: string, caseIds: any[]): Promise<AnyObj[]> {
  if (!mongoose.isValidObjectId(customerId) || !caseIds.length) return [];
  return ManualBooking.find({
    workspaceId: new mongoose.Types.ObjectId(customerId),
    source: "ADMIN_QUEUE",
    sourceBookingId: { $in: caseIds.map((id) => new mongoose.Types.ObjectId(String(id))) },
    isActive: { $ne: false },
  })
    .select("_id sourceBookingId type status subStatus attachments.type isActive updatedAt bookingRef")
    .lean();
}
