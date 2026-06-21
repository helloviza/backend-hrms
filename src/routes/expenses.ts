// apps/backend/src/routes/expenses.ts
//
// Expense Management — Sprint 3a. Read API + export over the confirmed Expense
// records created by the WhatsApp capture flow (Sprint 1/2).
//
// Mounted at /api/expenses behind requireAuth + requireWorkspace (see server.ts).
//
// Scoping rules (NON-NEGOTIABLE):
//   • Every query AND the export sets `workspaceId` explicitly — the
//     workspaceScope plugin is NOT ambient (it only injects when a query carries
//     `_workspaceId` in its options), so a missing workspaceId would leak across
//     tenants. buildExpenseFilter() is the single place this is guaranteed.
//   • Finance/Admin (requireAdmin role set) see ALL workspace expenses and MAY
//     narrow by ?employeeId. Everyone else is FORCED to their own employeeId and
//     any ?employeeId param is ignored.
//
// Mirrors the invoices (list) and sbt.bookingRegister (export) patterns.

import express from "express";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import multer from "multer";
import { seesAll, userIdOf } from "../services/expense.access.js";
import { presignGetObject } from "../utils/s3Presign.js";
import { csvRow } from "../utils/exportHelpers.js";
import { parseISTStart, parseISTEnd } from "../utils/dateIST.js";
import { uploadExpenseReceiptToS3 } from "../utils/s3Upload.js";
import { extractReceipt } from "../services/receiptExtractorGemini.js";
import { createExpense } from "../services/expenses.service.js";
import { propagateReportLifecycle } from "../services/reports.service.js";
import { env } from "../config/env.js";
import Expense from "../models/Expense.js";
import ExpenseCategory from "../models/ExpenseCategory.js";
import Report from "../models/Report.js";
import ExpenseActivity from "../models/ExpenseActivity.js";
import ExpenseAdvance from "../models/ExpenseAdvance.js";
import User from "../models/User.js";

const router = express.Router();

/* ── Receipt upload (multipart) — memory storage, 10MB, image + PDF ──── */
const RECEIPT_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "application/pdf",
]);

const uploadReceipt = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (RECEIPT_MIMES.has(file.mimetype)) return cb(null, true);
    cb(new Error("Unsupported file type. Allowed: JPEG, PNG, WEBP, HEIC, PDF."));
  },
});

// Wrap multer so file errors return clean JSON (mirrors workspace.branding).
function receiptUploadMw(req: any, res: any, next: any) {
  uploadReceipt.single("file")(req, res, (err: any) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "File too large. Maximum size is 10MB." });
    }
    return res.status(400).json({ error: err?.message || "Upload failed" });
  });
}

/* ── Access predicates: delegated to the single source of truth ──────
 * services/expense.access.ts owns the role sets + the seesAll/finance/admin
 * logic. These thin adapters just feed it req.user (the divergent inline
 * FINANCE_ADMIN_ROLES set that used to live here is gone). */
function seesAllExpenses(req: any): boolean {
  return seesAll(req.user);
}

function ownEmployeeId(req: any): string {
  return userIdOf(req.user);
}

/** Claims routed to `me` as their snapshotted approver — the line expenses of
 *  these must be visible to the approver even though they aren't their own rows
 *  (the "approver can't open the receipts" fix). Status-agnostic: a routed claim
 *  is theirs to see before AND after they decide it. */
async function routedClaimIdsFor(req: any, me: string): Promise<mongoose.Types.ObjectId[]> {
  if (!me || !mongoose.Types.ObjectId.isValid(me)) return [];
  const reports = await Report.find({
    workspaceId: req.workspaceObjectId,
    approverId: new mongoose.Types.ObjectId(me),
  })
    .select("_id")
    .lean();
  return reports.map((r: any) => r._id as mongoose.Types.ObjectId);
}

/* ── Shared filter builder — the single guarantee of tenant + own scoping ──
 * `includeRoutedClaims` adds claim-aware visibility (own rows OR the expenses
 * of claims routed to me): ON for read/list/export/detail, OFF for personal
 * aggregates (summary) and own-only mutations (category PATCH). */
async function buildExpenseFilter(
  req: any,
  opts: { includeRoutedClaims?: boolean } = {},
): Promise<Record<string, any>> {
  const includeRoutedClaims = opts.includeRoutedClaims !== false;
  const filter: Record<string, any> = {
    workspaceId: req.workspaceObjectId, // NON-NEGOTIABLE explicit tenant scope
  };

  const all = seesAllExpenses(req);
  if (!all) {
    const me = ownEmployeeId(req);
    if (includeRoutedClaims) {
      // Own rows PLUS the line expenses of any claim routed to me as approver.
      // Pushed into $and so it composes with the search $or / status blocks
      // below instead of clobbering them.
      const routedIds = await routedClaimIdsFor(req, me);
      filter.$and = [
        ...(filter.$and || []),
        { $or: [{ employeeId: me }, { reportId: { $in: routedIds } }] },
      ];
    } else {
      // Employees are forced to their own records; ?employeeId is ignored.
      filter.employeeId = me;
    }
  } else if (req.query.employeeId) {
    // Finance/Admin may narrow to one employee.
    try {
      filter.employeeId = new mongoose.Types.ObjectId(String(req.query.employeeId));
    } catch {
      filter._id = { $in: [] }; // invalid id → empty result, never a leak
    }
  }

  // User-facing "status" is the report lifecycle (Layer 2), not the internal
  // record-state (Expense.status, always "submitted").
  if (req.query.status) {
    const s = String(req.query.status);
    if (s === "pending_to_submit") {
      // LOOSE pending only: pending (incl. legacy/WhatsApp rows that predate the
      // field, so missing/null counts too) AND not yet in any claim. An expense
      // sitting in a draft claim is still lifecycleStatus=pending_to_submit but
      // is surfaced as the derived "in_claim" bucket below, not here.
      // { reportId: null } matches both an explicit null and a missing field.
      filter.$and = [
        ...(filter.$and || []),
        { $or: [{ lifecycleStatus: "pending_to_submit" }, { lifecycleStatus: { $exists: false } }, { lifecycleStatus: null }] },
        { reportId: null },
      ];
    } else if (s === "in_claim") {
      // DERIVED bucket (no stored value): pending_to_submit linked to a
      // draft/clarification claim. Distinguished purely by reportId.
      filter.lifecycleStatus = "pending_to_submit";
      filter.reportId = { $ne: null };
    } else {
      filter.lifecycleStatus = s;
    }
  }

  // Add-to-report picker scope: only expenses not yet linked to ANY report.
  // Gated on reportId (NOT the status label) because both a loose expense and one
  // already sitting in a draft/clarification report now read "pending_to_submit".
  // { reportId: null } matches both an explicit null and a missing field.
  if (req.query.unlinked === "1" || req.query.unlinked === "true") {
    filter.reportId = null;
  }

  if (req.query.category) {
    // Layer 1: category filter is by managed categoryId (exact), not free text.
    const c = String(req.query.category);
    if (mongoose.Types.ObjectId.isValid(c)) {
      filter.categoryId = new mongoose.Types.ObjectId(c);
    } else {
      filter._id = { $in: [] }; // unknown category → empty result, never a leak
    }
  }

  if (req.query.dateFrom || req.query.dateTo) {
    // YYYY-MM-DD interpreted as an IST calendar day; parseISTEnd is inclusive.
    filter.date = {};
    if (req.query.dateFrom) filter.date.$gte = parseISTStart(String(req.query.dateFrom));
    if (req.query.dateTo) filter.date.$lte = parseISTEnd(String(req.query.dateTo));
  }

  if (req.query.search) {
    const re = new RegExp(String(req.query.search), "i");
    filter.$or = [{ merchant: re }, { ref: re }];
  }

  return filter;
}

function employeeNameOf(emp: any): string {
  if (!emp || typeof emp !== "object") return "";
  const full = [emp.firstName, emp.lastName].filter(Boolean).join(" ").trim();
  return full || emp.name || emp.email || "";
}

/* ── Export columns (single source of truth for CSV + XLSX) ─────────── */
type Col = { key: string; label: string; money?: boolean };
const EXPORT_COLUMNS: Col[] = [
  { key: "date", label: "Date" },
  { key: "employee", label: "Employee" },
  { key: "merchant", label: "Merchant" },
  { key: "category", label: "Category" },
  { key: "amount", label: "Amount", money: true },
  { key: "tax", label: "Tax", money: true },
  { key: "currency", label: "Currency" },
  { key: "gstin", label: "GSTIN" },
  { key: "status", label: "Status" },
  { key: "reimbursedOn", label: "Reimbursed On" },
  { key: "ref", label: "Ref" },
  { key: "claim", label: "Claim" },
  { key: "created", label: "Created" },
  { key: "receipt", label: "Receipt" },
  // ── Advances (Phase 2) — claim-level figures, appended after the existing
  // columns (order preserved). Blank for loose expenses / no-advance claims. ──
  { key: "advanceApplied", label: "Advance Applied", money: true },
  { key: "netReimbursed", label: "Net Reimbursed", money: true },
  // Advance cross-reference — the advance ref(s) + settled amount applied to this
  // expense's parent claim (so finance can trace which advance settled which
  // claim from the expenses file). Text, "; "-joined; blank when none.
  { key: "advancesApplied", label: "Advances Applied" },
];

function fmtDate(d: any): string {
  return d ? new Date(d).toLocaleDateString("en-IN") : "";
}

/** Inline money for the advance cross-reference cell, e.g. 5000 → "₹5,000". */
function fmtINR(n: any): string {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return `₹${new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(v)}`;
}

function categoryNameOf(d: any): string {
  // Prefer the managed category name; fall back to the AI hint for legacy rows
  // (created before Layer 1) that have no categoryId.
  const cat = d.categoryId;
  if (cat && typeof cat === "object" && cat.name) return String(cat.name);
  return d.suggestedCategory || "";
}

function humanizeLifecycle(s: any): string {
  // Legacy/missing rows read as the entry state. "Pending to submit", etc.
  const v = String(s || "pending_to_submit").replace(/_/g, " ");
  return v.charAt(0).toUpperCase() + v.slice(1);
}

function expenseToExportRow(
  d: any,
  claimsById: Map<
    string,
    {
      ref?: string;
      reimbursedAt?: any;
      advanceAppliedTotal?: number;
      reimbursedAmount?: number | null;
      claimTotal?: number;
    }
  >,
  // reportId → "ADV-… (₹…); …" — advances applied to that claim (preformatted).
  advancesByReport: Map<string, string>,
): Record<string, any> {
  const claim = d.reportId ? claimsById.get(String(d.reportId)) : null;
  return {
    date: fmtDate(d.date),
    employee: employeeNameOf(d.employeeId),
    merchant: d.merchant || "",
    category: categoryNameOf(d),
    amount: d.amount ?? 0,
    tax: d.taxAmount ?? 0,
    currency: d.currency || "",
    gstin: d.gstin || "",
    status: humanizeLifecycle(d.lifecycleStatus), // user-facing lifecycle, not record-state
    // reimbursedAt of the claim this expense sits in; blank unless reimbursed.
    reimbursedOn: claim?.reimbursedAt ? fmtDate(claim.reimbursedAt) : "",
    ref: d.ref || "",
    // Claim ref: the authoritative report.ref when resolved, else derived from
    // the id (CLM-XXXXXX = last 6 of the ObjectId, upper-cased — matches
    // refFromId). Blank for a loose expense (no claim).
    claim: claim?.ref || (d.reportId ? `CLM-${String(d.reportId).slice(-6).toUpperCase()}` : ""),
    created: fmtDate(d.createdAt),
    receipt: d.imageKey ? "Yes" : "No",
    // Advance figures of the CLAIM this expense sits in (claim-level, repeated
    // across the claim's rows). advanceApplied blank when 0/none (reads clean).
    advanceApplied: claim?.advanceAppliedTotal ? claim.advanceAppliedTotal : "",
    // Net cash paid out, for REIMBURSED claims only. The recorded reimbursedAmount
    // when present, else (no-advance / pre-P2 reimbursed claim where it is null)
    // the full claim total — never 0/blank for a reimbursed claim.
    netReimbursed: claim?.reimbursedAt
      ? claim.reimbursedAmount != null
        ? claim.reimbursedAmount
        : claim.claimTotal ?? ""
      : "",
    // Advance ref(s) + settled amount applied to this expense's parent claim
    // (claim-level, repeated across the claim's rows). Blank for loose expenses /
    // claims with no advance applied.
    advancesApplied: d.reportId ? advancesByReport.get(String(d.reportId)) || "" : "",
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expenses
 * Filters: dateFrom, dateTo (on `date`), employeeId (admin only), status,
 *   category (→ suggestedCategory), search (merchant + ref). page, limit.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/", async (req: any, res: any) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, parseInt(req.query.limit) || 25);
    const filter = await buildExpenseFilter(req);

    const [docs, total] = await Promise.all([
      Expense.find(filter)
        .select("-rawExtraction -perFieldConfidence")
        .populate("employeeId", "firstName lastName email name")
        .populate("categoryId", "name")
        .sort({ date: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Expense.countDocuments(filter),
    ]);

    const enriched = docs.map((d: any) => {
      const emp = d.employeeId;
      const cat = d.categoryId;
      return {
        ...d,
        employeeId: emp && typeof emp === "object" ? emp._id : emp,
        employeeName: employeeNameOf(emp),
        categoryId: cat && typeof cat === "object" ? cat._id : cat,
        categoryName: categoryNameOf(d), // managed name ?? AI hint (legacy)
        hasReceipt: !!d.imageKey,
      };
    });

    res.json({ ok: true, docs: enriched, total, page, pages: Math.ceil(total / limit) });
  } catch (err: any) {
    console.error("[Expenses GET list]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to list expenses" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expenses/export?format=csv|xlsx
 * Same filter + scoping as the list; NO pagination (full filtered set).
 * Receipt is a has-receipt flag, never a presigned URL.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/export", async (req: any, res: any) => {
  try {
    const format = req.query.format === "xlsx" ? "xlsx" : "csv";
    const filter = await buildExpenseFilter(req);

    const docs = await Expense.find(filter)
      .select("-rawExtraction -perFieldConfidence")
      .populate("employeeId", "firstName lastName email name")
      .populate("categoryId", "name")
      .sort({ date: -1, createdAt: -1 })
      .lean();

    // Resolve the claim each expense sits in (for the Claim + Reimbursed On
    // columns) in ONE workspace-scoped query. Loose expenses have no reportId.
    const reportIds = [
      ...new Set(docs.map((d: any) => d.reportId).filter(Boolean).map(String)),
    ];
    const claimsById = new Map<
      string,
      {
        ref?: string;
        reimbursedAt?: any;
        advanceAppliedTotal?: number;
        reimbursedAmount?: number | null;
        claimTotal?: number;
      }
    >();
    if (reportIds.length) {
      const reportObjIds = reportIds.map((rid) => new mongoose.Types.ObjectId(rid));
      const [reports, totals] = await Promise.all([
        Report.find({
          workspaceId: req.workspaceObjectId,
          _id: { $in: reportObjIds },
        })
          .select("ref reimbursedAt advanceAppliedTotal reimbursedAmount")
          .lean(),
        // True claim total per claim (Σ ALL its expenses, not just the filtered
        // export rows) — the Net Reimbursed fallback for reimbursed claims whose
        // reimbursedAmount is null (no-advance / pre-P2).
        Expense.aggregate([
          { $match: { workspaceId: req.workspaceObjectId, reportId: { $in: reportObjIds } } },
          { $group: { _id: "$reportId", total: { $sum: { $ifNull: ["$amount", 0] } } } },
        ]),
      ]);
      const totalByReport = new Map<string, number>();
      totals.forEach((t: any) => totalByReport.set(String(t._id), t.total || 0));
      reports.forEach((r: any) =>
        claimsById.set(String(r._id), {
          ref: r.ref,
          reimbursedAt: r.reimbursedAt,
          advanceAppliedTotal: r.advanceAppliedTotal,
          reimbursedAmount: r.reimbursedAmount,
          claimTotal: totalByReport.get(String(r._id)) ?? 0,
        }),
      );
    }

    // Advance cross-reference: in ONE batched query, find every advance whose
    // settlements reference any of the export's claims, then build a
    // reportId → "ADV-… (₹…); …" map (the advance ref + settled drawdown applied
    // to that claim). Lets each expense row name the advance(s) on its claim.
    const advancesByReport = new Map<string, string>();
    if (reportIds.length) {
      const reportObjIds = reportIds.map((rid) => new mongoose.Types.ObjectId(rid));
      const reportIdSet = new Set(reportIds);
      const advances = await ExpenseAdvance.find({
        workspaceId: req.workspaceObjectId,
        "settlements.reportId": { $in: reportObjIds },
      })
        .select("ref settlements")
        .lean();
      const partsByReport = new Map<string, string[]>();
      advances.forEach((a: any) => {
        const advRef = a.ref || `ADV-${String(a._id).slice(-6).toUpperCase()}`;
        (Array.isArray(a.settlements) ? a.settlements : []).forEach((s: any) => {
          const rid = s?.reportId ? String(s.reportId) : "";
          if (!rid || !reportIdSet.has(rid)) return;
          // Applied/earmark amount + settlement state (earmarked → settled).
          const state = s?.status === "settled" ? "settled" : "earmarked";
          const part = `${advRef} (${fmtINR(s.amountApplied)}, ${state})`;
          const arr = partsByReport.get(rid);
          if (arr) arr.push(part);
          else partsByReport.set(rid, [part]);
        });
      });
      partsByReport.forEach((parts, rid) => advancesByReport.set(rid, parts.join("; ")));
    }

    const rows = docs.map((d: any) => expenseToExportRow(d, claimsById, advancesByReport));
    const header = EXPORT_COLUMNS.map((c) => c.label);

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="expenses-export.csv"');
      res.write(csvRow(header));
      rows.forEach((r) => res.write(csvRow(EXPORT_COLUMNS.map((c) => r[c.key]))));
      return res.end();
    }

    // XLSX — mirror the booking-register ExcelJS pattern.
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Expenses");
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    const headerRow = sheet.addRow(header);
    headerRow.font = { bold: true };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF0" } };
    EXPORT_COLUMNS.forEach((c, i) => {
      if (c.money) sheet.getColumn(i + 1).numFmt = "#,##0.00";
    });
    rows.forEach((r) => sheet.addRow(EXPORT_COLUMNS.map((c) => r[c.key])));

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", 'attachment; filename="expenses-export.xlsx"');
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err: any) {
    console.error("[Expenses export]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to export expenses" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expenses/summary
 * Aggregate counts + amounts for the dashboard. MUST be declared before the
 * GET /:id param route, or ":id" would capture "summary".
 *
 * Tenant + own/admin scope comes from buildExpenseFilter (workspaceId always
 * stamped). The employee module passes ?employeeId=<self> to force own-only
 * even for admins; non-admins are forced own regardless.
 *
 * Note: aggregate() does NOT cast like find(), so we coerce id fields on the
 * match to ObjectId explicitly — otherwise a string employeeId never matches.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/summary", async (req: any, res: any) => {
  try {
    // Personal aggregate: own-scoped only (routed claims must not pollute the
    // employee's own totals, and aggregate() can't carry the routed $or cleanly).
    const filter = await buildExpenseFilter(req, { includeRoutedClaims: false });

    const match: Record<string, any> = { ...filter };
    if (match.workspaceId && !(match.workspaceId instanceof mongoose.Types.ObjectId)) {
      match.workspaceId = new mongoose.Types.ObjectId(String(match.workspaceId));
    }
    if (
      match.employeeId &&
      !(match.employeeId instanceof mongoose.Types.ObjectId) &&
      mongoose.Types.ObjectId.isValid(String(match.employeeId))
    ) {
      match.employeeId = new mongoose.Types.ObjectId(String(match.employeeId));
    }

    // Current IST calendar-month start (inclusive). Server clock may be UTC, so
    // shift into IST before deriving the YYYY-MM-01 boundary.
    const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const monthStartStr = `${nowIst.getUTCFullYear()}-${String(nowIst.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const monthStart = parseISTStart(monthStartStr);

    const sumAmount = { $sum: { $ifNull: ["$amount", 0] } };
    const [agg] = await Expense.aggregate([
      { $match: match },
      {
        $facet: {
          totals: [{ $group: { _id: null, count: { $sum: 1 }, amount: sumAmount } }],
          byStatus: [
            {
              $group: {
                // Split pending_to_submit into LOOSE (reportId null/missing) vs the
                // derived "in_claim" (reportId set). Legacy missing lifecycleStatus
                // folds into pending_to_submit. Stored values are never changed.
                _id: {
                  $cond: [
                    {
                      $and: [
                        { $eq: [{ $ifNull: ["$lifecycleStatus", "pending_to_submit"] }, "pending_to_submit"] },
                        { $ne: ["$reportId", null] },
                      ],
                    },
                    "in_claim",
                    { $ifNull: ["$lifecycleStatus", "pending_to_submit"] },
                  ],
                },
                count: { $sum: 1 },
                amount: sumAmount,
              },
            },
          ],
          thisMonth: [
            { $match: { date: { $gte: monthStart } } },
            { $group: { _id: null, count: { $sum: 1 }, amount: sumAmount } },
          ],
        },
      },
    ]);

    const totals = agg?.totals?.[0] || { count: 0, amount: 0 };
    const month = agg?.thisMonth?.[0] || { count: 0, amount: 0 };
    const byStatus = (agg?.byStatus || []).map((s: any) => ({
      status: s._id || "unknown",
      count: s.count || 0,
      amount: s.amount || 0,
    }));

    res.json({
      ok: true,
      summary: {
        total: { count: totals.count || 0, amount: totals.amount || 0 },
        month: { count: month.count || 0, amount: month.amount || 0, since: monthStartStr },
        byStatus,
      },
    });
  } catch (err: any) {
    console.error("[Expenses summary]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load summary" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expenses/analytics?dateFrom=&dateTo=
 * Workspace-wide expense analytics for finance/admin (seesAll). Returns
 * KPI + chart + table blocks via Mongo aggregation. ALL blocks are explicitly
 * tenant-scoped (workspaceId stamped — the workspaceScope plugin does NOT hook
 * .aggregate()) and respect the date range.
 *
 * Range semantics:
 *   • Spend / category / status / channel / merchant / spender blocks → on
 *     Expense.date (matches buildExpenseFilter + /summary).
 *   • Awaiting-reimbursement → approved claims whose approvedAt is in range.
 *   • Approval / reimburse cycle times + policy-flag rate → ExpenseActivity
 *     event timestamps (submit→approve, approve→reimburse, policy_check).
 *
 * Declared BEFORE GET /:id so ":id" never captures "analytics".
 * ───────────────────────────────────────────────────────────────────── */
router.get("/analytics", async (req: any, res: any) => {
  try {
    // Workspace-wide view is finance/admin only — never leak teammates' spend.
    if (!seesAllExpenses(req)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const workspaceId = req.workspaceObjectId as mongoose.Types.ObjectId;
    if (!workspaceId) {
      return res.status(400).json({ error: "Missing workspace context" });
    }

    const pad = (n: number) => String(n).padStart(2, "0");

    // Default range = last 12 IST calendar months (inclusive) when unspecified,
    // so the charts always have a meaningful window.
    const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const iy = nowIst.getUTCFullYear();
    const im = nowIst.getUTCMonth(); // 0-based
    const defFrom = new Date(Date.UTC(iy, im - 11, 1));
    const dateFromStr = req.query.dateFrom
      ? String(req.query.dateFrom)
      : `${defFrom.getUTCFullYear()}-${pad(defFrom.getUTCMonth() + 1)}-01`;
    const dateToStr = req.query.dateTo
      ? String(req.query.dateTo)
      : `${iy}-${pad(im + 1)}-${pad(nowIst.getUTCDate())}`;

    const rangeStart = parseISTStart(dateFromStr);
    const rangeEnd = parseISTEnd(dateToStr);

    const sumAmount = { $sum: { $ifNull: ["$amount", 0] } };
    const expMatch = {
      workspaceId,
      date: { $gte: rangeStart, $lte: rangeEnd },
    };

    // lifecycleStatus bucket expression — mirrors /summary (LOOSE pending vs the
    // derived "in_claim" when a pending expense sits in a draft/clarif claim).
    const statusBucket = {
      $cond: [
        {
          $and: [
            { $eq: [{ $ifNull: ["$lifecycleStatus", "pending_to_submit"] }, "pending_to_submit"] },
            { $ne: ["$reportId", null] },
          ],
        },
        "in_claim",
        { $ifNull: ["$lifecycleStatus", "pending_to_submit"] },
      ],
    };

    /* ── Block 1: expense-based aggregation (single pass, faceted) ──────── */
    const [expAgg] = await Expense.aggregate([
      { $match: expMatch },
      // Resolve a display category label: managed name → AI hint → Uncategorized.
      {
        $lookup: {
          from: ExpenseCategory.collection.name,
          localField: "categoryId",
          foreignField: "_id",
          as: "_cat",
        },
      },
      {
        $addFields: {
          categoryLabel: {
            $ifNull: [
              { $arrayElemAt: ["$_cat.name", 0] },
              { $ifNull: ["$suggestedCategory", "Uncategorized"] },
            ],
          },
        },
      },
      {
        $facet: {
          totals: [{ $group: { _id: null, amount: sumAmount, count: { $sum: 1 } } }],
          byMonthCat: [
            {
              $group: {
                _id: {
                  month: {
                    $dateToString: {
                      format: "%Y-%m",
                      date: { $ifNull: ["$date", "$createdAt"] },
                      timezone: "Asia/Kolkata",
                    },
                  },
                  category: "$categoryLabel",
                },
                amount: sumAmount,
              },
            },
          ],
          byCategory: [
            { $group: { _id: "$categoryLabel", amount: sumAmount, count: { $sum: 1 } } },
            { $sort: { amount: -1 } },
          ],
          byStatus: [
            { $group: { _id: statusBucket, amount: sumAmount, count: { $sum: 1 } } },
          ],
          byChannel: [
            {
              $group: {
                _id: { $ifNull: ["$sourceChannel", "whatsapp"] },
                amount: sumAmount,
                count: { $sum: 1 },
              },
            },
          ],
          topSpenders: [
            {
              $group: {
                _id: "$employeeId",
                amount: sumAmount,
                reportIds: { $addToSet: "$reportId" },
              },
            },
            {
              $project: {
                amount: 1,
                claims: {
                  $size: {
                    $filter: { input: "$reportIds", cond: { $ne: ["$$this", null] } },
                  },
                },
              },
            },
            { $sort: { amount: -1 } },
            { $limit: 10 },
          ],
          topMerchants: [
            { $match: { merchant: { $nin: [null, ""] } } },
            { $group: { _id: "$merchant", amount: sumAmount, expenses: { $sum: 1 } } },
            { $sort: { amount: -1 } },
            { $limit: 10 },
          ],
        },
      },
    ]);

    const totals = expAgg?.totals?.[0] || { amount: 0, count: 0 };

    // Spend over time — fill every month in range so the area chart has no gaps.
    const months: string[] = [];
    {
      const [fy, fm] = dateFromStr.split("-").map(Number);
      const [ty, tm] = dateToStr.split("-").map(Number);
      let y = fy;
      let m = fm;
      while (y < ty || (y === ty && m <= tm)) {
        months.push(`${y}-${pad(m)}`);
        m++;
        if (m > 12) {
          m = 1;
          y++;
        }
      }
    }
    const monthIdx = new Map<string, { month: string; total: number; categories: Record<string, number> }>();
    months.forEach((mo) => monthIdx.set(mo, { month: mo, total: 0, categories: {} }));
    (expAgg?.byMonthCat || []).forEach((r: any) => {
      const mo = r._id?.month;
      const bucket = monthIdx.get(mo);
      if (!bucket) return; // outside range (null/odd dates) — ignore
      const cat = r._id?.category || "Uncategorized";
      const amt = r.amount || 0;
      bucket.total += amt;
      bucket.categories[cat] = (bucket.categories[cat] || 0) + amt;
    });
    const spendOverTime = months.map((mo) => monthIdx.get(mo)!);

    const categories = (expAgg?.byCategory || []).map((c: any) => ({
      name: c._id || "Uncategorized",
      amount: c.amount || 0,
      count: c.count || 0,
    }));
    const byStatus = (expAgg?.byStatus || []).map((s: any) => ({
      status: s._id || "unknown",
      amount: s.amount || 0,
      count: s.count || 0,
    }));
    const channels = (expAgg?.byChannel || []).map((c: any) => ({
      channel: c._id || "whatsapp",
      amount: c.amount || 0,
      count: c.count || 0,
    }));

    /* ── Block 2: resolve names for top spenders ──────────────────────── */
    const topSpenderRaw = expAgg?.topSpenders || [];
    const spenderIds = topSpenderRaw
      .map((s: any) => s._id)
      .filter((id: any) => id && mongoose.Types.ObjectId.isValid(String(id)));
    const userMap = new Map<string, any>();
    if (spenderIds.length) {
      const users = await User.find({ _id: { $in: spenderIds } })
        .select("firstName lastName name email")
        .lean();
      users.forEach((u: any) => userMap.set(String(u._id), u));
    }
    const topSpenders = topSpenderRaw.map((s: any) => ({
      employeeId: String(s._id || ""),
      name: employeeNameOf(userMap.get(String(s._id))) || "Unknown",
      amount: s.amount || 0,
      claims: s.claims || 0,
    }));
    const topMerchants = (expAgg?.topMerchants || []).map((m: any) => ({
      merchant: m._id || "—",
      amount: m.amount || 0,
      expenses: m.expenses || 0,
    }));

    /* ── Block 3: awaiting reimbursement (approved, not yet reimbursed) ──
     * LIVE snapshot — "what's owed right now". Deliberately IGNORES the date
     * range (unlike every other block): finance needs the full current
     * outstanding liability, not just claims approved within the window. The
     * card is labelled "as of now" on the frontend to make this explicit. */
    const [awaitAgg] = await Report.aggregate([
      {
        $match: {
          workspaceId,
          status: "approved",
        },
      },
      {
        $lookup: {
          from: Expense.collection.name,
          localField: "_id",
          foreignField: "reportId",
          as: "_exp",
        },
      },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          amount: { $sum: { $sum: "$_exp.amount" } },
        },
      },
    ]);
    const awaitingReimbursement = {
      amount: awaitAgg?.amount || 0,
      count: awaitAgg?.count || 0,
    };

    /* ── Block 4: cycle times + policy-flag rate (ExpenseActivity) ─────── */
    // Per-claim terminal event timestamps. $max picks the latest of each event
    // (handles resubmit → uses the final submit before approval). aggregate() is
    // NOT scoped by the plugin, so workspaceId is matched explicitly.
    const actAgg = await ExpenseActivity.aggregate([
      {
        $match: {
          workspaceId,
          event: { $in: ["submitted", "resubmitted", "approved", "reimbursed", "policy_check"] },
        },
      },
      {
        $group: {
          _id: "$reportId",
          submittedAt: {
            $max: {
              $cond: [{ $in: ["$event", ["submitted", "resubmitted"]] }, "$createdAt", null],
            },
          },
          approvedAt: {
            $max: { $cond: [{ $eq: ["$event", "approved"] }, "$createdAt", null] },
          },
          reimbursedAt: {
            $max: { $cond: [{ $eq: ["$event", "reimbursed"] }, "$createdAt", null] },
          },
          hasPolicyFlag: {
            $max: { $cond: [{ $eq: ["$event", "policy_check"] }, 1, 0] },
          },
        },
      },
    ]);

    const DAY_MS = 24 * 60 * 60 * 1000;
    const inRange = (d: any) => d && d >= rangeStart && d <= rangeEnd;

    let approvalSum = 0;
    let approvalN = 0;
    let reimburseSum = 0;
    let reimburseN = 0;
    let submittedN = 0;
    let flaggedN = 0;
    for (const r of actAgg) {
      const sub = r.submittedAt ? new Date(r.submittedAt) : null;
      const app = r.approvedAt ? new Date(r.approvedAt) : null;
      const rei = r.reimbursedAt ? new Date(r.reimbursedAt) : null;

      // Policy-flag rate: among claims SUBMITTED in range.
      if (inRange(sub)) {
        submittedN++;
        if (r.hasPolicyFlag) flaggedN++;
      }
      // Submit → approve: claims APPROVED in range with a prior submit.
      if (inRange(app) && sub && app! >= sub) {
        approvalSum += app!.getTime() - sub.getTime();
        approvalN++;
      }
      // Approve → reimburse: claims REIMBURSED in range with a prior approve.
      if (inRange(rei) && app && rei! >= app) {
        reimburseSum += rei!.getTime() - app.getTime();
        reimburseN++;
      }
    }

    const round1 = (n: number) => Math.round(n * 10) / 10;
    const avgApprovalDays = approvalN > 0 ? round1(approvalSum / approvalN / DAY_MS) : null;
    const avgReimburseDays = reimburseN > 0 ? round1(reimburseSum / reimburseN / DAY_MS) : null;
    const policyFlagRate = submittedN > 0 ? flaggedN / submittedN : null;

    res.json({
      ok: true,
      range: { dateFrom: dateFromStr, dateTo: dateToStr },
      kpis: {
        totalSpend: totals.amount || 0,
        totalCount: totals.count || 0,
        awaitingReimbursement,
        avgApprovalDays,
        policyFlagRate,
      },
      spendOverTime,
      categories,
      byStatus,
      channels,
      topSpenders,
      topMerchants,
      cycleTimes: {
        submitToApproveDays: avgApprovalDays,
        approveToReimburseDays: avgReimburseDays,
        approvalSampleSize: approvalN,
        reimburseSampleSize: reimburseN,
      },
    });
  } catch (err: any) {
    console.error("[Expenses analytics]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load analytics" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expenses/:id/receipt-url
 * Fresh presigned GET URL for one expense's receipt. Same workspace + own/admin
 * gate as the list — an employee can only presign their own receipt.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/:id/receipt-url", async (req: any, res: any) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: "Expense not found" });
    }

    const filter: Record<string, any> = {
      _id: new mongoose.Types.ObjectId(id),
      workspaceId: req.workspaceObjectId, // NON-NEGOTIABLE explicit tenant scope
    };
    if (!seesAllExpenses(req)) {
      // Own receipt OR a receipt in a claim routed to me (claim-aware visibility).
      const me = ownEmployeeId(req);
      const routedIds = await routedClaimIdsFor(req, me);
      filter.$or = [{ employeeId: me }, { reportId: { $in: routedIds } }];
    }

    const expense: any = await Expense.findOne(filter)
      .select("imageKey s3Bucket ref")
      .lean();
    if (!expense) return res.status(404).json({ error: "Expense not found" });
    if (!expense.imageKey) return res.status(404).json({ error: "No receipt on file" });

    const url = await presignGetObject({
      bucket: expense.s3Bucket || env.S3_BUCKET,
      key: expense.imageKey,
      filename: `receipt-${expense.ref}.jpg`,
    });

    res.json({ ok: true, url });
  } catch (err: any) {
    console.error("[Expenses receipt-url]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to presign receipt" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expenses/:id
 * Single expense for the detail page. Declared AFTER /summary, /export and
 * /:id/receipt-url so those literal/longer paths win.
 *
 * Tenant + own/admin scope via buildExpenseFilter (workspaceId always stamped);
 * the module passes ?employeeId=<self> to force own-only.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/:id", async (req: any, res: any) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: "Expense not found" });
    }

    const filter = await buildExpenseFilter(req); // workspace + own/routed/admin scope
    filter._id = new mongoose.Types.ObjectId(id);

    const doc: any = await Expense.findOne(filter)
      .select("-rawExtraction -perFieldConfidence")
      .populate("employeeId", "firstName lastName email name")
      .populate("categoryId", "name")
      .lean();

    if (!doc) return res.status(404).json({ error: "Expense not found" });

    const emp = doc.employeeId;
    const cat = doc.categoryId;
    res.json({
      ok: true,
      expense: {
        ...doc,
        employeeId: emp && typeof emp === "object" ? emp._id : emp,
        employeeName: employeeNameOf(emp),
        categoryId: cat && typeof cat === "object" ? cat._id : cat,
        categoryName: categoryNameOf(doc),
        hasReceipt: !!doc.imageKey,
      },
    });
  } catch (err: any) {
    console.error("[Expenses GET one]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load expense" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * PATCH /api/expenses/:id  (categoryId only, Layer 1)
 * Lets the detail screen reclassify an expense. Tenant + own/admin scope via
 * buildExpenseFilter (the module passes ?employeeId=<self>). categoryId must
 * belong to THIS workspace; null clears it. Other fields are NOT editable here.
 * ───────────────────────────────────────────────────────────────────── */
router.patch("/:id", async (req: any, res: any) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).json({ error: "Expense not found" });
    }

    const b = req.body || {};
    if (!("categoryId" in b)) {
      return res.status(400).json({ error: "categoryId is required" });
    }

    let categoryId: mongoose.Types.ObjectId | null = null;
    if (b.categoryId) {
      const c = String(b.categoryId);
      if (!mongoose.Types.ObjectId.isValid(c)) {
        return res.status(400).json({ error: "Invalid categoryId" });
      }
      // The category must exist in THIS workspace — never accept a cross-tenant id.
      const cat = await ExpenseCategory.findOne({
        _id: new mongoose.Types.ObjectId(c),
        workspaceId: req.workspaceObjectId,
      }).lean();
      if (!cat) return res.status(400).json({ error: "Unknown category for this workspace" });
      categoryId = cat._id as mongoose.Types.ObjectId;
    }

    // Reclassify is an own-only mutation — never via routed-claim visibility.
    const filter = await buildExpenseFilter(req, { includeRoutedClaims: false });
    filter._id = new mongoose.Types.ObjectId(id);

    const updated: any = await Expense.findOneAndUpdate(
      filter,
      { $set: { categoryId } },
      { new: true },
    )
      .select("-rawExtraction -perFieldConfidence")
      .populate("employeeId", "firstName lastName email name")
      .populate("categoryId", "name")
      .lean();

    if (!updated) return res.status(404).json({ error: "Expense not found" });

    const emp = updated.employeeId;
    const cat = updated.categoryId;
    res.json({
      ok: true,
      expense: {
        ...updated,
        employeeId: emp && typeof emp === "object" ? emp._id : emp,
        employeeName: employeeNameOf(emp),
        categoryId: cat && typeof cat === "object" ? cat._id : cat,
        categoryName: categoryNameOf(updated),
        hasReceipt: !!updated.imageKey,
      },
    });
  } catch (err: any) {
    console.error("[Expenses PATCH]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to update expense" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expenses/upload  (multipart, field "file")
 * Store the bill to S3, run extractReceipt synchronously, return a DRAFT for
 * review. Does NOT persist an Expense. Mirrors the /vouchers/extract flow.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/upload", receiptUploadMw, async (req: any, res: any) => {
  try {
    const file = req.file as Express.Multer.File | undefined;
    if (!file?.buffer?.length) {
      return res.status(400).json({ error: "file is required" });
    }

    const workspaceId = String(req.workspaceId || "");
    const employeeId = ownEmployeeId(req);
    if (!workspaceId || !employeeId) {
      return res.status(400).json({ error: "Missing workspace or user context" });
    }

    // Store first so the receipt is retained even if extraction is unusable.
    const { bucket, key } = await uploadExpenseReceiptToS3({
      buffer: file.buffer,
      mime: file.mimetype,
      workspaceId,
      employeeId,
      sourceChannel: "web",
    });

    // Extraction is best-effort: on failure (e.g. no amount found) we still
    // return the stored imageKey so the user can fill the draft manually.
    let draft: Record<string, any> = {
      merchant: null,
      date: null,
      amount: null,
      currency: "INR",
      taxAmount: null,
      gstin: null,
      suggestedCategory: null,
    };
    let perFieldConfidence: any = {};
    let extractionModel: string | undefined;
    let rawExtraction: any = undefined;
    let extractionError: string | undefined;

    try {
      const result = await extractReceipt({ buffer: file.buffer, mime: file.mimetype });
      const { perFieldConfidence: pfc, ...fields } = result.fields;
      draft = fields;
      perFieldConfidence = pfc;
      extractionModel = result.raw.model;
      rawExtraction = result.raw.raw_candidate;
    } catch (exErr: any) {
      extractionError = exErr?.message || "Extraction failed";
      console.warn("[Expenses upload] extraction failed", extractionError);
    }

    res.json({
      ok: true,
      draft,
      perFieldConfidence,
      extractionModel,
      rawExtraction,
      imageKey: key,
      s3Bucket: bucket,
      ...(extractionError ? { extractionError } : {}),
    });
  } catch (err: any) {
    console.error("[Expenses upload]", err?.message);
    res.status(500).json({ error: err?.message || "Upload failed" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expenses  (JSON)
 * Persist a reviewed draft via the shared createExpense(). sourceChannel "web",
 * employeeId forced to the caller. Idempotent on (workspaceId, imageKey).
 * ───────────────────────────────────────────────────────────────────── */
router.post("/", async (req: any, res: any) => {
  try {
    const workspaceObjectId = req.workspaceObjectId;
    const workspaceId = String(req.workspaceId || "");
    const employeeId = ownEmployeeId(req);
    if (!workspaceObjectId || !employeeId) {
      return res.status(400).json({ error: "Missing workspace or user context" });
    }

    const b = req.body || {};
    if (b.amount == null || Number.isNaN(Number(b.amount))) {
      return res.status(400).json({ error: "amount is required" });
    }

    const imageKey = b.imageKey ? String(b.imageKey) : undefined;
    if (imageKey) {
      // Defensive: the key must belong to THIS user in THIS workspace.
      const expectedPrefix = `hrms/expenses/${workspaceId}/${employeeId}/`;
      if (!imageKey.startsWith(expectedPrefix)) {
        return res.status(403).json({ error: "imageKey does not belong to this user/workspace" });
      }
      // Idempotency: a re-submitted draft (same upload) returns the existing
      // expense instead of inserting a duplicate. Explicit workspaceId scope.
      const existing = await Expense.findOne({ workspaceId: workspaceObjectId, imageKey }).lean();
      if (existing) return res.json({ ok: true, expense: existing, deduped: true });
    }

    // Managed category (Layer 1): accept only an id that belongs to THIS workspace.
    let categoryId: mongoose.Types.ObjectId | null = null;
    if (b.categoryId) {
      const c = String(b.categoryId);
      if (!mongoose.Types.ObjectId.isValid(c)) {
        return res.status(400).json({ error: "Invalid categoryId" });
      }
      const cat = await ExpenseCategory.findOne({
        _id: new mongoose.Types.ObjectId(c),
        workspaceId: workspaceObjectId,
      }).lean();
      if (!cat) return res.status(400).json({ error: "Unknown category for this workspace" });
      categoryId = cat._id as mongoose.Types.ObjectId;
    }

    // Optional report linkage at creation (Layer 2). The report must be the
    // caller's OWN, DRAFT report in this workspace — same owner-only + draft gate
    // as POST /api/reports/:id/expenses. A bad/foreign/non-draft id is a 400,
    // never a silent unreported fallback.
    let reportId: mongoose.Types.ObjectId | null = null;
    if (b.reportId) {
      const r = String(b.reportId);
      if (!mongoose.Types.ObjectId.isValid(r)) {
        return res.status(400).json({ error: "Invalid reportId" });
      }
      const report = await Report.findOne({
        _id: new mongoose.Types.ObjectId(r),
        workspaceId: workspaceObjectId,
        employeeId: new mongoose.Types.ObjectId(employeeId),
        status: "draft",
      }).lean();
      if (!report) {
        return res.status(400).json({ error: "Report must be your own draft report" });
      }
      reportId = report._id as mongoose.Types.ObjectId;
    }

    const expense = await createExpense({
      workspaceId: workspaceObjectId,
      employeeId,
      sourceChannel: "web",
      merchant: b.merchant ?? null,
      date: b.date ?? null,
      amount: Number(b.amount),
      currency: b.currency,
      taxAmount: b.taxAmount ?? null,
      gstin: b.gstin ?? null,
      suggestedCategory: b.suggestedCategory ?? null,
      categoryId,
      reportId,
      imageKey,
      s3Bucket: b.s3Bucket,
      rawExtraction: b.rawExtraction,
      perFieldConfidence: b.perFieldConfidence,
      extractionModel: b.extractionModel,
    });

    // reports.service is the single writer of lifecycleStatus — funnel the new
    // expense's state through it rather than setting it inline. The report was
    // validated to be a DRAFT, so its expenses are pending_to_submit.
    if (reportId) {
      await propagateReportLifecycle(workspaceObjectId, reportId, "draft");
      (expense as any).lifecycleStatus = "pending_to_submit"; // reflect in the response
    }

    res.status(201).json({ ok: true, expense });
  } catch (err: any) {
    console.error("[Expenses create]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to create expense" });
  }
});

export default router;
