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
import { frontendBaseUrl, DISABLE_EMAILS } from "../routes/approvals.security.js";
import {
  buildRequesterApprovedHtml,
  buildRequestDeclinedEmailHtml,
  buildRequestOnHoldEmailHtml,
  buildProposalApprovedEmailHtml,
  buildProposalDeclinedEmailHtml,
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

export type RequestDecisionAction = "approved" | "declined" | "on_hold";

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
  if (!["approved", "declined", "on_hold"].includes(action)) {
    throw new DecisionError(400, "INVALID_ACTION", "Invalid action");
  }
  if (action === "declined" && !reason) {
    throw new DecisionError(400, "REASON_REQUIRED", "A reason is required to decline.");
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
      : { status: "pending", stage: "REQUEST_ON_HOLD", adminState: "on_hold" };
  if (action !== "on_hold") Object.assign(set, { approvedByEmail: email, approvedByName: name });

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
  doc.history.push({
    action: actor.via === "email" ? `email_${action}` : action,
    at: new Date(),
    by: actor.via === "email" ? `email:${email}` : actor.sub || "unknown",
    comment: reason || undefined,
    userEmail: email,
    userName: name,
  });
  await doc.save();

  await notifyRequesterOfRequestDecision(doc, action, name, email, reason);
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
        subject: `Your Travel Request is On Hold — ${doc.ticketId || ""}`,
        html: buildRequestOnHoldEmailHtml({ ticketId: doc.ticketId, requesterName, managerName: approverName, comment: reason, loginUrl }),
      } as any);
    }
  } catch {
    /* non-blocking */
  }
}

/* ───────────────────────── proposal decision ───────────────────────── */

export type ProposalDecisionAction = "approve" | "decline";

export function proposalDecidedBy(p: AnyObj) {
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
}): Promise<{ proposal: any; request: any }> {
  const { actor, action } = opts;
  const reason = str(opts.reason);
  if (!["approve", "decline"].includes(action)) {
    throw new DecisionError(400, "INVALID_ACTION", "Invalid action");
  }
  if (action === "decline" && !reason) {
    throw new DecisionError(400, "REASON_REQUIRED", "A reason is required to decline.");
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

  await assertActorMayDecide(await proposalDeciders(ar), actor, ar.frontlinerEmail);

  const email = norm(actor.email);
  const name = str(actor.name) || email;
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
          action: `${actor.via === "email" ? "EMAIL_" : ""}${decision.decision}`,
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
