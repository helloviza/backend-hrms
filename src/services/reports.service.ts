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
import { isAdmin, userIdOf } from "./expense.access.js";

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
}): Promise<void> {
  try {
    const actorId =
      params.actorId && mongoose.Types.ObjectId.isValid(String(params.actorId))
        ? new mongoose.Types.ObjectId(String(params.actorId))
        : null;
    const expenseId =
      params.expenseId && mongoose.Types.ObjectId.isValid(String(params.expenseId))
        ? new mongoose.Types.ObjectId(String(params.expenseId))
        : null;
    await ExpenseActivity.create({
      workspaceId: new mongoose.Types.ObjectId(String(params.workspaceId)),
      reportId: new mongoose.Types.ObjectId(String(params.reportId)),
      expenseId,
      event: params.event,
      actorId,
      actorName: params.actorName || "System",
      note: params.note ?? null,
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
    .select("ref merchant amount date imageKey categoryId")
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
async function resolveL1Approver(
  workspaceId: mongoose.Types.ObjectId,
  submitterId: mongoose.Types.ObjectId,
): Promise<{ id: mongoose.Types.ObjectId | null; user: any | null }> {
  const meId = String(submitterId);

  // 1) submitter's manager — same workspace, and not the submitter themselves.
  const submitter: any = await User.findOne({ _id: submitterId, workspaceId })
    .select("managerId")
    .lean();
  if (submitter?.managerId && String(submitter.managerId) !== meId) {
    const mgr: any = await User.findOne({ _id: submitter.managerId, workspaceId })
      .select(APPROVER_USER_FIELDS)
      .lean();
    if (mgr) return { id: mgr._id as mongoose.Types.ObjectId, user: mgr };
  }

  // 2) any OTHER workspace admin (separator-safe: isAdmin() is the authority).
  const candidates: any[] = await User.find({
    workspaceId,
    _id: { $ne: submitterId },
    roles: { $in: [/ADMIN/i, /LEADER/i, /^HR$/i, /^OPS$/i] },
  })
    .select(APPROVER_USER_FIELDS)
    .lean();
  const admin = candidates.find((u) => userIdOf(u) !== meId && isAdmin(u));
  if (admin) return { id: admin._id as mongoose.Types.ObjectId, user: admin };

  // 3) nobody eligible — caller refuses; no null approver is ever submitted.
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
async function resolveL2Approver(
  workspaceId: mongoose.Types.ObjectId,
  l1User: any,
  seniorApproverId: any,
  excludeIds: string[],
): Promise<any | null> {
  const excluded = new Set(excludeIds.map(String));
  const ok = (u: any) => u && !excluded.has(String(u._id));

  // a) manager's-manager — APPROVER_USER_FIELDS already carries L1's managerId.
  const l1MgrId = l1User?.managerId;
  if (l1MgrId && !excluded.has(String(l1MgrId))) {
    const mgr: any = await User.findOne({ _id: l1MgrId, workspaceId })
      .select(APPROVER_USER_FIELDS)
      .lean();
    if (ok(mgr)) return mgr;
  }

  // b) configured senior approver.
  if (seniorApproverId && !excluded.has(String(seniorApproverId))) {
    const senior: any = await User.findOne({ _id: seniorApproverId, workspaceId })
      .select(APPROVER_USER_FIELDS)
      .lean();
    if (ok(senior)) return senior;
  }

  // c) any OTHER workspace admin.
  const excludeObjIds = excludeIds
    .filter((x) => mongoose.Types.ObjectId.isValid(x))
    .map((x) => new mongoose.Types.ObjectId(x));
  const candidates: any[] = await User.find({
    workspaceId,
    _id: { $nin: excludeObjIds },
    roles: { $in: [/ADMIN/i, /LEADER/i, /^HR$/i, /^OPS$/i] },
  })
    .select(APPROVER_USER_FIELDS)
    .lean();
  const admin = candidates.find((u) => ok(u) && isAdmin(u));
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
): Promise<{
  chain: IApprovalChainLevel[];
  approverId: mongoose.Types.ObjectId | null;
  approver: any | null;
}> {
  const l1 = await resolveL1Approver(workspaceId, submitterId);
  if (!l1.id) return { chain: [], approverId: null, approver: null };

  const chain: IApprovalChainLevel[] = [
    { level: 1, approverId: l1.id, status: "pending", decidedAt: null, note: null },
  ];

  // L2 escalation — gated on a configured threshold the claim total exceeds.
  const ws: any = await CustomerWorkspace.findById(workspaceId)
    .select("config.expenseEscalationThreshold config.seniorApproverId")
    .lean();
  const threshold = ws?.config?.expenseEscalationThreshold;
  if (threshold != null && Number(totalAmount) > Number(threshold)) {
    const l2 = await resolveL2Approver(workspaceId, l1.user, ws?.config?.seniorApproverId, [
      String(submitterId),
      String(l1.id),
    ]);
    if (l2) {
      chain.push({ level: 2, approverId: l2._id, status: "pending", decidedAt: null, note: null });
    }
  }

  return { chain, approverId: l1.id, approver: l1.user };
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

  // Totals (for the response + email).
  const [agg] = await Expense.aggregate([
    { $match: { workspaceId: ws, reportId: rid } },
    { $group: { _id: null, total: { $sum: { $ifNull: ["$amount", 0] } }, count: { $sum: 1 } } },
  ]);
  const totalAmount = agg?.total ?? 0;
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
  const { chain, approverId, approver } = await resolveApprovalChain(ws, emp, totalAmount);
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
  report.approvalChain = chain;
  report.currentLevel = 1;
  report.approverId = approverId;
  report.status = "submitted";
  report.submittedAt = new Date();
  report.decisionNote = null;
  report.selfApproved = false;
  await report.save();

  await propagateReportLifecycle(ws, rid, "submitted");

  // Audit: the submission itself, then one Policy Bot entry per non-blocking
  // warning surfaced by validateReportForSubmit (receipts, categories, dupes).
  const submitterName = (await actorNameById(emp)) || "System";
  await logActivity({
    workspaceId: ws,
    reportId: rid,
    event: wasClarification ? "resubmitted" : "submitted",
    actorId: emp,
    actorName: submitterName,
  });
  for (const w of warnings) {
    await logActivity({
      workspaceId: ws,
      reportId: rid,
      event: "policy_check",
      actorName: "Policy Bot",
      note: w,
    });
  }

  const approverName = employeeNameOf(approver);

  // Approver email — non-fatal: log and continue, never block the submit. When
  // there's no approver email (no manager + no admin, or SMTP off) the in-app
  // approvals badge remains the notice.
  if (approver?.email) {
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
