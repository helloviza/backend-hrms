// apps/backend/src/routes/expenseActivity.ts
//
// Reports hub — the Activity Logs report (the first report on the shared
// contract). One append-only stream that fuses BOTH the claim timeline
// (ExpenseActivity keyed by reportId) and the advance timeline (keyed by
// advanceId), workspace-scoped, date-ranged on the event timestamp, newest
// first — the finance/admin view of "who did what, when" across the whole
// expense module.
//
// SHARED REPORT CONTRACT (every Reports-hub endpoint mirrors this, so ONE
// generic frontend runner can render any of them):
//   • JSON (no format / format=json):
//       { columns: [{key,label}], rows: [{<key>: value, …}], total,
//         range: {dateFrom, dateTo} }
//     — paginated via page,limit; each row's keys match the column keys;
//       columns carry the display order.
//   • format=csv|xlsx: the file built from the SAME columns+rows (CSV text/csv,
//     XLSX via ExcelJS), mirroring the existing expense/advance exports'
//     content-type + content-disposition. Files carry the FULL filtered set
//     (no pagination), exactly like /api/expenses/export.
//
// Mounted at /api/expense-activity behind requireAuth → requireWorkspace →
// requireFeature("expensesEnabled"). Reads are seesAll-gated (finance/admin)
// in-router. Tenant scoping is NON-NEGOTIABLE: every query stamps workspaceId
// via req.workspaceObjectId.
//
// Humanization mirrors the on-screen timelines:
//   • claim events  → ReportDetail.tsx  ACTIVITY_META
//   • advance events→ AdvanceDetail.tsx ACTIVITY_META
// The label is entity-aware (a claim "approved the claim" vs an advance
// "approved the advance") and capitalized for a standalone table cell.

import express from "express";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { seesAll } from "../services/expense.access.js";
import ExpenseActivity, { type ExpenseActivityEvent } from "../models/ExpenseActivity.js";
import Report from "../models/Report.js";
import ExpenseAdvance from "../models/ExpenseAdvance.js";
import User from "../models/User.js";
import { refFromId } from "../utils/refFromId.js";
import { parseISTStart, parseISTEnd } from "../utils/dateIST.js";
import { csvRow } from "../utils/exportHelpers.js";

const router = express.Router();

/* ── Shared contract: the columns (single source of truth for JSON + files) ──
 * Order here IS the display order the frontend runner renders. */
const COLUMNS: { key: string; label: string }[] = [
  { key: "when", label: "When" },
  { key: "actor", label: "Actor" },
  { key: "email", label: "Email" },
  { key: "action", label: "Action" },
  { key: "entity", label: "Entity" },
  { key: "ref", label: "Ref" },
  { key: "detail", label: "Detail" },
];

/* ── Action humanization — mirrors the two on-screen ACTIVITY_META maps ─────
 * Keyed by entity so "approved" reads "approved the claim" on a claim row and
 * "approved the advance" on an advance row, exactly as the detail timelines do. */
const CLAIM_LABELS: Partial<Record<ExpenseActivityEvent, string>> = {
  created: "created the claim",
  submitted: "submitted for approval",
  resubmitted: "resubmitted for approval",
  approved: "approved the claim",
  reimbursed: "marked it reimbursed",
  declined: "declined the claim",
  clarification_requested: "requested clarification",
  expense_added: "added expenses",
  expense_removed: "removed an expense",
  policy_check: "policy check",
  advance_applied: "applied an advance",
  advance_detached: "detached an advance",
};
const ADVANCE_LABELS: Partial<Record<ExpenseActivityEvent, string>> = {
  requested: "requested the advance",
  resubmitted: "resubmitted for approval",
  approved: "approved the advance",
  disbursed: "disbursed the advance",
  declined: "declined the advance",
  clarification_requested: "requested clarification",
  settled: "settled against a claim",
  recovered: "recovered cash",
};

function humanizeAction(event: ExpenseActivityEvent, isAdvance: boolean): string {
  const raw =
    (isAdvance ? ADVANCE_LABELS[event] : CLAIM_LABELS[event]) ||
    // Cross-entity events (advance_applied/detached log on the CLAIM timeline;
    // settled/recovered on the ADVANCE timeline) still resolve via the right map.
    CLAIM_LABELS[event] ||
    ADVANCE_LABELS[event] ||
    String(event).replace(/_/g, " ");
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function employeeNameOf(u: any): string {
  if (!u || typeof u !== "object") return "";
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return full || u.name || u.email || "";
}

/** IST date + time for the "When" column — explicit Asia/Kolkata so the output
 *  is identical regardless of the (UTC) server timezone. e.g. "22 Jun 2026, 03:45 PM". */
function fmtISTDateTime(d: any): string {
  if (!d) return "";
  return new Date(d).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expense-activity?dateFrom=&dateTo=&page=&limit=&format=
 * Activity Logs report. seesAll-gated, tenant-scoped, newest-first.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/", async (req: any, res: any) => {
  try {
    if (!seesAll(req.user)) {
      return res.status(403).json({ error: "Finance or admin access required" });
    }

    const format =
      req.query.format === "csv" ? "csv" : req.query.format === "xlsx" ? "xlsx" : "json";

    // Date range on the event timestamp (createdAt is the append-only timeline key).
    const filter: Record<string, any> = { workspaceId: req.workspaceObjectId };
    const dateFrom = req.query.dateFrom ? String(req.query.dateFrom) : "";
    const dateTo = req.query.dateTo ? String(req.query.dateTo) : "";
    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) filter.createdAt.$gte = parseISTStart(dateFrom);
      if (dateTo) filter.createdAt.$lte = parseISTEnd(dateTo);
    }

    // Optional entity split — claim entries carry reportId, advance entries carry
    // advanceId (exactly one is set per row). Omitted/empty = both (unchanged).
    const entity = String(req.query.entity || "");
    if (entity === "claim") filter.advanceId = null;
    else if (entity === "advance") filter.advanceId = { $ne: null };

    // Pagination — JSON is paged; file exports carry the full filtered set.
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));

    const query = ExpenseActivity.find(filter).sort({ createdAt: -1 });
    let total = 0;
    let docs: any[];
    if (format === "json") {
      [total, docs] = await Promise.all([
        ExpenseActivity.countDocuments(filter),
        query.skip((page - 1) * limit).limit(limit).lean(),
      ]);
    } else {
      docs = await query.lean();
      total = docs.length;
    }

    // ── Batched resolvers: actor → name+email, entity → ref ──
    const actorIds = [
      ...new Set(
        docs
          .map((a: any) => a.actorId)
          .filter((id: any) => id && mongoose.Types.ObjectId.isValid(String(id)))
          .map(String),
      ),
    ];
    const reportIds = [
      ...new Set(
        docs
          .filter((a: any) => !a.advanceId && a.reportId)
          .map((a: any) => String(a.reportId)),
      ),
    ];
    const advanceIds = [
      ...new Set(docs.filter((a: any) => a.advanceId).map((a: any) => String(a.advanceId))),
    ];

    const userMap = new Map<string, any>();
    const claimRefById = new Map<string, string>();
    const advanceRefById = new Map<string, string>();
    await Promise.all([
      actorIds.length
        ? User.find({ _id: { $in: actorIds.map((id) => new mongoose.Types.ObjectId(id)) } })
            .select("firstName lastName name email")
            .lean()
            .then((us: any[]) => us.forEach((u) => userMap.set(String(u._id), u)))
        : Promise.resolve(),
      reportIds.length
        ? Report.find({
            workspaceId: req.workspaceObjectId,
            _id: { $in: reportIds.map((id) => new mongoose.Types.ObjectId(id)) },
          })
            .select("ref")
            .lean()
            .then((rs: any[]) =>
              rs.forEach((r) => claimRefById.set(String(r._id), r.ref || refFromId("CLM", r._id))),
            )
        : Promise.resolve(),
      advanceIds.length
        ? ExpenseAdvance.find({
            workspaceId: req.workspaceObjectId,
            _id: { $in: advanceIds.map((id) => new mongoose.Types.ObjectId(id)) },
          })
            .select("ref")
            .lean()
            .then((as: any[]) =>
              as.forEach((a) =>
                advanceRefById.set(String(a._id), a.ref || refFromId("ADV", a._id)),
              ),
            )
        : Promise.resolve(),
    ]);

    const rows = docs.map((a: any) => {
      const isAdvance = !!a.advanceId;
      const u = a.actorId ? userMap.get(String(a.actorId)) : null;
      // Actor name: prefer the live user record, fall back to the name stamped on
      // the log at write time (covers automated "Policy Bot" / "System" entries
      // and any since-deleted user).
      const actor = employeeNameOf(u) || a.actorName || "";
      const ref = isAdvance
        ? advanceRefById.get(String(a.advanceId)) || refFromId("ADV", a.advanceId)
        : a.reportId
          ? claimRefById.get(String(a.reportId)) || refFromId("CLM", a.reportId)
          : "";
      return {
        when: fmtISTDateTime(a.createdAt),
        actor,
        email: (u && u.email) || "",
        action: humanizeAction(a.event, isAdvance),
        entity: isAdvance ? "Advance" : "Claim",
        ref,
        // Normalized to "" (never null) to match the CSV/XLSX cell behavior and
        // keep the JSON contract uniform.
        detail: a.note ?? "",
      } as Record<string, any>;
    });

    if (format === "json") {
      return res.json({
        columns: COLUMNS,
        rows,
        total,
        range: { dateFrom, dateTo },
      });
    }

    const header = COLUMNS.map((c) => c.label);

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="expense-activity.csv"');
      res.write(csvRow(header));
      rows.forEach((r) => res.write(csvRow(COLUMNS.map((c) => r[c.key]))));
      return res.end();
    }

    // XLSX — mirror the expenses/advances export ExcelJS pattern.
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Activity");
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    const headerRow = sheet.addRow(header);
    headerRow.font = { bold: true };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF0" } };
    rows.forEach((r) => sheet.addRow(COLUMNS.map((c) => r[c.key])));

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", 'attachment; filename="expense-activity.xlsx"');
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err: any) {
    console.error("[Expense activity report]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load activity log" });
  }
});

export default router;
