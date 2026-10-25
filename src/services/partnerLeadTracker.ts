// apps/backend/src/services/partnerLeadTracker.ts
//
// What a partner sees about the leads it sent: one row per case, built field
// by field from an allowlist (never a spread document), shared by the list and
// the detail route (routes/partner.cases.ts).
//
//   Out: case number, student name, services, route, dates, current step,
//        RM display name, step history {label, subStatus, at}, document STATUS
//        per booking (no file, name or link): issued once the booking holds a
//        customer document (ticket / voucher / document), labelled by the
//        booking's service — a flight's is a ticket, a hotel's a voucher,
//        anything else a document. Internal and legacy "other" files never count.
//   Never out: the student's phone or email, staff notes or comments, any
//        price / cost / margin / partner share, supplier, ids, emails of staff.
//
// Steps (the timeline): Case created → In Admin Queue → Assigned to RM (name)
// → Work started, then the bookings' status changes from the case history,
// and "Request closed" when ops close the case.
//
// Every label comes from TRACKER_LABEL below — the ONE map both trackers
// show (partner Student Cases and the student's Track my case render these
// strings as sent). Each step also carries its machine `state`, which the
// screens use for colour and empty states (never the wording):
//   created / queued / assigned / started   the case steps, unchanged
//   in_progress   a booking Pending (with its sub status) or WIP
//   processed     "Booking processed": a booking Confirmed / Invoiced, or
//                 the case marked done without one
//   cancelled     "Request cancelled": every booking cancelled (sub status)
//   closed        "Request closed": ops closed the case (Mark Processed /
//                 cancel) with no booking left — the close reason's label,
//                 never the note ops typed
//
// Current step and the counts come from the live state: the case's bookings
// (bookingRollup: most advanced open booking; processed only when none is
// open; cancelled when all are), else the case itself.
//   Registered     every case
//   Pending action not yet started (queued / assigned)
//   In progress    started, or a booking in progress
//   Actioned       processed, cancelled or closed
// Every case is in exactly one of the last three, so they sum to Registered.
import { itemDates, itemTitle, serviceOf } from "./approvalItemRules.js";
import { bookingRollup } from "./partnerLeadBooking.js";
import { CUSTOMER_DOCUMENT_TYPES, documentTypeForBookingType } from "../models/ManualBooking.js";
import { CLOSE_REASONS } from "./closeReasons.js";

type AnyObj = Record<string, any>;
const str = (v: any, max = 200) => String(v ?? "").trim().slice(0, max);
const iso = (v: any) => (v ? new Date(v).toISOString() : null);

export type Bucket = "pendingAction" | "inProgress" | "actioned";
export type TrackerState = "created" | "queued" | "assigned" | "started" | "in_progress" | "processed" | "cancelled" | "closed";
export type TrackerStep = { state: TrackerState; label: string; subStatus: string; at: string | null };

/** The tracker's wording, for both trackers. */
export const TRACKER_LABEL: Record<TrackerState, string> = {
  created: "Case created",
  queued: "In Admin Queue",
  assigned: "Assigned to RM",
  started: "Work started",
  in_progress: "In progress",
  processed: "Booking processed",
  cancelled: "Request cancelled",
  closed: "Request closed",
};

/** A booking status → its tracker state (unknown statuses read as in progress). */
const BOOKING_STATE: Record<string, TrackerState> = { PENDING: "in_progress", WIP: "in_progress", CONFIRMED: "processed", INVOICED: "processed", CANCELLED: "cancelled" };
/** Booking statuses whose sub status the tracker shows. */
const SHOWS_SUB = new Set(["PENDING", "CANCELLED"]);

const step = (state: TrackerState, at: string | null, subStatus = ""): TrackerStep => ({ state, label: TRACKER_LABEL[state], subStatus, at });

const SERVICE_LABEL: Record<string, string> = { flight: "Flight", hotel: "Hotel", visa: "Visa", cab: "Cab", forex: "Forex", esim: "eSIM", holiday: "Holiday", mice: "MICE" };
const BOOKING_TYPE_LABEL: Record<string, string> = { FLIGHT: "Flight", HOTEL: "Hotel", VISA: "Visa" };

const ASSIGN = new Set(["admin_assigned", "admin_auto_assigned", "admin_reassigned"]);
const STARTED = new Set(["booking_started", "admin_under_process"]);
const CLOSED = new Set(["admin_cancelled", "admin_closed"]);

/** The fields the tracker reads, for the query's projection. */
export const TRACKER_CASE_FIELDS =
  "_id createdAt adminState stage ticketId meta.source meta.closedReason meta.partnerLead.caseNumber meta.partnerLead.contact.name " +
  "cartItems.type cartItems.meta history.action history.at history.assigneeName history.bookingStatus history.bookingSubStatus";

function caseClosed(c: AnyObj): boolean {
  return str(c.adminState) === "cancelled" || str(c.stage).toUpperCase() === "BOOKING_CANCELLED" || (c.history || []).some((h: AnyObj) => CLOSED.has(str(h?.action)));
}

/** Why ops closed the case, customer-safe ("Not available"), or "": Mark Processed's reason only. */
function closeReason(c: AnyObj, action: string): string {
  return action === "admin_closed" ? str(CLOSE_REASONS[str(c.meta?.closedReason).toUpperCase()], 80) : "";
}

export function stepHistory(c: AnyObj): TrackerStep[] {
  const history: AnyObj[] = Array.isArray(c.history) ? c.history : [];
  const hasBookingRows = history.some((h) => h?.action === "booking_status");
  const steps: TrackerStep[] = [step("created", iso(c.createdAt))];
  let started = false;
  for (const h of history) {
    const action = str(h?.action);
    const at = iso(h?.at);
    if (action === "approved") steps.push(step("queued", at));
    else if (ASSIGN.has(action)) steps.push(step("assigned", at));
    else if (STARTED.has(action) && !started) {
      started = true;
      steps.push(step("started", at));
    } else if (action === "booking_status") {
      const status = str(h.bookingStatus).toUpperCase();
      steps.push(step(BOOKING_STATE[status] || "in_progress", at, SHOWS_SUB.has(status) ? str(h.bookingSubStatus, 80) : ""));
    } else if (action === "admin_done" && !hasBookingRows) steps.push(step("processed", at));
    else if (CLOSED.has(action)) steps.push(step("closed", at, closeReason(c, action)));
  }
  return steps;
}

/** The assigned RM's display name (the latest assignment row), or "". Never an email. */
function rmName(c: AnyObj): string {
  const rows = (c.history || []).filter((h: AnyObj) => ASSIGN.has(str(h?.action)) || str(h?.action) === "admin_unassigned");
  const last = rows[rows.length - 1];
  return last && str(last.action) !== "admin_unassigned" ? str(last.assigneeName, 80) : "";
}

const BUCKET: Record<TrackerState, Bucket> = {
  created: "pendingAction",
  queued: "pendingAction",
  assigned: "pendingAction",
  started: "inProgress",
  in_progress: "inProgress",
  processed: "actioned",
  cancelled: "actioned",
  closed: "actioned",
};

/** Current step + its bucket, from the live bookings, else the case. */
export function currentStep(c: AnyObj, bookings: AnyObj[]): { step: TrackerStep; bucket: Bucket } {
  const history: AnyObj[] = Array.isArray(c.history) ? c.history : [];
  const last = (pred: (h: AnyObj) => boolean) => [...history].reverse().find(pred);
  const r = bookingRollup(bookings);
  const of = (s: TrackerStep) => ({ step: s, bucket: BUCKET[s.state] });
  if (caseClosed(c)) {
    // Every booking cancelled → the bookings say why; otherwise ops closed it.
    if (r.state === "closed") return of(step("cancelled", iso(r.at), str(r.subStatus, 80)));
    const row = last((h) => CLOSED.has(str(h?.action)));
    return of(step("closed", iso(row?.at), closeReason(c, str(row?.action))));
  }
  if (r.state !== "none") {
    if (r.state === "done") return of(step("processed", iso(r.at)));
    if (r.state === "closed") return of(step("cancelled", iso(r.at), str(r.subStatus, 80)));
    return of(step("in_progress", iso(r.at), r.state === "pending" ? str(r.subStatus, 80) : ""));
  }
  if (str(c.adminState) === "done" || str(c.stage).toUpperCase() === "COMPLETED") {
    return of(step("processed", iso(last((h) => h?.action === "admin_done")?.at)));
  }
  const started = history.find((h) => STARTED.has(str(h?.action)));
  if (started || str(c.adminState) === "in_progress") return of(step("started", iso(started?.at)));
  const assigned = last((h) => ASSIGN.has(str(h?.action)));
  if (assigned && rmName(c)) return of(step("assigned", iso(assigned.at)));
  const queued = history.find((h) => h?.action === "approved");
  return of(step("queued", iso(queued?.at || c.createdAt)));
}

/** One case as the partner sees it. `bookings` are the case's live bookings. */
export function trackerRow(c: AnyObj, bookings: AnyObj[]) {
  const items: AnyObj[] = Array.isArray(c.cartItems) ? c.cartItems : [];
  const services = items
    .map((it) => {
      const type = serviceOf(it);
      if (!type) return null;
      const dates = itemDates(type, it.meta || {});
      return { service: SERVICE_LABEL[type] || type, route: str(itemTitle(type, it.meta || {}), 120), startDate: dates.start || null, endDate: dates.end || null };
    })
    .filter(Boolean);
  const { step, bucket } = currentStep(c, bookings);
  return {
    caseNumber: str(c.meta?.partnerLead?.caseNumber || c.ticketId, 20),
    studentName: str(c.meta?.partnerLead?.contact?.name, 120),
    services,
    createdAt: iso(c.createdAt),
    currentStep: step,
    bucket,
    rmName: rmName(c),
    steps: stepHistory(c),
    documents: bookings.map((b) => {
      const issued = (b.attachments || []).some((a: AnyObj) => CUSTOMER_DOCUMENT_TYPES.has(str(a?.type).toLowerCase()));
      const kind = documentTypeForBookingType(b.type);
      return {
        service: BOOKING_TYPE_LABEL[str(b.type).toUpperCase()] || "Other",
        ticketIssued: issued && kind === "ticket",
        voucherIssued: issued && kind === "voucher",
        documentIssued: issued && !kind,
      };
    }),
  };
}

export function trackerCounts(rows: Array<{ bucket: Bucket }>) {
  const n = (b: Bucket) => rows.filter((r) => r.bucket === b).length;
  return { registered: rows.length, pendingAction: n("pendingAction"), inProgress: n("inProgress"), actioned: n("actioned") };
}
