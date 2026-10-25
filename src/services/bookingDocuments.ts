// apps/backend/src/services/bookingDocuments.ts
//
// BOOKING DOCUMENTS on an approval request — the tickets and vouchers its
// requester, approver and Workspace Leaders may download.
//
//   • Which files: the ticket / voucher attachments of the manual booking that
//     completed the request (meta.bookingDocuments, bytes in S3), and files ops
//     uploaded on the queue's old Mark Processed (meta.attachments, kind
//     "admin_pdf", local disk). Never a manual booking's "internal" or
//     legacy "other" files and never proposal option PDFs (supplier quotes,
//     staff only).
//   • Who: requestDocumentsVisibleTo — Travel Desk staff inside their queue
//     scope, the requester, the approver, and Workspace Leaders of the
//     request's own company. Everyone else gets 404 (not 403: a request of
//     another company does not exist for them).
//   • How: GET /api/approvals/requests/:id/documents/:docId/download streams the
//     file; customers never receive a URL or an S3 key, only { id, name, type,
//     size }.
//
// syncRequestFromManualBooking is the Book Now → manual booking → Booked path:
// a manual booking linked to a request (source ADMIN_QUEUE, sourceBookingId =
// request id) that is saved Done (CONFIRMED) completes the request through the
// one markRequestDone path — documents from the booking, final prices from the
// booking (staff-only fields), and the "booking done" email via the outbox
// with the documents attached. Saved Pending / WIP, the request stays (or
// becomes) "Booking in progress". Idempotent: a request already booked only
// gets its document list refreshed, never a second email.
import fs from "fs";
import mongoose from "mongoose";
import ApprovalRequest from "../models/ApprovalRequest.js";
import { actorStamp } from "./actorNames.js";
import { markRequestDone, notifyRequesterProgress } from "./approvalProgress.js";
import {
  caseInQueueScope,
  isManagerOrLeaderOfRequest,
  isOwnerOfRequest,
  resolveLeaderCustomerIds,
} from "../routes/approvals.security.js";
import { requestDocuments, publicDocuments, CUSTOMER_DOC_TYPES as CUSTOMER_TYPES, type RequestDocument } from "./requestDocumentList.js";
import { isPartnerLeadCase } from "./partnerLeadCase.js";

export { requestDocuments, publicDocuments, type RequestDocument };

type AnyObj = Record<string, any>;

/** S3 bytes, loaded lazily: utils/s3Upload reads config/env on import. */
async function s3Bytes(key: string): Promise<Buffer> {
  const { getObjectBuffer } = await import("../utils/s3Upload.js");
  return getObjectBuffer(key);
}
const str = (v: any) => String(v ?? "").trim();

function userWorkspaceLeader(user: AnyObj): boolean {
  return (Array.isArray(user?.roles) ? user.roles : [])
    .map((r: any) => String(r).toUpperCase().replace(/[\s_-]/g, ""))
    .includes("WORKSPACELEADER");
}

/**
 * May the caller see (and download) this request's booking documents? Staff
 * inside their queue scope; the requester; the approver / leaders copied on
 * the request; a Workspace Leader of the request's own company.
 */
export async function requestDocumentsVisibleTo(req: AnyObj, doc: AnyObj): Promise<boolean> {
  if (!doc) return false;
  if (caseInQueueScope(req, doc)) return true;
  // A partner lead case's documents are the student's tickets and vouchers:
  // the partner (its Workspace Leaders) sees their status only, through the
  // partner tracker, never the files. Its requester is a system user.
  if (isPartnerLeadCase(doc)) return false;
  const user = req?.user || {};
  if (isOwnerOfRequest(doc, user) || isManagerOrLeaderOfRequest(doc, user)) return true;

  const sameWorkspace = !!doc.workspaceId && str(doc.workspaceId?._id || doc.workspaceId) === str(req.workspaceObjectId || req.workspaceId);
  if (sameWorkspace && userWorkspaceLeader(user)) return true;
  const leaderOf = await resolveLeaderCustomerIds(str(user.email));
  return leaderOf.includes(str(doc.customerId));
}

/** Streams one document; false when it is not one of the request's booking documents. */
export async function sendRequestDocument(res: AnyObj, doc: AnyObj, docId: string): Promise<boolean> {
  const found = requestDocuments(doc).find((d) => d.id === docId);
  if (!found) return false;
  const name = found.name.replace(/["\r\n]/g, "");
  if (found._s3Key) {
    const bytes = await s3Bytes(found._s3Key);
    res.setHeader("Content-Type", found.mime || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.setHeader("Content-Length", String(bytes.length));
    res.end(bytes);
    return true;
  }
  if (found._localPath && fs.existsSync(found._localPath)) {
    res.setHeader("Content-Type", found.mime || "application/pdf");
    res.download(found._localPath, name);
    return true;
  }
  return false;
}

/** Mail attachments for the "booking done" email: fetched from S3 at send time (retries too). */
function emailAttachmentsOf(docs: AnyObj[]) {
  return docs
    .filter((d) => CUSTOMER_TYPES.has(str(d?.type).toLowerCase()) && str(d?.s3Key))
    .map((d) => ({ filename: str(d.filename) || "document.pdf", s3Key: str(d.s3Key), contentType: str(d.mime) || "application/pdf" }));
}

/* ───────────────────────── manual booking → request ───────────────────────── */

const DONE_STATUSES = new Set(["CONFIRMED", "INVOICED"]);
const OPEN_STATUSES = new Set(["PENDING", "WIP"]);

/** The request a manual booking was created for (Book Now), or null. */
export function linkedRequestId(booking: AnyObj): string {
  const id = str(booking?.sourceBookingId);
  return str(booking?.source).toUpperCase() === "ADMIN_QUEUE" && mongoose.isValidObjectId(id) ? id : "";
}

/** The ticket / voucher attachments of a booking as stored on the request (staff-only s3Key). */
function bookingDocsOf(booking: AnyObj) {
  return (Array.isArray(booking?.attachments) ? booking.attachments : [])
    .filter((a: AnyObj) => CUSTOMER_TYPES.has(str(a?.type).toLowerCase()))
    .map((a: AnyObj) => ({
      attachmentId: str(a._id),
      type: str(a.type).toLowerCase(),
      filename: str(a.originalFilename),
      s3Key: str(a.s3Key),
      size: Number(a.size) || 0,
      mime: str(a.mimeType),
      uploadedAt: a.uploadedAt || new Date(),
    }));
}

/** Customer-safe one-liner for the trail: "Ticket issued and shared". */
function bookedText(booking: AnyObj, docs: AnyObj[]): string {
  const t = str(booking?.type).toUpperCase();
  const hasTicket = docs.some((d) => d.type === "ticket");
  const hasVoucher = docs.some((d) => d.type === "voucher");
  if (t.includes("FLIGHT") || hasTicket) return docs.length ? "Ticket issued and shared" : "Ticket issued";
  if (t.includes("HOTEL") || hasVoucher) return docs.length ? "Hotel confirmed and voucher shared" : "Hotel confirmed";
  return docs.length ? "Booking confirmed and documents shared" : "Booking confirmed";
}

/**
 * The request's document list after one booking's save: that booking's
 * entries are replaced by `docs`, every other booking's are kept. A request
 * can have several bookings (one per service), and each used to overwrite the
 * whole list. Entries carry the booking they came from (manualBookingId);
 * entries written before that field existed belong to the booking that last
 * synced (meta.manualBookingId) and are tagged with it here.
 */
function mergedBookingDocs(meta: AnyObj, bookingId: string, docs: AnyObj[]): AnyObj[] {
  const legacyOwner = str(meta?.manualBookingId);
  const existing = (Array.isArray(meta?.bookingDocuments) ? meta.bookingDocuments : []).map((d: AnyObj) => ({
    ...d,
    manualBookingId: str(d?.manualBookingId) || legacyOwner,
  }));
  return [...existing.filter((d: AnyObj) => d.manualBookingId !== bookingId), ...docs.map((d) => ({ ...d, manualBookingId: bookingId }))];
}

export type SyncOutcome = "completed" | "documents_updated" | "in_progress" | "none";

/**
 * Called after a manual booking is created, saved or has an attachment added
 * or removed. Never throws (the booking save already succeeded); returns what
 * it did, for the caller's response and for tests.
 */
export async function syncRequestFromManualBooking(booking: AnyObj, actor: AnyObj): Promise<SyncOutcome> {
  const rid = linkedRequestId(booking);
  if (!rid) return "none";
  try {
    const doc: any = await ApprovalRequest.findById(rid).exec();
    if (!doc) return "none";
    const status = str(booking.status).toUpperCase();
    const stage = str(doc.stage).toUpperCase();
    const closed = str(doc.adminState) === "cancelled" || stage === "BOOKING_CANCELLED" || !!doc.meta?.revoked;
    if (closed) return "none";
    const booked = stage === "COMPLETED" || str(doc.adminState) === "done";

    const docs = bookingDocsOf(booking);
    doc.meta = doc.meta || {};
    const merged = mergedBookingDocs(doc.meta, String(booking._id), docs);
    const setDocs = () => {
      doc.meta.manualBookingId = String(booking._id);
      doc.meta.bookingDocuments = merged;
      doc.markModified("meta");
    };

    if (booked) {
      // Already booked: keep the document list in step with the booking
      // (a replaced ticket, a second voucher). No new trail row, no email.
      const ids = (list: AnyObj[]) => JSON.stringify(list.map((d: AnyObj) => `${str(d.manualBookingId)}:${str(d.attachmentId)}`));
      const unchanged = ids(doc.meta.bookingDocuments || []) === ids(merged) &&
        (doc.meta.bookingDocuments || []).every((d: AnyObj) => str(d.manualBookingId));
      if (unchanged && str(doc.meta.manualBookingId) === String(booking._id)) {
        return "none";
      }
      setDocs();
      await doc.save();
      return "documents_updated";
    }

    if (DONE_STATUSES.has(status)) {
      setDocs();
      const pricing = booking.pricing || {};
      const sell = Number(pricing.grandTotal) || Number(pricing.quotedPrice) || undefined;
      const cost = Number(pricing.actualPrice) || undefined;
      await markRequestDone({
        doc,
        admin: {
          sub: str(actor?.sub || actor?._id || actor?.id),
          email: str(actor?.email).toLowerCase(),
          name: str(actor?.name) || [str(actor?.firstName), str(actor?.lastName)].filter(Boolean).join(" "),
        },
        comment: bookedText(booking, docs),
        bookingAmount: sell,
        actualBookingPrice: cost,
        extraAttachments: emailAttachmentsOf(docs),
        service: str(booking.type),
      });
      return "completed";
    }

    if (OPEN_STATUSES.has(status)) {
      let changed = false;
      if (str(doc.meta.manualBookingId) !== String(booking._id)) {
        doc.meta.manualBookingId = String(booking._id);
        doc.markModified("meta");
        changed = true;
      }
      // Not yet in progress (Book Now's start-booking did not land): start it,
      // once — the same row and email start-booking writes.
      const wasInProgress = stage === "BOOKING_IN_PROGRESS";
      if (!wasInProgress) {
        doc.stage = "BOOKING_IN_PROGRESS";
        doc.adminState = "in_progress";
        doc.history = [
          ...(doc.history || []),
          { action: "booking_started", at: new Date(), by: str(actor?.sub || actor?._id) || "admin", userEmail: str(actor?.email).toLowerCase(), ...actorStamp(actor, "staff") },
        ];
        changed = true;
      }
      if (changed) await doc.save();
      if (!wasInProgress) await notifyRequesterProgress(doc, "booking_started");
      return "in_progress";
    }
    return "none";
  } catch (err: any) {
    console.error("[bookingDocuments] request sync failed", rid, err?.message || err);
    return "none";
  }
}
