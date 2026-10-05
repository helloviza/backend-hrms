// apps/backend/src/services/approvalEmails/templates.ts
//
// Subject + HTML for every event in the email map (map.ts). Pure: no
// database, no sending — services/approvalEmails/dispatch.ts resolves the
// recipients, and src/scripts/render-approval-emails.ts renders every event to
// files for review.
//
// Every email is the one layout (layout.ts) in the same order — header, hero,
// summary strip, trip summary, note, itinerary, buttons, expiry box, footer —
// so each template below only says WHAT goes in it.
//
// Customer-facing output is price-free (stripPriceText on all free text),
// HTML-escaped, names people (never ids) and shows staff as "Plumtrips Travel
// Desk". Each email with decision links states when they expire.
import type { MailKind } from "../../utils/mailer.js";
import { stripPriceText } from "../../routes/approvals.security.js";
import { escapeHtml, sanitizeAdminCommentForEmail } from "../../routes/approvals.email.js";
import { TRAVEL_DESK_NAME } from "../actorNames.js";
import {
  caseCode,
  decisionLinkUrl,
  deciderInboxUrl,
  deciderProposalsUrl,
  linkExpiryText,
  myRequestsUrl,
  proposalViewUrl,
  staffCaseUrl,
} from "./links.js";
import {
  buttonGroup,
  card,
  expiryBox,
  factsGrid,
  itinerary,
  noteBox,
  requestHeading,
  renderLayout,
  sectionLabel,
  summaryStrip,
  type Fact,
  type Hero,
  type ItineraryRow,
} from "./layout.js";
import { safe, serviceOf, SERVICE_LABEL, tripModel, type TripModel } from "./tripModel.js";
import type { ApprovalEmailEvent } from "./map.js";

type AnyObj = Record<string, any>;
const str = (v: any) => String(v ?? "").trim();

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

/* ───────────────────────── shared pieces ───────────────────────── */

/** "trip to Mumbai", "forex request", "event in Goa" — escaped. */
function thing(t: TripModel): string {
  if (!t.destination) return escapeHtml(t.noun);
  if (t.noun === "trip") return `trip to ${safe(t.destination)}`;
  if (t.noun === "event") return `event in ${safe(t.destination)}`;
  return escapeHtml(t.noun);
}
/** "Asha Rao's trip" — escaped. */
const theirs = (ar: AnyObj, t: TripModel) => `${safe(requesterName(ar))}'s ${escapeHtml(t.noun)}`;
/** "Your trip to Mumbai" — escaped. */
const yours = (t: TripModel) => `Your ${thing(t)}`;

function strip(ar: AnyObj, t: TripModel) {
  return summaryStrip([
    { icon: "i-workspace.png", label: "Workspace", value: safe(customerName(ar)) },
    { icon: "i-user.png", label: "Requested by", value: safe(requesterName(ar)) },
    { icon: "i-items.png", label: "Items", value: t.itemsLabel },
  ]);
}

const requestNote = (ar: AnyObj) => noteBox("Request note", safe(ar?.comments));

function viewButton(href: string) {
  return buttonGroup({ label: "View request", href });
}

/** Standard body: strip, trip summary, notes, itinerary, then whatever comes after. */
function body(ar: AnyObj, t: TripModel, href: string, opts: { notes?: string[]; after?: string[]; itineraryRows?: ItineraryRow[]; itineraryLabel?: string } = {}) {
  return [
    strip(ar, t),
    // No items: the request number still shows, in its own heading.
    t.summaryHtml || card(requestHeading("Request", caseCode(ar))),
    ...(opts.notes || []),
    itinerary(opts.itineraryRows || t.itinerary, href, opts.itineraryLabel),
    ...(opts.after || []),
  ];
}

function doc(opts: { title: string; preheader: string; hero: Hero; blocks: string[]; staff?: boolean }) {
  return renderLayout({
    title: opts.title,
    preheader: opts.preheader,
    hero: opts.hero,
    blocks: opts.blocks,
    footer: opts.staff ? "staff" : "customer",
  });
}

/** A titled card of label / value facts (staff case details, the failure alert). */
function factsCard(label: string, facts: Fact[]) {
  return card(`${sectionLabel(escapeHtml(label))}<div style="height:6px;line-height:6px;font-size:0;">&nbsp;</div>${factsGrid(facts)}`);
}

/* ───────────────────────── request phase ───────────────────────── */

function approverRequestHtml(event: ApprovalEmailEvent, ctx: EmailCtx, recipient: string): string {
  const ar = ctx.ar;
  const t = tripModel(ar);
  const id = String(ar?._id || "");
  const who = safe(requesterName(ar));
  const approveUrl = decisionLinkUrl("request", id, recipient, null, "approve");

  const hero: Hero =
    event === "request_reminder"
      ? { badge: `Reminder ${ctx.reminderNo || 1} of 3`, tone: "orange", headline: `${theirs(ar, t)} is still waiting for your approval`, instruction: "Please approve, decline or ask a question below." }
      : event === "request_resubmitted"
      ? { badge: "Resubmitted", tone: "orange", headline: `${theirs(ar, t)} is back for your approval`, instruction: `${who} edited and resubmitted it after it was declined.` }
      : event === "clarification_answered"
      ? { badge: "Approval needed", tone: "orange", headline: `${who} answered your question`, instruction: `Review the reply${ctx.edited ? " and the edited request" : ""}, then approve, decline or ask again.` }
      : event === "request_resent"
      ? { badge: "Approval needed", tone: "orange", headline: `${theirs(ar, t)} needs your approval`, instruction: `${who} sent this request to you again. Please review it and take action.` }
      : { badge: "Approval needed", tone: "orange", headline: `${theirs(ar, t)} needs your approval`, instruction: "Please review the details below and take action." };

  const notes =
    event === "clarification_answered"
      ? [noteBox("Your question", safe(ctx.question)), noteBox(`${requesterName(ar)}'s reply${ctx.edited ? " (request edited)" : ""}`, safe(ctx.reply))]
      : [requestNote(ar)];

  const buttons = approveUrl
    ? buttonGroup({ label: "Approve request", href: approveUrl, glyph: "&#10003;" }, [
        { label: "Decline", href: decisionLinkUrl("request", id, recipient, null, "decline"), style: "danger", glyph: "&#10005;" },
        { label: "Ask a question", href: decisionLinkUrl("request", id, recipient, null, "clarify"), style: "warn" },
      ])
    : buttonGroup({ label: "Open Plumbox to decide", href: deciderInboxUrl() });

  return doc({
    title: "Approval needed",
    preheader: `${requesterName(ar)}'s travel request needs your decision — approve, decline or ask a question.`,
    hero,
    blocks: body(ar, t, deciderInboxUrl(), { notes, after: [buttons, approveUrl ? expiryBox(linkExpiryText(ctx.now)) : ""] }),
  });
}

function submitConfirmationHtml(ctx: EmailCtx) {
  const ar = ctx.ar;
  const t = tripModel(ar);
  const approver = str(ar?.managerName) && str(ar?.managerName) !== "Approver" ? str(ar.managerName) : "your approver";
  return doc({
    title: "Request received",
    preheader: `Your travel request ${caseCode(ar)} is with ${approver} for approval.`,
    hero: {
      badge: "Submitted",
      tone: "blue",
      headline: `${yours(t)} has been sent for approval`,
      instruction: `It's with ${safe(approver)} now; a Workspace Leader may also decide. We'll email you as soon as it's decided.`,
    },
    blocks: body(ar, t, myRequestsUrl(), { notes: [requestNote(ar)], after: [viewButton(myRequestsUrl())] }),
  });
}

function autoApprovedHtml(ctx: EmailCtx) {
  const ar = ctx.ar;
  const t = tripModel(ar);
  const direct = ar?.meta?.travelFlow === "APPROVAL_DIRECT";
  return doc({
    title: "Request approved",
    preheader: `Your travel request ${caseCode(ar)} is approved.`,
    hero: {
      badge: "Auto-approved",
      tone: "blue",
      headline: `${yours(t)} is approved`,
      instruction: `As a Workspace Leader, nobody else needs to approve it. The ${TRAVEL_DESK_NAME} will now ${direct ? "book it" : "prepare a proposal for you"}.`,
    },
    blocks: body(ar, t, myRequestsUrl(), { after: [viewButton(myRequestsUrl())] }),
  });
}

function requestApprovedHtml(ctx: EmailCtx) {
  const ar = ctx.ar;
  const t = tripModel(ar);
  const direct = ar?.meta?.travelFlow === "APPROVAL_DIRECT";
  const by = safe(ctx.actorName) || "Your approver";
  return doc({
    title: "Request approved",
    preheader: `Your travel request ${caseCode(ar)} was approved.`,
    hero: {
      badge: "Approved",
      tone: "green",
      headline: `${yours(t)} is approved`,
      instruction: `${by} approved it. The ${TRAVEL_DESK_NAME} will now ${direct ? "book it" : "prepare a proposal for you"}.`,
    },
    blocks: body(ar, t, myRequestsUrl(), { after: [viewButton(myRequestsUrl())] }),
  });
}

function requestDeclinedHtml(ctx: EmailCtx) {
  const ar = ctx.ar;
  const t = tripModel(ar);
  const by = safe(ctx.actorName) || "Your approver";
  return doc({
    title: "Request declined",
    preheader: `Your travel request ${caseCode(ar)} was declined.`,
    hero: {
      badge: "Declined",
      tone: "red",
      headline: `${yours(t)} was declined`,
      instruction: `${by} declined it. You can edit and resubmit it from My Requests.`,
    },
    blocks: body(ar, t, myRequestsUrl(), { notes: [noteBox("Reason", safe(ctx.reason))], after: [viewButton(myRequestsUrl())] }),
  });
}

function clarificationAskedHtml(ctx: EmailCtx) {
  const ar = ctx.ar;
  const t = tripModel(ar);
  const by = safe(ctx.actorName) || "Your approver";
  return doc({
    title: "A question about your request",
    preheader: `${str(ctx.actorName) || "Your approver"} needs more information before deciding.`,
    hero: {
      badge: "Needs your reply",
      tone: "orange",
      headline: `${by} has a question about your ${escapeHtml(t.noun)}`,
      instruction: "Reply from My Requests — you can also edit the request first. Your reply goes back to whoever asked.",
    },
    blocks: body(ar, t, myRequestsUrl(), { notes: [noteBox("Question", safe(ctx.reason))], after: [viewButton(myRequestsUrl())] }),
  });
}

/** FYI to the other deciders: request approved/declined, or a proposal decision. */
function decisionFyiHtml(event: ApprovalEmailEvent, ctx: EmailCtx) {
  const ar = ctx.ar;
  const t = tripModel(ar);
  const isProposal = event === "proposal_decision_fyi";
  const outcome: "approved" | "declined" | "changes" =
    isProposal ? (ctx.decision === "APPROVED" ? "approved" : ctx.decision === "DECLINED" ? "declined" : "changes") : event === "request_approved_fyi" ? "approved" : "declined";
  const subject = isProposal ? `${theirs(ar, t)} proposal` : theirs(ar, t);
  const headline =
    outcome === "approved" ? `${subject} was approved` : outcome === "declined" ? `${subject} was declined` : `${subject} was sent back for changes`;
  const by = safe(ctx.actorName) || "An approver";
  const href = isProposal ? deciderProposalsUrl() : deciderInboxUrl();
  return doc({
    title: isProposal ? "Proposal decided" : "Request decided",
    preheader: `${str(ctx.actorName) || "An approver"} decided ${caseCode(ar)}. No action is needed from you.`,
    hero: {
      badge: outcome === "approved" ? "Approved" : outcome === "declined" ? "Declined" : "Changes requested",
      tone: outcome === "approved" ? "green" : outcome === "declined" ? "red" : "blue",
      headline,
      instruction: `Decided by ${by}. No action is needed from you.`,
    },
    blocks: body(ar, t, href, { notes: [noteBox("Note", safe(ctx.reason))], after: [viewButton(href)] }),
  });
}

/* ───────────────────────── ops (staff) ───────────────────────── */

function flowFact(ar: AnyObj): Fact {
  return { label: "Flow", value: ar?.meta?.travelFlow === "APPROVAL_DIRECT" ? "Flow 3 — book directly" : "Flow 2 — proposal first" };
}

function deskNewCaseHtml(event: ApprovalEmailEvent, ctx: EmailCtx) {
  const ar = ctx.ar;
  const t = tripModel(ar);
  const noAgent = event === "ops_no_agent";
  const cancelled = event === "ops_customer_cancelled";
  const approval = ar?.meta?.selfApproved
    ? "Auto-approved (requester is a Workspace Leader)"
    : `Approved by ${safe(str(ctx.actorName) || str(ar?.approvedByName) || "the approver")}`;
  const assignment = noAgent
    ? "No agent available — auto-allocation found nobody"
    : ctx.assignedToName
    ? `Auto-assigned to ${safe(ctx.assignedToName)}`
    : "Unassigned (auto-allocation is off)";
  const hero: Hero = cancelled
    ? { badge: "Cancelled", tone: "red", headline: `${theirs(ar, t)} was cancelled by the customer`, instruction: "Stop any booking work and release holds." }
    : noAgent
    ? { badge: "No agent available", tone: "blue", headline: `Nobody is free to take ${theirs(ar, t)}`, instruction: "Assign it by hand from the ops queue." }
    : { badge: "New case", tone: "blue", headline: `New case: ${theirs(ar, t)}${t.destination ? ` to ${safe(t.destination)}` : ""}`, instruction: ctx.assignedToName ? `Auto-assigned to ${safe(ctx.assignedToName)}.` : "Unassigned — pick it up from the queue." };
  const facts: Fact[] = cancelled
    ? [flowFact(ar)]
    : [flowFact(ar), { label: "Approval", value: approval }, { label: "Assignment", value: assignment }];
  const href = staffCaseUrl(ar?._id);
  return doc({
    title: cancelled ? "Customer cancelled" : noAgent ? "Unassigned case" : "New case",
    preheader: `${caseCode(ar)} — ${customerName(ar)}`,
    hero,
    staff: true,
    blocks: body(ar, t, href, {
      notes: cancelled ? [noteBox("Reason", safe(ctx.reason))] : [requestNote(ar)],
      after: [factsCard("Case", facts), viewButton(href)],
    }),
  });
}

function assigneeHtml(ctx: EmailCtx) {
  const ar = ctx.ar;
  const t = tripModel(ar);
  const agent = ctx.agent || { name: "", email: "" };
  const href = staffCaseUrl(ar?._id);
  return doc({
    title: "Case assigned to you",
    preheader: `${caseCode(ar)} — ${customerName(ar)} is assigned to you.`,
    hero: {
      badge: "Case assigned",
      tone: "blue",
      headline: `${theirs(ar, t)}${t.destination ? ` to ${safe(t.destination)}` : ""} is yours`,
      instruction: `Hi ${safe(agent.name) || "there"}, this case is assigned to you on the ${TRAVEL_DESK_NAME}.`,
    },
    staff: true,
    blocks: body(ar, t, href, {
      notes: [requestNote(ar), noteBox("Note from the assigner", escapeHtml(str(ctx.assignNote)))],
      after: [
        factsCard("Case", [flowFact(ar), { label: "Why you", value: escapeHtml(str(ctx.assignWhy) || "Assigned by a colleague") }]),
        viewButton(href),
      ],
    }),
  });
}

function deskProposalOutcomeHtml(ctx: EmailCtx) {
  const ar = ctx.ar;
  const t = tripModel(ar);
  const p = ctx.proposal || {};
  const d = ctx.decision;
  const href = staffCaseUrl(ar?._id);
  const headline =
    d === "APPROVED" ? `${theirs(ar, t)} proposal was approved` : d === "DECLINED" ? `${theirs(ar, t)} proposal was declined` : `${theirs(ar, t)} proposal needs changes`;
  const next = d === "APPROVED" ? "Start the booking." : d === "DECLINED" ? "Talk to the customer; send a revised proposal if wanted." : "Revise the proposal and submit it again.";
  return doc({
    title: "Proposal outcome",
    preheader: `${caseCode(ar)} — proposal ${d === "APPROVED" ? "approved" : d === "DECLINED" ? "declined" : "changes requested"}`,
    hero: {
      badge: d === "APPROVED" ? "Approved" : d === "DECLINED" ? "Declined" : "Changes requested",
      tone: d === "APPROVED" ? "green" : d === "DECLINED" ? "red" : "orange",
      headline,
      instruction: next,
    },
    staff: true,
    blocks: body(ar, t, href, {
      notes: [noteBox(d === "CHANGES_REQUESTED" ? "Changes asked for" : "Note", escapeHtml(str(ctx.reason)))],
      after: [
        factsCard("Case", [
          { label: "Proposal", value: p?.version ? `v${escapeHtml(String(p.version))}` : "—" },
          { label: "Decided by", value: escapeHtml(str(ctx.actorName) || "—") },
        ]),
        viewButton(href),
      ],
    }),
  });
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
  const facts: Fact[] = [
    { label: "Request", value: escapeHtml(f.caseCode || "—") },
    { label: "Customer", value: escapeHtml(f.customerName || "—") },
    { label: "Email", value: escapeHtml(f.event) },
    { label: "Subject", value: escapeHtml(f.subject) },
    { label: "To", value: escapeHtml(f.to.join(", ")) },
    ...(f.cc.length ? [{ label: "CC", value: escapeHtml(f.cc.join(", ")) }] : []),
    { label: "Tries", value: escapeHtml(String(f.attempts)) },
    { label: "Last error", value: escapeHtml(f.error) },
  ];
  return doc({
    title: "Email not delivered",
    preheader: `${f.caseCode || "Approval flow"}: "${f.subject}" could not be delivered.`,
    hero: {
      badge: "Email failure",
      tone: "blue",
      headline: "An approval email could not be delivered",
      instruction: "Nobody listed below has it. Reach them another way if it matters; it's also under “Email failures” on the ops queue.",
    },
    staff: true,
    blocks: [factsCard("Failed email", facts), f.requestId ? viewButton(staffCaseUrl(f.requestId)) : ""],
  });
}

/* ───────────────────────── proposal phase ───────────────────────── */

function lineLabel(li: AnyObj): string {
  const m = li?.meta || {};
  const origin = str(m.origin || li?.from || li?.origin);
  const dest = str(m.destination || li?.to || li?.destination);
  const raw = str(m.tripType || li?.tripType).toLowerCase();
  const tripType = raw === "oneway" ? "One way" : raw === "roundtrip" ? "Round trip" : "";
  if (origin && dest) return `${origin} → ${dest}${tripType ? ` (${tripType})` : ""}`;
  return str(li?.title || li?.description || li?.name || li?.category) || "Travel service";
}

/** The proposal's options as itinerary rows: no prices, every text stripped AND escaped. */
export function proposalOptionRows(p: AnyObj): ItineraryRow[] {
  const options = (Array.isArray(p?.options) ? p.options : [])
    .slice()
    .sort((a: any, b: any) => Number(a?.optionNo || 0) - Number(b?.optionNo || 0));
  return options.map((opt: AnyObj) => {
    const lines: AnyObj[] = Array.isArray(opt?.lineItems) ? opt.lineItems : [];
    const first = lines[0] ? serviceOf(lines[0]) : "other";
    return {
      service: SERVICE_LABEL[first] ? first : "other",
      title: `Option ${escapeHtml(String(opt?.optionNo || ""))} — ${safe(opt?.title) || "Option"}`,
      lines: [
        ...(str(opt?.notes) ? [safe(opt.notes)] : []),
        ...lines.map((li) => {
          const qty = Number(li?.qty || 1);
          return `${safe(lineLabel(li))}${qty > 1 ? ` × ${escapeHtml(String(qty))}` : ""}`;
        }),
      ].filter(Boolean),
    };
  });
}

function proposalApprovalHtml(event: ApprovalEmailEvent, ctx: EmailCtx, recipient: string) {
  const ar = ctx.ar;
  const t = tripModel(ar);
  const p = ctx.proposal || {};
  const pid = String(p?._id || "");
  const approveUrl = decisionLinkUrl("proposal", pid, recipient, null, "approve");
  const reminder = event === "proposal_reminder";
  const buttons = approveUrl
    ? buttonGroup({ label: "Approve proposal", href: approveUrl, glyph: "&#10003;" }, [
        { label: "Request changes", href: decisionLinkUrl("proposal", pid, recipient, null, "request_changes"), style: "warn" },
        { label: "Decline", href: decisionLinkUrl("proposal", pid, recipient, null, "decline"), style: "danger", glyph: "&#10005;" },
      ])
    : buttonGroup({ label: "Open Plumbox to decide", href: deciderProposalsUrl() });
  const rows = proposalOptionRows(p);
  return doc({
    title: "Proposal approval needed",
    preheader: `The ${TRAVEL_DESK_NAME} sent a proposal for ${requesterName(ar)}'s request — approve, request changes or decline.`,
    hero: {
      badge: reminder ? `Reminder ${ctx.reminderNo || 1} of 3` : "Proposal approval needed",
      tone: "orange",
      headline: reminder ? `${theirs(ar, t)} proposal is still waiting for your approval` : `${theirs(ar, t)} proposal needs your approval`,
      instruction: `Review the option${rows.length === 1 ? "" : "s"} below, then approve, request changes or decline. The first decision counts.`,
    },
    blocks: body(ar, t, deciderProposalsUrl(), {
      itineraryRows: rows.length ? rows : [{ service: "other", title: "No options", lines: [] }],
      itineraryLabel: `Proposal${p?.version ? ` v${String(p.version)}` : ""} — options`,
      after: [buttons, approveUrl ? expiryBox(linkExpiryText(ctx.now)) : ""],
    }),
  });
}

function proposalReadyHtml(ctx: EmailCtx) {
  const ar = ctx.ar;
  const t = tripModel(ar);
  const href = proposalViewUrl(ctx.proposal?._id);
  return doc({
    title: "Your proposal is ready",
    preheader: `The ${TRAVEL_DESK_NAME} has prepared a proposal for your request ${caseCode(ar)}.`,
    hero: {
      badge: "Proposal ready",
      tone: "orange",
      headline: `${yours(t)} has a proposal`,
      instruction: `The ${TRAVEL_DESK_NAME} prepared it; your approver or a Workspace Leader will decide. We'll email you the outcome.`,
    },
    blocks: body(ar, t, href, { after: [viewButton(href)] }),
  });
}

function proposalOutcomeHtml(event: ApprovalEmailEvent, ctx: EmailCtx) {
  const ar = ctx.ar;
  const t = tripModel(ar);
  const by = safe(ctx.actorName) || "Your approver";
  const c =
    event === "proposal_approved"
      ? { title: "Proposal approved", badge: "Approved", tone: "green" as const, headline: `The proposal for your ${thing(t)} was approved`, instruction: `The ${TRAVEL_DESK_NAME} will now book it. Your tickets and vouchers will come by email.`, note: "" }
      : event === "proposal_declined"
      ? { title: "Proposal declined", badge: "Declined", tone: "red" as const, headline: `The proposal for your ${thing(t)} was declined`, instruction: `${by} declined it. The ${TRAVEL_DESK_NAME} will be in touch about next steps.`, note: "Reason" }
      : { title: "Changes requested", badge: "Changes requested", tone: "blue" as const, headline: `Changes were requested on the proposal for your ${thing(t)}`, instruction: `${by} asked for changes. The ${TRAVEL_DESK_NAME} will revise it and send it for approval again.`, note: "What to change" };
  return doc({
    title: c.title,
    preheader: `${c.title} — ${caseCode(ar)}`,
    hero: { badge: c.badge, tone: c.tone, headline: c.headline, instruction: c.instruction },
    blocks: body(ar, t, myRequestsUrl(), { notes: c.note ? [noteBox(c.note, safe(ctx.reason))] : [], after: [viewButton(myRequestsUrl())] }),
  });
}

/* ───────────────────────── booking ───────────────────────── */

function progressHtml(event: ApprovalEmailEvent, ctx: EmailCtx) {
  const ar = ctx.ar;
  const t = tripModel(ar);
  const c =
    event === "booking_started"
      ? { title: "Booking in progress", badge: "Booking started", tone: "blue" as const, headline: `We're booking your ${thing(t)}`, instruction: "You'll get your tickets and vouchers by email when it's done.", note: "Note" }
      : event === "booking_on_hold"
      ? { title: "Booking on hold", badge: "On hold", tone: "blue" as const, headline: `${yours(t)} is on hold`, instruction: `The ${TRAVEL_DESK_NAME} paused the booking for now and will continue as soon as it can.`, note: "Why" }
      : { title: "Request cancelled", badge: "Cancelled", tone: "red" as const, headline: `${yours(t)} was cancelled`, instruction: `The ${TRAVEL_DESK_NAME} cancelled this request.`, note: "Reason" };
  return doc({
    title: c.title,
    preheader: `${c.title} — ${caseCode(ar)}`,
    hero: { badge: c.badge, tone: c.tone, headline: c.headline, instruction: c.instruction },
    blocks: body(ar, t, myRequestsUrl(), { notes: [noteBox(c.note, safe(ctx.reason))], after: [viewButton(myRequestsUrl())] }),
  });
}

function bookingDoneHtml(ctx: EmailCtx) {
  const ar = ctx.ar;
  const t = tripModel(ar);
  const files = (ctx.attachmentNames || []).map(str).filter(Boolean);
  const docs = files.length
    ? card(`${sectionLabel("Attached to this email")}<div style="height:6px;line-height:6px;font-size:0;">&nbsp;</div>${factsGrid(
        files.map((f, i) => ({ label: `Document ${i + 1}`, value: escapeHtml(f) })),
      )}`)
    : "";
  return doc({
    title: "Booking processed",
    preheader: `Your booking ${caseCode(ar)} is done.${files.length ? " Your documents are attached." : ""}`,
    hero: {
      badge: "Booked",
      tone: "green",
      headline: `${yours(t)} is booked`,
      instruction: files.length ? "Your tickets and vouchers are attached to this email." : `The ${TRAVEL_DESK_NAME} has completed your booking.`,
    },
    blocks: body(ar, t, myRequestsUrl(), {
      notes: [noteBox(`Message from the ${TRAVEL_DESK_NAME}`, safe(sanitizeAdminCommentForEmail(ctx.doneComment)))],
      after: [docs, viewButton(myRequestsUrl())],
    }),
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
    case "proposal_declined":
    case "proposal_changes_requested":
      html = proposalOutcomeHtml(event, ctx);
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
