// apps/backend/src/services/activityText.ts
//
// Plain-English activity text for customer-side viewers. Ops rows were written
// as "[ADMIN] [MODE:DONE] [SERVICE:FLIGHT] [REASON:TICKET_ISSUED] Ticket issued
// & shared — Attachment: https://…/download" (AdminApprovalQueue's
// buildAdminComment). Customers get "Ticket issued and shared": no tags, no
// URLs, no prices; an attachment becomes its file name only (the drawer shows
// it as a document chip with a permission-checked Download).
//
// The frontend twin is lib/activityText.ts (staff screens read the raw rows
// and clean them the same way).

const str = (v: any) => String(v ?? "").trim();

/** Ops reason codes (AdminApprovalQueue SERVICE_REASON_CONFIG) → plain text. */
export const REASON_TEXT: Record<string, string> = {
  TICKET_ISSUED: "Ticket issued and shared",
  REISSUE_DONE: "Reissue / rebooking completed",
  FARE_PROTECTED: "Fare protected and confirmed",
  CONFIRMED: "Hotel confirmed and voucher shared",
  UPGRADE_CONFIRMED: "Room upgrade confirmed",
  DATE_CHANGE_DONE: "Date change processed",
  APPLICATION_SUBMITTED: "Visa application submitted",
  VISA_APPROVED: "Visa approved and copy shared",
  BIOMETRIC_COMPLETED: "Biometric appointment completed",
  BOOKING_CONFIRMED: "Booking confirmed",
  DRIVER_ASSIGNED: "Driver assigned and details shared",
  SERVICE_DELIVERED: "Service delivered",
  REQUEST_FULFILLED: "Request fulfilled",
  // Mark Processed (no booking) outcomes
  CANCELLED_BY_CLIENT: "Cancelled by the client",
  NOT_AVAILABLE: "Not available",
  DUPLICATE: "Duplicate request",
  HANDLED_ELSEWHERE: "Handled outside Plumbox",
  // hold / under process / cancel
  WAITING_TRAVELLER_CONFIRM: "Waiting for traveller confirmation",
  WAITING_MANAGER_APPROVAL: "Awaiting internal approval",
  PAYMENT_CLEARANCE: "Payment clearance in progress",
  QUEUE_WITH_AIRLINE: "In queue with the airline",
  PNR_GENERATED: "PNR generated, ticketing in progress",
  SCHEDULE_CHANGE_REVIEW: "Schedule change review in progress",
  TRAVELLER_CANCELLED: "Cancelled by the traveller",
  POLICY_NON_COMPLIANT: "Not compliant with travel policy",
  FARE_EXPIRED: "Fare expired / seats not available",
  PAYMENT_FAILED: "Payment failure",
  RATE_NEGOTIATION: "Rate negotiation with the property",
  ROOM_ON_REQUEST: "Room on request, awaiting confirmation",
  PAYMENT_PENDING: "Payment pending",
  BLOCKING_IN_PROGRESS: "Blocking rooms",
  SPECIAL_REQUESTS: "Special requests being coordinated",
  GROUP_IN_PROGRESS: "Group booking in progress",
  NO_AVAILABILITY: "No availability at the requested property",
  RATE_REJECTED: "Rate not approved",
  DOCUMENTS_PENDING: "Documents pending from the traveller",
  APPOINTMENT_SLOTS: "Waiting for appointment slots",
  UNDER_EMBASSY_REVIEW: "Under embassy review",
  APPLICATION_UNDER_PROCESS: "Application under process",
  ADDITIONAL_DOCS_REVIEW: "Additional documents under review",
  REFUSED_BY_EMBASSY: "Refused by the embassy",
  DOCUMENTS_NOT_COMPLIANT: "Documents not compliant",
  VEHICLE_AVAILABILITY: "Checking vehicle availability",
  ROUTE_CLARIFICATION: "Route / timing clarification",
  COORDINATION_IN_PROGRESS: "Coordination in progress",
  NO_VEHICLE: "No vehicle available",
  INTERNAL_APPROVAL: "Internal approval pending",
  VENDOR_NEGOTIATION: "Vendor negotiation in progress",
  WORK_IN_PROGRESS: "Work in progress",
  REQUEST_WITHDRAWN: "Withdrawn by the requester",
  SCOPE_CHANGED: "Scope changed, a new request is needed",
};

/** "SOME_CODE" → "Some code" when the code is not in the table. */
function codeText(code: string): string {
  const c = str(code).toUpperCase();
  if (REASON_TEXT[c]) return REASON_TEXT[c];
  const words = c.replace(/[_-]+/g, " ").toLowerCase().trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

/** The file name in an attachment URL / path ("…/attachments/abc.pdf/download" → "abc.pdf"). */
export function fileNameOf(url: string): string {
  const clean = str(url).split("#")[0].split("?")[0].replace(/\/download$/i, "");
  const last = clean.split("/").filter(Boolean).pop() || "";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

const URL_RE = /\bhttps?:\/\/\S+|(?:^|\s)\/?(?:api|uploads)\/\S+/gi;

export type PlainActivity = { text: string; documentName: string };

/**
 * One activity comment as plain text. Tags go; a [REASON:…] becomes its words
 * (unless the text already says it); "Attachment: <url>" becomes the file name
 * in `documentName`; any other URL is dropped; money tokens never survive.
 */
export function plainActivity(comment: any): PlainActivity {
  let s = str(comment);
  if (!s) return { text: "", documentName: "" };

  let documentName = "";
  const att = s.match(/Attachment:\s*(\S+)/i);
  if (att?.[1]) {
    documentName = fileNameOf(att[1]);
    s = s.replace(/\s*[—-]?\s*Attachment:\s*\S+/i, " ");
  }

  const reasons: string[] = [];
  for (const m of s.matchAll(/\[(?:ITEM_\d+_)?REASON:([^\]]+)\]/gi)) {
    if (str(m[1]).toUpperCase() !== "MULTI") reasons.push(codeText(m[1]));
  }
  s = s.replace(/\[[^\]]{1,80}\]/g, " ");
  s = s.replace(URL_RE, " ");
  s = s.replace(/\s*&\s*/g, " and ");
  s = s.replace(/\s{2,}/g, " ").replace(/^\s*[—-]\s*|\s*[—-]\s*$/g, "").trim();

  // A reason whose label the text already starts with is not repeated.
  const lead = reasons.filter((r) => r && !s.toLowerCase().startsWith(r.toLowerCase().slice(0, 12)));
  const text = [...lead, s].filter(Boolean).join(" — ");
  return { text, documentName };
}

/**
 * History actions customers never see: delivery bookkeeping (it names the
 * recipients' emails), internal uploads and email-skip notes.
 */
export const CUSTOMER_HIDDEN_ACTIONS = new Set([
  "admin_notify_sent",
  "admin_notify_failed",
  "admin_notify_skipped",
  "admin_notify_queued",
  "email_skipped",
  "admin_attachment_uploaded",
]);
