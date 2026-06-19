// apps/backend/src/routes/expenseReports.ts
//
// Expense Reports — Layer 2. A named bundle of an employee's expenses, taken
// from draft → submitted. Mounted at /api/reports behind requireAuth +
// requireWorkspace (see server.ts).
//
// Scoping (NON-NEGOTIABLE): every query stamps workspaceId via req.workspaceObjectId.
// Reads use the seesAll admin-all pattern (mirrors expenses.ts); MUTATIONS are
// owner-only in Layer 2 (employeeId === caller) — approve/reject/reimburse +
// approver routing are Layer 3.

import express from "express";
import mongoose from "mongoose";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import {
  propagateReportLifecycle,
  unlinkAllExpenses,
  createReport,
  linkExpensesToReport,
  submitReport,
  logActivity,
} from "../services/reports.service.js";
import Report from "../models/Report.js";
import ExpenseActivity from "../models/ExpenseActivity.js";

// Owner-editable report states: a draft, or one bounced back for clarification.
// add / remove / rename / submit / delete all gate on this set.
const EDITABLE_STATUSES = new Set(["draft", "clarification_required"]);
import Expense from "../models/Expense.js";
import User from "../models/User.js";

const router = express.Router();

/* ── Role gate: who sees ALL workspace reports (mirrors expenses.ts) ──── */
function norm(v: any) {
  return String(v ?? "").trim().toUpperCase().replace(/[\s\-_]/g, "");
}
const FINANCE_ADMIN_ROLES = [
  "ADMIN", "SUPERADMIN", "SUPER_ADMIN", "HR", "HR_ADMIN",
  "OPS", "OPS_ADMIN", "TENANT_ADMIN", "WORKSPACE_ADMIN",
].map(norm);

function seesAllReports(req: any): boolean {
  if (isSuperAdmin(req)) return true;
  const u = req.user || {};
  const signals: any[] = [];
  if (Array.isArray(u.roles)) signals.push(...u.roles);
  if (u.role) signals.push(u.role);
  if (u.userType) signals.push(u.userType);
  if (u.accountType) signals.push(u.accountType);
  if (u.hrmsAccessRole) signals.push(u.hrmsAccessRole);
  if (u.hrmsAccessLevel) signals.push(u.hrmsAccessLevel);
  return signals.map(norm).some((r) => FINANCE_ADMIN_ROLES.includes(r));
}

function ownEmployeeId(req: any): string {
  return String(req.user?.id || req.user?._id || req.user?.sub || "");
}

/** Finance actor — a DISTINCT predicate (so reimburse can tighten later). */
const FINANCE_ROLES = ["ADMIN", "SUPERADMIN", "SUPER_ADMIN", "HR", "HR_ADMIN", "OPS", "OPS_ADMIN"].map(norm);
function isFinance(req: any): boolean {
  if (isSuperAdmin(req)) return true;
  const u = req.user || {};
  const signals: any[] = [];
  if (Array.isArray(u.roles)) signals.push(...u.roles);
  if (u.role) signals.push(u.role);
  if (u.userType) signals.push(u.userType);
  if (u.accountType) signals.push(u.accountType);
  if (u.hrmsAccessRole) signals.push(u.hrmsAccessRole);
  if (u.hrmsAccessLevel) signals.push(u.hrmsAccessLevel);
  return signals.map(norm).some((r) => FINANCE_ROLES.includes(r));
}

function employeeNameOf(u: any): string {
  if (!u || typeof u !== "object") return "";
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return full || u.name || u.email || "";
}

/** Acting user's display name for the activity log (falls back to "System"). */
function actorNameOf(req: any): string {
  return employeeNameOf(req.user) || "System";
}

/** Load a report by id within the tenant, WITHOUT an owner restriction —
 *  for approval actions the actor is the approver/finance, not the owner. */
async function loadReportAny(req: any, id: string) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return Report.findOne({
    _id: new mongoose.Types.ObjectId(id),
    workspaceId: req.workspaceObjectId,
  });
}

/** Per-report counts + totals, aggregated on read (no cached counts). */
async function countsForReports(
  workspaceId: mongoose.Types.ObjectId,
  reportIds: mongoose.Types.ObjectId[],
): Promise<Record<string, { count: number; amount: number }>> {
  if (reportIds.length === 0) return {};
  const rows = await Expense.aggregate([
    { $match: { workspaceId, reportId: { $in: reportIds } } },
    { $group: { _id: "$reportId", count: { $sum: 1 }, amount: { $sum: { $ifNull: ["$amount", 0] } } } },
  ]);
  const out: Record<string, { count: number; amount: number }> = {};
  for (const r of rows) out[String(r._id)] = { count: r.count || 0, amount: r.amount || 0 };
  return out;
}

function categoryNameOf(d: any): string {
  const cat = d.categoryId;
  if (cat && typeof cat === "object" && cat.name) return String(cat.name);
  return d.suggestedCategory || "";
}

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/reports
 *  - default        : own (admin: all), each row carries count + total
 *  - ?queue=approvals: reports submitted to ME (approverId==me); admin/HR see ALL
 *                      submitted (covers the no-manager case)
 *  - ?queue=reimburse: approved reports awaiting reimbursement — FINANCE only
 * Queue views populate the submitter name.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/", async (req: any, res: any) => {
  try {
    const queue = String(req.query.queue || "");
    const filter: Record<string, any> = { workspaceId: req.workspaceObjectId };

    if (queue === "approvals") {
      filter.status = "submitted";
      // Admin/HR see all submitted; a plain approver sees only those routed to them.
      if (!seesAllReports(req)) {
        filter.approverId = new mongoose.Types.ObjectId(ownEmployeeId(req));
      }
    } else if (queue === "reimburse") {
      if (!isFinance(req)) return res.status(403).json({ error: "Finance access required" });
      filter.status = "approved";
    } else {
      // Default list: own, or all for admins (optionally narrowed by ?employeeId).
      if (!seesAllReports(req)) {
        filter.employeeId = new mongoose.Types.ObjectId(ownEmployeeId(req));
      } else if (req.query.employeeId && mongoose.Types.ObjectId.isValid(String(req.query.employeeId))) {
        filter.employeeId = new mongoose.Types.ObjectId(String(req.query.employeeId));
      }
      if (req.query.status) filter.status = String(req.query.status);
    }

    const reports = await Report.find(filter)
      .populate("employeeId", "firstName lastName email name")
      .sort({ createdAt: -1 })
      .lean();
    const counts = await countsForReports(
      req.workspaceObjectId,
      reports.map((r: any) => r._id),
    );

    const docs = reports.map((r: any) => {
      const emp = r.employeeId;
      return {
        ...r,
        employeeId: emp && typeof emp === "object" ? emp._id : emp,
        employeeName: employeeNameOf(emp),
        expenseCount: counts[String(r._id)]?.count ?? 0,
        totalAmount: counts[String(r._id)]?.amount ?? 0,
      };
    });

    res.json({ ok: true, docs });
  } catch (err: any) {
    console.error("[Reports GET list]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to list reports" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/reports/pending-count  — sidebar badge.
 * Declared before /:id so ":id" can't capture "pending-count".
 * ───────────────────────────────────────────────────────────────────── */
router.get("/pending-count", async (req: any, res: any) => {
  try {
    const ws = req.workspaceObjectId;
    const approvalsFilter: Record<string, any> = { workspaceId: ws, status: "submitted" };
    if (!seesAllReports(req)) {
      approvalsFilter.approverId = new mongoose.Types.ObjectId(ownEmployeeId(req));
    }
    const approvals = await Report.countDocuments(approvalsFilter);
    const reimburse = isFinance(req)
      ? await Report.countDocuments({ workspaceId: ws, status: "approved" })
      : 0;

    res.json({ ok: true, approvals, reimburse });
  } catch (err: any) {
    console.error("[Reports pending-count]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load count" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/reports  — create a draft.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/", async (req: any, res: any) => {
  try {
    const employeeId = ownEmployeeId(req);
    if (!req.workspaceObjectId || !employeeId) {
      return res.status(400).json({ error: "Missing workspace or user context" });
    }
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });

    // Shared state machine (CLM- ref + draft status live in createReport).
    const report = await createReport(req.workspaceObjectId, employeeId, name);

    res.status(201).json({ ok: true, report: { ...report.toObject(), expenseCount: 0, totalAmount: 0 } });
  } catch (err: any) {
    console.error("[Reports POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to create report" });
  }
});

/* ── Shared: load a report scoped to workspace + (own unless admin) ───── */
async function loadReport(req: any, id: string, opts: { ownerOnly: boolean }) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const filter: Record<string, any> = {
    _id: new mongoose.Types.ObjectId(id),
    workspaceId: req.workspaceObjectId,
  };
  // Mutations are owner-only in Layer 2; reads allow admins to see all.
  if (opts.ownerOnly || !seesAllReports(req)) {
    filter.employeeId = new mongoose.Types.ObjectId(ownEmployeeId(req));
  }
  return Report.findOne(filter);
}

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/reports/:id  — report + its expenses.
 * Visible to: the OWNER, an ADMIN, or the routed APPROVER (so they can open a
 * queued report). Includes submitter + approver names + canApprove/canReimburse
 * hints for the UI.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/:id", async (req: any, res: any) => {
  try {
    const report = await loadReportAny(req, req.params.id);
    if (!report) return res.status(404).json({ error: "Report not found" });

    const me = ownEmployeeId(req);
    const isOwner = String(report.employeeId) === me;
    const isApprover = report.approverId && String(report.approverId) === me;
    if (!isOwner && !seesAllReports(req) && !isApprover) {
      return res.status(404).json({ error: "Report not found" });
    }

    const expenses = await Expense.find({
      workspaceId: req.workspaceObjectId,
      reportId: report._id,
    })
      .select("-rawExtraction -perFieldConfidence")
      .populate("categoryId", "name")
      .sort({ date: -1, createdAt: -1 })
      .lean();

    const enriched = expenses.map((d: any) => {
      const cat = d.categoryId;
      return {
        ...d,
        categoryId: cat && typeof cat === "object" ? cat._id : cat,
        categoryName: categoryNameOf(d),
        hasReceipt: !!d.imageKey,
      };
    });

    const totalAmount = enriched.reduce((s, e) => s + (Number(e.amount) || 0), 0);

    // Resolve submitter + approver display names (small, two lookups).
    const [submitter, approver] = await Promise.all([
      User.findById(report.employeeId).select("firstName lastName email name").lean(),
      report.approverId
        ? User.findById(report.approverId).select("firstName lastName email name").lean()
        : Promise.resolve(null),
    ]);

    const decision = canDecide(req, report);
    const out = {
      ...report.toObject(),
      employeeName: employeeNameOf(submitter),
      approverName: employeeNameOf(approver),
      expenseCount: enriched.length,
      totalAmount,
      // UI affordances (server is still the source of truth on every action).
      viewerIsOwner: isOwner,
      canApprove: report.status === "submitted" && decision.ok,
      canReimburse: report.status === "approved" && isFinance(req),
    };

    // Activity timeline (oldest → newest). Tenant-scoped: workspaceId is stamped
    // explicitly so it can never read another workspace's claim history.
    const activityDocs = await ExpenseActivity.find({
      workspaceId: req.workspaceObjectId,
      reportId: report._id,
    })
      .sort({ createdAt: 1 })
      .lean();
    const activity = activityDocs.map((a: any) => ({
      _id: String(a._id),
      event: a.event,
      actorName: a.actorName,
      actorId: a.actorId ? String(a.actorId) : null,
      expenseId: a.expenseId ? String(a.expenseId) : null,
      note: a.note ?? null,
      createdAt: a.createdAt,
    }));

    res.json({ ok: true, report: out, expenses: enriched, activity });
  } catch (err: any) {
    console.error("[Reports GET one]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load report" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /api/reports/:id  — rename (DRAFT only, owner).
 * ───────────────────────────────────────────────────────────────────── */
router.patch("/:id", async (req: any, res: any) => {
  try {
    const report = await loadReport(req, req.params.id, { ownerOnly: true });
    if (!report) return res.status(404).json({ error: "Report not found" });
    if (!EDITABLE_STATUSES.has(report.status)) {
      return res.status(409).json({ error: "Only draft or clarification-required reports can be edited" });
    }
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });

    report.name = name;
    await report.save();
    res.json({ ok: true, report: report.toObject() });
  } catch (err: any) {
    console.error("[Reports PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update report" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/reports/:id/expenses  — add OWN unreported expenses (DRAFT only).
 * Atomic conditional update: each expense must be own, in this workspace and
 * not already linked. Skipped ids (already reported / not own) are reported back.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/expenses", async (req: any, res: any) => {
  try {
    const report = await loadReport(req, req.params.id, { ownerOnly: true });
    if (!report) return res.status(404).json({ error: "Report not found" });
    if (!EDITABLE_STATUSES.has(report.status)) {
      return res.status(409).json({ error: "Can only add expenses to a draft or clarification-required report" });
    }

    const raw = Array.isArray(req.body?.expenseIds) ? req.body.expenseIds : [];
    if (raw.length === 0) return res.status(400).json({ error: "expenseIds is required" });

    // Shared state machine: only OWN, in-workspace, unlinked expenses move in;
    // each takes the report's own lifecycle. Skipped ids are reported back.
    const { added, skipped } = await linkExpensesToReport(
      req.workspaceObjectId,
      ownEmployeeId(req),
      report,
      raw,
    );

    res.json({ ok: true, added, skipped });
  } catch (err: any) {
    console.error("[Reports add expenses]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to add expenses" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * DELETE /api/reports/:id/expenses/:eid  — unlink one → pending_to_submit.
 * Allowed on editable reports (draft / clarification_required) AND on a
 * DECLINED report: declined is terminal, but the owner may pull its expenses
 * out so they can be re-reported elsewhere.
 * ───────────────────────────────────────────────────────────────────── */
router.delete("/:id/expenses/:eid", async (req: any, res: any) => {
  try {
    const report = await loadReport(req, req.params.id, { ownerOnly: true });
    if (!report) return res.status(404).json({ error: "Report not found" });
    if (!EDITABLE_STATUSES.has(report.status) && report.status !== "declined") {
      return res.status(409).json({ error: "Can only remove expenses from a draft, clarification-required or declined report" });
    }
    const { eid } = req.params;
    if (!mongoose.Types.ObjectId.isValid(eid)) {
      return res.status(404).json({ error: "Expense not found" });
    }

    const result = await Expense.updateOne(
      {
        _id: new mongoose.Types.ObjectId(eid),
        workspaceId: req.workspaceObjectId,
        employeeId: new mongoose.Types.ObjectId(ownEmployeeId(req)),
        reportId: report._id,
      },
      { $set: { reportId: null, lifecycleStatus: "pending_to_submit" } },
    );
    if (!result.matchedCount) return res.status(404).json({ error: "Expense not in this report" });

    await logActivity({
      workspaceId: req.workspaceObjectId,
      reportId: report._id as mongoose.Types.ObjectId,
      event: "expense_removed",
      actorId: ownEmployeeId(req),
      actorName: actorNameOf(req),
      expenseId: eid,
    });

    res.json({ ok: true });
  } catch (err: any) {
    console.error("[Reports remove expense]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to remove expense" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/reports/:id/submit  — draft → submitted (owner, ≥1 expense).
 * Delegates to the shared submitReport() state machine: validates (blocking →
 * 409 list, warnings → echoed), snapshots the approver (manager → admin/HR
 * fallback), propagates expenses to awaiting_approval, and fires the approver
 * email (non-fatal). Same path used by WhatsApp quick-submit.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/submit", async (req: any, res: any) => {
  try {
    const result = await submitReport(req.workspaceObjectId, ownEmployeeId(req), req.params.id);
    if (!result.ok) {
      if (result.reason === "not_found") return res.status(404).json({ error: "Report not found" });
      if (result.reason === "not_editable") {
        return res.status(409).json({ error: "Only draft or clarification-required reports can be submitted" });
      }
      // blocking — surfaced via api.ts error.errors
      return res.status(409).json({
        error: "Please fix the following before submitting:",
        errors: result.blocking,
        blocking: result.blocking,
        warnings: result.warnings,
      });
    }

    res.json({
      ok: true,
      report: { ...result.report.toObject(), expenseCount: result.expenseCount },
      warnings: result.warnings,
    });
  } catch (err: any) {
    console.error("[Reports submit]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to submit report" });
  }
});

/* ── Authorization helper for approve/reject ─────────────────────────
 * The actor must be the routed approver OR an admin (seesAll). A NON-admin
 * cannot decide their OWN report (segregation of duties); an ADMIN may
 * (owner-operator override) — recorded via selfApproved. */
function canDecide(req: any, report: any): { ok: boolean; admin: boolean; isSelf: boolean } {
  const me = ownEmployeeId(req);
  const admin = seesAllReports(req);
  const isApprover = report.approverId && String(report.approverId) === me;
  const isSelf = String(report.employeeId) === me;
  const ok = (isApprover || admin) && (!isSelf || admin);
  return { ok, admin, isSelf };
}

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/reports/:id/approve  — submitted → approved (approver or admin).
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/approve", async (req: any, res: any) => {
  try {
    const report = await loadReportAny(req, req.params.id);
    if (!report) return res.status(404).json({ error: "Report not found" });
    if (report.status !== "submitted") {
      return res.status(409).json({ error: "Only submitted reports can be approved" });
    }
    const { ok, isSelf } = canDecide(req, report);
    if (!ok) return res.status(403).json({ error: "You are not authorized to approve this report" });

    const me = ownEmployeeId(req);
    report.status = "approved";
    report.approvedAt = new Date();
    report.approverId = new mongoose.Types.ObjectId(me); // actual decider
    report.selfApproved = isSelf;
    if (isSelf) report.decisionNote = report.decisionNote || "Self-approved by admin";
    await report.save();

    await propagateReportLifecycle(req.workspaceObjectId, report._id as mongoose.Types.ObjectId, "approved");

    await logActivity({
      workspaceId: req.workspaceObjectId,
      reportId: report._id as mongoose.Types.ObjectId,
      event: "approved",
      actorId: me,
      actorName: actorNameOf(req),
      note: isSelf ? "Self-approved by admin" : null,
    });

    res.json({ ok: true, report: report.toObject() });
  } catch (err: any) {
    console.error("[Reports approve]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to approve report" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/reports/:id/decline  — submitted → declined (approver or admin).
 * decisionNote (reason) is REQUIRED. TERMINAL: a declined report has no reopen.
 * (Owners may still pull individual expenses out — see DELETE :id/expenses/:eid.)
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/decline", async (req: any, res: any) => {
  try {
    const report = await loadReportAny(req, req.params.id);
    if (!report) return res.status(404).json({ error: "Report not found" });
    if (report.status !== "submitted") {
      return res.status(409).json({ error: "Only submitted reports can be declined" });
    }
    const { ok, isSelf } = canDecide(req, report);
    if (!ok) return res.status(403).json({ error: "You are not authorized to decline this report" });

    const note = String(req.body?.decisionNote || "").trim();
    if (!note) return res.status(400).json({ error: "A reason is required to decline." });

    const me = ownEmployeeId(req);
    report.status = "declined";
    report.approverId = new mongoose.Types.ObjectId(me);
    report.decisionNote = note;
    report.selfApproved = isSelf;
    await report.save();

    await propagateReportLifecycle(req.workspaceObjectId, report._id as mongoose.Types.ObjectId, "declined");

    await logActivity({
      workspaceId: req.workspaceObjectId,
      reportId: report._id as mongoose.Types.ObjectId,
      event: "declined",
      actorId: me,
      actorName: actorNameOf(req),
      note,
    });

    res.json({ ok: true, report: report.toObject() });
  } catch (err: any) {
    console.error("[Reports decline]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to decline report" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/reports/:id/request-clarification  — submitted → clarification_required
 * (approver or admin). decisionNote (the question) is REQUIRED. Returns the
 * report to the OWNER, who can edit and Resubmit (replaces the old reopen loop).
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/request-clarification", async (req: any, res: any) => {
  try {
    const report = await loadReportAny(req, req.params.id);
    if (!report) return res.status(404).json({ error: "Report not found" });
    if (report.status !== "submitted") {
      return res.status(409).json({ error: "Only submitted reports can be sent back for clarification" });
    }
    const { ok, isSelf } = canDecide(req, report);
    if (!ok) return res.status(403).json({ error: "You are not authorized to action this report" });

    const note = String(req.body?.decisionNote || "").trim();
    if (!note) return res.status(400).json({ error: "A note is required to request clarification." });

    const me = ownEmployeeId(req);
    report.status = "clarification_required";
    report.approverId = new mongoose.Types.ObjectId(me);
    report.decisionNote = note;
    report.selfApproved = isSelf;
    report.approvedAt = null;
    await report.save();

    await propagateReportLifecycle(
      req.workspaceObjectId,
      report._id as mongoose.Types.ObjectId,
      "clarification_required",
    );

    await logActivity({
      workspaceId: req.workspaceObjectId,
      reportId: report._id as mongoose.Types.ObjectId,
      event: "clarification_requested",
      actorId: me,
      actorName: actorNameOf(req),
      note,
    });

    res.json({ ok: true, report: report.toObject() });
  } catch (err: any) {
    console.error("[Reports request-clarification]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to request clarification" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/reports/:id/reimburse  — approved → reimbursed (FINANCE only).
 * Finance may reimburse their own approved report (owner-operator leniency).
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/reimburse", async (req: any, res: any) => {
  try {
    if (!isFinance(req)) return res.status(403).json({ error: "Finance access required" });

    const report = await loadReportAny(req, req.params.id);
    if (!report) return res.status(404).json({ error: "Report not found" });
    if (report.status !== "approved") {
      return res.status(409).json({ error: "Only approved reports can be reimbursed" });
    }

    report.status = "reimbursed";
    report.reimbursedAt = new Date();
    await report.save();

    await propagateReportLifecycle(req.workspaceObjectId, report._id as mongoose.Types.ObjectId, "reimbursed");

    await logActivity({
      workspaceId: req.workspaceObjectId,
      reportId: report._id as mongoose.Types.ObjectId,
      event: "reimbursed",
      actorId: ownEmployeeId(req),
      actorName: actorNameOf(req),
    });

    res.json({ ok: true, report: report.toObject() });
  } catch (err: any) {
    console.error("[Reports reimburse]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to reimburse report" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * DELETE /api/reports/:id  — owner, editable (draft / clarification_required).
 * Unlinks its expenses (→ pending_to_submit) first.
 * ───────────────────────────────────────────────────────────────────── */
router.delete("/:id", async (req: any, res: any) => {
  try {
    const report = await loadReport(req, req.params.id, { ownerOnly: true });
    if (!report) return res.status(404).json({ error: "Report not found" });
    if (!EDITABLE_STATUSES.has(report.status)) {
      return res.status(409).json({ error: "Only draft or clarification-required reports can be deleted" });
    }

    await unlinkAllExpenses(req.workspaceObjectId, report._id as mongoose.Types.ObjectId);
    await report.deleteOne();

    res.json({ ok: true });
  } catch (err: any) {
    console.error("[Reports DELETE]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to delete report" });
  }
});

export default router;
