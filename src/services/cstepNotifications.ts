// apps/backend/src/services/cstepNotifications.ts
//
// CSTEP Travel & Claim Portal notification emails — the single entry point
// every CSTEP transition calls (routes/cstep.ts). One call:
//
//   1. re-checks cstepEnabled on the request's own workspace (inert otherwise);
//   2. resolves the one recipient for the event from the traveller's mapping
//      (Approver / Official / Finance user) or the request's owner;
//   3. claims {logEntryId, recipient} in CstepNotification — the dedupe guard,
//      written BEFORE the send so a repeat call can never send twice;
//   4. renders the email (approvalEmails/layout, footer "cstep") and hands it
//      to the existing outbox (services/emailOutbox.ts), which owns retries.
//
// Dormant unless CSTEP_NOTIFICATIONS_ENABLED is explicitly truthy (default off).
// Never throws: a mail problem must not fail the transition that caused it.
// An unmapped recipient is skipped with a log line — no fallback recipient.
//
//   event                    recipient
//   SUBMITTED                Tour Approver   (TravellerProfile.tourApproverId)
//   APPROVED                 Official user   (TravellerProfile.officialUserId)
//   REPORT_SUBMITTED         Official user
//   RETURN_TO_OFFICIAL       Official user
//   TRANSFERRED_TO_FINANCE   Finance user    (TravellerProfile.financeUserId)
//   RETURN, RETURN_REPORT,   owner — the traveller: claimedBy User's email →
//   REJECTED, REIMBURSED,      TravellerProfile.email → the request creator's
//   SETTLED, ARRANGED          email, first one present
import mongoose from "mongoose";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import TravellerProfile from "../models/TravellerProfile.js";
import User from "../models/User.js";
import { CstepNotification } from "../models/cstep/index.js";
import { enqueueEmail } from "./emailOutbox.js";
import { renderLayout, factsGrid, noteBox, buttonGroup, para, type Hero, type Fact } from "./approvalEmails/layout.js";
import { escapeHtml } from "../routes/approvals.email.js";
import { DISABLE_EMAILS, frontendBaseUrl } from "../routes/approvals.security.js";
import { CSTEP_NOTIFICATION_FROM, cstepOrgLabel } from "../config/cstepNotification.js";
import logger from "../utils/logger.js";

export type CstepNotifyEvent =
  | "SUBMITTED"
  | "APPROVED"
  | "REPORT_SUBMITTED"
  | "TRANSFERRED_TO_FINANCE"
  | "RETURN"
  | "RETURN_REPORT"
  | "RETURN_TO_OFFICIAL"
  | "REJECTED"
  | "REIMBURSED"
  | "SETTLED"
  | "ARRANGED";

type Role = "APPROVER" | "OFFICIAL" | "FINANCE" | "OWNER";

const RECIPIENT: Record<CstepNotifyEvent, Role> = {
  SUBMITTED: "APPROVER",
  APPROVED: "OFFICIAL",
  REPORT_SUBMITTED: "OFFICIAL",
  RETURN_TO_OFFICIAL: "OFFICIAL",
  TRANSFERRED_TO_FINANCE: "FINANCE",
  RETURN: "OWNER",
  RETURN_REPORT: "OWNER",
  REJECTED: "OWNER",
  REIMBURSED: "OWNER",
  SETTLED: "OWNER",
  ARRANGED: "OWNER",
};

export type CstepNotifyCtx = {
  /** The CstepApproval entry the transition wrote — the dedupe key. */
  logEntryId: any;
  /** Return / reject / send-back reason. */
  reason?: string;
  /** Rupee amount for TRANSFERRED_TO_FINANCE / REIMBURSED. */
  amountInr?: number;
  /** Payment reference for REIMBURSED. */
  reference?: string;
};

export type CstepNotifyResult =
  | { status: "QUEUED"; recipient: string; outboxId: string; outboxStatus: string }
  | { status: "SKIPPED"; reason: string };

const norm = (v: any) => String(v || "").trim().toLowerCase();

async function userEmail(id: any): Promise<string> {
  if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return "";
  const u: any = await User.findById(id).select("email officialEmail").lean();
  return norm(u?.email || u?.officialEmail);
}

async function resolveRecipient(role: Role, traveller: any, request: any): Promise<string> {
  if (role === "APPROVER") return userEmail(traveller?.tourApproverId);
  if (role === "OFFICIAL") return userEmail(traveller?.officialUserId);
  if (role === "FINANCE") return userEmail(traveller?.financeUserId);
  return (await userEmail(traveller?.claimedBy)) || norm(traveller?.email) || (await userEmail(request.createdBy));
}

/* ───────────────────────── content ───────────────────────── */

const fmtDate = (d?: string) => {
  if (!d) return "";
  const t = new Date(`${d}T00:00:00Z`);
  return Number.isNaN(t.getTime())
    ? d
    : t.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};
const inr = (n?: number) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

function destinationOf(r: any): string {
  if (r.formType === "EVENT_REQUEST" && r.eventLocation) return r.eventLocation;
  const countries = (r.countries || []).map((c: any) => c?.country).filter(Boolean);
  if (countries.length) return countries.join(", ");
  return (r.stations || []).map((s: any) => s?.to).filter(Boolean).join(", ");
}

type Copy = { subject: string; badge: string; tone: Hero["tone"]; headline: string; instruction: string; note?: string };

function copyFor(event: CstepNotifyEvent, who: string, kind: string, ctx: CstepNotifyCtx): Copy {
  const reason = ctx.reason || "";
  switch (event) {
    case "SUBMITTED":
      return { subject: `${kind} awaiting your approval — ${who}`, badge: "Approval needed", tone: "orange", headline: `${who} has submitted a ${kind.toLowerCase()}`, instruction: "Please review it and approve, return or reject." };
    case "APPROVED":
      return { subject: `${kind} approved — ready to arrange — ${who}`, badge: "Approved", tone: "green", headline: `${who}'s ${kind.toLowerCase()} is approved`, instruction: "Please arrange the requested services." };
    case "REPORT_SUBMITTED":
      return { subject: `Travel report submitted — ${who}`, badge: "Report submitted", tone: "blue", headline: `${who} has submitted their travel report`, instruction: "Please verify it and settle the claim." };
    case "RETURN_TO_OFFICIAL":
      return { subject: `Claim sent back by Finance — ${who}`, badge: "Sent back", tone: "red", headline: `Finance has sent ${who}'s claim back`, instruction: "Please review the settlement and finalize it again.", note: reason };
    case "TRANSFERRED_TO_FINANCE":
      return { subject: `Claim ready for reimbursement — ${who}`, badge: "With Finance", tone: "blue", headline: `${inr(ctx.amountInr)} is owed to ${who}`, instruction: "The claim is verified. Please process the reimbursement." };
    case "RETURN":
      return { subject: `Your ${kind.toLowerCase()} was returned`, badge: "Returned", tone: "red", headline: `Your ${kind.toLowerCase()} needs changes`, instruction: "Please update it and submit it again.", note: reason };
    case "RETURN_REPORT":
      return { subject: "Your travel report was sent back", badge: "Sent back", tone: "red", headline: "Your travel report needs a fix", instruction: "Please correct it and submit it again.", note: reason };
    case "REJECTED":
      return { subject: `Your ${kind.toLowerCase()} was rejected`, badge: "Rejected", tone: "red", headline: `Your ${kind.toLowerCase()} was not approved`, instruction: "This request is closed.", note: reason };
    case "REIMBURSED":
      return { subject: "Your claim has been reimbursed", badge: "Reimbursed", tone: "green", headline: `${inr(ctx.amountInr)} has been reimbursed`, instruction: "Your claim is settled and closed." };
    case "SETTLED":
      return { subject: "Your claim is settled", badge: "Settled", tone: "green", headline: "Your claim is settled", instruction: "Nothing is owed on this trip, so it is closed." };
    case "ARRANGED":
      return { subject: "Your travel has been arranged", badge: "Arranged", tone: "green", headline: "Your travel has been arranged", instruction: "After your trip, file your travel report in the portal." };
  }
}

export function renderCstepEmail(event: CstepNotifyEvent, request: any, traveller: any, ctx: CstepNotifyCtx) {
  const org = cstepOrgLabel();
  const who = [traveller?.firstName, traveller?.lastName].filter(Boolean).join(" ").trim() || "A traveller";
  const kind = request.formType === "EVENT_REQUEST" ? "Event request" : "Tour proposal";
  const c = copyFor(event, who, kind, ctx);

  const dates = [fmtDate(request.departureDate), fmtDate(request.returnDate)].filter(Boolean).join(" – ");
  const facts: Fact[] = [
    { label: "Traveller", value: escapeHtml(who) },
    { label: "Request", value: escapeHtml(kind) },
    { label: request.formType === "EVENT_REQUEST" ? "Event" : "Purpose", value: escapeHtml(request.purpose || "—") },
    { label: "Destination", value: escapeHtml(destinationOf(request) || "—") },
    ...(dates ? [{ label: "Dates", value: escapeHtml(dates) }] : []),
    ...(request.claimReference ? [{ label: "TIN", value: escapeHtml(request.claimReference) }] : []),
    ...(ctx.reference ? [{ label: "Payment reference", value: escapeHtml(ctx.reference) }] : []),
  ];
  const href = `${frontendBaseUrl()}/cstep/requests/${String(request._id)}`;

  const html = renderLayout({
    title: c.subject,
    preheader: c.instruction,
    hero: { badge: escapeHtml(c.badge), tone: c.tone, headline: escapeHtml(c.headline), instruction: escapeHtml(c.instruction) },
    blocks: [
      factsGrid(facts),
      c.note ? noteBox("Reason", escapeHtml(c.note)) : "",
      buttonGroup({ label: "Open request", href }),
      para(`Or open <a href="${escapeHtml(href)}" style="color:#00477f;">${escapeHtml(href)}</a>`),
    ],
    footer: "cstep",
    orgLabel: org,
  });
  return { subject: `[${org}] ${c.subject}`, html };
}

/* ───────────────────────── entry point ───────────────────────── */

/**
 * Master switch, OFF unless CSTEP_NOTIFICATIONS_ENABLED is explicitly truthy
 * (true / 1 / yes / on). The module deploys dormant and is switched on once
 * CSTEP's sender (config/cstepNotification.ts) is confirmed. Read per call,
 * so flipping the env var needs no code change.
 */
export function cstepNotificationsEnabled(): boolean {
  return ["true", "1", "yes", "on"].includes(String(process.env.CSTEP_NOTIFICATIONS_ENABLED || "").trim().toLowerCase());
}

export async function notifyCstep(event: CstepNotifyEvent, request: any, ctx: CstepNotifyCtx): Promise<CstepNotifyResult> {
  const skip = (reason: string): CstepNotifyResult => {
    logger.info("[CSTEP notify] skipped", { event, requestId: String(request?._id || ""), reason });
    return { status: "SKIPPED", reason };
  };
  try {
    if (!cstepNotificationsEnabled()) return skip("CSTEP_NOTIFICATIONS_ENABLED is off");
    if (DISABLE_EMAILS) return skip("emails disabled");
    if (!request?._id || !request?.workspaceId || !ctx?.logEntryId) return skip("missing request or log entry");

    const ws: any = await CustomerWorkspace.findById(request.workspaceId)
      .select("config.features.cstepEnabled companyName name")
      .lean();
    if (ws?.config?.features?.cstepEnabled !== true) return skip("workspace is not cstepEnabled");

    const traveller: any = await TravellerProfile.findOne({
      _id: request.travelerProfileId,
      workspaceId: request.workspaceId,
    })
      .select("firstName lastName email claimedBy tourApproverId officialUserId financeUserId")
      .lean();

    const role = RECIPIENT[event];
    const recipient = await resolveRecipient(role, traveller, request);
    if (!recipient) return skip(`no ${role.toLowerCase()} email mapped`);

    let claim: any;
    try {
      claim = await CstepNotification.create({
        workspaceId: request.workspaceId,
        requestId: request._id,
        logEntryId: ctx.logEntryId,
        event,
        recipient,
      });
    } catch (err: any) {
      if (err?.code === 11000) return skip(`already notified ${recipient} for this log entry`);
      throw err;
    }

    const { subject, html } = renderCstepEmail(event, request, traveller, ctx);
    const r = await enqueueEmail({
      event: `cstep_${event.toLowerCase()}`,
      kind: "NOTIFICATIONS",
      from: CSTEP_NOTIFICATION_FROM,
      to: [recipient],
      subject,
      html,
      requestId: request._id,
      caseCode: request.claimReference || "",
      customerName: ws?.companyName || ws?.name || "",
      onSent: null,
      onFailed: null,
    });
    await CstepNotification.updateOne(
      { _id: claim._id, workspaceId: request.workspaceId },
      { $set: { status: r.status, outboxId: new mongoose.Types.ObjectId(r.id) } },
    );
    return { status: "QUEUED", recipient, outboxId: r.id, outboxStatus: r.status };
  } catch (err: any) {
    logger.error("[CSTEP notify] failed", { event, requestId: String(request?._id || ""), error: err?.message });
    return { status: "SKIPPED", reason: `error: ${err?.message}` };
  }
}
