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

//
// Who hears about each decision is the email map (approvalEmails/map.ts);
// this file only says WHICH event happened.

import ApprovalRequest from "../models/ApprovalRequest.js";
import Proposal from "../models/Proposal.js";
import { autoAllocate } from "./travelDesk.js";
import { actorName, actorStamp, TRAVEL_DESK_NAME } from "./actorNames.js";
import {
  workspaceOf,
  activeLeaderEmails,
  isUserInactive,
  requestDeciders,
  proposalDeciders,
  proposalOpsEmails,
} from "./approvalDeciders.js";
import { notifySafely } from "./approvalEmails/dispatch.js";
import type { EmailCtx } from "./approvalEmails/templates.js";
import {
  hasWorkflow,
  currentStepOf,
  assigneeEmails,
  isWatcher,
  nextApproverStep,
  type WorkflowSnapshot,
} from "./approvalWorkflow/engine.js";

export { workspaceOf, activeLeaderEmails, requestDeciders, proposalDeciders, proposalOpsEmails };
export { decisionLinkUrl } from "./approvalEmails/links.js";

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

async function assertActorMayDecide(deciders: string[], actor: DecisionActor, ar: AnyObj) {
  const requesterEmail = ar?.frontlinerEmail;
  const email = norm(actor.email);
  if (email && email === norm(requesterEmail) && !deciders.includes(email)) {
    throw new DecisionError(403, "SELF_APPROVAL_NOT_ALLOWED", "You cannot approve or decline your own request.");
  }
  if (!email || !deciders.includes(email)) {
    throw new DecisionError(403, "NOT_AN_APPROVER", "You are no longer an approver for this request.");
  }
  // Inactive in the request's company (a suspended second-company membership counts).
  if (await isUserInactive(email, ar?.workspaceId?._id || ar?.workspaceId || ar?.meta?.customerWorkspaceId)) {
    throw new DecisionError(403, "NOT_AN_APPROVER", "Your account is not active.");
  }
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

  // Raised under an approval workflow: its chain decides (step engine below).
  if (hasWorkflow(ar)) return applyWorkflowDecision(ar, actor, action, reason);

  await assertActorMayDecide(await requestDeciders(ar), actor, ar);

  const email = norm(actor.email);
  // The person who clicked — never the approver on file (a delegate or a
  // Workspace Leader may decide).
  const name = str(actor.name) || (await actorName(actor)) || email;
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

  const ctx = { ar: doc, actorEmail: email, actorName: name, reason };
  if (action === "approved") {
    await Promise.all([notifySafely("request_approved", ctx), notifySafely("request_approved_fyi", ctx)]);
  } else if (action === "declined") {
    await Promise.all([notifySafely("request_declined", ctx), notifySafely("request_declined_fyi", ctx)]);
  } else {
    await notifySafely("clarification_asked", ctx);
  }

  // Approved → it is now in the ops queue: Travel Desk auto-allocation, and the desk hears.
  if (action === "approved") {
    const allocated = await enterOpsQueue(doc, name);
    if (allocated.assignedTo || allocated.flagged) return (await ApprovalRequest.findById(doc._id).exec()) || doc;
  }
  return doc;
}

/* ───────────────────────── workflow decision (step engine) ───────────────────────── */

/**
 * A decision on a request raised under an approval workflow
 * (docs/audits/request-workflow-audit.md §12.2, D3):
 *   - a watcher can never decide (in-app or by link);
 *   - the current step's assignees decide; approving a step that is not the
 *     last moves the request to the next approver step (it stays pending,
 *     REQUEST_RAISED) and that step's assignees get "approval needed";
 *     approving the last one approves the request exactly as today
 *     (REQUEST_APPROVED / PROPOSAL_PENDING, ops queue, emails);
 *   - a decline at any step ends the request (REQUEST_DECLINED), as today;
 *   - Workspace Leaders, per leadersMayDecide: ALLOW → as an assignee;
 *     DENY → never; OVERRIDE_WITH_REASON → approve or decline the CURRENT
 *     STEP in-app only, with a mandatory reason (the step is OVERRIDDEN and
 *     the chain continues to the next approver step, or approves the request
 *     if it was the last; an override decline ends it like any decline),
 *     recorded in workflow.overrides and shown on the request and in the
 *     emails;
 *   - an email link may be used only by a current-step assignee;
 *   - first decision wins per step: the update is conditional on the round
 *     and the step index.
 */
async function applyWorkflowDecision(ar: AnyObj, actor: DecisionActor, action: RequestDecisionAction, reason: string): Promise<any> {
  const wf: WorkflowSnapshot = ar.workflow;
  const email = norm(actor.email);
  const { index, step } = currentStepOf(ar);

  if (email && isWatcher(ar, email)) {
    throw new DecisionError(
      403,
      "WATCHER_CANNOT_DECIDE",
      "You are copied on this request for information only. You cannot approve or decline it.",
    );
  }
  if (email && email === norm(ar?.frontlinerEmail)) {
    throw new DecisionError(403, "SELF_APPROVAL_NOT_ALLOWED", "You cannot approve or decline your own request.");
  }
  if (!step) throw new DecisionError(409, "ALREADY_DECIDED", "This request has already been decided.", { decided: decidedBy(ar) });

  const isAssignee = assigneeEmails(step).includes(email);
  let override = false;
  if (!isAssignee) {
    const leaders = await activeLeaderEmails(await workspaceOf(ar), ar);
    const isLeader = !!email && leaders.includes(email);
    if (actor.via === "email" || !isLeader || wf.leadersMayDecide === "DENY") {
      throw new DecisionError(403, "NOT_AN_APPROVER", "You are no longer an approver for this request.");
    }
    if (wf.leadersMayDecide === "OVERRIDE_WITH_REASON") {
      if (action === "clarify") {
        throw new DecisionError(403, "OVERRIDE_CLARIFY_NOT_ALLOWED", `Only ${step.label.toLowerCase()} can ask the requester a question.`);
      }
      if (!reason) {
        throw new DecisionError(
          400,
          "OVERRIDE_REASON_REQUIRED",
          `This request is waiting for ${step.label.toLowerCase()}. To ${action === "approved" ? "approve" : "decline"} it instead, give a reason.`,
        );
      }
      override = true;
    }
  }
  if (await isUserInactive(email, ar?.workspaceId?._id || ar?.workspaceId || ar?.meta?.customerWorkspaceId)) {
    throw new DecisionError(403, "NOT_AN_APPROVER", "Your account is not active.");
  }

  const name = str(actor.name) || (await actorName(actor)) || email;
  const now = new Date();
  const next: WorkflowSnapshot = JSON.parse(JSON.stringify(wf));
  const decided = { email, name, via: actor.via, override };
  const set: AnyObj = {};
  let advancedTo = -1;

  if (action === "clarify") {
    set.stage = "REQUEST_NEEDS_CLARIFICATION";
  } else if (action === "declined") {
    Object.assign(next.steps[index], { status: "DECLINED", decidedAt: now, decidedBy: decided, note: reason });
    next.currentStep = -1;
    next.pendingEmails = [];
    Object.assign(set, { status: "declined", stage: "REQUEST_DECLINED", adminState: "cancelled", approvedByEmail: email, approvedByName: name });
  } else {
    // An override decides the CURRENT step only; the chain then continues.
    Object.assign(next.steps[index], { status: override ? "OVERRIDDEN" : "APPROVED", decidedAt: now, decidedBy: decided, note: reason });
    advancedTo = nextApproverStep(next, index);
    if (advancedTo >= 0) {
      Object.assign(next.steps[advancedTo], { status: "PENDING", routedAt: now });
      next.currentStep = advancedTo;
      next.pendingEmails = assigneeEmails(next.steps[advancedTo]);
      const first = next.steps[advancedTo].assignees[0];
      Object.assign(set, { managerEmail: first.email, managerName: first.name || first.email, managerId: first.userId || undefined });
    } else {
      next.currentStep = -1;
      next.pendingEmails = [];
    }
  }
  const finalApproval = action === "approved" && advancedTo < 0;
  if (finalApproval) {
    Object.assign(set, { status: "approved", stage: approvedStageFor(ar), adminState: "pending", approvedByEmail: email, approvedByName: name });
  }
  if (override) {
    next.overrides = [...(next.overrides || []), { stepKey: step.key, action: action as "approved" | "declined", byEmail: email, byName: name, reason, at: now }];
  }
  if (action !== "clarify") set.workflow = next;

  // First decision wins, per step and round.
  const claimed = await ApprovalRequest.findOneAndUpdate(
    {
      _id: ar._id,
      status: "pending",
      stage: { $in: REQUEST_ACTIONABLE_STAGES },
      "workflow.round": wf.round,
      "workflow.currentStep": index,
    },
    { $set: set },
    { new: true },
  ).exec();
  if (!claimed) {
    const nowDoc: any = await ApprovalRequest.findOne({ _id: ar._id }).lean().exec();
    throw new DecisionError(409, "ALREADY_DECIDED", "This step has already been decided.", { decided: decidedBy(nowDoc || ar) });
  }

  const doc: any = await ApprovalRequest.findOne({ _id: ar._id }).exec();
  doc.history = Array.isArray(doc.history) ? doc.history : [];
  const base = action === "clarify" ? "clarification_requested" : advancedTo >= 0 ? "step_approved" : action;
  const overrideText = override ? `Workspace Leader override of ${step.label.toLowerCase()} — reason: ${reason}` : "";
  doc.history.push({
    action: actor.via === "email" ? `email_${base}` : base,
    at: now,
    by: actor.via === "email" ? `email:${email}` : actor.sub || "unknown",
    comment: overrideText || (advancedTo >= 0 ? `${step.label} approved${reason ? ` — ${reason}` : ""}` : reason || undefined),
    userEmail: email,
    userName: name,
  });
  if (action === "clarify") {
    doc.clarifications = Array.isArray(doc.clarifications) ? doc.clarifications : [];
    doc.clarifications.push({ kind: "question", text: reason, at: now, byEmail: email, byName: name });
  }
  await doc.save();

  const ctx: EmailCtx = { ar: doc, actorEmail: email, actorName: name, reason };
  if (override) ctx.override = { reason, stepLabel: step.label };
  if (advancedTo >= 0) {
    await notifySafely("request_step_pending", { ...ctx, stepLabel: step.label });
    return doc;
  }
  if (action === "approved") {
    await Promise.all([
      notifySafely("request_approved", ctx),
      notifySafely("request_approved_fyi", ctx),
      notifySafely("request_watcher_fyi", { ...ctx, watcherEvent: "approved" }),
      notifySafely("request_travel_admin_fyi", ctx),
    ]);
    const allocated = await enterOpsQueue(doc, name);
    if (allocated.assignedTo || allocated.flagged) return (await ApprovalRequest.findById(doc._id).exec()) || doc;
  } else if (action === "declined") {
    await Promise.all([
      notifySafely("request_declined", ctx),
      notifySafely("request_declined_fyi", ctx),
      notifySafely("request_watcher_fyi", { ...ctx, watcherEvent: "declined" }),
    ]);
  } else {
    await notifySafely("clarification_asked", ctx);
  }
  return doc;
}

/**
 * A request has just entered the ops queue (approved, or auto-approved at
 * submit): Travel Desk auto-allocation (never throws), then one email to the
 * ops desk — "new case" (saying who it went to), or "no agent available"
 * when allocation found nobody.
 */
export async function enterOpsQueue(ar: AnyObj, approvedByName?: string) {
  const allocated = await autoAllocate(String(ar._id));
  try {
    const fresh: any = (await ApprovalRequest.findById(ar._id).lean().exec()) || ar;
    await notifySafely(allocated.flagged ? "ops_no_agent" : "ops_new_case", {
      ar: fresh,
      actorName: approvedByName,
      assignedToName: str(fresh?.meta?.adminAssigned?.agentName),
    });
  } catch (err: any) {
    // Never fails the approval that put it in the queue.
    console.error("[approval-emails] ops desk notice failed", { requestId: String(ar?._id || ""), error: err?.message });
  }
  return allocated;
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
  const name = str(opts.actor.name) || (await actorName(opts.actor)) || email;
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

  // The reply goes back to whoever asked (a Workspace Leader may have asked,
  // not the assigned approver) — while they can still decide.
  const deciders = await requestDeciders(doc);
  const askedBy = norm(question?.byEmail);
  const manager = norm(doc.managerEmail);
  const asker = deciders.includes(askedBy) ? askedBy : deciders.includes(manager) ? manager : deciders[0] || manager;
  await notifySafely("clarification_answered", {
    ar: doc,
    asker,
    question: str(question?.text),
    reply,
    edited: !!opts.edited,
  });
  return doc;
}

/* ───────────────────────── proposal decision ───────────────────────── */

/** request_changes: back to ops with a note; ops revise and resubmit. */
export type ProposalDecisionAction = "approve" | "decline" | "request_changes";

/**
 * Who decided a proposal, as customer-side readers may see it. A decision ops
 * recorded on the customer's behalf (history RECORDED_*) carries the staff
 * member's name and email in the decision slot — shown as the Travel Desk.
 */
export function proposalDecidedBy(p: AnyObj) {
  const last = [...(Array.isArray(p?.history) ? p.history : [])]
    .reverse()
    .find((h: any) => /^(RECORDED_|EMAIL_)?(APPROVED|DECLINED|CHANGES_REQUESTED)$/.test(str(h?.action)));
  const recorded = /^RECORDED_/.test(str(last?.action));
  const who = (byName: any, byEmail: any) =>
    recorded ? { byName: TRAVEL_DESK_NAME, byEmail: "" } : { byName: str(byName), byEmail: str(byEmail) };
  if (str(p?.status) === "CHANGES_REQUESTED") {
    const c = p?.customer || {};
    return { status: "CHANGES_REQUESTED", decision: "CHANGES_REQUESTED", ...who(c.byName, c.byEmail), at: c.at || null };
  }
  const d = p?.approvals?.l2 || {};
  return {
    status: str(p?.status),
    decision: str(d.decision),
    ...who(d.byName, d.byEmail),
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
    ? // Customers read this note: the travel desk, never a staff name or email
      // (staff see who recorded it from the row's actor).
      `Recorded by ${TRAVEL_DESK_NAME} on behalf of the customer: ${note}`
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

  if (!onBehalf) await assertActorMayDecide(await proposalDeciders(ar), actor, ar);

  const email = norm(actor.email);
  const name = str(actor.name) || (await actorName(actor)) || email;

  if (action === "request_changes") {
    const back: any = await Proposal.findOneAndUpdate(
      { _id: p._id, status: "SUBMITTED" },
      {
        $set: {
          status: "CHANGES_REQUESTED",
          customer: { action: "needs_changes", note: reason, at: new Date(), byEmail: email, byName: name },
        },
        $push: {
          history: { action: `${onBehalf ? "RECORDED_" : actor.via === "email" ? "EMAIL_" : ""}CHANGES_REQUESTED`, at: new Date(), byEmail: email, byName: name, note: reason, ...actorStamp(actor, onBehalf ? "staff" : "customer") },
        },
      },
      { new: true },
    ).exec();
    if (!back) {
      const now: any = await Proposal.findOne({ _id: p._id }).lean().exec();
      throw new DecisionError(409, "ALREADY_DECIDED", "This proposal has already been decided.", { decided: proposalDecidedBy(now || p) });
    }
    await setProposalPhaseStage(ar._id, "PROPOSAL_CHANGES_REQUESTED");
    await announceProposalDecision(ar, back, "CHANGES_REQUESTED", { email, name, onBehalf, reason, note });
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
          ...actorStamp(actor, onBehalf ? "staff" : "customer"),
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
  await announceProposalDecision(ar, updated, decision.decision as "APPROVED" | "DECLINED", { email, name, onBehalf, reason, note });
  return { proposal: updated, request: ar };
}

/**
 * One proposal decision, three audiences (approvalEmails/map.ts):
 *   - the requester (approved / declined / changes requested);
 *   - the other deciders, FYI — never the person who decided. Recorded on
 *     the customer's behalf: shown as the Travel Desk and nobody is skipped;
 *   - the ops desk, copying the assigned agent and the proposal's staff.
 */
async function announceProposalDecision(
  ar: AnyObj,
  proposal: AnyObj,
  decision: "APPROVED" | "DECLINED" | "CHANGES_REQUESTED",
  who: { email: string; name: string; onBehalf: boolean; reason: string; note: string },
) {
  const customerSide = {
    ar,
    proposal,
    decision,
    reason: who.reason,
    actorEmail: who.onBehalf ? "" : who.email,
    actorName: who.onBehalf ? TRAVEL_DESK_NAME : who.name,
  };
  await Promise.all([
    notifySafely(
      decision === "APPROVED" ? "proposal_approved" : decision === "DECLINED" ? "proposal_declined" : "proposal_changes_requested",
      customerSide,
    ),
    notifySafely("proposal_decision_fyi", customerSide),
    notifySafely("ops_proposal_outcome", {
      ar,
      proposal,
      decision,
      reason: who.onBehalf ? who.note : who.reason,
      actorEmail: who.email,
      actorName: who.onBehalf ? `${who.name || who.email} (recorded on the customer's behalf)` : who.name,
    }),
  ]);
}
