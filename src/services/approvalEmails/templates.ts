// apps/backend/src/services/approvalEmails/templates.ts
//
// Subject + HTML for every event in the email map (map.ts). Pure: no
// database, no sending — services/approvalEmails/dispatch.ts resolves the
// recipients, and src/scripts/render-approval-emails.ts renders every event to
// files for review.
//
// Customer-facing output is price-free (stripPriceText on all free text),
// HTML-escaped, names people (never ids) and shows staff as "Plumtrips Travel
// Desk". Each email with decision links states when they expire.
import type { MailKind } from "../../utils/mailer.js";
import { stripPriceText } from "../../routes/approvals.security.js";
import {
  buildApproverEmailHtml,
  buildRequesterApprovedHtml,
  buildRequestDeclinedEmailHtml,
  buildProposalApprovedEmailHtml,
  buildProposalDeclinedEmailHtml,
  buildAdminProcessedEmailHtml,
  buildEmailShell,
  eBtn,
  eCard,
  eLabel,
  eRow,
  escapeHtml,
  pickTripSummary,
} from "../../routes/approvals.email.js";
import { TRAVEL_DESK_NAME } from "../actorNames.js";
import {
  caseCode,
  decisionLinkUrl,
  deciderInboxUrl,
  deciderProposalsUrl,
  linkExpiryText,
  myRequestsUrl,
  newRequestUrl,
  proposalViewUrl,
  staffCaseUrl,
} from "./links.js";
import type { ApprovalEmailEvent } from "./map.js";

type AnyObj = Record<string, any>;
const str = (v: any) => String(v ?? "").trim();
/** Free text for a customer email: price-stripped, then escaped. */
const clean = (v: any) => escapeHtml(stripPriceText(str(v)));

export type ProposalDecision = "APPROVED" | "DECLINED" | "CHANGES_REQUESTED";

/** Everything a template may need. Only `ar` is always present. */
export type EmailCtx = {
  /** The ApprovalRequest (lean object or document). */
  ar: AnyObj;
  proposal?: AnyObj | null;
  /** Who acted — dropped from FYI recipients. Empty when ops recorded it on behalf. */
  actorEmail?: string;
  /** The name customers see for whoever acted (already TRAVEL_DESK_NAME for staff). */
  actorName?: string;
  /** Decline reason, question, change note… (free text, customer-visible). */
  reason?: string;
  decision?: ProposalDecision;
  /** request_reminder / proposal_reminder: 1, 2 or 3. */
  reminderNo?: number;
  /** clarification_answered: who asked (the reply goes back to them). */
  asker?: string;
  question?: string;
  reply?: string;
  edited?: boolean;
  /** ops_new_case: who auto-allocation assigned it to, if anyone. */
  assignedToName?: string;
  /** case_assigned */
  agent?: { name: string; email: string };
  assignWhy?: string;
  assignNote?: string;
  /** One line per item (route and dates), for staff emails. */
  tripLines?: string[];
  /** booking_done */
  doneComment?: string;
  attachmentNames?: string[];
  /** email_send_failed_alert */
  failure?: { event: string; subject: string; to: string[]; cc: string[]; attempts: number; error: string };
  /** For a stable "expires by" line in rendered samples. */
  now?: Date;
};

export type Rendered = { subject: string; html: string; kind: MailKind };

const customerName = (ar: AnyObj) => str(ar?.customerName) || "your company";
const requesterName = (ar: AnyObj) => str(ar?.frontlinerName) || str(ar?.frontlinerEmail).split("@")[0] || "the requester";
const trip = (ar: AnyObj) => stripPriceText(pickTripSummary(ar?.cartItems || []).seg);
const firstName = (ar: AnyObj) => requesterName(ar);

function para(html: string) {
  return `<div style="font-size:13px;line-height:1.65;color:#334155;">${html}</div>`;
}

function noteBox(text: string) {
  return text
    ? `<div style="margin-top:10px;padding:10px 12px;border-radius:10px;background:#f8fafc;border:1px solid #e2e8f0;white-space:pre-wrap;">${text}</div>`
    : "";
}

function tripLine(ar: AnyObj) {
  const t = trip(ar);
  return t ? `<br/><br/><b style="color:#0f172a;">${escapeHtml(t)}</b> (${escapeHtml(caseCode(ar))})` : ` (${escapeHtml(caseCode(ar))})`;
}

const footerReply = `<div style="margin-top:16px;color:#94a3b8;font-size:12px;line-height:1.6;">Questions? Reply to this email to reach the ${TRAVEL_DESK_NAME}.</div>`;

/* ───────────────────────── request phase ───────────────────────── */

function approverRequestHtml(event: ApprovalEmailEvent, ctx: EmailCtx, recipient: string): string {
  const ar = ctx.ar;
  const id = String(ar?._id || "");
  const notice =
    event === "request_reminder"
      ? `Reminder ${ctx.reminderNo || 1} of 3 — this request is still waiting for a decision.`
      : event === "request_resubmitted"
      ? "The requester resubmitted this request after it was declined."
      : event === "request_resent"
      ? "The requester sent this request to you again."
      : event === "clarification_answered"
      ? `${requesterName(ar)} replied to the question${ctx.edited ? " and edited the request" : ""}.`
      : "";
  const comments =
    event === "clarification_answered"
      ? `Question: ${str(ctx.question)}\nReply${ctx.edited ? " (request edited)" : ""}: ${str(ctx.reply)}`
      : str(ar?.comments);
  return buildApproverEmailHtml({
    requestId: id,
    code: caseCode(ar),
    requesterName: requesterName(ar),
    requesterEmail: "",
    customerName: str(ar?.customerName) || "Workspace",
    ticketId: ar?.ticketId,
    items: Array.isArray(ar?.cartItems) ? ar.cartItems : [],
    comments,
    approveUrl: decisionLinkUrl("request", id, recipient, null, "approve"),
    declineUrl: decisionLinkUrl("request", id, recipient, null, "decline"),
    clarifyUrl: decisionLinkUrl("request", id, recipient, null, "clarify"),
    inboxUrl: deciderInboxUrl(),
    notice,
    expiresText: linkExpiryText(ctx.now),
  });
}

function submitConfirmationHtml(ctx: EmailCtx) {
  const ar = ctx.ar;
  const approver = str(ar?.managerName) && str(ar?.managerName) !== "Approver" ? str(ar.managerName) : "your approver";
  return buildEmailShell(
    `${eCard(`
      ${eLabel("Request received")}
      ${para(`Hi <b style="color:#0f172a;">${escapeHtml(firstName(ar))}</b>,<br/><br/>
        We've received your travel request${tripLine(ar)}. It is with <b style="color:#0f172a;">${escapeHtml(approver)}</b>
        for approval; a Workspace Leader may also decide. We'll email you as soon as it is decided.`)}
    `)}
    <div style="margin-top:16px;">${eBtn("View My Requests", myRequestsUrl(), "#00477f", "#ffffff")}</div>
    ${footerReply}`,
    { title: "We've received your request", badgeText: "AWAITING APPROVAL", badgeColor: "#f59e0b" },
  );
}

function autoApprovedHtml(ctx: EmailCtx) {
  const ar = ctx.ar;
  const direct = ar?.meta?.travelFlow === "APPROVAL_DIRECT";
  return buildEmailShell(
    `${eCard(`
      ${eLabel("Request approved")}
      ${para(`Hi <b style="color:#0f172a;">${escapeHtml(firstName(ar))}</b>,<br/><br/>
        Your travel request${tripLine(ar)} is approved — as a Workspace Leader, nobody else needs to approve it.
        ${direct ? `The ${TRAVEL_DESK_NAME} will now book it.` : `The ${TRAVEL_DESK_NAME} will now prepare a proposal for you.`}`)}
    `)}
    <div style="margin-top:16px;">${eBtn("View My Requests", myRequestsUrl(), "#10b981", "#ffffff")}</div>
    ${footerReply}`,
    { title: "Your request is approved", badgeText: "APPROVED", badgeColor: "#10b981" },
  );
}

function requestApprovedHtml(ctx: EmailCtx) {
  const ar = ctx.ar;
  return buildRequesterApprovedHtml({
    customerName: str(ar?.customerName) || "Workspace",
    ticketId: caseCode(ar),
    requesterName: requesterName(ar),
    requesterEmail: "",
    approverName: str(ctx.actorName),
    approverEmail: "",
    items: Array.isArray(ar?.cartItems) ? ar.cartItems : [],
    travelFlow: ar?.meta?.travelFlow,
  });
}

function requestDeclinedHtml(ctx: EmailCtx) {
  const ar = ctx.ar;
  return buildRequestDeclinedEmailHtml({
    ticketId: caseCode(ar),
    requesterName: requesterName(ar),
    managerName: str(ctx.actorName) || "your approver",
    comment: stripPriceText(str(ctx.reason)),
    loginUrl: myRequestsUrl(),
  });
}

function clarificationAskedHtml(ctx: EmailCtx) {
  const ar = ctx.ar;
  return buildEmailShell(
    `${eCard(`
      ${eLabel("Question from your approver")}
      ${para(`Hi <b style="color:#0f172a;">${escapeHtml(firstName(ar))}</b>,<br/><br/>
        <b style="color:#0f172a;">${escapeHtml(str(ctx.actorName) || "Your approver")}</b> needs more information before deciding on
        your travel request${tripLine(ar)}:
        ${noteBox(clean(ctx.reason))}`)}
    `)}
    <div style="margin-top:16px;">${eBtn("Reply in My Requests", myRequestsUrl(), "#00477f", "#ffffff")}</div>
    <div style="margin-top:12px;color:#94a3b8;font-size:12px;">You can also edit the request before replying. Your reply goes back to whoever asked.</div>
    ${footerReply}`,
    { title: "Your approver has a question", badgeText: "NEEDS YOUR REPLY", badgeColor: "#f59e0b" },
  );
}

/** FYI to the other deciders: request approved/declined, or a proposal decision. */
function decisionFyiHtml(event: ApprovalEmailEvent, ctx: EmailCtx) {
  const ar = ctx.ar;
  const isProposal = event === "proposal_decision_fyi";
  const verb = isProposal
    ? ctx.decision === "APPROVED"
      ? "approved"
      : ctx.decision === "DECLINED"
      ? "declined"
      : "sent back for changes"
    : event === "request_approved_fyi"
    ? "approved"
    : "declined";
  const what = isProposal
    ? `The proposal${ctx.proposal?.version ? ` (v${escapeHtml(String(ctx.proposal.version))})` : ""} for ${escapeHtml(requesterName(ar))}'s request`
    : `${escapeHtml(requesterName(ar))}'s travel request`;
  const color = verb === "approved" ? "#10b981" : verb === "declined" ? "#dc2626" : "#f59e0b";
  return buildEmailShell(
    `${eCard(`
      ${eLabel(`${isProposal ? "Proposal" : "Request"} ${verb}`)}
      ${para(`${what}${tripLine(ar)} was <b>${verb}</b> by <b>${escapeHtml(str(ctx.actorName) || "an approver")}</b>.
        ${ctx.reason ? `<br/><br/><b>Note:</b> ${clean(ctx.reason)}` : ""}
        <br/><br/>No action is needed from you.`)}
    `)}
    <div style="margin-top:16px;">${eBtn("Open Plumbox", deciderInboxUrl(), "#00477f", "#ffffff")}</div>`,
    { title: `${isProposal ? "Proposal" : "Request"} ${verb}`, badgeText: verb.toUpperCase(), badgeColor: color },
  );
}

/* ───────────────────────── ops (staff) ───────────────────────── */

function staffCaseTable(ar: AnyObj, extra: Array<[string, string]> = [], tripLines?: string[]) {
  return `<table cellpadding="0" cellspacing="0" width="100%">
    ${eRow("Request", escapeHtml(caseCode(ar)))}
    ${eRow("Customer", escapeHtml(customerName(ar)))}
    ${eRow("Requested by", escapeHtml(requesterName(ar)))}
    ${eRow("Trip", tripLines?.length ? tripLines.map((l) => escapeHtml(stripPriceText(l))).join("<br/>") : escapeHtml(trip(ar)))}
    ${eRow("Flow", ar?.meta?.travelFlow === "APPROVAL_DIRECT" ? "Flow 3 — book directly" : "Flow 2 — proposal first")}
    ${extra.map(([k, v]) => eRow(k, v)).join("")}
  </table>`;
}

function deskNewCaseHtml(event: ApprovalEmailEvent, ctx: EmailCtx) {
  const ar = ctx.ar;
  const noAgent = event === "ops_no_agent";
  const cancelled = event === "ops_customer_cancelled";
  const auto = ar?.meta?.selfApproved ? "Auto-approved (requester is a Workspace Leader)" : `Approved by ${escapeHtml(str(ctx.actorName) || str(ar?.approvedByName) || "the approver")}`;
  const assigned = noAgent
    ? `<b style="color:#dc2626;">No agent available</b> — auto-allocation found nobody; assign it by hand.`
    : ctx.assignedToName
    ? `Auto-assigned to <b>${escapeHtml(ctx.assignedToName)}</b>`
    : "Unassigned (auto-allocation is off) — pick it up from the queue.";
  return buildEmailShell(
    `${eCard(`
      ${eLabel(cancelled ? "Customer cancelled" : noAgent ? "New case — no agent available" : "New case in the ops queue")}
      ${staffCaseTable(ar, cancelled ? [["Reason", clean(ctx.reason)]] : [["Approval", auto], ["Assignment", assigned]])}
    `)}
    <div style="margin-top:16px;">${eBtn("Open in the ops queue", staffCaseUrl(ar?._id), "#00477f", "#ffffff")}</div>`,
    {
      title: cancelled ? "Customer cancelled" : noAgent ? "Unassigned case" : "New case",
      badgeText: cancelled ? "CANCELLED" : noAgent ? "NO AGENT" : "NEW",
      badgeColor: cancelled || noAgent ? "#dc2626" : "#4f46e5",
    },
  );
}

function assigneeHtml(ctx: EmailCtx) {
  const ar = ctx.ar;
  const agent = ctx.agent || { name: "", email: "" };
  return buildEmailShell(
    `${eCard(`
      ${eLabel("Assigned to you")}
      ${para(`Hi ${escapeHtml(agent.name || "there")},<br/><br/>A travel request has been assigned to you on the ${TRAVEL_DESK_NAME}.`)}
      <div style="margin-top:10px;">${staffCaseTable(ar, [
        ["Why you", escapeHtml(str(ctx.assignWhy) || "Assigned by a colleague")],
        ...(ctx.assignNote ? ([["Note", escapeHtml(str(ctx.assignNote))]] as Array<[string, string]>) : []),
      ], ctx.tripLines)}</div>
    `)}
    <div style="margin-top:16px;">${eBtn("Open in the ops queue", staffCaseUrl(ar?._id), "#00477f", "#ffffff")}</div>`,
    { title: "Case assigned to you", badgeText: "ASSIGNED", badgeColor: "#4f46e5" },
  );
}

function deskProposalOutcomeHtml(ctx: EmailCtx) {
  const ar = ctx.ar;
  const p = ctx.proposal || {};
  const label = ctx.decision === "APPROVED" ? "approved" : ctx.decision === "DECLINED" ? "declined" : "changes requested";
  return buildEmailShell(
    `${eCard(`
      ${eLabel(`Proposal v${escapeHtml(String(p?.version ?? ""))} ${label}`)}
      ${staffCaseTable(ar, [
        ["Decided by", escapeHtml(str(ctx.actorName) || "—")],
        ...(ctx.reason ? ([["Note", escapeHtml(str(ctx.reason))]] as Array<[string, string]>) : []),
        ["Next", ctx.decision === "APPROVED" ? "Start the booking." : ctx.decision === "DECLINED" ? "Talk to the customer; send a revised proposal if wanted." : "Revise the proposal and submit it again."],
      ])}
    `)}
    <div style="margin-top:16px;">${eBtn("Open in the ops queue", staffCaseUrl(ar?._id), "#00477f", "#ffffff")}</div>`,
    {
      title: `Proposal ${label}`,
      badgeText: String(ctx.decision || "").replace("_", " "),
      badgeColor: ctx.decision === "APPROVED" ? "#10b981" : ctx.decision === "DECLINED" ? "#dc2626" : "#f59e0b",
    },
  );
}

export function buildSendFailureAlertHtml(f: {
  event: string;
  subject: string;
  to: string[];
  cc: string[];
  attempts: number;
  error: string;
  caseCode: string;
  customerName: string;
  requestId: string;
}) {
  return buildEmailShell(
    `${eCard(`
      ${eLabel("An email could not be delivered")}
      <table cellpadding="0" cellspacing="0" width="100%">
        ${eRow("Request", escapeHtml(f.caseCode || "—"))}
        ${eRow("Customer", escapeHtml(f.customerName || "—"))}
        ${eRow("Email", escapeHtml(f.event))}
        ${eRow("Subject", escapeHtml(f.subject))}
        ${eRow("To", escapeHtml(f.to.join(", ")))}
        ${f.cc.length ? eRow("CC", escapeHtml(f.cc.join(", "))) : ""}
        ${eRow("Tries", escapeHtml(String(f.attempts)))}
        ${eRow("Last error", escapeHtml(f.error))}
      </table>
      ${para(`<br/>Nobody on the list above has this email. Contact them another way if it matters; the failure is also listed under "Email failures" on the ops queue.`)}
    `)}
    ${f.requestId ? `<div style="margin-top:16px;">${eBtn("Open the case", staffCaseUrl(f.requestId), "#00477f", "#ffffff")}</div>` : ""}`,
    { title: "Email not delivered", badgeText: "SEND FAILED", badgeColor: "#dc2626" },
  );
}

/* ───────────────────────── proposal phase ───────────────────────── */

function lineLabel(li: AnyObj): string {
  const m = li?.meta || {};
  const origin = str(m.origin || li?.from || li?.origin);
  const dest = str(m.destination || li?.to || li?.destination);
  const raw = str(m.tripType || li?.tripType).toLowerCase();
  const tripType = raw === "oneway" ? "One Way" : raw === "roundtrip" ? "Round Trip" : "";
  if (origin && dest) return `${origin} → ${dest}${tripType ? ` (${tripType})` : ""}`;
  return str(li?.title || li?.description || li?.name || li?.category) || "Travel service";
}

/** The proposal's options for customer-side eyes: no prices, every text stripped AND escaped. */
export function proposalOptionsHtml(p: AnyObj): string {
  const options = (Array.isArray(p?.options) ? p.options : [])
    .slice()
    .sort((a: any, b: any) => Number(a?.optionNo || 0) - Number(b?.optionNo || 0));
  if (!options.length) return `<div style="color:#64748b;font-size:13px;">No options</div>`;
  return options
    .map((opt: AnyObj) => {
      const rows = (Array.isArray(opt?.lineItems) ? opt.lineItems : [])
        .map(
          (li: AnyObj) => `<tr>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;color:#0f172a;">${clean(lineLabel(li))}</td>
            <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-size:13px;color:#0f172a;">${escapeHtml(String(Number(li?.qty || 1)))}</td>
          </tr>`,
        )
        .join("");
      const notes = clean(opt?.notes);
      return `<div style="border:1px solid #e8eef6;border-radius:12px;padding:14px;margin-top:12px;">
        <div style="font-weight:800;margin-bottom:6px;font-size:14px;color:#0f172a;">Option ${escapeHtml(String(opt?.optionNo || ""))} — ${clean(opt?.title) || "Option"}</div>
        ${notes ? `<div style="font-size:12px;color:#475569;margin-bottom:6px;">${notes}</div>` : ""}
        <table style="width:100%;border-collapse:collapse;">
          <thead><tr>
            <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #eee;font-size:11px;color:#64748b;">Item</th>
            <th style="text-align:right;padding:6px 8px;border-bottom:1px solid #eee;font-size:11px;color:#64748b;">Qty</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    })
    .join("");
}

function proposalApprovalHtml(event: ApprovalEmailEvent, ctx: EmailCtx, recipient: string) {
  const ar = ctx.ar;
  const p = ctx.proposal || {};
  const pid = String(p?._id || "");
  const approveUrl = decisionLinkUrl("proposal", pid, recipient, null, "approve");
  const declineUrl = decisionLinkUrl("proposal", pid, recipient, null, "decline");
  const changesUrl = decisionLinkUrl("proposal", pid, recipient, null, "request_changes");
  const ctas = approveUrl
    ? `${eBtn("✓ Approve", approveUrl, "#4f46e5", "#ffffff")}
       ${eBtn("✕ Decline", declineUrl, "#ffffff", "#dc2626", "#fca5a5")}
       ${eBtn("Request changes", changesUrl, "#ffffff", "#92400e", "#fcd34d")}
       <div style="margin-top:8px;font-size:12px;color:#64748b;">Each button opens a page where you confirm. ${escapeHtml(linkExpiryText(ctx.now))}</div>`
    : eBtn("Open Plumbox to decide", deciderProposalsUrl(), "#4f46e5", "#ffffff");
  const reminder =
    event === "proposal_reminder"
      ? `<div style="margin-bottom:12px;padding:12px 14px;border:1px solid #fcd34d;background:#fffbeb;border-radius:14px;font-size:14px;font-weight:700;color:#92400e;">Reminder ${escapeHtml(String(ctx.reminderNo || 1))} of 3 — this proposal is still waiting for a decision.</div>`
      : "";
  return buildEmailShell(
    `${reminder}
    ${eCard(`
      <table cellpadding="0" cellspacing="0" width="100%">
        ${eRow("Request", escapeHtml(caseCode(ar)))}
        ${eRow("Requested by", escapeHtml(requesterName(ar)))}
        ${eRow("Trip", escapeHtml(trip(ar)))}
        ${p?.version ? eRow("Proposal", `v${escapeHtml(String(p.version))}`) : ""}
      </table>
    `)}
    <div style="margin-top:14px;">${eLabel("Options")}${proposalOptionsHtml(p)}</div>
    <div style="margin-top:20px;">${ctas}</div>
    <div style="margin-top:16px;font-size:12px;color:#64748b;line-height:1.55;">
      The request's approver and every Workspace Leader receive this. The first decision counts;
      after that the links show who decided. Do not forward this email.
    </div>`,
    { title: "Proposal Approval Needed", subtitle: "Review the proposal and decide", badgeText: "AWAITING APPROVAL", badgeColor: "#f59e0b" },
  );
}

function proposalReadyHtml(ctx: EmailCtx) {
  const ar = ctx.ar;
  return buildEmailShell(
    `${eCard(`
      ${eLabel("Proposal ready")}
      ${para(`Hi <b style="color:#0f172a;">${escapeHtml(firstName(ar))}</b>,<br/><br/>
        The ${TRAVEL_DESK_NAME} has prepared a proposal for your trip${tripLine(ar)}. It is with your approver now —
        your approver or a Workspace Leader will decide. You can view it below.`)}
    `)}
    <div style="margin-top:16px;">${eBtn("View the proposal", proposalViewUrl(ctx.proposal?._id), "#00477f", "#ffffff")}</div>
    ${footerReply}`,
    { title: "Your proposal is ready", badgeText: "PROPOSAL READY", badgeColor: "#4f46e5" },
  );
}

function proposalChangesRequestedHtml(ctx: EmailCtx) {
  const ar = ctx.ar;
  return buildEmailShell(
    `${eCard(`
      ${eLabel("Changes requested")}
      ${para(`Hi <b style="color:#0f172a;">${escapeHtml(firstName(ar))}</b>,<br/><br/>
        <b style="color:#0f172a;">${escapeHtml(str(ctx.actorName) || "Your approver")}</b> asked for changes to the proposal for your trip${tripLine(ar)}.
        The ${TRAVEL_DESK_NAME} will revise it and send it for approval again.
        ${noteBox(clean(ctx.reason))}`)}
    `)}
    <div style="margin-top:16px;">${eBtn("View My Requests", myRequestsUrl(), "#00477f", "#ffffff")}</div>
    ${footerReply}`,
    { title: "Changes requested on your proposal", badgeText: "CHANGES REQUESTED", badgeColor: "#f59e0b" },
  );
}

/* ───────────────────────── booking ───────────────────────── */

function progressHtml(event: ApprovalEmailEvent, ctx: EmailCtx) {
  const ar = ctx.ar;
  const reason = clean(ctx.reason);
  const c =
    event === "booking_started"
      ? { title: "We're booking your trip", badge: "BOOKING IN PROGRESS", color: "#4f46e5", body: "Our team has started booking your trip. You will get your tickets and vouchers by email when it is done.", cta: ["View My Requests", myRequestsUrl()] }
      : event === "booking_on_hold"
      ? { title: "Booking on hold", badge: "ON HOLD", color: "#f59e0b", body: "Our team has paused the booking for now. We will be in touch, or continue as soon as we can.", cta: ["View My Requests", myRequestsUrl()] }
      : { title: "Booking update — request cancelled", badge: "CANCELLED", color: "#dc2626", body: `Your travel request has been cancelled by the ${TRAVEL_DESK_NAME}.`, cta: ["Raise a new request", newRequestUrl()] };
  return buildEmailShell(
    `${eCard(`
      ${eLabel(c.title)}
      ${para(`Hi <b style="color:#0f172a;">${escapeHtml(firstName(ar))}</b>,<br/><br/>
        ${escapeHtml(c.body)}${tripLine(ar)}
        ${reason ? `<br/><br/><b style="color:#0f172a;">${event === "booking_cancelled" ? "Reason" : "Note"}:</b> ${reason}` : ""}`)}
    `)}
    <div style="margin-top:16px;">${eBtn(c.cta[0], c.cta[1], "#00477f", "#ffffff")}</div>
    ${footerReply}`,
    { title: c.title, badgeText: c.badge, badgeColor: c.color },
  );
}

function bookingDoneHtml(ctx: EmailCtx) {
  const ar = ctx.ar;
  return buildAdminProcessedEmailHtml({
    customerName: str(ar?.customerName) || "Workspace",
    ticketId: caseCode(ar),
    requesterEmail: "",
    requesterName: requesterName(ar),
    // Customer email: staff show as the travel desk, never by name or email.
    processedByEmail: "",
    processedByName: TRAVEL_DESK_NAME,
    comment: str(ctx.doneComment),
    items: Array.isArray(ar?.cartItems) ? ar.cartItems : [],
    attachments: (ctx.attachmentNames || []).map((filename) => ({ filename })),
  });
}

/* ───────────────────────── subjects ───────────────────────── */

function subjectFor(event: ApprovalEmailEvent, ctx: EmailCtx): string {
  const ar = ctx.ar;
  const code = caseCode(ar);
  const cust = str(ar?.customerName) || "Workspace";
  const verbP = ctx.decision === "APPROVED" ? "approved" : ctx.decision === "DECLINED" ? "declined" : "sent back for changes";
  switch (event) {
    case "request_submitted_approver":
    case "request_submitted_leaders":
    case "request_resent":
      return `Approval Needed — ${cust} (${code})`;
    case "request_resubmitted":
      return `Approval Needed (Resubmitted) — ${cust} (${code})`;
    case "request_reminder":
      return `Reminder ${ctx.reminderNo || 1} of 3: Approval Needed — ${cust} (${code})`;
    case "clarification_answered":
      return `Reply received — Approval Needed — ${cust} (${code})`;
    case "request_submitted_confirmation":
      return `We've received your travel request — ${code}`;
    case "request_auto_approved":
      return `Request Approved — ${code}`;
    case "request_approved":
      return `Request approved — ${cust} (${code})`;
    case "request_approved_fyi":
      return `Request approved — ${code}`;
    case "request_declined":
      return `Your Travel Request Has Been Declined — ${code}`;
    case "request_declined_fyi":
      return `Request declined — ${code}`;
    case "clarification_asked":
      return `Your approver has a question — ${code}`;
    case "ops_new_case":
      return `New case — ${code} — ${cust}`;
    case "ops_no_agent":
      return `Unassigned — no agent available — ${code} — ${cust}`;
    case "ops_customer_cancelled":
      return `Customer cancelled — ${code} — ${cust}`;
    case "case_assigned":
      return `Assigned to you — ${code} — ${cust}`;
    case "proposal_submitted":
      return `Proposal Approval Needed — ${code}`;
    case "proposal_reminder":
      return `Reminder ${ctx.reminderNo || 1} of 3: Proposal Approval Needed — ${code}`;
    case "proposal_ready":
      return `Your travel proposal is ready — ${code}`;
    case "proposal_approved":
      return `Your Travel Proposal Has Been Approved — ${code}`;
    case "proposal_declined":
      return `Your Travel Proposal Has Been Declined — ${code}`;
    case "proposal_changes_requested":
      return `Changes requested on your travel proposal — ${code}`;
    case "proposal_decision_fyi":
      return `Proposal ${verbP} — ${code}`;
    case "ops_proposal_outcome":
      return `Proposal ${ctx.decision === "CHANGES_REQUESTED" ? "changes requested" : verbP} — ${code} — ${cust}`;
    case "booking_started":
      return `Booking in progress — ${code}`;
    case "booking_on_hold":
      return `Your booking is on hold — ${code}`;
    case "booking_cancelled":
      return `Booking Update — Request Cancelled — ${code}`;
    case "booking_done":
      return `Your Booking has been Processed — ${cust} (${code})`;
    case "email_send_failed_alert":
      return `Email not delivered — ${code} — ${ctx.failure?.subject || ""}`;
  }
}

const KIND: Partial<Record<ApprovalEmailEvent, MailKind>> = {
  request_submitted_approver: "REQUESTS",
  request_submitted_leaders: "REQUESTS",
  request_resent: "REQUESTS",
  request_resubmitted: "REQUESTS",
  request_reminder: "REQUESTS",
  clarification_answered: "REQUESTS",
  proposal_submitted: "REQUESTS",
  proposal_reminder: "REQUESTS",
  request_approved_fyi: "APPROVALS",
  request_declined_fyi: "APPROVALS",
  proposal_decision_fyi: "APPROVALS",
  request_auto_approved: "APPROVALS",
  request_approved: "APPROVALS",
  case_assigned: "APPROVALS",
  ops_new_case: "NOTIFICATIONS",
  ops_no_agent: "NOTIFICATIONS",
  ops_customer_cancelled: "NOTIFICATIONS",
  ops_proposal_outcome: "NOTIFICATIONS",
  email_send_failed_alert: "NOTIFICATIONS",
};

/** Subject, HTML and From-identity of one event for one recipient. */
export function renderApprovalEmail(event: ApprovalEmailEvent, ctx: EmailCtx, recipient = ""): Rendered {
  let html = "";
  switch (event) {
    case "request_submitted_approver":
    case "request_submitted_leaders":
    case "request_resent":
    case "request_resubmitted":
    case "request_reminder":
    case "clarification_answered":
      html = approverRequestHtml(event, ctx, recipient);
      break;
    case "request_submitted_confirmation":
      html = submitConfirmationHtml(ctx);
      break;
    case "request_auto_approved":
      html = autoApprovedHtml(ctx);
      break;
    case "request_approved":
      html = requestApprovedHtml(ctx);
      break;
    case "request_declined":
      html = requestDeclinedHtml(ctx);
      break;
    case "request_approved_fyi":
    case "request_declined_fyi":
    case "proposal_decision_fyi":
      html = decisionFyiHtml(event, ctx);
      break;
    case "clarification_asked":
      html = clarificationAskedHtml(ctx);
      break;
    case "ops_new_case":
    case "ops_no_agent":
    case "ops_customer_cancelled":
      html = deskNewCaseHtml(event, ctx);
      break;
    case "case_assigned":
      html = assigneeHtml(ctx);
      break;
    case "proposal_submitted":
    case "proposal_reminder":
      html = proposalApprovalHtml(event, ctx, recipient);
      break;
    case "proposal_ready":
      html = proposalReadyHtml(ctx);
      break;
    case "proposal_approved":
      html = buildProposalApprovedEmailHtml({ requesterName: requesterName(ctx.ar), ticketId: caseCode(ctx.ar), loginUrl: myRequestsUrl() });
      break;
    case "proposal_declined":
      html = buildProposalDeclinedEmailHtml({ requesterName: requesterName(ctx.ar), ticketId: caseCode(ctx.ar), loginUrl: myRequestsUrl() });
      break;
    case "proposal_changes_requested":
      html = proposalChangesRequestedHtml(ctx);
      break;
    case "ops_proposal_outcome":
      html = deskProposalOutcomeHtml(ctx);
      break;
    case "booking_started":
    case "booking_on_hold":
    case "booking_cancelled":
      html = progressHtml(event, ctx);
      break;
    case "booking_done":
      html = bookingDoneHtml(ctx);
      break;
    case "email_send_failed_alert":
      html = buildSendFailureAlertHtml({
        ...(ctx.failure || { event: "", subject: "", to: [], cc: [], attempts: 0, error: "" }),
        caseCode: caseCode(ctx.ar),
        customerName: customerName(ctx.ar),
        requestId: String(ctx.ar?._id || ""),
      });
      break;
  }
  return { subject: subjectFor(event, ctx), html, kind: KIND[event] || "CONFIRMATIONS" };
}
