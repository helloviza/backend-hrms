// apps/backend/src/services/reports.service.ts
//
// Report lifecycle propagation. This module is the SINGLE writer of
// Expense.lifecycleStatus — every linkage/status change funnels through here so
// the hot read paths (list / summary / dashboard) can stay a plain field
// filter instead of a per-row report join.

import mongoose from "mongoose";
import Expense from "../models/Expense.js";
import Report, {
  type IReport,
  type ReportStatus,
  type IApprovalChainLevel,
  type ChainLevelStatus,
} from "../models/Report.js";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import ExpenseActivity, { type ExpenseActivityEvent } from "../models/ExpenseActivity.js";
import { refFromId } from "../utils/refFromId.js";
import { sendClaimSubmittedEmail } from "../utils/claimEmails.js";
import { isAdmin, userIdOf, ADMIN_ROLE_PREFILTER } from "./expense.access.js";
import { expenseAdminUserIds, withGrants } from "./expenseGrants.service.js";
import { appendActivity, lineSnapshot, msBetween } from "./expenseAudit.service.js";
import { SYSTEM_ACTOR, type ExpenseActorType } from "../models/ExpenseActivity.js";
import { getPolicy } from "./expensePolicy.service.js";
import { routeClaim, type RoutingDecision } from "./expenseRouting.service.js";
import { buildRoutingInput } from "./expenseRoutingInput.service.js";
import type { ReceiptVerdict } from "./receiptExtractions.service.js";
import { APPROVAL_BOT_ACTOR } from "../models/ExpenseActivity.js";
import { activeUserFilter } from "../utils/userActiveStatus.js";
import {
  amountBaseExpr,
  getWorkspaceBaseCurrency,
  isConversionPending,
} from "./expenseFx.service.js";

/* ──────────────────────────────────────────────────────────────────────
 * Activity / audit log.
 *
 * One append-only writer for the claim timeline (model: ExpenseActivity).
 * Co-located with the lifecycle writer: service transitions call it directly;
 * the route-resident transitions (approve / decline / clarification / reimburse
 * / single-expense removal) import and call it at their own save points.
 *
 * EVERY write stamps workspaceId. EVERY call is non-fatal — a logging failure
 * is swallowed (logged to console) so it can never block a lifecycle action.
 * ────────────────────────────────────────────────────────────────────── */
export async function logActivity(params: {
  workspaceId: mongoose.Types.ObjectId | string;
  reportId: mongoose.Types.ObjectId | string;
  event: ExpenseActivityEvent;
  actorName: string;
  actorId?: mongoose.Types.ObjectId | string | null;
  expenseId?: mongoose.Types.ObjectId | string | null;
  note?: string | null;
  // Audit plumbing (sub-step 2): who-vs-what, how long it sat with the actor,
  // and the structured payload. All optional — every pre-existing call site
  // keeps working and gets elapsedMs for free from appendActivity.
  actorType?: ExpenseActorType;
  heldMs?: number | null;
  details?: Record<string, any> | null;
}): Promise<void> {
  try {
    await appendActivity({
      workspaceId: params.workspaceId,
      reportId: params.reportId,
      expenseId: params.expenseId ?? null,
      event: params.event,
      actorId: params.actorId ?? null,
      actorName: params.actorName || "System",
      actorType: params.actorType,
      note: params.note ?? null,
      heldMs: params.heldMs ?? null,
      details: params.details ?? null,
    });
  } catch (err: any) {
    console.error("[expense activity log]", params.event, err?.message || err);
  }
}

/** Resolve a display name for an actor by id (best-effort; "" when unknown). */
async function actorNameById(userId: mongoose.Types.ObjectId | string): Promise<string> {
  try {
    const u: any = await User.findById(userId).select("firstName lastName name email").lean();
    return employeeNameOf(u);
  } catch {
    return "";
  }
}

// Owner-editable claim states — a draft, or one bounced back for clarification.
// Mirrors EDITABLE_STATUSES in routes/expenseReports.ts (the route gates the
// same set before mutating).
const EDITABLE_STATUSES = new Set<ReportStatus>(["draft", "clarification_required"]);

function employeeNameOf(u: any): string {
  if (!u || typeof u !== "object") return "";
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return full || u.name || u.email || "";
}

export type ExpenseLifecycle =
  | "pending_to_submit"
  | "awaiting_approval"
  | "approved"
  | "declined"
  | "clarification_required"
  | "reimbursed";

/** report.status → the lifecycleStatus its linked expenses should carry.
 *  draft AND clarification_required both mean "back in the owner's hands, not
 *  yet awaiting approval" → pending_to_submit (same as having no report). */
export function expenseLifecycleForReport(status: ReportStatus | null): ExpenseLifecycle {
  switch (status) {
    case "draft":
      return "pending_to_submit";
    case "clarification_required":
      return "clarification_required";
    case "submitted":
      return "awaiting_approval";
    case "approved":
      return "approved";
    case "declined":
      return "declined";
    case "reimbursed":
      return "reimbursed";
    default:
      return "pending_to_submit"; // no report
  }
}

/**
 * Set every expense linked to `reportId` to the lifecycle implied by
 * `reportStatus`. Used on report submit / (Layer 3) approve-reject-reimburse.
 *
 * workspaceId is stamped explicitly (defense-in-depth): a reportId is globally
 * unique and single-tenant, so matching by reportId alone is already safe, but
 * we honor the same "every query stamps workspaceId" chokepoint discipline.
 */
export async function propagateReportLifecycle(
  workspaceId: mongoose.Types.ObjectId | string,
  reportId: mongoose.Types.ObjectId | string,
  reportStatus: ReportStatus,
): Promise<number> {
  const lifecycle = expenseLifecycleForReport(reportStatus);
  const res = await Expense.updateMany(
    {
      workspaceId: new mongoose.Types.ObjectId(String(workspaceId)),
      reportId: new mongoose.Types.ObjectId(String(reportId)),
    },
    { $set: { lifecycleStatus: lifecycle } },
  );
  return res.modifiedCount ?? 0;
}

/* ──────────────────────────────────────────────────────────────────────
 * Pre-submission validation.
 *
 * Single extensible chokepoint for POST /reports/:id/submit. Returns two lists:
 *  • blocking  — submission MUST be refused (route returns 409 with the list).
 *  • warnings  — surfaced to the UI but MUST NOT prevent submit.
 *
 * Add new rules here (e.g. policy caps, FX, GSTIN format) without touching the
 * route. Messages are user-facing.
 * ────────────────────────────────────────────────────────────────────── */
export type ReportSubmitValidation = { blocking: string[]; warnings: string[] };

function expenseLabel(e: any): string {
  return e.ref || e.merchant || "An expense";
}

export async function validateReportForSubmit(
  workspaceId: mongoose.Types.ObjectId | string,
  reportId: mongoose.Types.ObjectId | string,
): Promise<ReportSubmitValidation> {
  const blocking: string[] = [];
  const warnings: string[] = [];

  const expenses = await Expense.find({
    workspaceId: new mongoose.Types.ObjectId(String(workspaceId)),
    reportId: new mongoose.Types.ObjectId(String(reportId)),
  })
    .select("ref merchant amount currency amountBase date imageKey categoryId")
    .lean();

  // BLOCKING: nothing to submit.
  if (expenses.length === 0) {
    blocking.push("Add at least one expense before submitting.");
    return { blocking, warnings };
  }

  // BLOCKING: every expense needs an amount and a date.
  for (const e of expenses) {
    if (e.amount == null || Number.isNaN(Number(e.amount))) {
      blocking.push(`${expenseLabel(e)} is missing an amount.`);
    }
    if (!e.date) {
      blocking.push(`${expenseLabel(e)} is missing a date.`);
    }
  }

  // BLOCKING (FX slice 0): every line must carry a resolved base-currency
  // amount — approval routes and pays on the base total, and a claim with a
  // conversion-pending line has no true total. Capture stays open; only the
  // submit waits for a rate (live at entry, or manual via PATCH /expenses/:id/rate).
  const baseCurrency = await getWorkspaceBaseCurrency(workspaceId);
  for (const e of expenses) {
    if (isConversionPending(e, baseCurrency)) {
      blocking.push(
        `${expenseLabel(e)} (${e.currency}) is awaiting a ${baseCurrency} exchange rate — enter one before submitting.`,
      );
    }
  }

  // WARNING (non-blocking): no receipt image.
  const noReceipt = expenses.filter((e) => !e.imageKey).length;
  if (noReceipt > 0) {
    warnings.push(
      `${noReceipt} expense${noReceipt === 1 ? "" : "s"} ${noReceipt === 1 ? "has" : "have"} no receipt attached.`,
    );
  }

  // WARNING (non-blocking): uncategorized.
  const noCategory = expenses.filter((e) => !e.categoryId).length;
  if (noCategory > 0) {
    warnings.push(
      `${noCategory} expense${noCategory === 1 ? "" : "s"} ${noCategory === 1 ? "has" : "have"} no category.`,
    );
  }

  // WARNING (non-blocking): likely-duplicate pairs (same merchant + amount + date).
  const seen = new Set<string>();
  let dupes = 0;
  for (const e of expenses) {
    const day = e.date ? new Date(e.date).toISOString().slice(0, 10) : "";
    const key = [String(e.merchant || "").trim().toLowerCase(), Number(e.amount) || 0, day].join("|");
    if (seen.has(key)) dupes++;
    else seen.add(key);
  }
  if (dupes > 0) {
    warnings.push(
      `${dupes} possible duplicate expense${dupes === 1 ? "" : "s"} (same merchant, amount and date).`,
    );
  }

  return { blocking, warnings };
}

/**
 * Unlink every expense from `reportId` and reset them to unreported. Used on
 * report delete. workspaceId stamped explicitly (see note above).
 */
export async function unlinkAllExpenses(
  workspaceId: mongoose.Types.ObjectId | string,
  reportId: mongoose.Types.ObjectId | string,
): Promise<number> {
  const res = await Expense.updateMany(
    {
      workspaceId: new mongoose.Types.ObjectId(String(workspaceId)),
      reportId: new mongoose.Types.ObjectId(String(reportId)),
    },
    { $set: { reportId: null, lifecycleStatus: "pending_to_submit" } },
  );
  return res.modifiedCount ?? 0;
}

/* ──────────────────────────────────────────────────────────────────────
 * Shared claim state machine.
 *
 * These are the SINGLE implementation of create / link / submit. Both the
 * /api/reports routes and the WhatsApp quick-submit call them so the two never
 * diverge. (Reads + Layer-3 approve/decline/reimburse stay in the route.)
 * ────────────────────────────────────────────────────────────────────── */

/** Create a DRAFT claim owned by `employeeId` (ref = CLM-XXXXXX). */
export async function createReport(
  workspaceId: mongoose.Types.ObjectId | string,
  employeeId: mongoose.Types.ObjectId | string,
  name: string,
): Promise<IReport> {
  const report = new Report({
    workspaceId: new mongoose.Types.ObjectId(String(workspaceId)),
    employeeId: new mongoose.Types.ObjectId(String(employeeId)),
    name,
    status: "draft",
  });
  report.ref = refFromId("CLM", report._id as mongoose.Types.ObjectId);
  await report.save();

  await logActivity({
    workspaceId,
    reportId: report._id as mongoose.Types.ObjectId,
    event: "created",
    actorId: employeeId,
    actorName: (await actorNameById(employeeId)) || "System",
  });

  return report;
}

/**
 * Link OWN, in-workspace, currently-UNLINKED expenses into `report`. Each
 * expense takes the report's own lifecycle (draft/clarification → pending). Ids
 * that are already reported / not own / not in this workspace are skipped.
 */
export async function linkExpensesToReport(
  workspaceId: mongoose.Types.ObjectId | string,
  employeeId: mongoose.Types.ObjectId | string,
  report: IReport,
  expenseIds: (mongoose.Types.ObjectId | string)[],
): Promise<{ added: number; skipped: number }> {
  const ids = expenseIds
    .filter((x) => mongoose.Types.ObjectId.isValid(String(x)))
    .map((x) => new mongoose.Types.ObjectId(String(x)));
  if (ids.length === 0) return { added: 0, skipped: 0 };

  const result = await Expense.updateMany(
    {
      _id: { $in: ids },
      workspaceId: new mongoose.Types.ObjectId(String(workspaceId)),
      employeeId: new mongoose.Types.ObjectId(String(employeeId)),
      reportId: null,
    },
    { $set: { reportId: report._id, lifecycleStatus: expenseLifecycleForReport(report.status) } },
  );
  const added = result.modifiedCount ?? 0;

  if (added > 0) {
    await logActivity({
      workspaceId,
      reportId: report._id as mongoose.Types.ObjectId,
      event: "expense_added",
      actorId: employeeId,
      actorName: (await actorNameById(employeeId)) || "System",
      note: `Added ${added} expense${added === 1 ? "" : "s"} to the claim`,
    });
  }

  return { added, skipped: ids.length - added };
}

// Fields the snapshot needs (name/email) PLUS every role signal isAdmin() reads,
// so the admin-fallback filter below can decide eligibility off the lean doc.
const APPROVER_USER_FIELDS =
  "firstName lastName name email roles role userType accountType hrmsAccessRole hrmsAccessLevel isSuperAdmin managerId";

/**
 * Expense-admin candidates for the no-manager fallback (approval engine
 * sub-step 1): users carrying a STRUCTURAL admin role (coarse regex prefilter
 * that agrees with expense.access.ADMIN_ROLES) UNION users holding an active
 * expenseAdmin GRANT — the bare ADMIN token is no longer a signal. Every
 * returned doc has its grant attached so isAdmin() (the authority) can decide.
 * Workspace-scoped, active-filtered, never includes `excludeIds`.
 */
async function expenseAdminCandidates(
  workspaceId: mongoose.Types.ObjectId,
  excludeIds: mongoose.Types.ObjectId[],
): Promise<any[]> {
  const grantHolders = await expenseAdminUserIds(workspaceId);
  const users: any[] = await User.find({
    workspaceId,
    _id: { $nin: excludeIds },
    $or: [{ roles: { $in: ADMIN_ROLE_PREFILTER } }, { _id: { $in: grantHolders } }],
    ...activeUserFilter(),
  })
    .select(APPROVER_USER_FIELDS)
    .lean();
  return withGrants(workspaceId, users);
}

/**
 * Resolve the L1 approver to snapshot — workspace-scoped; every lookup stamps
 * workspaceId. Order:
 *   1. the submitter's own manager (must be in this workspace, and never the
 *      submitter themselves);
 *   2. else any OTHER user in the SAME workspace with an ADMIN_ROLES role
 *      (admin / superadmin / tenant-admin / workspace-admin / HR / OPS …) —
 *      this is what closes the gap where a tenant-admin-led workspace had no
 *      eligible fallback;
 *   3. else { id: null } — and the caller MUST refuse the submit (the claim is
 *      never stamped with approverId=null).
 *
 * Role strings are stored uppercase but keep their separators ("TENANT_ADMIN",
 * "WORKSPACE_LEADER"), whereas ADMIN_ROLES (expense.access) is separator-stripped
 * — so eligibility is decided by isAdmin() (same normalization on both sides),
 * NOT an exact-match $in that would silently miss tenant-/workspace-admin or
 * workspace-leader rows. The coarse regex pre-filter (/ADMIN/i, /LEADER/i, HR,
 * OPS) only keeps the scan off pure EMPLOYEE/MANAGER rows; isAdmin() is the
 * authority — and it MUST agree with the prefilter, hence /LEADER/i is required
 * now that WORKSPACE_LEADER is an expense admin. Self-approval guard: the
 * submitter is excluded at both the DB
 * ($ne) and isAdmin layers, so an admin filing their own claim falls through to
 * another workspace admin (and, if there is none, to the §3 refusal).
 */
// EXPORTED (2026-08-10) so services/visaApproval.service.ts can reuse it as
// a THIRD caller, after claims and cash advances. `export` is the only edit
// this function has taken — the resolution order, the workspace scoping and
// the self-exclusion are untouched, deliberately, so all three modules keep
// answering "who approves this?" identically. A visa request whose submitter
// has no distinct approver is handled by the CALLER (visa self-routes rather
// than refusing, unlike claims) — not by changing anything here.
/**
 * One line of the routing explanation (audit plumbing, sub-step 2). The
 * resolvers push into an optional `trace` array as they consider people, so
 * the `routed` activity can say who was considered, who was skipped and why,
 * and who was chosen — in the same shape the engine (sub-step 5) will fill
 * with limits / climbs / rules.
 */
export type RoutingTraceEntry = {
  step: string; // manager | admin_fallback | managers_manager | senior_approver | admin_fallback_l2 | limit (engine) | bot (engine)
  level: number;
  userId: string | null;
  name: string | null;
  outcome: "chosen" | "skipped" | "considered" | "none";
  reason: string;
  // engine fields (null today): the limit that applied, whether it covered
  limitBase?: number | null;
  covers?: boolean | null;
};

export async function resolveL1Approver(
  workspaceId: mongoose.Types.ObjectId,
  submitterId: mongoose.Types.ObjectId,
  trace?: RoutingTraceEntry[],
): Promise<{ id: mongoose.Types.ObjectId | null; user: any | null }> {
  const meId = String(submitterId);
  const t = (e: RoutingTraceEntry) => trace?.push(e);

  // 1) submitter's manager — same workspace, and not the submitter themselves.
  const submitter: any = await User.findOne({ _id: submitterId, workspaceId })
    .select("managerId")
    .lean();
  if (submitter?.managerId && String(submitter.managerId) !== meId) {
    const mgr: any = await User.findOne({ _id: submitter.managerId, workspaceId })
      .select(APPROVER_USER_FIELDS)
      .lean();
    if (mgr) {
      t({ step: "manager", level: 1, userId: String(mgr._id), name: employeeNameOf(mgr), outcome: "chosen", reason: "submitter's line manager" });
      return { id: mgr._id as mongoose.Types.ObjectId, user: mgr };
    }
    t({ step: "manager", level: 1, userId: String(submitter.managerId), name: null, outcome: "skipped", reason: "managerId points outside this workspace" });
  } else if (submitter?.managerId) {
    t({ step: "manager", level: 1, userId: meId, name: null, outcome: "skipped", reason: "manager is the submitter" });
  } else {
    t({ step: "manager", level: 1, userId: null, name: null, outcome: "none", reason: "no manager set" });
  }

  // 2) any OTHER workspace expense-admin — structural role OR expenseAdmin
  //    grant (isAdmin() is the authority; grants are attached to the docs).
  const candidates = await expenseAdminCandidates(workspaceId, [submitterId]);
  let chosen: any = null;
  for (const u of candidates) {
    if (chosen) {
      t({ step: "admin_fallback", level: 1, userId: String(u._id), name: employeeNameOf(u), outcome: "considered", reason: "eligible admin, not first in order" });
      continue;
    }
    if (userIdOf(u) !== meId && isAdmin(u)) {
      chosen = u;
      t({ step: "admin_fallback", level: 1, userId: String(u._id), name: employeeNameOf(u), outcome: "chosen", reason: "first eligible workspace expense-admin (insertion order)" });
    } else {
      t({ step: "admin_fallback", level: 1, userId: String(u._id), name: employeeNameOf(u), outcome: "skipped", reason: "not an expense admin" });
    }
  }
  if (chosen) return { id: chosen._id as mongoose.Types.ObjectId, user: chosen };

  // 3) nobody eligible — caller refuses; no null approver is ever submitted.
  t({ step: "admin_fallback", level: 1, userId: null, name: null, outcome: "none", reason: "no other expense-admin in the workspace" });
  return { id: null, user: null };
}

/**
 * Resolve the L2 (escalation) approver — only consulted when a workspace
 * threshold is set and the claim exceeds it. Walks, in order:
 *   a) the L1 approver's OWN manager (manager's-manager chain walk);
 *   b) the workspace's configured seniorApproverId;
 *   c) any OTHER workspace admin (separator-safe: isAdmin() is the authority).
 * Every candidate must be in this workspace and NOT in `excludeIds` (the
 * submitter and L1 — skip-self and no double-listing the same approver).
 *
 * Returns null when no DISTINCT L2 can be found. The caller treats that as "no
 * second level" (chain stays length 1) rather than stamping a null approver —
 * the claim still has a valid L1, so it is never stranded.
 */
// EXPORTED alongside resolveL1Approver above, for the same reason and with
// the same "logic untouched" guarantee. Visa v1 does NOT call this (chain
// length 1, no escalation threshold) — it is exported so that adding a visa
// L2 later is a change in the visa service, never a second implementation
// of the manager's-manager walk.
export async function resolveL2Approver(
  workspaceId: mongoose.Types.ObjectId,
  l1User: any,
  seniorApproverId: any,
  excludeIds: string[],
  trace?: RoutingTraceEntry[],
): Promise<any | null> {
  const excluded = new Set(excludeIds.map(String));
  const ok = (u: any) => u && !excluded.has(String(u._id));
  const t = (e: RoutingTraceEntry) => trace?.push(e);

  // a) manager's-manager — APPROVER_USER_FIELDS already carries L1's managerId.
  const l1MgrId = l1User?.managerId;
  if (l1MgrId && !excluded.has(String(l1MgrId))) {
    const mgr: any = await User.findOne({ _id: l1MgrId, workspaceId })
      .select(APPROVER_USER_FIELDS)
      .lean();
    if (ok(mgr)) {
      t({ step: "managers_manager", level: 2, userId: String(mgr._id), name: employeeNameOf(mgr), outcome: "chosen", reason: "L1 approver's own manager" });
      return mgr;
    }
  }

  // b) configured senior approver.
  if (seniorApproverId && !excluded.has(String(seniorApproverId))) {
    const senior: any = await User.findOne({ _id: seniorApproverId, workspaceId })
      .select(APPROVER_USER_FIELDS)
      .lean();
    if (ok(senior)) {
      t({ step: "senior_approver", level: 2, userId: String(senior._id), name: employeeNameOf(senior), outcome: "chosen", reason: "workspace senior approver" });
      return senior;
    }
  }

  // c) any OTHER workspace expense-admin (structural role OR grant).
  const excludeObjIds = excludeIds
    .filter((x) => mongoose.Types.ObjectId.isValid(x))
    .map((x) => new mongoose.Types.ObjectId(x));
  const candidates = await expenseAdminCandidates(workspaceId, excludeObjIds);
  const admin = candidates.find((u) => ok(u) && isAdmin(u));
  if (admin) {
    t({ step: "admin_fallback_l2", level: 2, userId: String(admin._id), name: employeeNameOf(admin), outcome: "chosen", reason: "first other expense-admin" });
  } else {
    t({ step: "admin_fallback_l2", level: 2, userId: null, name: null, outcome: "none", reason: "no distinct L2 — chain stays length 1" });
  }
  return admin || null;
}

/**
 * Build the approval chain to snapshot at submit.
 *   • L1 — the existing never-null manager → admin fallback (resolveL1Approver).
 *     When that returns null the caller MUST refuse the submit (unchanged).
 *   • L2 — appended ONLY when config.expenseEscalationThreshold is set AND the
 *     claim total exceeds it. Best-effort: omitted (chain stays length 1) if no
 *     distinct L2 exists. Threshold OFF (null) ⇒ chain length 1 ⇒ submit behaves
 *     EXACTLY as before this change.
 * approverId returned is L1 (the current pending approver; currentLevel=1).
 */
async function resolveApprovalChain(
  workspaceId: mongoose.Types.ObjectId,
  submitterId: mongoose.Types.ObjectId,
  totalAmount: number,
  baseCurrency: string,
): Promise<{
  chain: IApprovalChainLevel[];
  approverId: mongoose.Types.ObjectId | null;
  approver: any | null;
  routing: Record<string, any>;
}> {
  const now = new Date();
  const trace: RoutingTraceEntry[] = [];
  const l1 = await resolveL1Approver(workspaceId, submitterId, trace);

  // L2 escalation — gated on a configured threshold the claim total exceeds.
  // The threshold + senior approver live on the policy document (legacy
  // block) since sub-step 4; the walk itself is unchanged until sub-step 5.
  const legacy = (await getPolicy(workspaceId)).legacyEscalation;
  const threshold = legacy.claimThresholdBase;
  const seniorApproverId = legacy.seniorApproverId;
  const overThreshold = threshold != null && Number(totalAmount) > Number(threshold);

  // The routing decision, recorded in the shape the engine (sub-step 5) will
  // fill richly. Today's resolver is the "legacy manager → admin" mode: there
  // is no bot, no per-person limit and no climb yet, and those fields say so
  // explicitly (null / false) rather than being absent.
  const routing: Record<string, any> = {
    mode: "legacy_manager_admin",
    engineVersion: 0,
    policyVersion: null,
    amountBase: Number(totalAmount),
    baseCurrency,
    bot: { evaluated: false, enabled: false, thresholdBase: null, underThreshold: null, checks: null },
    requiredLimitBase: null,
    rule: {
      kind: overThreshold ? "workspace_escalation_threshold" : "single_approver",
      thresholdBase: threshold,
      overThreshold,
      department: null,
      categoryIds: [],
    },
    climbed: false,
    overLimit: false,
    fourEyes: false,
    trace,
    chosen: [] as { level: number; userId: string; name: string; via: string }[],
    decidedAt: now,
  };

  if (!l1.id) return { chain: [], approverId: null, approver: null, routing };

  const l1Via = trace.find((e) => e.level === 1 && e.outcome === "chosen")?.step ?? "unknown";
  const chain: IApprovalChainLevel[] = [
    { level: 1, approverId: l1.id, status: "pending", decidedAt: null, note: null, actorType: "user", via: l1Via, routedAt: now },
  ];
  routing.chosen.push({ level: 1, userId: String(l1.id), name: employeeNameOf(l1.user), via: l1Via });

  if (overThreshold) {
    const l2 = await resolveL2Approver(
      workspaceId,
      l1.user,
      seniorApproverId,
      [String(submitterId), String(l1.id)],
      trace,
    );
    if (l2) {
      const l2Via = trace.find((e) => e.level === 2 && e.outcome === "chosen")?.step ?? "unknown";
      // routedAt for L2 is stamped when L1 approves (the approve handler).
      chain.push({ level: 2, approverId: l2._id, status: "pending", decidedAt: null, note: null, actorType: "user", via: l2Via, routedAt: null });
      routing.chosen.push({ level: 2, userId: String(l2._id), name: employeeNameOf(l2), via: l2Via });
      routing.climbed = true; // a second level was appended because the total exceeded the threshold
    }
  }

  return { chain, approverId: l1.id, approver: l1.user, routing };
}

/**
 * Build the approval chain to snapshot when an ExpenseAdvance is requested.
 *
 * ADDITIVE PEER of resolveApprovalChain (the claim builder above) — it REUSES
 * the exact same private resolvers (resolveL1Approver / resolveL2Approver), so
 * the never-null manager → admin fallback and the L2 mgr's-mgr → seniorApprover
 * → admin walk behave identically to a claim. The ONLY difference is the
 * escalation gate: this reads config.advanceEscalationThreshold (NOT
 * expenseEscalationThreshold) and gates L2 on the ADVANCE amount. seniorApproverId
 * is shared with claims (there is one configured senior approver per workspace).
 *
 *   • L1 — never null; when resolveL1Approver returns null the CALLER MUST refuse
 *     the request (no advance is ever stamped with approverId=null).
 *   • L2 — appended ONLY when advanceEscalationThreshold is set AND amount exceeds
 *     it; best-effort (chain stays length 1 if no distinct L2 exists). Threshold
 *     OFF (null) ⇒ single-level chain.
 */
export async function resolveAdvanceApprovalChain(
  workspaceId: mongoose.Types.ObjectId | string,
  requesterId: mongoose.Types.ObjectId | string,
  amount: number,
): Promise<{
  chain: IApprovalChainLevel[];
  approverId: mongoose.Types.ObjectId | null;
  approver: any | null;
  routing: Record<string, any>;
}> {
  const ws = new mongoose.Types.ObjectId(String(workspaceId));
  const reqId = new mongoose.Types.ObjectId(String(requesterId));

  const now = new Date();
  const trace: RoutingTraceEntry[] = [];
  const l1 = await resolveL1Approver(ws, reqId, trace);
  const legacy = (await getPolicy(ws)).legacyEscalation;
  const threshold = legacy.advanceThresholdBase;
  const overThreshold = threshold != null && Number(amount) > Number(threshold);
  const routing: Record<string, any> = {
    mode: "legacy_manager_admin",
    engineVersion: 0,
    policyVersion: null,
    amountBase: Number(amount),
    bot: { evaluated: false, enabled: false, thresholdBase: null, underThreshold: null, checks: null },
    requiredLimitBase: null,
    rule: { kind: overThreshold ? "workspace_escalation_threshold" : "single_approver", thresholdBase: threshold, overThreshold },
    climbed: false,
    overLimit: false,
    fourEyes: false,
    trace,
    chosen: [] as any[],
    decidedAt: now,
  };
  if (!l1.id) return { chain: [], approverId: null, approver: null, routing };

  const l1Via = trace.find((e) => e.level === 1 && e.outcome === "chosen")?.step ?? "unknown";
  const chain: IApprovalChainLevel[] = [
    { level: 1, approverId: l1.id, status: "pending", decidedAt: null, note: null, actorType: "user", via: l1Via, routedAt: now },
  ];
  routing.chosen.push({ level: 1, userId: String(l1.id), name: employeeNameOf(l1.user), via: l1Via });

  if (overThreshold) {
    const l2 = await resolveL2Approver(ws, l1.user, legacy.seniorApproverId, [String(reqId), String(l1.id)], trace);
    if (l2) {
      const l2Via = trace.find((e) => e.level === 2 && e.outcome === "chosen")?.step ?? "unknown";
      chain.push({ level: 2, approverId: l2._id, status: "pending", decidedAt: null, note: null, actorType: "user", via: l2Via, routedAt: null });
      routing.chosen.push({ level: 2, userId: String(l2._id), name: employeeNameOf(l2), via: l2Via });
      routing.climbed = true;
    }
  }

  return { chain, approverId: l1.id, approver: l1.user, routing };
}

/**
 * report.status → the per-level disposition to stamp when lazy-initialising a
 * length-1 chain for a legacy in-flight claim (one that predates the chain
 * field). Mirrors the claim's own decision so the synthesized L1 step is
 * consistent with where the claim already sits.
 */
function chainLevelStatusForReport(status: ReportStatus | null): ChainLevelStatus {
  switch (status) {
    case "approved":
    case "reimbursed":
      return "approved";
    case "declined":
      return "declined";
    case "clarification_required":
      return "clarification_required";
    default:
      return "pending"; // submitted / draft
  }
}

/**
 * Lazy-init a length-1 approval chain for a legacy claim that has an approverId
 * but no chain yet (predates Phase 2). Idempotent: a no-op once a chain exists
 * or when there is nothing to backfill (a draft with no approver). Persists
 * best-effort — a save failure is swallowed so it can never break a read. Does
 * NOT change report.status or approverId, so approve/decline behave unchanged.
 */
export async function ensureApprovalChain(report: IReport): Promise<IReport> {
  if (!report) return report;
  if (Array.isArray(report.approvalChain) && report.approvalChain.length > 0) return report;
  if (!report.approverId) return report; // draft / never submitted — nothing to backfill

  report.approvalChain = [
    {
      level: 1,
      approverId: report.approverId,
      status: chainLevelStatusForReport(report.status),
      decidedAt: report.status === "submitted" ? null : report.approvedAt ?? report.updatedAt ?? null,
      note: report.decisionNote ?? null,
    },
  ];
  report.currentLevel = 1;

  try {
    await report.save();
  } catch (err: any) {
    console.error("[ensureApprovalChain]", err?.message || err);
  }
  return report;
}

// Flat shape (optional fields) rather than a discriminated union: this package
// compiles with strictNullChecks:false, where boolean-literal discriminants do
// not narrow. Branch on `ok`; the relevant fields are populated per outcome.
export type SubmitReportResult = {
  ok: boolean;
  reason?: "not_found" | "not_editable" | "blocking";
  blocking?: string[];
  warnings?: string[];
  report?: IReport;
  approverId?: mongoose.Types.ObjectId | null;
  approverName?: string;
  claimRef?: string;
  totalAmount?: number;
  expenseCount?: number;
};

/**
 * Submit a DRAFT/clarification claim (owner-only) → submitted. Validates first
 * (blocking refuses; warnings ride along), snapshots the approver (manager →
 * admin/HR fallback), propagates expenses → awaiting_approval, and fires the
 * approver email (non-fatal). Shared by the web route and quick-submit.
 */
export async function submitReport(
  workspaceId: mongoose.Types.ObjectId | string,
  employeeId: mongoose.Types.ObjectId | string,
  reportId: mongoose.Types.ObjectId | string,
  opts: {
    /**
     * Receipt verification — the submitter's escape hatch. true = "no
     * attachments for this claim": persisted on the report, the Approval Bot
     * is not consulted and the claim goes straight to a person. Omitted =
     * leave whatever the report already says (false by default).
     */
    attachmentsNotRequired?: boolean;
  } = {},
): Promise<SubmitReportResult> {
  const ws = new mongoose.Types.ObjectId(String(workspaceId));
  const emp = new mongoose.Types.ObjectId(String(employeeId));
  if (!mongoose.Types.ObjectId.isValid(String(reportId))) return { ok: false, reason: "not_found" };
  const rid = new mongoose.Types.ObjectId(String(reportId));

  const report = await Report.findOne({ _id: rid, workspaceId: ws, employeeId: emp });
  if (!report) return { ok: false, reason: "not_found" };
  if (!EDITABLE_STATUSES.has(report.status)) return { ok: false, reason: "not_editable" };

  // A submit coming out of clarification_required is a RE-submission.
  const wasClarification = report.status === "clarification_required";

  const { blocking, warnings } = await validateReportForSubmit(ws, rid);
  if (blocking.length > 0) return { ok: false, reason: "blocking", blocking, warnings };

  // The bypass is a fact about THIS submission: written before routing so the
  // engine (buildRoutingInput reads it off the report) and the trail see it.
  if (opts.attachmentsNotRequired !== undefined && !!report.attachmentsNotRequired !== !!opts.attachmentsNotRequired) {
    report.attachmentsNotRequired = !!opts.attachmentsNotRequired;
    await report.save();
  }

  // Totals (for the response + email) — in the workspace BASE currency (slice
  // 0): validateReportForSubmit has just guaranteed every line is converted,
  // so this is the true total the L2 threshold gate below compares against.
  const baseCurrency = await getWorkspaceBaseCurrency(ws);
  const [agg] = await Expense.aggregate([
    { $match: { workspaceId: ws, reportId: rid } },
    { $group: { _id: null, total: { $sum: amountBaseExpr(baseCurrency) }, count: { $sum: 1 } } },
  ]);
  const totalAmount = Math.round((agg?.total ?? 0) * 100) / 100;
  const expenseCount = agg?.count ?? 0;

  // L1 routing guard — a submitted claim must NEVER land with approverId=null.
  // No manager AND no eligible workspace admin → refuse like a blocking
  // validation failure (the claim stays a draft instead of stranding in
  // awaiting_approval with nobody able to act). Returns BEFORE any mutation.
  //
  // resolveApprovalChain also appends an L2 level when the workspace escalation
  // threshold is set and this claim's total exceeds it; with the threshold OFF
  // the chain is length 1 and this stamps exactly as before. approverId is the
  // L1 (current pending) approver — the denorm pointer the queues already read.
  //
  // ── THE ENGINE SWITCH (approval-engine sub-step 5) ──────────────────────
  // Branch on the workspace policy's engine master switch. OFF (the default,
  // and every workspace today) → the legacy manager → admin path below,
  // unchanged. ON → routeClaim(), the SAME pure function the simulator runs,
  // on the claim's base total / department / categories / pre-checks, and the
  // chain is built from its result. Only claims submitted AFTER the switch is
  // on go through here; an in-flight claim keeps the chain it already has
  // (nothing re-routes it).
  const policy = await getPolicy(ws);
  let chain: IApprovalChainLevel[];
  let approverId: mongoose.Types.ObjectId | null;
  let approver: any;
  let routing: Record<string, any>;
  let engineDecision: RoutingDecision | null = null;
  let receiptVerdict: ReceiptVerdict | null = null;

  if (policy.engineEnabled) {
    const built = await buildRoutingInput({ workspaceId: ws, kind: "claim", reportId: String(rid) });
    if (built.error || !built.input) {
      return { ok: false, reason: "blocking", blocking: [built.error || "Could not route this claim."], warnings };
    }
    engineDecision = routeClaim(built.input);
    routing = engineDecision; // same shape the simulator returns — kept identical on purpose
    // The per-line receipt verdict goes on the trail (policy_check entries
    // below), not onto Report.routing: the words are already in
    // bot.checksFailed / bot.reason, the structured rows belong with the log.
    receiptVerdict = built.summary?.receiptVerdict ?? null;

    // Nobody can approve this amount. Every top-of-chain mode presupposes a
    // pool with at least one limit; with none (NO_APPROVER), or when the
    // policy is REFUSE_SUBMIT, the claim stays a draft with a clear message —
    // never silently accepted, never stranded.
    if (engineDecision.outcome === "NO_APPROVER" || engineDecision.outcome === "REFUSE") {
      return {
        ok: false,
        reason: "blocking",
        blocking: [
          engineDecision.outcome === "REFUSE"
            ? `No approver is configured who can approve this amount (${baseCurrency} ${engineDecision.requiredLimitBase}) — contact your admin.`
            : "No approver is configured who can approve this amount — contact your admin.",
        ],
        warnings,
      };
    }

    const now = new Date();
    if (engineDecision.outcome === "BOT_AUTO_APPROVE") {
      // The bot is a real chain level, already decided.
      chain = [
        {
          level: 1,
          approverId: null,
          status: "approved",
          decidedAt: now,
          note: engineDecision.bot.reason,
          actorType: "bot",
          via: "bot",
          routedAt: now,
          heldMs: 0,
          overLimit: false,
          limitBase: engineDecision.bot.thresholdBase ?? null,
        },
      ];
      approverId = null;
      approver = null;
    } else {
      chain = engineDecision.chain.map((c, i) => ({
        level: c.level,
        approverId: c.approverId ? new mongoose.Types.ObjectId(c.approverId) : null,
        status: "pending" as const,
        decidedAt: null,
        note: null,
        actorType: "user" as const,
        via: c.via,
        routedAt: i === 0 ? now : null, // later levels start their clock when the previous one approves
        heldMs: null,
        overLimit: !!c.overLimit,
        limitBase: c.limitBase ?? null,
      }));
      approverId = chain[0]?.approverId ?? null;
      if (!approverId) {
        return { ok: false, reason: "blocking", blocking: ["No approver is configured who can approve this amount — contact your admin."], warnings };
      }
      approver = await User.findById(approverId).select(APPROVER_USER_FIELDS).lean();
    }
  } else {
    // ── Legacy path — untouched ──
    const legacy = await resolveApprovalChain(ws, emp, totalAmount, baseCurrency);
    chain = legacy.chain;
    approverId = legacy.approverId;
    approver = legacy.approver;
    routing = legacy.routing;
    if (!approverId) {
      return {
        ok: false,
        reason: "blocking",
        blocking: [
          "No approver available — set a manager for this employee, or add an admin to the workspace.",
        ],
        warnings,
      };
    }
  }

  // A submit after a withdraw is a round-trip worth marking on the trail.
  const priorWithdraws = await ExpenseActivity.countDocuments({ workspaceId: ws, reportId: rid, event: "withdrawn" });
  const priorSubmits = await ExpenseActivity.countDocuments({ workspaceId: ws, reportId: rid, event: { $in: ["submitted", "resubmitted"] } });

  const botApproved = engineDecision?.outcome === "BOT_AUTO_APPROVE";
  report.approvalChain = chain;
  report.currentLevel = 1;
  report.approverId = approverId;
  report.submittedAt = new Date();
  report.decisionNote = null;
  report.selfApproved = false;
  report.routing = routing;
  if (botApproved) {
    // Straight to approved — the bot decided at submit; finance picks it up.
    report.status = "approved";
    report.approvedAt = report.submittedAt;
  } else {
    report.status = "submitted";
  }
  await report.save();

  await propagateReportLifecycle(ws, rid, botApproved ? "approved" : "submitted");

  // Audit (sub-step 2): the submission carries the base total and EVERY line's
  // original + converted amount; then the routing decision as a system entry;
  // then one Policy Bot entry per non-blocking warning.
  const submitterName = (await actorNameById(emp)) || "System";
  const lines = await Expense.find({ workspaceId: ws, reportId: rid })
    .select("ref merchant date amount currency amountBase baseCurrency exchangeRate rateSource categoryId imageKey")
    .lean();
  await logActivity({
    workspaceId: ws,
    reportId: rid,
    event: wasClarification ? "resubmitted" : "submitted",
    actorId: emp,
    actorName: submitterName,
    actorType: "user",
    details: {
      totalBase: totalAmount,
      baseCurrency,
      lineCount: expenseCount,
      lines: lines.map(lineSnapshot),
      afterClarification: wasClarification,
      afterWithdraw: priorWithdraws > 0,
      submissionNumber: priorSubmits + 1,
      warnings,
    },
  });
  await logActivity({
    workspaceId: ws,
    reportId: rid,
    event: "routed",
    actorId: null,
    actorName: "Routing",
    actorType: "system",
    note: engineDecision
      ? engineDecision.explain.join(" ")
      : routing.chosen
          .map((c: any) => `L${c.level} → ${c.name || c.userId} (${String(c.via).replace(/_/g, " ")})`)
          .join(" · "),
    details: routing,
  });
  if (botApproved && engineDecision) {
    await logActivity({
      workspaceId: ws,
      reportId: rid,
      event: "auto_approved",
      actorId: APPROVAL_BOT_ACTOR.actorId,
      actorName: APPROVAL_BOT_ACTOR.actorName,
      actorType: APPROVAL_BOT_ACTOR.actorType,
      heldMs: 0,
      note: `Auto-approved: ${engineDecision.bot.reason}`,
      details: {
        thresholdBase: engineDecision.bot.thresholdBase,
        amountBase: engineDecision.amountBase,
        baseCurrency,
        checks: engineDecision.bot.checks,
        policyVersion: engineDecision.policyVersion,
        final: true,
      },
    });
  }
  for (const w of warnings) {
    await logActivity({
      workspaceId: ws,
      reportId: rid,
      event: "policy_check",
      actorName: "Policy Bot",
      actorType: "bot",
      note: w,
    });
  }
  // Receipt verification — WHY the bot stepped aside, in words, one entry per
  // failing bill ("EXP-1A2B: receipt amount INR 1,180.00 doesn't match claimed
  // INR 1,500.00 (tolerance INR 59.00)", "…: receipt not readable"), or the
  // bypass the submitter chose. The structured verdict rides on `details`.
  if (engineDecision && !botApproved && engineDecision.bot.enabled) {
    const verdict = receiptVerdict;
    if (engineDecision.bot.skipped) {
      await logActivity({
        workspaceId: ws,
        reportId: rid,
        event: "policy_check",
        actorName: "Approval Bot",
        actorType: "bot",
        note: `Approval Bot not consulted — ${engineDecision.bot.skipped}.`,
        details: { skipped: engineDecision.bot.skipped, attachmentsNotRequired: !!report.attachmentsNotRequired },
      });
    } else if (engineDecision.bot.checksEnforced.includes("receipt") && engineDecision.bot.checks.receipt === false) {
      const lines: any[] = verdict?.lines?.filter((l: any) => l.status !== "ok") ?? [];
      const notes = lines.length ? lines.map((l: any) => l.reason) : [engineDecision.bot.checksFailed.find((s) => /receipt/i.test(s)) || "receipt check failed"];
      for (let i = 0; i < notes.length; i++) {
        await logActivity({
          workspaceId: ws,
          reportId: rid,
          event: "policy_check",
          actorName: "Approval Bot",
          actorType: "bot",
          expenseId: lines[i]?.expenseId ?? null,
          note: `Receipt check failed — ${notes[i]}. Sent to a person.`,
          details: lines[i] ? { receipt: lines[i], tolerance: policy.bot.receiptMatch } : { tolerance: policy.bot.receiptMatch },
        });
      }
    }
  }

  const approverName = botApproved ? APPROVAL_BOT_ACTOR.actorName : employeeNameOf(approver);

  // Approver email — non-fatal: log and continue, never block the submit. When
  // there's no approver email (no manager + no admin, or SMTP off) the in-app
  // approvals badge remains the notice. A bot-approved claim has no approver
  // to notify.
  if (!botApproved && approver?.email) {
    try {
      const submitter: any = await User.findById(emp).select("firstName lastName name email").lean();
      await sendClaimSubmittedEmail({
        to: approver.email,
        approverName,
        employeeName: employeeNameOf(submitter) || "An employee",
        claimRef: report.ref,
        claimId: String(report._id),
        totalAmount,
      });
    } catch (mailErr: any) {
      console.error("[claim submit email]", mailErr?.message || mailErr);
    }
  }

  return {
    ok: true,
    report,
    warnings,
    approverId,
    approverName,
    claimRef: report.ref,
    totalAmount,
    expenseCount,
  };
}

/** Auto-name for a quick-submit claim: "⟨merchant⟩ · ⟨DD Mon⟩", or
 *  "Quick claim · ⟨DD Mon⟩" when the merchant is unknown. */
function autoClaimName(expense: any): string {
  const d = expense?.date ? new Date(expense.date) : new Date();
  const day = Number.isNaN(d.getTime())
    ? new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short" })
    : d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  const merchant = String(expense?.merchant || "").trim();
  return merchant ? `${merchant} · ${day}` : `Quick claim · ${day}`;
}

// Flat shape (see SubmitReportResult note on strictNullChecks). Branch on `ok`.
export type QuickSubmitResult = {
  ok: boolean;
  reason?: string;
  claimRef?: string;
  approverName?: string;
  warnings?: string[];
};

/**
 * Conversational quick-submit (WhatsApp): wrap ONE loose expense in a fresh
 * 1-expense claim and submit it through the shared state machine. On a blocking
 * validation failure the throwaway claim is removed and the expense returns to
 * loose (pending_to_submit) so nothing is stranded.
 */
export async function quickSubmitExpense(
  workspaceId: mongoose.Types.ObjectId | string,
  employeeId: mongoose.Types.ObjectId | string,
  expenseId: mongoose.Types.ObjectId | string,
): Promise<QuickSubmitResult> {
  const ws = new mongoose.Types.ObjectId(String(workspaceId));
  const emp = new mongoose.Types.ObjectId(String(employeeId));
  if (!mongoose.Types.ObjectId.isValid(String(expenseId))) {
    return { ok: false, reason: "Expense not found." };
  }
  const eid = new mongoose.Types.ObjectId(String(expenseId));

  // Guard: own, loose (no claim), still pending submission.
  const expense: any = await Expense.findOne({ _id: eid, workspaceId: ws, employeeId: emp });
  if (!expense) return { ok: false, reason: "Expense not found." };
  if (expense.reportId) return { ok: false, reason: "This expense is already in a claim." };
  if ((expense.lifecycleStatus ?? "pending_to_submit") !== "pending_to_submit") {
    return { ok: false, reason: "This expense isn't pending submission." };
  }

  const report = await createReport(ws, emp, autoClaimName(expense));
  const { added } = await linkExpensesToReport(ws, emp, report, [eid]);
  if (added < 1) {
    await report.deleteOne(); // nothing linked (race) — drop the empty draft
    return { ok: false, reason: "Couldn't add the expense to a claim." };
  }

  const result = await submitReport(ws, emp, report._id as mongoose.Types.ObjectId);
  if (!result.ok) {
    // Roll the throwaway claim back so the expense returns to the loose bucket.
    await unlinkAllExpenses(ws, report._id as mongoose.Types.ObjectId);
    await report.deleteOne();
    const reason =
      result.reason === "blocking"
        ? result.blocking[0] || "Missing required details."
        : "Couldn't submit this expense.";
    return { ok: false, reason };
  }

  return {
    ok: true,
    claimRef: result.claimRef,
    approverName: result.approverName || "your approver",
    warnings: result.warnings,
  };
}
