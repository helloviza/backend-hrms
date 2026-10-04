// apps/backend/src/services/approvalProgress.ts
//
// What happens after approval (Flow 2 and Flow 3), and who hears about it:
//
//   - markRequestDone: the ONE "booking done" path. The ops queue's Mark Done
//     and the proposal page's Done both land here: request COMPLETED, linked
//     proposal booking DONE, and one email to the requester with the
//     approver and Workspace Leaders copied, carrying the booking documents
//     (queue uploads and proposal booking uploads). "Notified" is recorded
//     only once that email is actually sent (the outbox retries a failure).
//   - notifyRequesterProgress: booking started / on hold with Plumtrips /
//     cancelled.
//   - notifyProposalReady: the requester hears a proposal is ready, with a
//     link to a read-only, price-free view.
//
// Recipients for all of these are in the email map (approvalEmails/map.ts).
// Every email here is price-free.

import { actorStamp, userNames } from "./actorNames.js";
import fs from "fs";
import path from "path";
import ApprovalRequest from "../models/ApprovalRequest.js";
import Proposal from "../models/Proposal.js";
import TravelBooking from "../models/TravelBooking.js";
import { DISABLE_EMAILS } from "../routes/approvals.security.js";
import { buildEmailAttachmentsFromMeta, sanitizeAdminCommentForEmail } from "../routes/approvals.email.js";
import { notifySafely, recipientsFor } from "./approvalEmails/dispatch.js";

type AnyObj = Record<string, any>;
const norm = (v: any) => String(v ?? "").trim().toLowerCase();
const str = (v: any) => String(v ?? "").trim();

/* ───────────────────────── booking done ───────────────────────── */

/** Booking documents uploaded on the proposal page, as mail attachments. */
function proposalBookingAttachments(p: AnyObj | null) {
  const out: Array<{ filename: string; path: string; contentType?: string }> = [];
  for (const u of Array.isArray(p?.booking?.attachments) ? p!.booking.attachments : []) {
    const m = String(u || "").match(/[?&]path=([^&]+)/);
    if (!m) continue;
    let rel = "";
    try {
      rel = decodeURIComponent(m[1]).replace(/\\/g, "/");
    } catch {
      continue;
    }
    if (!rel.startsWith("proposals/")) continue;
    const root = path.resolve(process.cwd(), "uploads");
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs)) continue;
    out.push({ filename: path.basename(abs).replace(/^\d+_/, ""), path: abs, contentType: "application/pdf" });
  }
  return out;
}

export async function markRequestDone(opts: {
  doc: any; // ApprovalRequest document (not lean)
  admin: { sub?: string; email: string; name: string };
  comment?: string;
  notifyEmail?: any;
  bookingAmount?: any;
  actualBookingPrice?: any;
}): Promise<{ doc: any; message: string }> {
  const { doc, admin } = opts;
  const comment = String(opts.comment || "");
  const adminEmail = norm(admin.email);
  const adminName = str(admin.name);
  const by = admin.sub || "unknown";
  const staffActor = actorStamp({ sub: admin.sub, name: adminName }, "staff");

  if (Number.isFinite(Number(opts.bookingAmount))) doc.bookingAmount = Number(opts.bookingAmount);
  if (Number.isFinite(Number(opts.actualBookingPrice))) doc.actualBookingPrice = Number(opts.actualBookingPrice);

  doc.adminState = "done";
  doc.stage = "COMPLETED";
  doc.history = Array.isArray(doc.history) ? doc.history : [];
  doc.history.push({ action: "admin_done", at: new Date(), by, comment: comment.trim() || undefined, userEmail: adminEmail, userName: adminName, ...staffActor });
  await doc.save();

  // The linked proposal (latest version) is done too.
  let proposal: any = null;
  try {
    proposal = await Proposal.findOne({ requestId: doc._id }).sort({ version: -1 }).exec();
    if (proposal) {
      proposal.booking = proposal.booking || {};
      proposal.booking.status = "DONE";
      proposal.booking.doneAt = new Date();
      proposal.booking.doneByEmail = adminEmail;
      proposal.booking.doneByName = adminName;
      if (Number.isFinite(Number(opts.bookingAmount))) proposal.booking.bookingAmount = Number(opts.bookingAmount);
      if (Number.isFinite(Number(opts.actualBookingPrice))) proposal.booking.actualBookingPrice = Number(opts.actualBookingPrice);
      proposal.history = Array.isArray(proposal.history) ? proposal.history : [];
      proposal.history.push({ action: "BOOKING_DONE", at: new Date(), byEmail: adminEmail, byName: adminName, note: "", ...staffActor });
      proposal.markModified?.("booking");
      await proposal.save();
    }
  } catch {
    /* non-blocking */
  }

  // Concierge booking record (unchanged behaviour of the queue's Mark Done).
  try {
    const serviceMatch = comment.match(/\[SERVICE:(\w+)\]/i);
    const amountMatch = comment.match(/\[BOOKING_AMOUNT:(\d+(?:\.\d+)?)\]/i);
    if (serviceMatch && amountMatch) {
      const service = serviceMatch[1].toUpperCase();
      const amount = parseFloat(amountMatch[1]);
      if (["FLIGHT", "HOTEL", "VISA", "CAB", "FOREX", "ESIM", "HOLIDAY", "MICE"].includes(service) && amount > 0) {
        await TravelBooking.findOneAndUpdate(
          { reference: doc._id },
          {
            tenantId: doc.customerId || "default",
            service,
            amount,
            userId: doc.frontlinerId,
            status: "CONFIRMED",
            source: "CONCIERGE",
            reference: doc._id,
            referenceModel: "ApprovalRequest",
            bookedAt: new Date(),
            metadata: { approvalId: doc._id },
          },
          { upsert: true, new: true },
        );
      }
    }
  } catch {
    /* non-blocking */
  }

  const notify = !(opts.notifyEmail === false || opts.notifyEmail === "false" || opts.notifyEmail === 0 || opts.notifyEmail === "0");
  const skip = async (why: string, message: string) => {
    doc.history.push({ action: "admin_notify_skipped", at: new Date(), by, comment: why, userEmail: adminEmail, userName: adminName, ...staffActor });
    await doc.save();
    return { doc, message };
  };
  if (!notify) return skip("NOTIFY_EMAIL not requested", "Marked done (notification skipped)");
  if (DISABLE_EMAILS) return skip("DISABLE_EMAILS enabled — skipped admin notification email.", "Marked done (emails disabled)");

  const to = norm(doc.frontlinerEmail);
  if (!to) {
    doc.history.push({ action: "admin_notify_failed", at: new Date(), by, comment: "Requester email missing; cannot notify.", userEmail: adminEmail, userName: adminName, ...staffActor });
    await doc.save();
    return { doc, message: "Marked done (no requester email)" };
  }
  const emailAtts = [...buildEmailAttachmentsFromMeta(doc), ...proposalBookingAttachments(proposal)];
  // The requester's profile name (services/actorNames.ts), else the stored name.
  const requesterLookup = await userNames([doc.frontlinerId, to]);
  const requesterName =
    requesterLookup.get(String(doc.frontlinerId || "")) || requesterLookup.get(to) || str(doc.frontlinerName);

  const ctx = {
    ar: { ...doc.toObject(), frontlinerName: requesterName || doc.frontlinerName },
    doneComment: sanitizeAdminCommentForEmail(comment),
    attachmentNames: emailAtts.map((a) => a.filename || "attachment.pdf"),
  };
  const who = await recipientsFor("booking_done", ctx);
  const row = { by, userEmail: adminEmail, userName: adminName, ...staffActor };
  const sent = await notifySafely("booking_done", ctx, {
    attachments: emailAtts,
    // Pushed by the outbox only when the email is actually sent / finally fails.
    onSent: {
      action: "admin_notify_sent",
      ...row,
      comment: `Notified: to=${who.to.join(",")}${who.cc.length ? ` cc=${who.cc.join(",")}` : ""}${emailAtts.length ? ` attachments=${emailAtts.length}` : ""}`,
    },
    onFailed: { action: "admin_notify_failed", ...row, comment: "Booking email could not be delivered after retries" },
  });

  let message = "Marked done";
  if (!sent || sent.skipped === "no-recipients") {
    await ApprovalRequest.updateOne(
      { _id: doc._id },
      { $push: { history: { action: "admin_notify_skipped", at: new Date(), ...row, comment: "No active recipient to notify." } } },
    ).exec();
    message = "Marked done (nobody to notify)";
  } else if (!sent.delivered) {
    await ApprovalRequest.updateOne(
      { _id: doc._id },
      { $push: { history: { action: "admin_notify_queued", at: new Date(), ...row, comment: "Booking email failed to send; retrying automatically." } } },
    ).exec();
    message = "Marked done (email will be retried)";
  }
  // History rows above were written by the outbox / updateOne: return the stored request.
  const fresh = await ApprovalRequest.findById(doc._id).exec();
  return { doc: fresh || doc, message };
}

/**
 * Why a case can't be cancelled (already cancelled, declined or revoked), or
 * null. The queue's cancel and the proposal page's cancel both check it, so a
 * closed case is never cancelled — or its requester emailed — twice.
 */
export function closedCaseRefusal(doc: AnyObj): { error: string; code: string } | null {
  if (str(doc?.adminState) === "cancelled" || str(doc?.stage).toUpperCase() === "BOOKING_CANCELLED") {
    return { error: "This request is already cancelled.", code: "ALREADY_CANCELLED" };
  }
  if (doc?.meta?.revoked || str(doc?.status).toLowerCase() === "declined") {
    return { error: "This request was declined or revoked; there is nothing to cancel.", code: "NOT_CANCELLABLE" };
  }
  return null;
}

/* ───────────────────────── requester updates ───────────────────────── */

export type ProgressKind = "booking_started" | "ops_on_hold" | "cancelled";

const PROGRESS_EVENT = {
  booking_started: "booking_started",
  ops_on_hold: "booking_on_hold",
  cancelled: "booking_cancelled",
} as const;

export async function notifyRequesterProgress(ar: AnyObj, kind: ProgressKind, note?: string) {
  await notifySafely(PROGRESS_EVENT[kind], { ar, reason: str(note) });
}

/** The requester hears that a proposal is ready (read-only, price-free view). */
export async function notifyProposalReady(ar: AnyObj, proposal: AnyObj) {
  await notifySafely("proposal_ready", { ar, proposal });
}

/** Requester's own requests: the latest submitted-or-later proposal per request. */
export async function latestProposalsFor(requestIds: any[]) {
  if (!requestIds.length) return new Map<string, AnyObj>();
  const rows: any[] = await Proposal.aggregate([
    { $match: { requestId: { $in: requestIds }, status: { $ne: "DRAFT" } } },
    { $sort: { requestId: 1, version: -1 } },
    { $group: { _id: "$requestId", id: { $first: "$_id" }, status: { $first: "$status" }, version: { $first: "$version" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { id: String(r.id), status: r.status, version: r.version }]));
}

