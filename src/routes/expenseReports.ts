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
import ExcelJS from "exceljs";
import {
  seesAll,
  isAdmin as isAdminUser,
  isFinance as isFinanceUser,
  canDecide as canDecideUser,
  canReimburse as canReimburseUser,
  userIdOf,
} from "../services/expense.access.js";
import ExpenseAdvance from "../models/ExpenseAdvance.js";
import { csvRow } from "../utils/exportHelpers.js";
import { parseISTStart, parseISTEnd } from "../utils/dateIST.js";
import { refFromId } from "../utils/refFromId.js";
import {
  propagateReportLifecycle,
  unlinkAllExpenses,
  createReport,
  linkExpensesToReport,
  submitReport,
  logActivity,
  ensureApprovalChain,
  actorNameById,
} from "../services/reports.service.js";
import Report from "../models/Report.js";
import ExpenseActivity from "../models/ExpenseActivity.js";
import { sendClaimSubmittedEmail } from "../utils/claimEmails.js";
import {
  earmarkedTotalForClaim,
  settleEarmarksForClaim,
  releaseEarmarksForClaim,
  listAppliedAdvancesForClaim,
  claimTotal,
  round2,
} from "../services/advanceSettlement.service.js";

// Owner-editable report states: a draft, or one bounced back for clarification.
// add / remove / rename / submit / delete all gate on this set.
const EDITABLE_STATUSES = new Set(["draft", "clarification_required"]);
import Expense from "../models/Expense.js";
import User from "../models/User.js";
import {
  amountBaseExpr,
  pendingConversionExpr,
  getWorkspaceBaseCurrency,
  fxView,
} from "../services/expenseFx.service.js";
import { appendActivity, msBetween, fmtDuration } from "../services/expenseAudit.service.js";
import { normalizeActorType } from "../models/ExpenseActivity.js";

import ExpenseCategory from "../models/ExpenseCategory.js";
import { claimDisplayName, withDisplayName } from "../services/expenseClaimNaming.js";

const router = express.Router();

/* ── Access predicates: delegated to the single source of truth ──────
 * services/expense.access.ts owns the role sets + seesAll/finance/admin/decide
 * logic. These thin req-shaped adapters feed it req.user; the divergent inline
 * FINANCE_ADMIN_ROLES / FINANCE_ROLES sets that used to live here are gone. */
function seesAllReports(req: any): boolean {
  return seesAll(req.user);
}

function ownEmployeeId(req: any): string {
  return userIdOf(req.user);
}

function isFinance(req: any): boolean {
  return isFinanceUser(req.user);
}

function employeeNameOf(u: any): string {
  if (!u || typeof u !== "object") return "";
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return full || u.name || u.email || "";
}

/** The acting person's NAME for the trail (audit F-25). req.user is the JWT
 *  payload — no first/last name — so resolve through the User document like
 *  the submitter entries do; fall back to the token's email, never blank. */
async function actorNameOf(req: any): Promise<string> {
  return (await actorNameById(userIdOf(req.user))) || employeeNameOf(req.user) || "System";
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
// Per-claim count + total. `amount` is the BASE-CURRENCY total (Σ amountBase,
// slice 0 — audit F-19) and is round2'd here so it agrees with claimTotal()
// in advanceSettlement.service (audit F-20). `pendingConversion` counts the
// foreign lines that still have no rate — such a claim's total is partial and
// the UI says so; the submit gate refuses it anyway.
async function countsForReports(
  workspaceId: mongoose.Types.ObjectId,
  reportIds: mongoose.Types.ObjectId[],
  baseCurrency?: string,
): Promise<Record<string, { count: number; amount: number; pendingConversion: number; categoryNames: string[] }>> {
  if (reportIds.length === 0) return {};
  const base = baseCurrency || (await getWorkspaceBaseCurrency(workspaceId));
  const rows = await Expense.aggregate([
    { $match: { workspaceId, reportId: { $in: reportIds } } },
    {
      $group: {
        _id: "$reportId",
        count: { $sum: 1 },
        amount: { $sum: amountBaseExpr(base) },
        pendingConversion: { $sum: pendingConversionExpr(base) },
        // Distinct categories on the claim — drives the display-name prefix.
        categoryIds: { $addToSet: "$categoryId" },
      },
    },
  ]);
  // One lookup for every category id seen across the page of claims.
  const catIds = [
    ...new Set(
      rows.flatMap((r: any) => (Array.isArray(r.categoryIds) ? r.categoryIds : [])).filter(Boolean).map((c: any) => String(c)),
    ),
  ];
  const catNames = new Map<string, string>();
  if (catIds.length) {
    const cats = await ExpenseCategory.find({ workspaceId, _id: { $in: catIds.map((c) => new mongoose.Types.ObjectId(c)) } })
      .select("name")
      .lean();
    for (const c of cats as any[]) catNames.set(String(c._id), String(c.name));
  }
  const out: Record<string, { count: number; amount: number; pendingConversion: number; categoryNames: string[] }> = {};
  for (const r of rows) {
    out[String(r._id)] = {
      count: r.count || 0,
      amount: round2(r.amount || 0),
      pendingConversion: r.pendingConversion || 0,
      categoryNames: (Array.isArray(r.categoryIds) ? r.categoryIds : [])
        .filter(Boolean)
        .map((c: any) => catNames.get(String(c)) || "")
        .filter(Boolean),
    };
  }
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
    const baseCurrency = await getWorkspaceBaseCurrency(req.workspaceObjectId);
    const counts = await countsForReports(
      req.workspaceObjectId,
      reports.map((r: any) => r._id),
      baseCurrency,
    );

    const docs = reports.map((r: any) => {
      const emp = r.employeeId;
      return {
        ...r,
        employeeId: emp && typeof emp === "object" ? emp._id : emp,
        employeeName: employeeNameOf(emp),
        expenseCount: counts[String(r._id)]?.count ?? 0,
        totalAmount: counts[String(r._id)]?.amount ?? 0, // base currency
        baseCurrency,
        pendingConversion: counts[String(r._id)]?.pendingConversion ?? 0,
        // Derived every read from the bills the claim holds now — never stored.
        displayName: claimDisplayName(String(r.name || ""), counts[String(r._id)]?.categoryNames ?? []),
      };
    });

    res.json({ ok: true, docs, baseCurrency });
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

    res.status(201).json({ ok: true, report: withDisplayName({ ...report.toObject(), expenseCount: 0, totalAmount: 0 }, []) });
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
/* ─────────────────────────────────────────────────────────────────────
 * GET /api/reports/export?format=csv|xlsx|json&dateFrom=&dateTo=&page=&limit=
 * The "Claim Report" — ONE row per claim, on the SHARED report contract so the
 * Reports-hub runner can render it. CLAIM_REPORT_COLUMNS + the per-row builder
 * are the SINGLE source for every output:
 *   • format absent / format=json → { columns, rows, total, range }, PAGINATED
 *     via page/limit (newest first).
 *   • format=csv|xlsx → the file (FULL filtered set) — CSV + XLSX (ExcelJS),
 *     mirroring the expenses / advances exports.
 *
 * seesAll-gated (finance/admin). Tenant-scoped (workspaceId stamped). Date-ranged
 * on the claim's createdAt when ?dateFrom/?dateTo are passed; no params = all.
 * ALL enrichment is batched — employee names, approver names, and the advance
 * cross-ref — so there are NO per-row queries.
 *
 * Declared BEFORE GET /:id so ":id" never captures "export".
 * ───────────────────────────────────────────────────────────────────── */
type ReportColumnType = "money" | "number" | "date" | "text";
type ClaimCol = { key: string; label: string; money?: boolean; type?: ReportColumnType };
const CLAIM_REPORT_COLUMNS: ClaimCol[] = [
  { key: "ref", label: "Ref" },
  { key: "title", label: "Title" },
  { key: "employee", label: "Employee" },
  { key: "email", label: "Email" },
  { key: "status", label: "Status" },
  { key: "expenses", label: "Expenses", type: "number" },
  { key: "total", label: "Total", money: true, type: "money" },
  // Base currency the Total / Advance Applied / Net Payout columns are in.
  { key: "currency", label: "Currency" },
  { key: "advanceApplied", label: "Advance Applied", money: true, type: "money" },
  { key: "netPayout", label: "Net Payout", money: true, type: "money" },
  { key: "advances", label: "Advances" },
  { key: "approval", label: "Approval" },
  { key: "submittedOn", label: "Submitted On", type: "date" },
  { key: "approvedOn", label: "Approved On", type: "date" },
  { key: "reimbursedOn", label: "Reimbursed On", type: "date" },
  { key: "createdOn", label: "Created On", type: "date" },
];

/** IST-formatted date — matches the expenses / advances exports. */
function fmtClaimDate(d: any): string {
  return d ? new Date(d).toLocaleDateString("en-IN") : "";
}

/** Inline money for the advance cross-ref cell, e.g. 5000 → "₹5,000". */
function fmtClaimINR(n: any): string {
  const v = round2(n);
  return `₹${new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(v)}`;
}

/** "clarification_required" → "Clarification required" (claim status display). */
function humanizeClaimStatus(s: any): string {
  const v = String(s || "").replace(/_/g, " ");
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : "";
}

router.get("/export", async (req: any, res: any) => {
  try {
    if (!seesAllReports(req)) {
      return res.status(403).json({ error: "Finance or admin access required" });
    }

    const format =
      req.query.format === "xlsx" ? "xlsx" : req.query.format === "csv" ? "csv" : "json";

    // Tenant-scoped; date-ranged on the claim's createdAt when passed.
    const filter: Record<string, any> = { workspaceId: req.workspaceObjectId };
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom) : "";
    const dateTo = req.query.dateTo ? String(req.query.dateTo) : "";
    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = parseISTStart(dateFrom);
      if (dateTo) filter.createdAt.$lte = parseISTEnd(dateTo);
    }

    // JSON is paged; file exports carry the FULL filtered set.
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));

    const baseQuery = Report.find(filter).sort({ createdAt: -1 });
    let docs: any[];
    let total: number;
    if (format === "json") {
      [docs, total] = await Promise.all([
        baseQuery.skip((page - 1) * limit).limit(limit).lean(),
        Report.countDocuments(filter),
      ]);
    } else {
      docs = await baseQuery.lean();
      total = docs.length;
    }

    const reportObjIds = docs.map((r: any) => r._id);
    const reportIdSet = new Set(reportObjIds.map(String));

    // ── Batched: per-claim counts + totals (one aggregation; base currency) ──
    const baseCurrency = await getWorkspaceBaseCurrency(req.workspaceObjectId);
    const counts = await countsForReports(req.workspaceObjectId, reportObjIds, baseCurrency);

    // ── Batched: employee names + emails (one lookup) ──
    const employeeIds = [
      ...new Set(docs.map((r: any) => r.employeeId).filter(Boolean).map(String)),
    ];
    const employeeById = new Map<string, any>();
    if (employeeIds.length) {
      const users = await User.find({
        _id: { $in: employeeIds.map((id) => new mongoose.Types.ObjectId(id)) },
      })
        .select("firstName lastName name email")
        .lean();
      users.forEach((u: any) => employeeById.set(String(u._id), u));
    }

    // ── Batched: chain approver names across every claim's approvalChain (one lookup) ──
    const chainApproverIds = [
      ...new Set(
        docs
          .flatMap((r: any) => (Array.isArray(r.approvalChain) ? r.approvalChain : []))
          .map((l: any) => l?.approverId)
          .filter((id: any) => id && mongoose.Types.ObjectId.isValid(String(id)))
          .map(String),
      ),
    ];
    const chainNameById = new Map<string, string>();
    if (chainApproverIds.length) {
      const chainUsers = await User.find({
        _id: { $in: chainApproverIds.map((id) => new mongoose.Types.ObjectId(id)) },
      })
        .select("firstName lastName name email")
        .lean();
      chainUsers.forEach((u: any) => chainNameById.set(String(u._id), employeeNameOf(u)));
    }

    // ── Batched: advance cross-ref — every advance whose settlements reference any
    // of these claims, in ONE query (reuses the expenses export's pattern). Builds
    // BOTH the "ADV-… (₹…, state); …" cell AND the Σ-applied-per-claim total. ──
    const advancesByReport = new Map<string, string>();
    const appliedByReport = new Map<string, number>();
    if (reportObjIds.length) {
      const advances = await ExpenseAdvance.find({
        workspaceId: req.workspaceObjectId,
        "settlements.reportId": { $in: reportObjIds },
      })
        .select("ref settlements")
        .lean();
      const partsByReport = new Map<string, string[]>();
      advances.forEach((a: any) => {
        const advRef = a.ref || refFromId("ADV", a._id);
        (Array.isArray(a.settlements) ? a.settlements : []).forEach((s: any) => {
          const rid = s?.reportId ? String(s.reportId) : "";
          if (!rid || !reportIdSet.has(rid)) return;
          // Earmarked until the claim reimburses, then settled.
          const state = s?.status === "settled" ? "settled" : "earmarked";
          const part = `${advRef} (${fmtClaimINR(s.amountApplied)}, ${state})`;
          const arr = partsByReport.get(rid);
          if (arr) arr.push(part);
          else partsByReport.set(rid, [part]);
          // Σ applied — settled uses settledAmount, earmarked uses amountApplied
          // (mirrors GET /:id's earmarked-applied + settled-applied total).
          const applied =
            s?.status === "settled" ? Number(s.settledAmount) || 0 : Number(s.amountApplied) || 0;
          appliedByReport.set(rid, (appliedByReport.get(rid) || 0) + applied);
        });
      });
      partsByReport.forEach((parts, rid) => advancesByReport.set(rid, parts.join("; ")));
    }

    const rows = docs.map((r: any) => {
      const id = String(r._id);
      const c = counts[id] || { count: 0, amount: 0, pendingConversion: 0 };
      const emp = employeeById.get(String(r.employeeId));
      const totalAmount = round2(c.amount);
      const appliedTotal = round2(appliedByReport.get(id) || 0);
      const approval = (Array.isArray(r.approvalChain) ? r.approvalChain : [])
        .map((l: any) => {
          const nm = l?.approverId ? chainNameById.get(String(l.approverId)) || "" : "";
          const st = String(l?.status || "").replace(/_/g, " ");
          return nm ? `${nm} (${st})` : `(${st})`;
        })
        .join("; ");
      return {
        ref: r.ref || refFromId("CLM", r._id),
        title: r.name || "",
        employee: employeeNameOf(emp),
        email: (emp && emp.email) || "",
        status: humanizeClaimStatus(r.status),
        expenses: c.count,
        total: totalAmount,
        currency: baseCurrency,
        // Blank when no advance applied (reads clean; mirrors the expenses export).
        advanceApplied: appliedTotal ? appliedTotal : "",
        netPayout: round2(totalAmount - appliedTotal),
        advances: advancesByReport.get(id) || "",
        approval,
        submittedOn: fmtClaimDate(r.submittedAt),
        approvedOn: fmtClaimDate(r.approvedAt),
        reimbursedOn: fmtClaimDate(r.reimbursedAt),
        createdOn: fmtClaimDate(r.createdAt),
      } as Record<string, any>;
    });

    // JSON (shared report contract) — same columns + rows, paginated.
    if (format === "json") {
      return res.json({
        columns: CLAIM_REPORT_COLUMNS.map((c) => ({ key: c.key, label: c.label, type: c.type })),
        rows,
        total,
        range: { dateFrom, dateTo },
      });
    }

    const header = CLAIM_REPORT_COLUMNS.map((c) => c.label);

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="claims-export.csv"');
      res.write(csvRow(header));
      rows.forEach((row) => res.write(csvRow(CLAIM_REPORT_COLUMNS.map((c) => row[c.key]))));
      return res.end();
    }

    // XLSX — mirror the expenses / advances export ExcelJS pattern.
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Claims");
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    const headerRow = sheet.addRow(header);
    headerRow.font = { bold: true };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF0" } };
    CLAIM_REPORT_COLUMNS.forEach((c, i) => {
      if (c.money) sheet.getColumn(i + 1).numFmt = "#,##0.00";
    });
    rows.forEach((row) => sheet.addRow(CLAIM_REPORT_COLUMNS.map((c) => row[c.key])));

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", 'attachment; filename="claims-export.xlsx"');
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err: any) {
    console.error("[Claims export]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to export claims" });
  }
});

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

    // Lazy-init a length-1 chain for legacy in-flight claims (approverId, no
    // chain). No-op once a chain exists; never changes status/approverId, so
    // approve/decline are unaffected.
    await ensureApprovalChain(report);

    const expenses = await Expense.find({
      workspaceId: req.workspaceObjectId,
      reportId: report._id,
    })
      .select("-rawExtraction -perFieldConfidence")
      .populate("categoryId", "name")
      .sort({ date: -1, createdAt: -1 })
      .lean();

    const baseCurrency = await getWorkspaceBaseCurrency(req.workspaceObjectId);
    const enriched = expenses.map((d: any) => {
      const cat = d.categoryId;
      return {
        ...d,
        categoryId: cat && typeof cat === "object" ? cat._id : cat,
        categoryName: categoryNameOf(d),
        hasReceipt: !!d.imageKey,
        ...fxView(d, baseCurrency), // amountBase / rate / conversionPending
      };
    });

    // Claim total in the BASE currency (slice 0). A conversion-pending line
    // contributes 0 and is counted in pendingConversion so the total is never
    // presented as complete while a rate is missing.
    const totalAmount = round2(
      enriched.reduce((s, e) => s + (Number(e.amountBase) || 0), 0),
    );
    const pendingConversion = enriched.filter((e) => e.conversionPending).length;

    // Resolve submitter + approver display names (small, two lookups).
    const [submitter, approver] = await Promise.all([
      User.findById(report.employeeId).select("firstName lastName email name").lean(),
      report.approverId
        ? User.findById(report.approverId).select("firstName lastName email name").lean()
        : Promise.resolve(null),
    ]);

    // Chain-progress stepper: enrich each level with its approver display name
    // (one workspace-scoped lookup over the level approverIds). currentLevel +
    // the raw chain are already on report.toObject(); this only adds the names.
    const rawChain: any[] = Array.isArray((report as any).approvalChain)
      ? (report as any).approvalChain
      : [];
    const chainNameById = new Map<string, string>();
    const chainApproverIds = rawChain.map((l) => l.approverId).filter(Boolean);
    if (chainApproverIds.length) {
      const chainUsers = await User.find({
        workspaceId: req.workspaceObjectId,
        _id: { $in: chainApproverIds },
      })
        .select("firstName lastName email name")
        .lean();
      chainUsers.forEach((u: any) => chainNameById.set(String(u._id), employeeNameOf(u)));
    }
    const approvalChain = rawChain.map((l: any) => ({
      level: l.level,
      approverId: l.approverId ? String(l.approverId) : null,
      // A bot level has no user — name it for the stepper (engine, sub-step 5).
      approverName: l.approverId ? chainNameById.get(String(l.approverId)) || "" : l.actorType === "bot" ? "Approval Bot" : "",
      status: l.status,
      decidedAt: l.decidedAt ?? null,
      note: l.note ?? null,
      // Audit / engine plumbing (sub-steps 2 + 5)
      actorType: l.actorType ?? "user",
      via: l.via ?? null,
      routedAt: l.routedAt ?? null,
      heldMs: l.heldMs ?? null,
      overLimit: !!l.overLimit,
      limitBase: l.limitBase ?? null,
    }));

    // Advances (Phase 2) applied to this claim — earmarked or settled — plus the
    // running applied total and the net the claim would pay out at reimburse.
    const appliedAdvances = await listAppliedAdvancesForClaim(req.workspaceObjectId, report._id);
    const earmarkedApplied = appliedAdvances
      .filter((a) => a.status === "earmarked")
      .reduce((s, a) => s + a.amountApplied, 0);
    const settledApplied = appliedAdvances
      .filter((a) => a.status === "settled")
      .reduce((s, a) => s + a.settledAmount, 0);
    const appliedTotal = round2(earmarkedApplied + settledApplied);

    const decision = canDecide(req, report);
    const out = {
      ...report.toObject(),
      employeeName: employeeNameOf(submitter),
      approverName: employeeNameOf(approver),
      approvalChain, // override the raw chain with the name-enriched one
      expenseCount: enriched.length,
      totalAmount, // base currency
      baseCurrency,
      pendingConversion,
      // ── Advance application (additive; empty/0 for a no-advance claim) ──
      appliedAdvances,
      advanceAppliedTotal: appliedTotal,
      // Net the claim pays out: a reimbursed claim shows its recorded net, or —
      // for a no-advance / pre-P2 reimbursed claim where reimbursedAmount is null
      // — the FULL claim total (never 0/blank). In-flight claims preview the net
      // from current earmarks (appliedTotal already treats a missing total as 0).
      netPayout:
        report.status === "reimbursed"
          ? (report as any).reimbursedAmount != null
            ? (report as any).reimbursedAmount
            : totalAmount
          : round2(totalAmount - appliedTotal),
      // UI affordances (server is still the source of truth on every action).
      viewerIsOwner: isOwner,
      canApprove: report.status === "submitted" && decision.ok,
      canReimburse: canReimburseUser(req.user, report),
      // System-owned prefix, derived from the lines just loaded (never stored).
      displayName: claimDisplayName(String((report as any).name || ""), enriched.map((d: any) => d.categoryName)),
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
      actorType: normalizeActorType(a), // rows from before sub-step 2 normalise by name
      expenseId: a.expenseId ? String(a.expenseId) : null,
      note: a.note ?? null,
      elapsedMs: a.elapsedMs ?? null,
      heldMs: a.heldMs ?? null,
      details: a.details ?? null,
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

    // The employee types the descriptive half only; if they pasted a prefix back
    // in, it is stripped on read — `name` stays exactly what they typed.
    report.name = name;
    await report.save();
    const lineCats = await Expense.find({ workspaceId: req.workspaceObjectId, reportId: report._id })
      .populate("categoryId", "name")
      .select("categoryId")
      .lean();
    res.json({ ok: true, report: withDisplayName(report.toObject(), lineCats.map((d: any) => categoryNameOf(d))) });
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
      actorName: await actorNameOf(req),
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
    // Receipt verification: the optional "no attachments for this claim"
    // bypass rides on the submit body. Only an explicit boolean is honoured.
    const b = req.body || {};
    const opts = typeof b.attachmentsNotRequired === "boolean" ? { attachmentsNotRequired: b.attachmentsNotRequired } : {};
    const result = await submitReport(req.workspaceObjectId, ownEmployeeId(req), req.params.id, opts);
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

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/reports/:id/withdraw  — submitted → draft (OWNER only). Audit F-14.
 *
 * Allowed ONLY while nobody has acted: status is still `submitted` AND every
 * chain level is still `pending` (a multi-level claim whose L1 has already
 * approved is "being reviewed" even though the claim itself still reads
 * submitted). The guard is a single conditional update on exactly that shape,
 * so a withdraw racing an approve/decline/send-back loses cleanly (409) instead
 * of overwriting the decision (the F-07 pattern).
 *
 * The claim goes back to DRAFT, not deleted: its lines stay linked and return
 * to pending_to_submit; the chain snapshot is cleared (a resubmit re-resolves
 * it); advance earmarks are kept (a draft may hold them). Timeline: `withdrawn`.
 * A claim already sent back (clarification_required) is already the owner's —
 * nothing to withdraw; declined / approved / reimbursed are refused.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/withdraw", async (req: any, res: any) => {
  try {
    const report = await loadReport(req, req.params.id, { ownerOnly: true });
    if (!report) return res.status(404).json({ error: "Report not found" }); // incl. someone else's claim

    const reviewed = "This claim is already being reviewed and can't be withdrawn — ask the approver to send it back.";
    if (report.status === "draft") {
      return res.status(409).json({ error: "This claim is already a draft." });
    }
    if (report.status === "clarification_required") {
      return res.status(409).json({ error: "This claim has been sent back to you — it is already editable." });
    }
    if (report.status !== "submitted") {
      return res.status(409).json({ error: reviewed });
    }

    const rid = report._id as mongoose.Types.ObjectId;
    const flipped = await Report.findOneAndUpdate(
      {
        _id: rid,
        workspaceId: req.workspaceObjectId,
        employeeId: new mongoose.Types.ObjectId(ownEmployeeId(req)),
        status: "submitted",
        // No level decided yet — every chain step (if any) is still pending.
        approvalChain: { $not: { $elemMatch: { status: { $ne: "pending" } } } },
      },
      {
        $set: {
          status: "draft",
          approverId: null,
          approvalChain: [],
          currentLevel: 1,
          submittedAt: null,
          decisionNote: null,
          selfApproved: false,
        },
      },
      { new: true },
    );
    if (!flipped) return res.status(409).json({ error: reviewed });

    await propagateReportLifecycle(req.workspaceObjectId, rid, "draft");

    const me = ownEmployeeId(req);
    const withdrawnAt = new Date();
    const inReviewMs = msBetween(report.submittedAt, withdrawnAt);
    await logActivity({
      workspaceId: req.workspaceObjectId,
      reportId: rid,
      event: "withdrawn",
      actorId: me,
      actorName: await actorNameOf(req),
      actorType: "user",
      heldMs: inReviewMs,
      note: `Withdrawn before review (after ${fmtDuration(inReviewMs) || "n/a"}) — back to draft`,
      details: { submittedAt: report.submittedAt ?? null, withdrawnAt, inReviewMs, previousApproverId: report.approverId ? String(report.approverId) : null },
    });

    res.json({ ok: true, report: flipped.toObject() });
  } catch (err: any) {
    console.error("[Reports withdraw]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to withdraw report" });
  }
});

/** Audit plumbing (sub-step 2): ms the CURRENT chain level sat with its
 *  approver — from the level's routedAt (stamped at submit / on advance), or
 *  the submit time for a chain that predates routedAt. Also stamps heldMs on
 *  the level itself so the chain and the timeline agree. */
function stampHeld(report: any, idx: number, decidedAt: Date): number | null {
  const chain: any[] = Array.isArray(report.approvalChain) ? report.approvalChain : [];
  const lvl = chain[idx];
  const routedAt = lvl?.routedAt ?? (idx === 0 ? report.submittedAt : null);
  const held = msBetween(routedAt, decidedAt);
  if (lvl) lvl.heldMs = held;
  return held;
}

/* ── Authorization helper for approve/reject ─────────────────────────
 * The actor must be the routed approver OR an admin. A NON-admin cannot decide
 * their OWN report (segregation of duties); an ADMIN may (owner-operator
 * override) — recorded via selfApproved. Delegates to expense.access.canDecide
 * (single source of truth); this req-shaped wrapper keeps the call sites stable. */
function canDecide(req: any, report: any): { ok: boolean; admin: boolean; isSelf: boolean } {
  return canDecideUser(req.user, report);
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
    // Lazy-init a length-1 chain for legacy claims so approval can advance it
    // (no-op when a chain is already present; never changes status/approverId).
    await ensureApprovalChain(report);

    const { ok, isSelf } = canDecide(req, report);
    if (!ok) return res.status(403).json({ error: "You are not authorized to approve this report" });

    const me = ownEmployeeId(req);
    const note = String(req.body?.decisionNote || "").trim() || null;

    // Locate the current step inside the chain (clamped for safety).
    const chain: any[] = Array.isArray(report.approvalChain) ? report.approvalChain : [];
    const totalLevels = chain.length || 1;
    const idx = Math.min(Math.max((report.currentLevel || 1) - 1, 0), Math.max(chain.length - 1, 0));
    const levelNo = idx + 1;

    // Stamp THIS level approved + who actually decided it + how long it sat.
    const decidedAt = new Date();
    const heldMs = stampHeld(report, idx, decidedAt);
    if (chain[idx]) {
      chain[idx].status = "approved";
      chain[idx].decidedAt = decidedAt;
      chain[idx].approverId = new mongoose.Types.ObjectId(me);
      if (note) chain[idx].note = note;
    }
    report.markModified("approvalChain");

    const hasNext = idx < chain.length - 1;
    const decisionDetails = {
      level: levelNo,
      ofLevels: totalLevels,
      routedAt: chain[idx]?.routedAt ?? report.submittedAt ?? null,
      decidedAt,
      heldMs,
      via: chain[idx]?.via ?? null,
      note,
      selfApproved: isSelf,
      adminOverride: !!(canDecide(req, report).admin && String(report.approverId) !== me), // decided by an admin who was not the routed approver
    };

    if (hasNext) {
      // ── Advance: not the last level → move to the next approver. The claim
      // stays `submitted` (expenses stay awaiting_approval — no re-propagation);
      // "awaiting L2" is derived from currentLevel. approverId is repointed to the
      // next approver so the queue + pending-count + canDecide all follow along.
      const next = chain[idx + 1];
      next.routedAt = decidedAt; // the next approver's clock starts now
      report.currentLevel = levelNo + 1;
      report.approverId = next.approverId; // denorm pointer → next pending approver
      report.selfApproved = isSelf;
      await report.save();

      await logActivity({
        workspaceId: req.workspaceObjectId,
        reportId: report._id as mongoose.Types.ObjectId,
        event: "approved",
        actorId: me,
        actorName: await actorNameOf(req),
        actorType: "user",
        heldMs,
        note: `Approved (L${levelNo}, held ${fmtDuration(heldMs) || "n/a"}) → awaiting L${levelNo + 1}`,
        details: { ...decisionDetails, nextLevel: levelNo + 1, nextApproverId: String(next.approverId) },
      });

      // Notify the next approver (best-effort — mirrors the submit notification).
      if (next?.approverId) {
        try {
          const [nextApprover, submitter, counts] = await Promise.all([
            User.findById(next.approverId).select("firstName lastName name email").lean(),
            User.findById(report.employeeId).select("firstName lastName name email").lean(),
            countsForReports(req.workspaceObjectId, [report._id as mongoose.Types.ObjectId]),
          ]);
          if ((nextApprover as any)?.email) {
            await sendClaimSubmittedEmail({
              to: (nextApprover as any).email,
              approverName: employeeNameOf(nextApprover),
              employeeName: employeeNameOf(submitter) || "An employee",
              claimRef: report.ref,
              claimId: String(report._id),
              totalAmount: counts[String(report._id)]?.amount ?? 0,
            });
          }
        } catch (mailErr: any) {
          console.error("[claim advance email]", mailErr?.message || mailErr);
        }
      }

      return res.json({ ok: true, report: report.toObject() });
    }

    // ── Final level → finalize exactly as today.
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
      actorName: await actorNameOf(req),
      actorType: "user",
      heldMs,
      note: totalLevels > 1
        ? `Approved (final, L${levelNo}, held ${fmtDuration(heldMs) || "n/a"})`
        : isSelf
          ? "Self-approved by admin"
          : heldMs != null
            ? `Approved (held ${fmtDuration(heldMs)})`
            : null,
      details: { ...decisionDetails, final: true },
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
    await ensureApprovalChain(report);

    const { ok, isSelf } = canDecide(req, report);
    if (!ok) return res.status(403).json({ error: "You are not authorized to decline this report" });

    const note = String(req.body?.decisionNote || "").trim();
    if (!note) return res.status(400).json({ error: "A reason is required to decline." });

    const me = ownEmployeeId(req);

    // Stamp the current chain level declined; the claim itself is terminal.
    const chain: any[] = Array.isArray(report.approvalChain) ? report.approvalChain : [];
    const idx = Math.min(Math.max((report.currentLevel || 1) - 1, 0), Math.max(chain.length - 1, 0));
    const levelNo = idx + 1;
    const decidedAt = new Date();
    const heldMs = stampHeld(report, idx, decidedAt);
    if (chain[idx]) {
      chain[idx].status = "declined";
      chain[idx].decidedAt = decidedAt;
      chain[idx].approverId = new mongoose.Types.ObjectId(me);
      chain[idx].note = note;
    }
    report.markModified("approvalChain");

    report.status = "declined";
    report.approverId = new mongoose.Types.ObjectId(me);
    report.decisionNote = note;
    report.selfApproved = isSelf;
    await report.save();

    await propagateReportLifecycle(req.workspaceObjectId, report._id as mongoose.Types.ObjectId, "declined");

    // Earmark release: a declined claim is terminal → drop any earmarked advance
    // applications. No balance moves (an earmark never reduced outstanding), so
    // the advances are left FULLY OUTSTANDING. Best-effort; never blocks decline.
    try {
      const { releasedCount } = await releaseEarmarksForClaim(
        req.workspaceObjectId,
        report._id as mongoose.Types.ObjectId,
      );
      if (releasedCount > 0) {
        await logActivity({
          workspaceId: req.workspaceObjectId,
          reportId: report._id as mongoose.Types.ObjectId,
          event: "advance_detached",
          actorId: me,
          actorName: await actorNameOf(req),
          note: `Released ${releasedCount} earmarked advance${releasedCount === 1 ? "" : "s"} (claim declined)`,
        });
      }
    } catch (e: any) {
      console.error("[Reports decline release earmarks]", e?.message || e);
    }

    await logActivity({
      workspaceId: req.workspaceObjectId,
      reportId: report._id as mongoose.Types.ObjectId,
      event: "declined",
      actorId: me,
      actorName: await actorNameOf(req),
      actorType: "user",
      heldMs,
      note: (chain.length || 1) > 1 ? `Declined (L${levelNo}): ${note}` : note,
      details: { level: levelNo, ofLevels: chain.length || 1, routedAt: chain[idx]?.routedAt ?? report.submittedAt ?? null, decidedAt, heldMs, via: chain[idx]?.via ?? null, note, selfApproved: isSelf },
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
    await ensureApprovalChain(report);

    const { ok, isSelf } = canDecide(req, report);
    if (!ok) return res.status(403).json({ error: "You are not authorized to action this report" });

    const note = String(req.body?.decisionNote || "").trim();
    if (!note) return res.status(400).json({ error: "A note is required to request clarification." });

    const me = ownEmployeeId(req);

    // Stamp the current chain level as needing clarification; returns to owner.
    // On resubmit the chain re-resolves fresh (submitReport rebuilds it).
    const chain: any[] = Array.isArray(report.approvalChain) ? report.approvalChain : [];
    const idx = Math.min(Math.max((report.currentLevel || 1) - 1, 0), Math.max(chain.length - 1, 0));
    const levelNo = idx + 1;
    const decidedAt = new Date();
    const heldMs = stampHeld(report, idx, decidedAt);
    if (chain[idx]) {
      chain[idx].status = "clarification_required";
      chain[idx].decidedAt = decidedAt;
      chain[idx].approverId = new mongoose.Types.ObjectId(me);
      chain[idx].note = note;
    }
    report.markModified("approvalChain");

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
      actorName: await actorNameOf(req),
      actorType: "user",
      heldMs,
      note: (chain.length || 1) > 1 ? `Clarification (L${levelNo}): ${note}` : note,
      details: { level: levelNo, ofLevels: chain.length || 1, routedAt: chain[idx]?.routedAt ?? report.submittedAt ?? null, decidedAt, heldMs, via: chain[idx]?.via ?? null, note, selfApproved: isSelf },
    });

    res.json({ ok: true, report: report.toObject() });
  } catch (err: any) {
    console.error("[Reports request-clarification]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to request clarification" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/reports/:id/reroute  — sub-step 8, the EXPLICIT ADMIN RETRY.
 *
 * A claim flagged `needsAttention` is one nobody could be found to approve when
 * its approver left. Nothing un-sticks it on its own: an admin raises a limit or
 * flags another approver on the Team page, then asks for this. It re-runs the
 * engine on the claim's current facts and either places it (flag cleared,
 * `re_routed` on the trail with the admin as actor) or leaves it flagged with a
 * message saying what still has to change.
 *
 * Admin only, and checked BEFORE the claim is loaded so a non-admin learns
 * nothing about which ids exist.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/reroute", async (req: any, res: any) => {
  try {
    if (!isAdminUser(req.user)) {
      return res.status(403).json({ error: "Only an expense admin can re-route a claim" });
    }
    const report = await loadReportAny(req, req.params.id);
    if (!report) return res.status(404).json({ error: "Report not found" });
    if (report.status !== "submitted") {
      return res.status(409).json({ error: "Only a submitted claim can be re-routed" });
    }
    if (!report.needsAttention) {
      return res.status(409).json({ error: "This claim is not waiting for a re-route" });
    }

    const { retryRoutingNow } = await import("../services/expenseReroute.service.js");
    const outcome = await retryRoutingNow({
      kind: "claim",
      doc: report,
      workspaceId: req.workspaceObjectId,
      actor: { id: String(userIdOf(req.user)), name: await actorNameOf(req) },
    });

    res.json({ ...outcome, report: report.toObject() });
  } catch (err: any) {
    console.error("[Reports reroute]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to re-route this claim" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/reports/:id/reimburse  — approved → reimbursed (FINANCE only).
 * Finance may reimburse their own approved report (owner-operator leniency).
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/reimburse", async (req: any, res: any) => {
  try {
    const report = await loadReportAny(req, req.params.id);
    if (!report) return res.status(404).json({ error: "Report not found" });
    if (report.status !== "approved") {
      return res.status(409).json({ error: "Only approved reports can be reimbursed" });
    }
    // Audit integrity (sub-step 2): NOBODY pays their own claim — not finance,
    // not an admin, not a superadmin. Checked before every other gate.
    if (String(report.employeeId) === ownEmployeeId(req)) {
      return res.status(403).json({
        error: "You can't reimburse your own claim — a different finance user must pay it out.",
        code: "OWN_CLAIM_PAYOUT_DENIED",
      });
    }
    // Finance-only + same-claim SoD: a finance user may not reimburse a claim
    // they themselves approved; an admin may (owner-operator override, LOGGED
    // below as sodOverride — audit F-18).
    if (!canReimburseUser(req.user, report)) {
      if (!isFinance(req)) return res.status(403).json({ error: "Finance access required" });
      return res.status(403).json({
        error: "You approved this claim — a different finance user must reimburse it.",
      });
    }
    const payerWasApprover = [
      ...(Array.isArray(report.approvalChain) ? report.approvalChain.map((l: any) => String(l?.approverId || "")) : []),
      String(report.approverId || ""),
    ].includes(ownEmployeeId(req));

    const ws = req.workspaceObjectId;
    const rid = report._id as mongoose.Types.ObjectId;

    // Atomic gate (idempotency): flip approved → reimbursed exactly ONCE. A retry
    // or a concurrent reimburse loses the race (status is no longer "approved")
    // and gets a 409, so the settlement step below can never double-draw an
    // advance. Replaces the previous load+save; the resulting document state is
    // identical for a no-advance claim (status + reimbursedAt).
    const flipped = await Report.findOneAndUpdate(
      { _id: rid, workspaceId: ws, status: "approved" },
      { $set: { status: "reimbursed", reimbursedAt: new Date() } },
      { new: true },
    );
    if (!flipped) {
      return res.status(409).json({ error: "Only approved reports can be reimbursed" });
    }

    // ── Advance settlement (NET reimburse) ──
    // The claim is now frozen as reimbursed, so its earmarks can't change under
    // us. A claim with NO applied advances skips ALL of this — appliedTotal === 0
    // → no settle, no net calc, no extra log note — and reimburses exactly as
    // before (THE regression line).
    const appliedTotal = await earmarkedTotalForClaim(ws, rid);
    let reimburseNote: string | null = null;
    if (appliedTotal > 0) {
      const { settledTotal, claimTotal: total, perAdvance } = await settleEarmarksForClaim(ws, rid);
      const net = Math.max(0, round2(total - settledTotal));
      flipped.advanceAppliedTotal = settledTotal;
      flipped.reimbursedAmount = net; // net cash actually paid out
      await flipped.save();
      reimburseNote = `Net payout ${net} (claim total ${total} − advances applied ${settledTotal})`;

      // Audit each advance drawdown on the ADVANCE timeline (best-effort).
      for (const pa of perAdvance) {
        try {
          await appendActivity({
            workspaceId: ws,
            advanceId: pa.advanceId,
            event: "settled",
            actorId: ownEmployeeId(req),
            actorName: await actorNameOf(req),
            actorType: "user",
            note: `Settled ${pa.settledAmount} against ${report.ref} (→ ${pa.newStatus})`,
            details: { reportId: String(rid), claimRef: report.ref, settledAmount: pa.settledAmount, newStatus: pa.newStatus },
          });
        } catch (e: any) {
          console.error("[advance settle log]", e?.message || e);
        }
      }
    }

    await propagateReportLifecycle(ws, rid, "reimbursed");

    const paidAt = flipped.reimbursedAt ?? new Date();
    const paidClaimTotal = await claimTotal(ws, rid);
    const sinceApprovalMs = msBetween(report.approvedAt, paidAt);
    await logActivity({
      workspaceId: ws,
      reportId: rid,
      event: "reimbursed",
      actorId: ownEmployeeId(req),
      actorName: await actorNameOf(req),
      actorType: "user",
      heldMs: sinceApprovalMs,
      note: [reimburseNote, payerWasApprover ? "Admin SoD override: payer also approved this claim" : null]
        .filter(Boolean)
        .join(" · ") || null,
      details: {
        approvedAt: report.approvedAt ?? null,
        paidAt,
        sinceApprovalMs,
        claimTotal: paidClaimTotal,
        advancesApplied: flipped.advanceAppliedTotal ?? 0,
        netPayout: flipped.reimbursedAmount ?? null,
        sodOverride: payerWasApprover,
        payerIsAdmin: isAdminUser(req.user),
      },
    });

    res.json({ ok: true, report: flipped.toObject() });
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

    // Audit F-05: an advance earmarked against this claim must be released
    // first (mirrors the decline handler) or it points at a deleted claim
    // forever — never settles, permanently reduces availableToEarmark.
    const { releasedCount } = await releaseEarmarksForClaim(
      req.workspaceObjectId,
      report._id as mongoose.Types.ObjectId,
    );
    await unlinkAllExpenses(req.workspaceObjectId, report._id as mongoose.Types.ObjectId);
    await report.deleteOne();

    res.json({ ok: true, releasedEarmarks: releasedCount });
  } catch (err: any) {
    console.error("[Reports DELETE]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to delete report" });
  }
});

export default router;
