// apps/backend/src/services/approvalProgress.ts
//
// What happens after approval (Flow 2 and Flow 3), and who hears about it:
//
//   - markRequestDone: the ONE "booking done" path. The ops queue's Mark Done
//     and the proposal page's Done both land here: request COMPLETED, linked
//     proposal booking DONE, and one email to the requester with the
//     approver and Workspace Leaders copied, carrying the booking documents
//     (queue uploads and proposal booking uploads).
//   - notifyRequesterProgress: booking started / on hold with Plumtrips /
//     cancelled.
//   - notifyProposalReady: the requester hears a proposal is ready, with a
//     link to a read-only, price-free view.
//
// Every email here is price-free.

import fs from "fs";
import path from "path";
import Proposal from "../models/Proposal.js";
import TravelBooking from "../models/TravelBooking.js";
import { sendMail } from "../utils/mailer.js";
import { frontendBaseUrl, DISABLE_EMAILS, uniqEmails, stripPriceText } from "../routes/approvals.security.js";
import {
  buildAdminProcessedEmailHtml,
  buildEmailAttachmentsFromMeta,
  sanitizeAdminCommentForEmail,
  buildEmailShell,
  eBtn,
  eCard,
  eLabel,
  escapeHtml,
  pickTripSummary,
} from "../routes/approvals.email.js";
import { activeLeaderEmails, workspaceOf } from "./approvalDecisions.js";

type AnyObj = Record<string, any>;
const norm = (v: any) => String(v ?? "").trim().toLowerCase();
const str = (v: any) => String(v ?? "").trim();

function code(ar: AnyObj) {
  return str(ar?.ticketId) || String(ar?._id || "").slice(-6).toUpperCase();
}

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

  if (Number.isFinite(Number(opts.bookingAmount))) doc.bookingAmount = Number(opts.bookingAmount);
  if (Number.isFinite(Number(opts.actualBookingPrice))) doc.actualBookingPrice = Number(opts.actualBookingPrice);

  doc.adminState = "done";
  doc.stage = "COMPLETED";
  doc.history = Array.isArray(doc.history) ? doc.history : [];
  doc.history.push({ action: "admin_done", at: new Date(), by, comment: comment.trim() || undefined, userEmail: adminEmail, userName: adminName });
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
      proposal.history.push({ action: "BOOKING_DONE", at: new Date(), byEmail: adminEmail, byName: adminName, note: "" });
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
    doc.history.push({ action: "admin_notify_skipped", at: new Date(), by, comment: why, userEmail: adminEmail, userName: adminName });
    await doc.save();
    return { doc, message };
  };
  if (!notify) return skip("NOTIFY_EMAIL not requested", "Marked done (notification skipped)");
  if (DISABLE_EMAILS) return skip("DISABLE_EMAILS enabled — skipped admin notification email.", "Marked done (emails disabled)");

  const to = norm(doc.frontlinerEmail);
  if (!to) {
    doc.history.push({ action: "admin_notify_failed", at: new Date(), by, comment: "Requester email missing; cannot notify.", userEmail: adminEmail, userName: adminName });
    await doc.save();
    return { doc, message: "Marked done (no requester email)" };
  }
  const leaders = await activeLeaderEmails(await workspaceOf(doc), doc);
  const cc = uniqEmails([norm(doc.managerEmail), ...(Array.isArray(doc?.meta?.ccLeaders) ? doc.meta.ccLeaders : []), ...leaders]).filter(
    (e) => e && e !== to,
  );
  const emailAtts = [...buildEmailAttachmentsFromMeta(doc), ...proposalBookingAttachments(proposal)];

  try {
    await (sendMail as any)({
      kind: "CONFIRMATIONS",
      to,
      cc: cc.length ? cc : undefined,
      subject: `Your Booking has been Processed — ${doc.customerName || "Workspace"}${doc.ticketId ? ` (${doc.ticketId})` : ""}`,
      replyTo: adminEmail || undefined,
      html: buildAdminProcessedEmailHtml({
        customerName: doc.customerName || "Workspace",
        ticketId: doc.ticketId,
        requesterEmail: to,
        processedByEmail: adminEmail,
        processedByName: adminName,
        comment: sanitizeAdminCommentForEmail(comment),
        items: Array.isArray(doc.cartItems) ? doc.cartItems : [],
        attachments: emailAtts.map((a) => ({ filename: a.filename || "attachment.pdf" })),
      }),
      attachments: emailAtts.length ? emailAtts : undefined,
    });
    doc.history.push({
      action: "admin_notify_sent",
      at: new Date(),
      by,
      comment: `Notified: to=${to}${cc.length ? ` cc=${cc.join(",")}` : ""}${emailAtts.length ? ` attachments=${emailAtts.length}` : ""}`,
      userEmail: adminEmail,
      userName: adminName,
    });
    await doc.save();
  } catch (e: any) {
    doc.history.push({ action: "admin_notify_failed", at: new Date(), by, comment: `Notify send failed: ${String(e?.message || e)}`, userEmail: adminEmail, userName: adminName });
    await doc.save();
  }
  return { doc, message: "Marked done" };
}

/* ───────────────────────── requester updates ───────────────────────── */

export type ProgressKind = "booking_started" | "ops_on_hold" | "cancelled";

export async function notifyRequesterProgress(ar: AnyObj, kind: ProgressKind, note?: string) {
  if (DISABLE_EMAILS) return;
  const to = norm(ar?.frontlinerEmail);
  if (!to) return;
  const name = str(ar?.frontlinerName) || to.split("@")[0];
  const trip = stripPriceText(pickTripSummary(ar?.cartItems || []).seg);
  const reason = stripPriceText(str(note));
  const base = frontendBaseUrl();
  const copy: Record<ProgressKind, { subject: string; title: string; badge: string; color: string; body: string; cta: [string, string] }> = {
    booking_started: {
      subject: `Booking in progress — ${code(ar)}`,
      title: "We're booking your trip",
      badge: "BOOKING IN PROGRESS",
      color: "#4f46e5",
      body: "Our team has started booking your trip. You will get your tickets and vouchers by email when it is done.",
      cta: ["View My Requests", `${base}/customer/approvals/mine`],
    },
    ops_on_hold: {
      subject: `Your booking is on hold — ${code(ar)}`,
      title: "Booking on hold",
      badge: "ON HOLD",
      color: "#f59e0b",
      body: "Our team has paused the booking for now. We will be in touch, or continue as soon as we can.",
      cta: ["View My Requests", `${base}/customer/approvals/mine`],
    },
    cancelled: {
      subject: `Booking Update — Request Cancelled — ${code(ar)}`,
      title: "Booking Update — Request Cancelled",
      badge: "CANCELLED",
      color: "#dc2626",
      body: "Your travel request has been cancelled by our team.",
      cta: ["Raise a New Request", `${base}/customer/approvals/new`],
    },
  };
  const c = copy[kind];
  try {
    await sendMail({
      kind: "CONFIRMATIONS",
      to,
      subject: c.subject,
      html: buildEmailShell(
        `${eCard(`
          ${eLabel(c.title)}
          <div style="font-size:13px;line-height:1.65;color:#334155;">
            Hi <b style="color:#0f172a;">${escapeHtml(name)}</b>,<br/><br/>
            ${escapeHtml(c.body)}${trip ? `<br/><br/><b style="color:#0f172a;">${escapeHtml(trip)}</b> (${escapeHtml(code(ar))})` : ""}
            ${reason ? `<br/><br/><b style="color:#0f172a;">${kind === "cancelled" ? "Reason" : "Note"}:</b> ${escapeHtml(reason)}` : ""}
          </div>
        `)}
        <div style="margin-top:16px;">${eBtn(c.cta[0], c.cta[1], "#00477f", "#ffffff")}</div>`,
        { title: c.title, badgeText: c.badge, badgeColor: c.color },
      ),
    } as any);
  } catch {
    /* non-blocking */
  }
}

/** The requester hears that a proposal is ready (read-only, price-free view). */
export async function notifyProposalReady(ar: AnyObj, proposal: AnyObj) {
  if (DISABLE_EMAILS) return;
  const to = norm(ar?.frontlinerEmail);
  if (!to) return;
  const name = str(ar?.frontlinerName) || to.split("@")[0];
  const url = `${frontendBaseUrl()}/customer/approvals/proposal/${encodeURIComponent(String(proposal?._id || ""))}`;
  try {
    await sendMail({
      kind: "CONFIRMATIONS",
      to,
      subject: `Your travel proposal is ready — ${code(ar)}`,
      html: buildEmailShell(
        `${eCard(`
          ${eLabel("Proposal ready")}
          <div style="font-size:13px;line-height:1.65;color:#334155;">
            Hi <b style="color:#0f172a;">${escapeHtml(name)}</b>,<br/><br/>
            Our team has prepared a proposal for your trip (${escapeHtml(code(ar))}). It is with your approver now —
            your approver or a Workspace Leader will decide. You can view it below.
          </div>
        `)}
        <div style="margin-top:16px;">${eBtn("View the proposal", url, "#00477f", "#ffffff")}</div>`,
        { title: "Your proposal is ready", badgeText: "PROPOSAL READY", badgeColor: "#4f46e5" },
      ),
    } as any);
  } catch {
    /* non-blocking */
  }
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

