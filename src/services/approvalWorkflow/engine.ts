// apps/backend/src/services/approvalWorkflow/engine.ts
//
// The step engine (docs/audits/request-workflow-audit.md §12.2). Only for a
// request that carries a `workflow` snapshot — written at submit when the
// workspace has a workflow in force (store.ts activeWorkflowFor). A request
// without one never reaches this file: today's routing is untouched.
//
//   buildWorkflowSnapshot  resolve every step for the requester, once (D5:
//                          never re-resolved mid-request, not even on resubmit)
//   currentStepOf          the step waiting for a decision (-1 = none)
//   stepClaim              "<round>.<index>.<key>" — carried by email links;
//                          a link whose claim is not the current one is stale
//   workflowDeciders       who may decide now (the current step's assignees,
//                          plus Workspace Leaders only when leadersMayDecide is
//                          ALLOW); watchers never
//   linkRecipients         who may get a decision LINK: current step
//                          assignees only (D3), whatever leadersMayDecide says
//   nextAfterApproval      what an approval of the current step leads to
//   resubmitReset          a declined request sent back: the same chain from
//                          its first approver step, round + 1
//
// Steps:  APPROVER  blocks until approved / declined (or clarified)
//         WATCHER   never blocks; its assignees can view and get the FYI
//                   emails their step lists, and can never decide
import mongoose from "mongoose";
import TravellerProfile from "../../models/TravellerProfile.js";
import Department from "../../models/Department.js";
import User from "../../models/User.js";
import { isUserInactive } from "../approvalDeciders.js";
import type { WorkflowConfig, WorkflowStep } from "./config.js";

type AnyObj = Record<string, any>;
const str = (v: any) => String(v ?? "").trim();
const norm = (v: any) => str(v).toLowerCase();
const oid = (v: any) => (mongoose.Types.ObjectId.isValid(str(v)) ? new mongoose.Types.ObjectId(str(v)) : null);

export type Assignee = { userId: string; email: string; name: string };
export type StepStatus = "WAITING" | "PENDING" | "APPROVED" | "DECLINED" | "SKIPPED" | "AUTO_PASSED" | "WATCHING" | "OVERRIDDEN";

/** Why a step went to someone other than its own type's person (D2 — shown on the request). */
export type FallbackReason =
  | "NO_TRAVELLER_PROFILE"
  | "DUPLICATE_TRAVELLER_PROFILES"
  | "NO_DEPARTMENT"
  | "NO_DEPARTMENT_HEAD"
  | "DEPARTMENT_HEAD_INACTIVE"
  | "REQUESTER_IS_DEPARTMENT_HEAD"
  | "NO_REPORTING_MANAGER"
  | "REPORTING_MANAGER_INACTIVE"
  | "REQUESTER_IS_REPORTING_MANAGER"
  | "NO_DEFAULT_APPROVER";

export const FALLBACK_TEXT: Record<FallbackReason, string> = {
  NO_TRAVELLER_PROFILE: "no traveller profile linked to the requester",
  DUPLICATE_TRAVELLER_PROFILES: "the requester is linked to more than one traveller profile",
  NO_DEPARTMENT: "no department set",
  NO_DEPARTMENT_HEAD: "no department head set",
  DEPARTMENT_HEAD_INACTIVE: "the department head's account is inactive",
  REQUESTER_IS_DEPARTMENT_HEAD: "the requester is the department head",
  NO_REPORTING_MANAGER: "no reporting manager set",
  REPORTING_MANAGER_INACTIVE: "the reporting manager's account is inactive",
  REQUESTER_IS_REPORTING_MANAGER: "the requester is their own reporting manager",
  NO_DEFAULT_APPROVER: "no default approver or Workspace Leader",
};

export interface SnapshotStep {
  key: string;
  label: string;
  phase: "REQUEST";
  type: WorkflowStep["type"];
  role: WorkflowStep["role"];
  decisionRule: "ANY";
  assignees: Assignee[];
  /** How the assignees were found, e.g. DEPARTMENT_HEAD, FALLBACK_DEFAULT_APPROVER, REPORTING_MANAGER_REQUESTER_IS_HEAD. */
  resolvedVia: string;
  fallbackReason: FallbackReason | null;
  /** Human text for the request page and emails, e.g. "Routed to fallback: no department head set". Empty when not a fallback. */
  routingNote: string;
  status: StepStatus;
  watcherEvents: string[];
  routedAt: Date | null;
  decidedAt: Date | null;
  decidedBy: { email: string; name: string; via: "app" | "email"; override: boolean } | null;
  note: string;
}

export interface WorkflowSnapshot {
  versionId: string;
  versionNumber: number;
  /** Bumped on every resubmit; part of the link claim so a link from an earlier round is stale. */
  round: number;
  leadersMayDecide: WorkflowConfig["leadersMayDecide"];
  completion: WorkflowConfig["completion"];
  requestOnlyMode: boolean;
  currentStep: number;
  /** The current step's assignees (indexed; the inbox reads it). */
  pendingEmails: string[];
  /** Every WATCHING step's assignees (indexed; the FYI bucket reads it). */
  watcherEmails: string[];
  /** D1: snapshot of email.travelAdminEmails. */
  travelAdminEmails: string[];
  purpose: { code: string; text: string } | null;
  steps: SnapshotStep[];
  overrides: Array<{ stepKey: string; action: "approved" | "declined"; byEmail: string; byName: string; reason: string; at: Date }>;
}

export class WorkflowRoutingError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/* ───────────────────────── resolution ───────────────────────── */

type Ctx = {
  ws: AnyObj;
  workspaceId: mongoose.Types.ObjectId;
  requester: { id: string; email: string };
  leaderEmails: string[];
  profile?: { doc: AnyObj | null; reason: FallbackReason | null };
};

async function activeUserById(id: any, ctx: Ctx): Promise<Assignee | null> {
  const _id = oid(id);
  if (!_id) return null;
  const u: any = await User.findOne({ _id }).select("email name firstName lastName status").lean().exec();
  if (!u?.email || String(u.status || "").toUpperCase() === "INACTIVE") return null;
  if (await isUserInactive(norm(u.email), ctx.workspaceId)) return null;
  return { userId: String(u._id), email: norm(u.email), name: personLabel(u) };
}

async function activeUserByEmail(email: string, ctx: Ctx): Promise<Assignee | null> {
  const e = norm(email);
  if (!e) return null;
  const rx = new RegExp(`^${e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const u: any = await User.findOne({ email: rx }).select("email name firstName lastName status").lean().exec();
  if (u && String(u.status || "").toUpperCase() === "INACTIVE") return null;
  if (await isUserInactive(e, ctx.workspaceId)) return null;
  return { userId: u ? String(u._id) : "", email: e, name: u ? personLabel(u) : "" };
}

function personLabel(u: AnyObj): string {
  return str([u?.firstName, u?.lastName].filter(Boolean).join(" ")) || str(u?.name) || norm(u?.email).split("@")[0] || "";
}

/** The requester's claimed traveller profile in this workspace — exactly one, else a reason. */
async function profileOf(ctx: Ctx) {
  if (ctx.profile) return ctx.profile;
  const userId = oid(ctx.requester.id);
  const docs: any[] = userId
    ? await TravellerProfile.find({ workspaceId: ctx.workspaceId, isActive: true, claimedBy: userId })
        .select("departmentId reportingManagerId")
        .lean()
        .exec()
    : [];
  ctx.profile =
    docs.length === 1
      ? { doc: docs[0], reason: null }
      : { doc: null, reason: docs.length ? "DUPLICATE_TRAVELLER_PROFILES" : "NO_TRAVELLER_PROFILE" };
  return ctx.profile;
}

type Found = { assignees: Assignee[]; resolvedVia: string; reason: FallbackReason | null };
const none = (reason: FallbackReason): Found => ({ assignees: [], resolvedVia: "", reason });

/** Today's approver, as the fallback: defaultApproverEmails[0], then the Workspace Leaders — never the requester. */
async function defaultApprover(ctx: Ctx): Promise<Found> {
  const approvers: string[] = (Array.isArray(ctx.ws?.defaultApproverEmails) ? ctx.ws.defaultApproverEmails : []).map(norm).filter(Boolean);
  const candidates = Array.from(new Set([approvers[0], ...ctx.leaderEmails.map(norm)].filter(Boolean)));
  for (const e of candidates) {
    if (e === norm(ctx.requester.email)) continue;
    const a = await activeUserByEmail(e, ctx);
    if (a) return { assignees: [a], resolvedVia: e === approvers[0] ? "DEFAULT_APPROVER" : "WORKSPACE_LEADER", reason: null };
  }
  return none("NO_DEFAULT_APPROVER");
}

async function reportingManager(ctx: Ctx): Promise<Found> {
  const p = await profileOf(ctx);
  if (!p.doc) return none(p.reason!);
  if (!p.doc.reportingManagerId) return none("NO_REPORTING_MANAGER");
  const a = await activeUserById(p.doc.reportingManagerId, ctx);
  if (!a) return none("REPORTING_MANAGER_INACTIVE");
  if (a.userId === ctx.requester.id || a.email === norm(ctx.requester.email)) return none("REQUESTER_IS_REPORTING_MANAGER");
  return { assignees: [a], resolvedVia: "REPORTING_MANAGER", reason: null };
}

async function departmentHead(ctx: Ctx): Promise<Found> {
  const p = await profileOf(ctx);
  if (!p.doc) return none(p.reason!);
  const deptId = oid(p.doc.departmentId);
  const dept: any = deptId ? await Department.findOne({ _id: deptId, workspaceId: ctx.workspaceId }).select("managerId isActive").lean().exec() : null;
  if (!dept || dept.isActive === false) return none("NO_DEPARTMENT");
  if (!dept.managerId) return none("NO_DEPARTMENT_HEAD");
  const a = await activeUserById(dept.managerId, ctx);
  if (!a) return none("DEPARTMENT_HEAD_INACTIVE");
  if (a.userId === ctx.requester.id || a.email === norm(ctx.requester.email)) return none("REQUESTER_IS_DEPARTMENT_HEAD");
  return { assignees: [a], resolvedVia: "DEPARTMENT_HEAD", reason: null };
}

async function resolveStep(step: WorkflowStep, ctx: Ctx): Promise<Found & { refuse?: string }> {
  let found: Found;
  if (step.type === "DEFAULT_APPROVER") found = await defaultApprover(ctx);
  else if (step.type === "REPORTING_MANAGER") found = await reportingManager(ctx);
  else if (step.type === "DEPARTMENT_HEAD") found = await departmentHead(ctx);
  else throw new WorkflowRoutingError(500, "STEP_TYPE_NOT_SUPPORTED", `Step type ${step.type} is not supported.`);
  if (found.assignees.length) return found;

  const self = found.reason === "REQUESTER_IS_DEPARTMENT_HEAD" || found.reason === "REQUESTER_IS_REPORTING_MANAGER";
  if (self) {
    if (step.selfRule === "REFUSE") return { ...found, refuse: FALLBACK_TEXT[found.reason!] };
    if (step.selfRule === "SKIP") return found;
    // NEXT_IN_LINE (D4): a head raising their own request goes to their reporting manager.
    if (step.type === "DEPARTMENT_HEAD") {
      const rm = await reportingManager(ctx);
      if (rm.assignees.length) return { assignees: rm.assignees, resolvedVia: "REPORTING_MANAGER_REQUESTER_IS_HEAD", reason: found.reason };
    }
  }
  if (step.fallback === "REFUSE_SUBMIT") return { ...found, refuse: FALLBACK_TEXT[found.reason!] };
  if (step.fallback === "DEFAULT_APPROVER" && step.type !== "DEFAULT_APPROVER") {
    const d = await defaultApprover(ctx);
    if (d.assignees.length) return { assignees: d.assignees, resolvedVia: `FALLBACK_${d.resolvedVia}`, reason: found.reason };
  }
  return found; // SKIP, or a fallback that found nobody either
}

/**
 * Resolve the whole chain for one requester. Returns the snapshot and who the
 * request goes to first, or { autoApprove } when nobody but a Workspace Leader
 * requester could approve (today's rule), or throws WorkflowRoutingError.
 */
export async function buildWorkflowSnapshot(opts: {
  version: AnyObj & WorkflowConfig;
  ws: AnyObj;
  workspaceId: any;
  requester: { id: string; email: string };
  leaderEmails: string[];
  actorIsLeader: boolean;
  purpose?: { code: string; text: string } | null;
  now?: Date;
}): Promise<{ workflow: WorkflowSnapshot; approver: Assignee | null; autoApprove: boolean }> {
  const now = opts.now || new Date();
  const ctx: Ctx = {
    ws: opts.ws || {},
    workspaceId: oid(opts.workspaceId)!,
    requester: { id: str(opts.requester.id), email: norm(opts.requester.email) },
    leaderEmails: opts.leaderEmails.map(norm),
  };
  const approversSoFar = new Set<string>();
  const steps: SnapshotStep[] = [];
  for (const s of opts.version.steps) {
    const r = await resolveStep(s, ctx);
    if (r.refuse) {
      throw new WorkflowRoutingError(
        400,
        "WORKFLOW_NO_APPROVER",
        `This request can't be routed for "${s.label}": ${r.refuse}. Ask your travel admin to fix it.`,
      );
    }
    let assignees = r.assignees.filter((a) => a.email !== ctx.requester.email);
    let status: StepStatus;
    if (s.role === "WATCHER") {
      // Someone who approves is not also a watcher.
      assignees = assignees.filter((a) => !approversSoFar.has(a.email));
      status = assignees.length ? "WATCHING" : "SKIPPED";
    } else if (!assignees.length) {
      status = "SKIPPED";
    } else if (s.samePersonRule === "AUTO_PASS" && assignees.every((a) => approversSoFar.has(a.email))) {
      status = "AUTO_PASSED";
    } else {
      status = "WAITING";
      assignees.forEach((a) => approversSoFar.add(a.email));
    }
    const fallback = !!r.reason && assignees.length > 0;
    steps.push({
      key: s.key,
      label: s.label,
      phase: "REQUEST",
      type: s.type,
      role: s.role,
      decisionRule: "ANY",
      assignees,
      resolvedVia: assignees.length ? r.resolvedVia : `NONE`,
      fallbackReason: r.reason,
      routingNote: r.reason ? `${fallback ? "Routed to fallback" : "Skipped"}: ${FALLBACK_TEXT[r.reason]}` : "",
      status,
      watcherEvents: s.role === "WATCHER" ? [...s.watcherEvents] : [],
      routedAt: null,
      decidedAt: null,
      decidedBy: null,
      note: "",
    });
  }
  // A watcher resolved BEFORE an approver step that turned out to be the same person is dropped too.
  for (const st of steps) {
    if (st.role !== "WATCHER") continue;
    st.assignees = st.assignees.filter((a) => !approversSoFar.has(a.email));
    if (!st.assignees.length && st.status === "WATCHING") st.status = "SKIPPED";
  }

  const first = steps.findIndex((s) => s.role === "APPROVER" && s.status === "WAITING");
  if (first >= 0) {
    steps[first].status = "PENDING";
    steps[first].routedAt = now;
  }
  const workflow: WorkflowSnapshot = {
    versionId: String(opts.version._id || ""),
    versionNumber: Number(opts.version.versionNumber || 0),
    round: 1,
    leadersMayDecide: opts.version.leadersMayDecide,
    completion: opts.version.completion,
    requestOnlyMode: !!opts.version.requestOnlyMode,
    currentStep: first,
    pendingEmails: first >= 0 ? steps[first].assignees.map((a) => a.email) : [],
    watcherEmails: Array.from(new Set(steps.filter((s) => s.status === "WATCHING").flatMap((s) => s.assignees.map((a) => a.email)))),
    travelAdminEmails: [...(opts.version.email?.travelAdminEmails || [])],
    purpose: opts.purpose || null,
    steps,
    overrides: [],
  };
  if (first >= 0) return { workflow, approver: steps[first].assignees[0], autoApprove: false };
  // Nobody to approve. A Workspace Leader requester is auto-approved, as today; anyone else is refused.
  if (opts.actorIsLeader) return { workflow, approver: null, autoApprove: true };
  throw new WorkflowRoutingError(
    400,
    "WORKFLOW_NO_APPROVER",
    "There is nobody to approve this request (no department head, reporting manager or default approver). Ask your travel admin to set one.",
  );
}

/* ───────────────────────── reading a snapshot ───────────────────────── */

export const hasWorkflow = (ar: AnyObj | null | undefined): boolean => !!ar?.workflow && Array.isArray(ar.workflow.steps);

export function currentStepOf(ar: AnyObj): { index: number; step: SnapshotStep | null } {
  const wf = ar?.workflow;
  const i = Number(wf?.currentStep);
  const step = Number.isInteger(i) && i >= 0 ? (wf?.steps?.[i] as SnapshotStep) || null : null;
  return { index: step ? i : -1, step };
}

/** The claim an email link carries; undefined for a request without a workflow. */
export function stepClaim(ar: AnyObj): string | undefined {
  if (!hasWorkflow(ar)) return undefined;
  const { index, step } = currentStepOf(ar);
  return step ? `${Number(ar.workflow.round || 1)}.${index}.${step.key}` : "closed";
}

export const assigneeEmails = (step: SnapshotStep | null | undefined) => (step?.assignees || []).map((a) => norm(a.email)).filter(Boolean);

export function watcherEmailsOf(ar: AnyObj): string[] {
  return (Array.isArray(ar?.workflow?.watcherEmails) ? ar.workflow.watcherEmails : []).map(norm).filter(Boolean);
}

export function isWatcher(ar: AnyObj, email: string): boolean {
  return hasWorkflow(ar) && watcherEmailsOf(ar).includes(norm(email));
}

/** Anyone named on the request's chain (any step, approver or watcher): may VIEW it. */
export function isWorkflowParticipant(ar: AnyObj, email: string): boolean {
  if (!hasWorkflow(ar)) return false;
  const e = norm(email);
  if (!e) return false;
  return (ar.workflow.steps as SnapshotStep[]).some((s) => assigneeEmails(s).includes(e));
}

/** Current step assignees only — the only people a decision LINK is ever sent to (D3). */
export function linkRecipients(ar: AnyObj): string[] {
  const { step } = currentStepOf(ar);
  if (!step || step.role !== "APPROVER") return [];
  const requester = norm(ar?.frontlinerEmail);
  const watchers = watcherEmailsOf(ar);
  return assigneeEmails(step).filter((e) => e !== requester && !watchers.includes(e));
}

/**
 * Who may decide a workflow request now: the current step's assignees, plus
 * active Workspace Leaders when leadersMayDecide is ALLOW. (Under
 * OVERRIDE_WITH_REASON a leader decides only through the override path, which
 * needs a reason.) Once the chain is finished: everyone who was on an approver
 * step, and leaders unless DENY — the FYI audience. Never the requester,
 * never a watcher.
 */
export function workflowDeciders(ar: AnyObj, leaders: string[]): string[] {
  const wf = ar.workflow;
  const requester = norm(ar?.frontlinerEmail);
  const watchers = watcherEmailsOf(ar);
  const { step } = currentStepOf(ar);
  const out: string[] = [];
  const add = (e: string) => e && !out.includes(e) && out.push(e);
  if (step) {
    assigneeEmails(step).forEach(add);
    if (wf.leadersMayDecide === "ALLOW") leaders.map(norm).forEach(add);
  } else {
    for (const s of wf.steps as SnapshotStep[]) {
      if (s.role === "APPROVER" && ["APPROVED", "DECLINED", "PENDING", "OVERRIDDEN"].includes(s.status)) assigneeEmails(s).forEach(add);
    }
    if (wf.leadersMayDecide !== "DENY") leaders.map(norm).forEach(add);
  }
  return out.filter((e) => e !== requester && !watchers.includes(e));
}

/** The last approver step's assignees (for a Flow 2 proposal under a workflow), plus leaders unless DENY. */
export function workflowProposalDeciders(ar: AnyObj, leaders: string[]): string[] {
  const steps = (ar.workflow.steps as SnapshotStep[]).filter((s) => s.role === "APPROVER" && s.assignees.length);
  const last = steps[steps.length - 1];
  const out = new Set<string>(assigneeEmails(last));
  if (ar.workflow.leadersMayDecide !== "DENY") leaders.map(norm).forEach((e) => out.add(e));
  const watchers = watcherEmailsOf(ar);
  const requester = norm(ar?.frontlinerEmail);
  const all = Array.from(out).filter((e) => e && !watchers.includes(e));
  const others = all.filter((e) => e !== requester);
  if (others.length) return others;
  return leaders.map(norm).includes(requester) ? [requester] : [];
}

/** The next APPROVER step waiting after `index`, or -1 when the chain is finished. */
export function nextApproverStep(wf: AnyObj, index: number): number {
  const steps: SnapshotStep[] = wf.steps || [];
  for (let j = index + 1; j < steps.length; j++) {
    if (steps[j].role === "APPROVER" && steps[j].status === "WAITING") return j;
  }
  return -1;
}

/** A declined request sent back: the same chain (D5), from its first approver step, in a new round. */
export function resubmitReset(ar: AnyObj, now = new Date()): WorkflowSnapshot {
  const wf: WorkflowSnapshot = JSON.parse(JSON.stringify(ar.workflow));
  let first = -1;
  wf.steps.forEach((s, i) => {
    if (s.role !== "APPROVER") return;
    if (["PENDING", "APPROVED", "DECLINED", "OVERRIDDEN", "WAITING"].includes(s.status)) {
      s.status = "WAITING";
      s.decidedAt = null;
      s.decidedBy = null;
      s.note = "";
      s.routedAt = null;
      if (first < 0) first = i;
    }
  });
  if (first >= 0) {
    wf.steps[first].status = "PENDING";
    wf.steps[first].routedAt = now;
  }
  wf.round = Number(wf.round || 1) + 1;
  wf.currentStep = first;
  wf.pendingEmails = first >= 0 ? assigneeEmails(wf.steps[first]) : [];
  return wf;
}

const OPEN_STAGES = new Set(["", "REQUEST_RAISED", "REQUEST_ON_HOLD"]);

/**
 * What one viewer sees and may do on a workflow request (inbox rows, request
 * detail): their role, whether they may decide, whether only a Workspace
 * Leader override is open to them, and the step timeline with any fallback
 * note (D2) and override (D3). Names only on the steps.
 */
export async function workflowViewFor(ar: AnyObj, email: string) {
  if (!hasWorkflow(ar)) return null;
  const { activeLeaderEmails, workspaceOf } = await import("../approvalDeciders.js");
  const leaders = await activeLeaderEmails(await workspaceOf(ar), ar);
  const e = norm(email);
  const { step } = currentStepOf(ar);
  const watcher = isWatcher(ar, e);
  const requester = !!e && e === norm(ar?.frontlinerEmail);
  const assignee = !!step && assigneeEmails(step).includes(e);
  const leader = leaders.includes(e);
  const mode = ar.workflow.leadersMayDecide;
  const open = norm(ar?.status) === "pending" && OPEN_STAGES.has(str(ar?.stage).toUpperCase()) && !!step;
  const canDecide = open && !watcher && !requester && (assignee || (leader && mode === "ALLOW"));
  const canOverride = open && !watcher && !requester && !assignee && leader && mode === "OVERRIDE_WITH_REASON";
  return {
    role: watcher ? "WATCHER" : requester ? "REQUESTER" : assignee ? "APPROVER" : leader ? "LEADER" : "VIEWER",
    canDecide,
    canOverride,
    leadersMayDecide: mode,
    currentStep: step ? { key: step.key, label: step.label, names: step.assignees.map((a) => a.name || a.email) } : null,
    steps: (ar.workflow.steps as SnapshotStep[]).map((s) => ({
      key: s.key,
      label: s.label,
      role: s.role,
      status: s.status,
      names: s.assignees.map((a) => a.name || a.email),
      routingNote: s.routingNote || "",
      decidedByName: s.decidedBy?.name || "",
      decidedAt: s.decidedAt || null,
      override: !!s.decidedBy?.override,
      note: s.note || "",
    })),
    overrides: (ar.workflow.overrides || []).map((o: AnyObj) => ({ action: o.action, byName: o.byName, reason: o.reason, at: o.at })),
    purpose: ar.workflow.purpose || null,
  };
}
