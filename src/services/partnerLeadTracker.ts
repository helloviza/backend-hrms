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
// Steps: Case created → In Admin Queue → Assigned to RM (name) → Work started
// → the bookings' Status / Sub Status (Pending – <sub>, WIP, Done, Cancelled –
// <sub>), from the case history; Closed when ops close the case.
//
// Current step and the counts come from the live state: the case's bookings
// (bookingRollup: most advanced open booking; Done only when none is open;
// Closed when all are cancelled), else the case itself.
//   Registered     every case
//   Pending action not yet started (In Admin Queue / Assigned to RM)
//   In progress    started, and a booking Pending / WIP (or none yet)
//   Actioned       Done, or Cancelled / closed
// Every case is in exactly one of the last three, so they sum to Registered.
import { itemDates, itemTitle, serviceOf } from "./approvalItemRules.js";
import { BOOKING_STATUS_LABEL, bookingRollup } from "./partnerLeadBooking.js";
import { CUSTOMER_DOCUMENT_TYPES, documentTypeForBookingType } from "../models/ManualBooking.js";

type AnyObj = Record<string, any>;
const str = (v: any, max = 200) => String(v ?? "").trim().slice(0, max);
const iso = (v: any) => (v ? new Date(v).toISOString() : null);

export type Bucket = "pendingAction" | "inProgress" | "actioned";
export type TrackerStep = { label: string; subStatus: string; at: string | null };

const SERVICE_LABEL: Record<string, string> = { flight: "Flight", hotel: "Hotel", visa: "Visa", cab: "Cab", forex: "Forex", esim: "eSIM", holiday: "Holiday", mice: "MICE" };
const BOOKING_TYPE_LABEL: Record<string, string> = { FLIGHT: "Flight", HOTEL: "Hotel", VISA: "Visa" };

const ASSIGN = new Set(["admin_assigned", "admin_auto_assigned", "admin_reassigned"]);
const STARTED = new Set(["booking_started", "admin_under_process"]);
const CLOSED = new Set(["admin_cancelled", "admin_closed"]);

/** The fields the tracker reads, for the query's projection. */
export const TRACKER_CASE_FIELDS =
  "_id createdAt adminState stage ticketId meta.source meta.partnerLead.caseNumber meta.partnerLead.contact.name " +
  "cartItems.type cartItems.meta history.action history.at history.assigneeName history.bookingStatus history.bookingSubStatus";

function caseClosed(c: AnyObj): boolean {
  return str(c.adminState) === "cancelled" || str(c.stage).toUpperCase() === "BOOKING_CANCELLED" || (c.history || []).some((h: AnyObj) => CLOSED.has(str(h?.action)));
}

export function stepHistory(c: AnyObj): TrackerStep[] {
  const history: AnyObj[] = Array.isArray(c.history) ? c.history : [];
  const hasBookingRows = history.some((h) => h?.action === "booking_status");
  const steps: TrackerStep[] = [{ label: "Case created", subStatus: "", at: iso(c.createdAt) }];
  let started = false;
  for (const h of history) {
    const action = str(h?.action);
    const at = iso(h?.at);
    if (action === "approved") steps.push({ label: "In Admin Queue", subStatus: "", at });
    else if (ASSIGN.has(action)) steps.push({ label: "Assigned to RM", subStatus: "", at });
    else if (STARTED.has(action) && !started) {
      started = true;
      steps.push({ label: "Work started", subStatus: "", at });
    } else if (action === "booking_status") {
      const status = str(h.bookingStatus).toUpperCase();
      steps.push({ label: BOOKING_STATUS_LABEL[status] || "Updated", subStatus: status === "PENDING" || status === "CANCELLED" ? str(h.bookingSubStatus, 80) : "", at });
    } else if (action === "admin_done" && !hasBookingRows) steps.push({ label: "Done", subStatus: "", at });
    else if (CLOSED.has(action)) steps.push({ label: "Closed", subStatus: "", at });
  }
  return steps;
}

/** The assigned RM's display name (the latest assignment row), or "". Never an email. */
function rmName(c: AnyObj): string {
  const rows = (c.history || []).filter((h: AnyObj) => ASSIGN.has(str(h?.action)) || str(h?.action) === "admin_unassigned");
  const last = rows[rows.length - 1];
  return last && str(last.action) !== "admin_unassigned" ? str(last.assigneeName, 80) : "";
}

/** Current step + its bucket, from the live bookings, else the case. */
export function currentStep(c: AnyObj, bookings: AnyObj[]): { step: TrackerStep; bucket: Bucket } {
  const history: AnyObj[] = Array.isArray(c.history) ? c.history : [];
  const last = (pred: (h: AnyObj) => boolean) => [...history].reverse().find(pred);
  const r = bookingRollup(bookings);
  if (caseClosed(c)) {
    const row = last((h) => CLOSED.has(str(h?.action)));
    return { step: { label: "Closed", subStatus: "", at: iso(row?.at) }, bucket: "actioned" };
  }
  if (r.state !== "none") {
    const step = {
      label: BOOKING_STATUS_LABEL[r.status] || "Updated",
      subStatus: r.state === "pending" || r.state === "closed" ? str(r.subStatus, 80) : "",
      at: iso(r.at),
    };
    return { step, bucket: r.state === "done" || r.state === "closed" ? "actioned" : "inProgress" };
  }
  if (str(c.adminState) === "done" || str(c.stage).toUpperCase() === "COMPLETED") {
    return { step: { label: "Done", subStatus: "", at: iso(last((h) => h?.action === "admin_done")?.at) }, bucket: "actioned" };
  }
  const started = history.find((h) => STARTED.has(str(h?.action)));
  if (started || str(c.adminState) === "in_progress") {
    return { step: { label: "Work started", subStatus: "", at: iso(started?.at) }, bucket: "inProgress" };
  }
  const assigned = last((h) => ASSIGN.has(str(h?.action)));
  if (assigned && rmName(c)) return { step: { label: "Assigned to RM", subStatus: "", at: iso(assigned.at) }, bucket: "pendingAction" };
  const queued = history.find((h) => h?.action === "approved");
  return { step: { label: "In Admin Queue", subStatus: "", at: iso(queued?.at || c.createdAt) }, bucket: "pendingAction" };
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
