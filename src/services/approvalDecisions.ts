// apps/backend/src/services/approvalDecisions.ts
//
// The one place a customer-side DECISION is applied — request approval
// (Flow 2 and Flow 3) and proposal approval (Flow 2) — shared by the in-app
// routes (approvals.ts, proposals.ts) and the email decision links
// (approvalLinks.ts), so both paths enforce the same rules:
//
//   - who may decide is re-checked at decision time (never trusted from the
//     moment the email went out): request → the assigned approver while they
//     are still a workspace approver or leader, or any active Workspace
//     Leader; proposal → the request's approver OR any active Workspace
//     Leader ("either"). Nobody decides their own request.
//   - first decision wins: the state change is a conditional update, so a
//     second approver (or a second click) gets ALREADY_DECIDED naming who
//     decided.
//   - a decline needs a reason.

import mongoose from "mongoose";
import ApprovalRequest from "../models/ApprovalRequest.js";
import Proposal from "../models/Proposal.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import CustomerMember from "../models/CustomerMember.js";
import User from "../models/User.js";
import { sendMail } from "../utils/mailer.js";
import { signApprovalLink, approvalLinkExpiryHours, type ApprovalLinkKind } from "../utils/approvalLinkToken.js";
import { frontendBaseUrl, DISABLE_EMAILS, stripPriceText } from "../routes/approvals.security.js";
import {
  buildRequesterApprovedHtml,
  buildRequestDeclinedEmailHtml,
  buildProposalApprovedEmailHtml,
  buildProposalDeclinedEmailHtml,
  buildApproverEmailHtml,
  buildEmailShell,
  eBtn,
  eCard,
  eLabel,
  escapeHtml,
} from "../routes/approvals.email.js";

type AnyObj = Record<string, any>;

export type DecisionActor = { email: string; name?: string; sub?: string; via: "app" | "email" };

export class DecisionError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: AnyObj,
  ) {
    super(message);
  }
}

const norm = (v: any) => String(v ?? "").trim().toLowerCase();
const str = (v: any) => String(v ?? "").trim();

/** Request stages an approver can still act on. */
export const REQUEST_ACTIONABLE_STAGES = ["REQUEST_RAISED", "REQUEST_ON_HOLD", null];

/* ───────────────────────── who may decide ───────────────────────── */

export async function workspaceOf(ar: AnyObj): Promise<AnyObj | null> {
  const id = ar?.workspaceId || ar?.meta?.customerWorkspaceId;
  if (!id || !mongoose.Types.ObjectId.isValid(String(id))) return null;
  return (await CustomerWorkspace.findOne({ _id: id }).lean().exec()) as AnyObj | null;
}

export async function activeLeaderEmails(ws: AnyObj | null, ar?: AnyObj): Promise<string[]> {
  const customerId = str(ws?.customerId || ar?.customerId);
  if (!customerId) return [];
  const rows: any[] = await CustomerMember.find({
    customerId,
    role: "WORKSPACE_LEADER",
    isActive: { $ne: false },
  })
    .lean()
    .exec();
  return Array.from(new Set(rows.map((r) => norm(r.email)).filter(Boolean)));
}

async function isUserInactive(email: string): Promise<boolean> {
  if (!email) return true;
  const rx = new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const u: any = await User.findOne({ email: rx }).select("status").lean().exec();
  return String(u?.status || "").toUpperCase() === "INACTIVE";
}

/**
 * Who may decide this request now: the assigned approver while still a
 * workspace approver (defaultApproverEmails) or leader, plus every active
 * Workspace Leader. The requester is never on the list.
 */
export async function requestDeciders(ar: AnyObj): Promise<string[]> {
  const ws = await workspaceOf(ar);
  const leaders = await activeLeaderEmails(ws, ar);
  const approvers: string[] = (Array.isArray(ws?.defaultApproverEmails) ? ws!.defaultApproverEmails : []).map(norm);
  const manager = norm(ar?.managerEmail);
  const requester = norm(ar?.frontlinerEmail);
  const out: string[] = [];
  if (manager && (!ws || approvers.includes(manager) || leaders.includes(manager))) out.push(manager);
  for (const l of leaders) if (!out.includes(l)) out.push(l);
  return out.filter((e) => e && e !== requester);
}

/**
 * Who may decide this request's proposal: the request's approver OR any
 * active Workspace Leader — whoever acts first. The requester is excluded,
 * except a Workspace Leader requester when nobody else could decide (their
 * own request was auto-approved for the same reason: no one above them).
 */
export async function proposalDeciders(ar: AnyObj): Promise<string[]> {
  const ws = await workspaceOf(ar);
  const leaders = await activeLeaderEmails(ws, ar);
  const approvers: string[] = (Array.isArray(ws?.defaultApproverEmails) ? ws!.defaultApproverEmails : []).map(norm);
  const manager = norm(ar?.managerEmail);
  const requester = norm(ar?.frontlinerEmail);
  const all: string[] = [];
  if (manager && (!ws || approvers.includes(manager) || leaders.includes(manager))) all.push(manager);
  for (const l of leaders) if (!all.includes(l)) all.push(l);
  const others = all.filter((e) => e && e !== requester);
  if (others.length) return others;
  return leaders.includes(requester) ? [requester] : [];
}

async function assertActorMayDecide(deciders: string[], actor: DecisionActor, requesterEmail: string) {
  const email = norm(actor.email);
  if (email && email === norm(requesterEmail) && !deciders.includes(email)) {
    throw new DecisionError(403, "SELF_APPROVAL_NOT_ALLOWED", "You cannot approve or decline your own request.");
  }
  if (!email || !deciders.includes(email)) {
    throw new DecisionError(403, "NOT_AN_APPROVER", "You are no longer an approver for this request.");
  }
  if (await isUserInactive(email)) {
    throw new DecisionError(403, "NOT_AN_APPROVER", "Your account is not active.");
  }
}

/* ───────────────────────── email links ───────────────────────── */

/** Confirm-page URL for one recipient, or "" when links are not configured. */
export function decisionLinkUrl(
  kind: ApprovalLinkKind,
  id: string,
  recipient: string,
  ws: AnyObj | null,
  intent?: string,
): string {
  const token = signApprovalLink({ kind, id, email: recipient }, approvalLinkExpiryHours(ws));
  if (!token) return "";
  return `${frontendBaseUrl()}/approval/email?token=${encodeURIComponent(token)}${
    intent ? `&intent=${encodeURIComponent(intent)}` : ""
  }`;
}

/* ───────────────────────── request decision ───────────────────────── */

/**
 * "clarify" (Ask for clarification) replaced the customer approver's one-way
 * "On Hold": the request goes to the requester with a question and comes back
 * to the same approver when they reply. Ops keep their own internal hold.
 */
export type RequestDecisionAction = "approved" | "declined" | "clarify";

function approvedStageFor(ar: AnyObj) {
  return ar?.meta?.travelFlow === "APPROVAL_DIRECT" ? "REQUEST_APPROVED" : "PROPOSAL_PENDING";
}

export function decidedBy(ar: AnyObj) {
  const last = [...(Array.isArray(ar?.history) ? ar.history : [])]
    .reverse()
    .find((h: any) => /^(email_)?(approved|declined|auto_approved)$/.test(String(h?.action || "")));
  return {
    status: str(ar?.status),
    stage: str(ar?.stage),
    byName: str(ar?.approvedByName || last?.userName),
    byEmail: str(ar?.approvedByEmail || last?.userEmail),
    at: last?.at || null,
  };
}

/**
 * Applies an approver's decision to a request. Throws DecisionError on any
 * refusal; returns the saved document.
 */
export async function applyRequestDecision(opts: {
  requestId: string;
  workspaceId?: any;
  actor: DecisionActor;
  action: RequestDecisionAction;
  reason?: string;
}): Promise<any> {
  const { actor, action } = opts;
  const reason = str(opts.reason);
  if ((action as string) === "on_hold") {
    throw new DecisionError(400, "HOLD_REMOVED", "On Hold is no longer available — ask the requester a question instead.");
  }
  if (!["approved", "declined", "clarify"].includes(action)) {
    throw new DecisionError(400, "INVALID_ACTION", "Invalid action");
  }
  if (action === "declined" && !reason) {
    throw new DecisionError(400, "REASON_REQUIRED", "A reason is required to decline.");
  }
  if (action === "clarify" && !reason) {
    throw new DecisionError(400, "QUESTION_REQUIRED", "Write the question for the requester.");
  }

  const filter: AnyObj = { _id: opts.requestId };
  if (opts.workspaceId) filter.workspaceId = opts.workspaceId;
  const ar: any = await ApprovalRequest.findOne(filter).lean().exec();
  if (!ar) throw new DecisionError(404, "NOT_FOUND", "Request not found");

  const actionable =
    str(ar.status).toLowerCase() === "pending" &&
    (REQUEST_ACTIONABLE_STAGES as any[]).includes(ar.stage ? str(ar.stage).toUpperCase() : null);
  if (!actionable) {
    throw new DecisionError(409, "ALREADY_DECIDED", "This request has already been decided.", { decided: decidedBy(ar) });
  }

  await assertActorMayDecide(await requestDeciders(ar), actor, ar.frontlinerEmail);

  const email = norm(actor.email);
  const name = str(actor.name) || str(ar.managerName) || "Approver";
  const set: AnyObj =
    action === "approved"
      ? { status: "approved", stage: approvedStageFor(ar), adminState: "pending" }
      : action === "declined"
      ? { status: "declined", stage: "REQUEST_DECLINED", adminState: "cancelled" }
      : { status: "pending", stage: "REQUEST_NEEDS_CLARIFICATION" };
  if (action !== "clarify") Object.assign(set, { approvedByEmail: email, approvedByName: name });

  // First decision wins: only a still-actionable request is updated.
  const claimed = await ApprovalRequest.findOneAndUpdate(
    { _id: ar._id, status: "pending", stage: { $in: REQUEST_ACTIONABLE_STAGES } },
    { $set: set },
    { new: true },
  ).exec();
  if (!claimed) {
    const now: any = await ApprovalRequest.findOne({ _id: ar._id }).lean().exec();
    throw new DecisionError(409, "ALREADY_DECIDED", "This request has already been decided.", { decided: decidedBy(now || ar) });
  }

  // Reload as a document so the model's save hook keeps the FSM in step.
  const doc: any = await ApprovalRequest.findOne({ _id: ar._id }).exec();
  doc.history = Array.isArray(doc.history) ? doc.history : [];
  const historyAction = action === "clarify" ? "clarification_requested" : action;
  doc.history.push({
    action: actor.via === "email" ? `email_${historyAction}` : historyAction,
    at: new Date(),
    by: actor.via === "email" ? `email:${email}` : actor.sub || "unknown",
    comment: reason || undefined,
    userEmail: email,
    userName: name,
  });
  if (action === "clarify") {
    doc.clarifications = Array.isArray(doc.clarifications) ? doc.clarifications : [];
    doc.clarifications.push({ kind: "question", text: reason, at: new Date(), byEmail: email, byName: name });
  }
  await doc.save();

  await notifyRequesterOfRequestDecision(doc, action, name, email, reason);
  return doc;
}

/**
 * The requester answers the approver's question (and may have edited the
 * request in the same step). The request goes back to the same approver,
 * pending, and they get fresh decision links.
 */
export async function replyToClarification(opts: {
  requestId: string;
  workspaceId?: any;
  actor: DecisionActor;
  reply: string;
  edited?: boolean;
}): Promise<any> {
  const reply = str(opts.reply);
  if (!reply) throw new DecisionError(400, "REPLY_REQUIRED", "Write a reply to the approver's question.");

  const filter: AnyObj = { _id: opts.requestId, stage: "REQUEST_NEEDS_CLARIFICATION", status: "pending" };
  if (opts.workspaceId) filter.workspaceId = opts.workspaceId;
  const claimed = await ApprovalRequest.findOneAndUpdate(filter, { $set: { stage: "REQUEST_RAISED" } }, { new: true }).exec();
  if (!claimed) throw new DecisionError(409, "NOT_WAITING_FOR_REPLY", "This request is not waiting for your reply.");

  const doc: any = await ApprovalRequest.findOne({ _id: (claimed as any)._id }).exec();
  const email = norm(opts.actor.email);
  const name = str(opts.actor.name) || str(doc.frontlinerName) || email;
  doc.clarifications = Array.isArray(doc.clarifications) ? doc.clarifications : [];
  const question = [...doc.clarifications].reverse().find((c: any) => c?.kind === "question");
  doc.clarifications.push({ kind: "reply", text: reply, at: new Date(), byEmail: email, byName: name, edited: !!opts.edited });
  doc.history = Array.isArray(doc.history) ? doc.history : [];
  doc.history.push({
    action: "clarification_replied",
    at: new Date(),
    by: opts.actor.sub || "unknown",
    comment: reply,
    userEmail: email,
    userName: name,
  });
  await doc.save();

  if (!DISABLE_EMAILS) {
    const approverEmail = norm(doc.managerEmail);
    const ws = await workspaceOf(doc);
    try {
      await sendMail({
        kind: "REQUESTS",
        to: approverEmail,
        replyTo: email || undefined,
        subject: `Reply received — Approval Needed — ${doc.customerName || "Workspace"}${doc.ticketId ? ` (${doc.ticketId})` : ""}`,
        html: buildApproverEmailHtml({
          requestId: String(doc._id),
          requesterName: name,
          requesterEmail: email,
          customerName: doc.customerName || "Workspace",
          ticketId: doc.ticketId,
          items: Array.isArray(doc.cartItems) ? doc.cartItems : [],
          comments: `Your question: ${question?.text || ""}\nReply${opts.edited ? " (request edited)" : ""}: ${reply}`,
          approveUrl: decisionLinkUrl("request", String(doc._id), approverEmail, ws, "approve"),
          declineUrl: decisionLinkUrl("request", String(doc._id), approverEmail, ws, "decline"),
          clarifyUrl: decisionLinkUrl("request", String(doc._id), approverEmail, ws, "clarify"),
        }),
      } as any);
    } catch {
      /* non-blocking */
    }
  }
  return doc;
}

async function notifyRequesterOfRequestDecision(
  doc: AnyObj,
  action: RequestDecisionAction,
  approverName: string,
  approverEmail: string,
  reason: string,
) {
  if (DISABLE_EMAILS) return;
  const to = norm(doc.frontlinerEmail);
  if (!to) return;
  const requesterName = str(doc.frontlinerName) || to.split("@")[0];
  const loginUrl = `${frontendBaseUrl()}/customer/approvals/mine`;
  try {
    if (action === "approved") {
      await sendMail({
        kind: "APPROVALS",
        to,
        replyTo: approverEmail || undefined,
        subject: `Approved — moved to Admin Queue — ${doc.customerName || "Workspace"}${doc.ticketId ? ` (${doc.ticketId})` : ""}`,
        html: buildRequesterApprovedHtml({
          customerName: doc.customerName || "Workspace",
          ticketId: doc.ticketId,
          requesterName,
          requesterEmail: to,
          approverName,
          approverEmail,
          items: Array.isArray(doc.cartItems) ? doc.cartItems : [],
        }),
      } as any);
    } else if (action === "declined") {
      await sendMail({
        kind: "CONFIRMATIONS",
        to,
        subject: `Your Travel Request Has Been Declined — ${doc.ticketId || ""}`,
        html: buildRequestDeclinedEmailHtml({ ticketId: doc.ticketId, requesterName, managerName: approverName, comment: reason, loginUrl }),
      } as any);
    } else {
      await sendMail({
        kind: "CONFIRMATIONS",
        to,
        replyTo: approverEmail || undefined,
        subject: `Your approver has a question — ${doc.ticketId || "your travel request"}`,
        html: buildEmailShell(
          `${eCard(`
            ${eLabel("Question from your approver")}
            <div style="font-size:13px;line-height:1.65;color:#334155;">
              Hi <b style="color:#0f172a;">${escapeHtml(requesterName)}</b>,<br/><br/>
              <b style="color:#0f172a;">${escapeHtml(approverName)}</b> needs more information before deciding on
              your travel request${doc.ticketId ? ` <b style="color:#d06549;">(${escapeHtml(doc.ticketId)})</b>` : ""}:
              <div style="margin-top:10px;padding:10px 12px;border-radius:10px;background:#f8fafc;border:1px solid #e2e8f0;white-space:pre-wrap;">${escapeHtml(reason)}</div>
            </div>
          `)}
          <div style="margin-top:16px;">${eBtn("Reply in My Requests", loginUrl, "#00477f", "#ffffff")}</div>
          <div style="margin-top:12px;color:#94a3b8;font-size:12px;">You can also edit the request before replying. Your reply goes back to the same approver.</div>`,
          { title: "Your approver has a question", badgeText: "NEEDS YOUR REPLY", badgeColor: "#f59e0b" },
        ),
      } as any);
    }
  } catch {
    /* non-blocking */
  }
}

/* ───────────────────────── proposal decision ───────────────────────── */

/** request_changes: back to ops with a note; ops revise and resubmit. */
export type ProposalDecisionAction = "approve" | "decline" | "request_changes";

export function proposalDecidedBy(p: AnyObj) {
  if (str(p?.status) === "CHANGES_REQUESTED") {
    const c = p?.customer || {};
    return { status: "CHANGES_REQUESTED", decision: "CHANGES_REQUESTED", byName: str(c.byName), byEmail: str(c.byEmail), at: c.at || null };
  }
  const d = p?.approvals?.l2 || {};
  return {
    status: str(p?.status),
    decision: str(d.decision),
    byName: str(d.byName),
    byEmail: str(d.byEmail),
    at: d.at || null,
  };
}

/**
 * Stage of the linked request for a proposal-phase event. Proposal-phase
 * stages may move backwards (a revised proposal after a decline goes back to
 * PROPOSAL_SUBMITTED); booking-phase stages are never overwritten.
 */
export async function setProposalPhaseStage(requestId: any, stage: string) {
  await ApprovalRequest.updateOne(
    {
      _id: requestId,
      stage: { $nin: ["BOOKING_IN_PROGRESS", "BOOKING_ON_HOLD", "BOOKING_DONE", "BOOKING_CANCELLED", "COMPLETED", "CANCELLED"] },
    },
    { $set: { stage } },
  ).exec();
}

export async function applyProposalDecision(opts: {
  proposalId: string;
  workspaceId?: any;
  actor: DecisionActor;
  action: ProposalDecisionAction;
  reason?: string;
  /**
   * Ops recording a decision the customer gave them some other way (phone,
   * email to ops…). Staff-only — the route checks isStaffAdmin. The note is
   * required and says who decided, how and when; the "who may decide" check
   * is skipped because the decider is the customer, not the staff member,
   * but the first-decision-wins rule and every email are unchanged.
   */
  recordedOnBehalf?: boolean;
}): Promise<{ proposal: any; request: any }> {
  const { actor, action } = opts;
  const onBehalf = opts.recordedOnBehalf === true;
  const note = str(opts.reason);
  if (!["approve", "decline", "request_changes"].includes(action)) {
    throw new DecisionError(400, "INVALID_ACTION", "Invalid action");
  }
  if (onBehalf && !note) {
    throw new DecisionError(400, "NOTE_REQUIRED", "Say who decided, how and when.");
  }
  const reason = onBehalf
    ? `Recorded by ${str(actor.name) || norm(actor.email)} on behalf of the customer: ${note}`
    : note;
  if (action === "decline" && !reason) {
    throw new DecisionError(400, "REASON_REQUIRED", "A reason is required to decline.");
  }
  if (action === "request_changes" && !reason) {
    throw new DecisionError(400, "NOTE_REQUIRED", "Say what should change.");
  }

  const pFilter: AnyObj = { _id: opts.proposalId };
  if (opts.workspaceId) pFilter.workspaceId = opts.workspaceId;
  const p: any = await Proposal.findOne(pFilter).lean().exec();
  if (!p) throw new DecisionError(404, "NOT_FOUND", "Proposal not found");
  if (str(p.status) !== "SUBMITTED") {
    throw new DecisionError(409, "ALREADY_DECIDED", "This proposal has already been decided.", { decided: proposalDecidedBy(p) });
  }
  const ar: any = await ApprovalRequest.findOne({ _id: p.requestId }).lean().exec();
  if (!ar) throw new DecisionError(404, "NOT_FOUND", "Request not found for this proposal");

  if (!onBehalf) await assertActorMayDecide(await proposalDeciders(ar), actor, ar.frontlinerEmail);

  const email = norm(actor.email);
  const name = str(actor.name) || email;

  if (action === "request_changes") {
    const back: any = await Proposal.findOneAndUpdate(
      { _id: p._id, status: "SUBMITTED" },
      {
        $set: {
          status: "CHANGES_REQUESTED",
          customer: { action: "needs_changes", note: reason, at: new Date(), byEmail: email, byName: name },
        },
        $push: {
          history: { action: `${onBehalf ? "RECORDED_" : actor.via === "email" ? "EMAIL_" : ""}CHANGES_REQUESTED`, at: new Date(), byEmail: email, byName: name, note: reason },
        },
      },
      { new: true },
    ).exec();
    if (!back) {
      const now: any = await Proposal.findOne({ _id: p._id }).lean().exec();
      throw new DecisionError(409, "ALREADY_DECIDED", "This proposal has already been decided.", { decided: proposalDecidedBy(now || p) });
    }
    await setProposalPhaseStage(ar._id, "PROPOSAL_CHANGES_REQUESTED");
    await notifyOpsOfProposalOutcome(back, ar, "CHANGES_REQUESTED", name, reason);
    // A decision recorded by ops is news to the approver and leaders.
    if (onBehalf) await notifyDecidersOfProposalDecision(ar, back, "CHANGES_REQUESTED", name, reason);
    return { proposal: back, request: ar };
  }

  const decision = {
    decision: action === "approve" ? "APPROVED" : "DECLINED",
    at: new Date(),
    byEmail: email,
    byName: name,
    comment: reason,
  };
  // One decision, recorded on both legacy slots so every reader agrees.
  const updated: any = await Proposal.findOneAndUpdate(
    { _id: p._id, status: "SUBMITTED" },
    {
      $set: { status: decision.decision, "approvals.l2": decision, "approvals.l0": decision },
      $push: {
        history: {
          action: `${onBehalf ? "RECORDED_" : actor.via === "email" ? "EMAIL_" : ""}${decision.decision}`,
          at: new Date(),
          byEmail: email,
          byName: name,
          note: reason,
        },
      },
    },
    { new: true },
  ).exec();
  if (!updated) {
    const now: any = await Proposal.findOne({ _id: p._id }).lean().exec();
    throw new DecisionError(409, "ALREADY_DECIDED", "This proposal has already been decided.", { decided: proposalDecidedBy(now || p) });
  }

  await setProposalPhaseStage(ar._id, action === "approve" ? "PROPOSAL_APPROVED" : "PROPOSAL_DECLINED");
  await notifyRequesterOfProposalDecision(ar, action);
  await notifyOpsOfProposalOutcome(updated, ar, decision.decision, name, reason);
  await notifyDecidersOfProposalDecision(ar, updated, decision.decision as any, name, reason);
  return { proposal: updated, request: ar };
}

async function notifyRequesterOfProposalDecision(ar: AnyObj, action: ProposalDecisionAction) {
  if (DISABLE_EMAILS) return;
  const to = norm(ar.frontlinerEmail);
  if (!to) return;
  const requesterName = str(ar.frontlinerName);
  const loginUrl = `${frontendBaseUrl()}/customer/approvals/mine`;
  try {
    await sendMail({
      kind: "CONFIRMATIONS",
      to,
      subject: `Your Travel Proposal Has Been ${action === "approve" ? "Approved" : "Declined"} — ${ar.ticketId || ""}`,
      html:
        action === "approve"
          ? buildProposalApprovedEmailHtml({ requesterName, ticketId: ar.ticketId, loginUrl })
          : buildProposalDeclinedEmailHtml({ requesterName, ticketId: ar.ticketId, loginUrl }),
    } as any);
  } catch {
    /* non-blocking */
  }
}

/**
 * "Ops" for a proposal: the staff who submitted it (latest SUBMITTED entry)
 * and the staff who drafted it. No shared ops mailbox exists in config.
 */
export function proposalOpsEmails(p: AnyObj): string[] {
  const hist = Array.isArray(p?.history) ? p.history : [];
  const submitter = [...hist].reverse().find((h: any) => str(h?.action) === "SUBMITTED");
  return Array.from(new Set([norm(submitter?.byEmail), norm(p?.requesterEmail)].filter(Boolean)));
}

async function notifyOpsOfProposalOutcome(p: AnyObj, ar: AnyObj, outcome: string, byName: string, note: string) {
  if (DISABLE_EMAILS) return;
  const to = proposalOpsEmails(p);
  if (!to.length) return;
  const code = str(ar?.ticketId) || String(ar?._id || "").slice(-6).toUpperCase();
  const label = outcome === "APPROVED" ? "approved" : outcome === "DECLINED" ? "declined" : "sent back with changes requested";
  const url = `${frontendBaseUrl()}/admin/proposals/by-request?requestId=${encodeURIComponent(String(ar?._id || ""))}`;
  try {
    await sendMail({
      kind: "REQUESTS",
      to: to.join(","),
      subject: `Proposal ${outcome === "CHANGES_REQUESTED" ? "changes requested" : label} — ${code}`,
      html: buildEmailShell(
        `${eCard(`
          ${eLabel(`Proposal v${p?.version ?? ""} ${label}`)}
          <div style="font-size:13px;line-height:1.65;color:#334155;">
            Request <b>${escapeHtml(code)}</b> (${escapeHtml(str(ar?.customerName) || "Workspace")}) — proposal ${label}
            by <b>${escapeHtml(byName)}</b>.
            ${note ? `<div style="margin-top:10px;padding:10px 12px;border-radius:10px;background:#f8fafc;border:1px solid #e2e8f0;white-space:pre-wrap;">${escapeHtml(note)}</div>` : ""}
          </div>
        `)}
        <div style="margin-top:16px;">${eBtn("Open the proposal", url, "#00477f", "#ffffff")}</div>`,
        { title: `Proposal ${label}`, badgeText: outcome.replace("_", " "), badgeColor: outcome === "APPROVED" ? "#10b981" : outcome === "DECLINED" ? "#dc2626" : "#f59e0b" },
      ),
    } as any);
  } catch {
    /* non-blocking */
  }
}

function proposalCode(ar: AnyObj) {
  return str(ar?.ticketId) || String(ar?._id || "").slice(-6).toUpperCase();
}

/** The approver and every Workspace Leader hear the final proposal decision. */
async function notifyDecidersOfProposalDecision(
  ar: AnyObj,
  proposal: AnyObj,
  decision: "APPROVED" | "DECLINED" | "CHANGES_REQUESTED",
  byName: string,
  reason: string,
) {
  if (DISABLE_EMAILS) return;
  const to = await proposalDeciders(ar);
  if (!to.length) return;
  const verb = decision === "APPROVED" ? "approved" : decision === "DECLINED" ? "declined" : "sent back for changes";
  try {
    await sendMail({
      kind: "APPROVALS",
      to: to.join(","),
      subject: `Proposal ${verb} — ${proposalCode(ar)}`,
      html: buildEmailShell(
        `${eCard(`
          ${eLabel(`Proposal ${verb}`)}
          <div style="font-size:13px;line-height:1.65;color:#334155;">
            The proposal (v${escapeHtml(String(proposal?.version ?? ""))}) for ${escapeHtml(str(ar?.frontlinerName) || "the requester")}'s
            request <b>${escapeHtml(proposalCode(ar))}</b> was <b>${verb}</b> by <b>${escapeHtml(byName)}</b>.
            ${reason ? `<br/><br/><b>Note:</b> ${escapeHtml(stripPriceText(reason))}` : ""}
            <br/><br/>No action is needed from you.
          </div>
        `)}`,
        { title: `Proposal ${verb}`, badgeText: decision.replace("_", " "), badgeColor: decision === "APPROVED" ? "#10b981" : decision === "DECLINED" ? "#dc2626" : "#f59e0b" },
      ),
    } as any);
  } catch {
    /* non-blocking */
  }
}

