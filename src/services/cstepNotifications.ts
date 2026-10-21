// apps/backend/src/services/cstepNotifications.ts
//
// CSTEP Travel & Claim Portal notification emails — the single entry point
// every CSTEP transition calls (routes/cstep.ts). One call:
//
//   1. re-checks cstepEnabled on the request's own workspace (inert otherwise);
//   2. requires the workspace's own CSTEP sender (CstepNotificationSettings,
//      enabled and complete — services/cstepMailTransport.ts); without it
//      nothing is queued, and nothing ever falls back to Plumtrips' mailer;
//   3. resolves the recipient(s) for the event from the traveller's mapping
//      (Approver / Official / Finance user), the request's owner, or the
//      settings' CSTEP Admin addresses;
//   4. claims {logEntryId, recipient} in CstepNotification — the dedupe guard,
//      written BEFORE the send so a repeat call can never send twice;
//   5. renders the email (services/cstepEmailLayout.ts — HTML plus a
//      plain-text part from the same content) and hands it
//      to the existing outbox (services/emailOutbox.ts) as a CSTEP-transport
//      row, which owns retries and sends via the workspace's mailbox.
//
// Dormant unless CSTEP_NOTIFICATIONS_ENABLED is explicitly truthy (default
// off) AND the workspace's own settings are enabled. Never throws: a mail
// problem must not fail the transition that caused it. An unmapped recipient
// is skipped with a log line — no fallback recipient.
//
//   event                    recipient
//   SUBMITTED                Tour Approver   (TravellerProfile.tourApproverId)
//   APPROVED                 Official user   (TravellerProfile.officialUserId) — not for claims
//   CLAIM_APPROVED           CSTEP Admin(s)  (settings.adminRecipients) — a claim's next step
//   RETURN_TO_ADMIN          CSTEP Admin(s)  — Finance sent a claim back
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
import { isClaimFormType } from "../models/cstep/CstepTravelRequest.js";
import { enqueueEmail } from "./emailOutbox.js";
import { renderCstepEmailLayout, type CstepEmailInput, type CstepFact, type CstepStep, type CstepTone } from "./cstepEmailLayout.js";
import { DISABLE_EMAILS, frontendBaseUrl } from "../routes/approvals.security.js";
import { cstepNotificationsEnabled, resolveCstepTransport } from "./cstepMailTransport.js";
import logger from "../utils/logger.js";

export { cstepNotificationsEnabled };

export type CstepNotifyEvent =
  | "SUBMITTED"
  | "APPROVED"
  | "CLAIM_APPROVED"
  | "RETURN_TO_ADMIN"
  | "REPORT_SUBMITTED"
  | "TRANSFERRED_TO_FINANCE"
  | "RETURN"
  | "RETURN_REPORT"
  | "RETURN_TO_OFFICIAL"
  | "REJECTED"
  | "REIMBURSED"
  | "SETTLED"
  | "ARRANGED";

type Role = "APPROVER" | "OFFICIAL" | "FINANCE" | "ADMIN" | "OWNER";

const RECIPIENT: Record<CstepNotifyEvent, Role> = {
  SUBMITTED: "APPROVER",
  APPROVED: "OFFICIAL",
  CLAIM_APPROVED: "ADMIN",
  RETURN_TO_ADMIN: "ADMIN",
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
  /** Rupee amount for TRANSFERRED_TO_FINANCE / REIMBURSED / a recovered SETTLED. */
  amountInr?: number;
  /**
   * Which way the money moves (routes/cstep.ts financeCaseAmount): PAY_OUT —
   * CSTEP pays the traveller; COLLECT — the traveller repays CSTEP. Absent =
   * PAY_OUT for TRANSFERRED_TO_FINANCE, nothing owed for SETTLED.
   */
  direction?: "PAY_OUT" | "COLLECT";
  /** Payment reference for REIMBURSED / a recovered SETTLED. */
  reference?: string;
};

export type CstepNotifyResult =
  | { status: "QUEUED"; recipient: string; recipients: string[]; outboxId: string; outboxStatus: string }
  | { status: "SKIPPED"; reason: string };

const norm = (v: any) => String(v || "").trim().toLowerCase();

async function userEmail(id: any): Promise<string> {
  if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return "";
  const u: any = await User.findById(id).select("email officialEmail").lean();
  return norm(u?.email || u?.officialEmail);
}

async function resolveRecipients(role: Role, traveller: any, request: any, settings: any): Promise<string[]> {
  if (role === "ADMIN") return [...new Set(((settings?.adminRecipients || []) as string[]).map(norm).filter(Boolean))];
  let one = "";
  if (role === "APPROVER") one = await userEmail(traveller?.tourApproverId);
  else if (role === "OFFICIAL") one = await userEmail(traveller?.officialUserId);
  else if (role === "FINANCE") one = await userEmail(traveller?.financeUserId);
  else one = (await userEmail(traveller?.claimedBy)) || norm(traveller?.email) || (await userEmail(request.createdBy));
  return one ? [one] : [];
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

/** What each form is called in an email, and what its reference is called. */
const FORM_LABEL: Record<string, { kind: string; refLabel: string }> = {
  TOUR_PROPOSAL: { kind: "Tour proposal", refLabel: "TIN" },
  EVENT_REQUEST: { kind: "Event request", refLabel: "EVR reference" },
  LOCAL_TRAVEL_CLAIM: { kind: "Local Travel Claim", refLabel: "LTC reference" },
  EXPENSE_CLAIM: { kind: "Expense Claim", refLabel: "EXP reference" },
};
const formLabel = (formType: any) => FORM_LABEL[formType] || FORM_LABEL.TOUR_PROPOSAL;

/** "a tour proposal", "an event request", "an expense claim". */
const withArticle = (s: string) => `${/^[aeiou]/i.test(s) ? "an" : "a"} ${s}`;

function destinationOf(r: any): string {
  if (r.formType === "EVENT_REQUEST" && r.eventLocation) return r.eventLocation;
  const countries = (r.countries || []).map((c: any) => c?.country).filter(Boolean);
  if (countries.length) return countries.join(", ");
  return (r.stations || []).map((s: any) => s?.to).filter(Boolean).join(", ");
}

type Copy = { subject: string; badge: string; tone: CstepTone; headline: string; instruction: string; note?: string };

function copyFor(event: CstepNotifyEvent, who: string, kind: string, claim: boolean, ctx: CstepNotifyCtx): Copy {
  const reason = ctx.reason || "";
  const lower = kind.toLowerCase();
  const collect = ctx.direction === "COLLECT";
  switch (event) {
    case "SUBMITTED":
      return { subject: `${kind} awaiting your approval — ${who}`, badge: "Approval needed", tone: "orange", headline: `${who} has submitted ${withArticle(lower)}`, instruction: "Please review it and approve, return or reject." };
    case "APPROVED":
      return { subject: `${kind} approved — ready to arrange — ${who}`, badge: "Approved", tone: "green", headline: `${who}'s ${lower} is approved`, instruction: "Please arrange the requested services." };
    case "CLAIM_APPROVED":
      return { subject: `${kind} approved — awaiting your verification — ${who}`, badge: "Verify claim", tone: "orange", headline: `${who}'s ${lower} is approved`, instruction: "Please verify the claim and send it on to Finance." };
    case "RETURN_TO_ADMIN":
      return { subject: `${kind} sent back by Finance — ${who}`, badge: "Sent back", tone: "red", headline: `Finance has sent ${who}'s ${lower} back`, instruction: "Please review the claim and verify it again.", note: reason };
    case "REPORT_SUBMITTED":
      return { subject: `Travel report submitted — ${who}`, badge: "Report submitted", tone: "blue", headline: `${who} has submitted their travel report`, instruction: "Please verify it and settle the claim." };
    case "RETURN_TO_OFFICIAL":
      return { subject: `Claim sent back by Finance — ${who}`, badge: "Sent back", tone: "red", headline: `Finance has sent ${who}'s claim back`, instruction: "Please review the settlement and finalize it again.", note: reason };
    case "TRANSFERRED_TO_FINANCE":
      return collect
        ? { subject: `Claim verified — amount to recover — ${who}`, badge: "With Finance", tone: "blue", headline: `${inr(ctx.amountInr)} to be recovered from ${who}`, instruction: "The claim is verified. Please recover the amount from the traveller." }
        : { subject: `Claim ready for reimbursement — ${who}`, badge: "With Finance", tone: "blue", headline: `${inr(ctx.amountInr)} payable to ${who}`, instruction: "The claim is verified. Please process the reimbursement." };
    case "RETURN":
      return { subject: `Your ${lower} was returned`, badge: "Returned", tone: "red", headline: `Your ${lower} needs changes`, instruction: "Please update it and submit it again.", note: reason };
    case "RETURN_REPORT":
      return { subject: "Your travel report was sent back", badge: "Sent back", tone: "red", headline: "Your travel report needs a fix", instruction: "Please correct it and submit it again.", note: reason };
    case "REJECTED":
      return { subject: `Your ${lower} was rejected`, badge: "Rejected", tone: "red", headline: `Your ${lower} was not approved`, instruction: "This request is closed.", note: reason };
    case "REIMBURSED":
      return { subject: `Your ${claim ? lower : "claim"} has been reimbursed`, badge: "Reimbursed", tone: "green", headline: `${inr(ctx.amountInr)} has been reimbursed`, instruction: "Your claim is settled and closed." };
    case "SETTLED":
      if (collect) {
        return { subject: `Your ${claim ? lower : "claim"} is settled`, badge: "Settled", tone: "green", headline: `Your repayment of ${inr(ctx.amountInr)} has been received`, instruction: "Your claim is settled and closed." };
      }
      return claim
        ? { subject: `Your ${lower} is settled`, badge: "Settled", tone: "green", headline: `Your ${lower} is settled`, instruction: "Nothing is due either way on this claim, so it is closed." }
        : { subject: "Your claim is settled", badge: "Settled", tone: "green", headline: "Your claim is settled", instruction: "Nothing is owed on this trip, so it is closed." };
    case "ARRANGED":
      return { subject: "Your travel has been arranged", badge: "Arranged", tone: "green", headline: "Your travel has been arranged", instruction: "After your trip, file your travel report in the portal." };
  }
}

/**
 * The band above the headline: the airport photo on positive events, a plain
 * CSTEP-blue band on corrective ones (returned, sent back, rejected, an
 * amount to recover). Everything else — awaiting a decision, a report in —
 * gets the photo.
 */
function bandFor(event: CstepNotifyEvent, ctx: CstepNotifyCtx): CstepEmailInput["band"] {
  if (["RETURN", "RETURN_REPORT", "RETURN_TO_OFFICIAL", "RETURN_TO_ADMIN", "REJECTED"].includes(event)) return "plain";
  if (event === "TRANSFERRED_TO_FINANCE" && ctx.direction === "COLLECT") return "plain";
  return "photo";
}

/**
 * Who "Dear …," addresses. The traveller's own emails use their name; every
 * other email is one render shared by all its recipients (several CSTEP
 * Admins, say), so it greets the role instead.
 */
const GREETING: Record<Role, string> = {
  OWNER: "",
  APPROVER: "Approver",
  OFFICIAL: "colleague",
  FINANCE: "Finance team",
  ADMIN: "CSTEP Admin",
};

/** The "What happens next?" strip: the recipient's next steps after this email. */
function nextStepsFor(event: CstepNotifyEvent, claim: boolean, ctx: CstepNotifyCtx): CstepStep[] {
  const collect = ctx.direction === "COLLECT";
  switch (event) {
    case "SUBMITTED":
      return [
        { title: "Review", detail: "Open the request and check the details." },
        { title: "Decide", detail: "Approve it, return it with a reason, or reject it." },
        { title: "Traveller informed", detail: "The traveller is emailed your decision." },
      ];
    case "APPROVED":
      return [
        { title: "Arrange", detail: "Book the requested services." },
        { title: "Mark arranged", detail: "Record it in the portal." },
        { title: "Traveller informed", detail: "The traveller is emailed when it is arranged." },
      ];
    case "CLAIM_APPROVED":
    case "RETURN_TO_ADMIN":
      return [
        { title: "Verify", detail: "Check the claim and its bills in the portal." },
        { title: "Send to Finance", detail: "Or return it to the traveller with a reason." },
      ];
    case "REPORT_SUBMITTED":
    case "RETURN_TO_OFFICIAL":
      return [
        { title: "Verify", detail: "Check the travel report and its bills." },
        { title: "Settle", detail: "Finalize the settlement; Finance is told if money moves." },
      ];
    case "TRANSFERRED_TO_FINANCE":
      return collect
        ? [
            { title: "Recover", detail: "Collect the amount from the traveller." },
            { title: "Record", detail: "Enter the receipt reference in the portal to close the claim." },
          ]
        : [
            { title: "Pay", detail: "Process the reimbursement to the traveller." },
            { title: "Record", detail: "Enter the payment reference in the portal to close the claim." },
          ];
    case "RETURN":
    case "RETURN_REPORT":
      return [
        { title: "Open", detail: `Open your ${event === "RETURN_REPORT" ? "travel report" : "request"} in the portal.` },
        { title: "Update", detail: "Make the changes the reason asks for." },
        { title: "Submit again", detail: "It goes back for review." },
      ];
    case "REJECTED":
      return [{ title: "Closed", detail: "No further action is possible on this request. File a new one if you still need it." }];
    case "ARRANGED":
      return [
        { title: "Travel", detail: "Your bookings are in the portal." },
        { title: "File your report", detail: "After the trip, submit your travel report with bills." },
      ];
    case "REIMBURSED":
    case "SETTLED":
      return [{ title: "Nothing more to do", detail: `This ${claim ? "claim" : "trip's claim"} is settled and closed.` }];
  }
}

export function renderCstepEmail(event: CstepNotifyEvent, request: any, traveller: any, ctx: CstepNotifyCtx, orgLabel = "CSTEP", contactEmail = "") {
  const org = orgLabel || "CSTEP";
  const who = [traveller?.firstName, traveller?.lastName].filter(Boolean).join(" ").trim() || "A traveller";
  const { kind, refLabel } = formLabel(request.formType);
  const claim = isClaimFormType(request.formType);
  const c = copyFor(event, who, kind, claim, ctx);

  const dates = [fmtDate(request.departureDate), fmtDate(request.returnDate)].filter(Boolean).join(" – ");
  const destination = destinationOf(request);
  const claimed = claim ? Number(request.claimTotals?.gross || 0) : 0;
  // Plain text: the layout escapes for the HTML part and reuses it for the text part.
  const facts: CstepFact[] = [
    { label: "Traveller", value: who },
    { label: "Request", value: kind },
    { label: request.formType === "EVENT_REQUEST" ? "Event" : "Purpose", value: request.purpose || "—" },
    // A claim has no destination of its own; its amount stands in.
    ...(claim ? (claimed ? [{ label: "Amount claimed", value: inr(claimed) }] : []) : [{ label: "Destination", value: destination || "—" }]),
    ...(dates ? [{ label: "Dates", value: dates }] : []),
    ...(request.claimReference ? [{ label: refLabel, value: String(request.claimReference) }] : []),
    ...(ctx.reference ? [{ label: "Payment reference", value: String(ctx.reference) }] : []),
  ];
  const href = `${frontendBaseUrl()}/cstep/requests/${String(request._id)}`;
  const role = RECIPIENT[event];

  const { html, text } = renderCstepEmailLayout({
    title: c.subject,
    preheader: c.instruction,
    band: bandFor(event, ctx),
    hero: { badge: c.badge, tone: c.tone, headline: c.headline },
    greeting: role === "OWNER" ? (who === "A traveller" ? "traveller" : who) : GREETING[role],
    intro: c.instruction,
    facts,
    note: c.note ? { label: "Reason", text: c.note } : undefined,
    cta: { label: "Open request", href },
    nextSteps: nextStepsFor(event, claim, ctx),
    contactEmail,
  });
  return { subject: `[${org}] ${c.subject}`, html, text };
}

/* ───────────────────────── entry point ───────────────────────── */

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

    const transport = await resolveCstepTransport(request.workspaceId);
    if (transport.ok === false) return skip(transport.reason);

    const traveller: any = await TravellerProfile.findOne({
      _id: request.travelerProfileId,
      workspaceId: request.workspaceId,
    })
      .select("firstName lastName email claimedBy tourApproverId officialUserId financeUserId")
      .lean();

    const role = RECIPIENT[event];
    const recipients = await resolveRecipients(role, traveller, request, transport.settings);
    if (!recipients.length) return skip(`no ${role.toLowerCase()} email mapped`);

    const { subject, html, text } = renderCstepEmail(event, request, traveller, ctx, transport.orgLabel, transport.contactEmail);
    const queued: Array<{ recipient: string; id: string; status: string }> = [];
    for (const recipient of recipients) {
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
        if (err?.code === 11000) {
          logger.info("[CSTEP notify] skipped", { event, requestId: String(request._id), reason: `already notified ${recipient} for this log entry` });
          continue;
        }
        throw err;
      }

      const r = await enqueueEmail({
        event: `cstep_${event.toLowerCase()}`,
        kind: "NOTIFICATIONS",
        transport: "CSTEP",
        workspaceId: request.workspaceId,
        from: transport.from,
        replyTo: transport.replyTo,
        to: [recipient],
        subject,
        html,
        text,
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
      queued.push({ recipient, id: r.id, status: r.status });
    }
    if (!queued.length) return skip(`already notified ${recipients.join(", ")} for this log entry`);
    return {
      status: "QUEUED",
      recipient: queued[0].recipient,
      recipients: queued.map((q) => q.recipient),
      outboxId: queued[0].id,
      outboxStatus: queued[0].status,
    };
  } catch (err: any) {
    logger.error("[CSTEP notify] failed", { event, requestId: String(request?._id || ""), error: err?.message });
    return { status: "SKIPPED", reason: `error: ${err?.message}` };
  }
}
