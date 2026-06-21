// apps/backend/src/routes/expenseAdvances.ts
//
// Expense Advances — System B (cash advances). A PEER of the claim (Report)
// flow, NOT an extension of it: request → approve (reuses the claim chain
// resolvers + chain-advance lifecycle) → finance disburse → outstanding balance.
// Settlement/recovery of an advance against later expenses is Phase 2 (the
// model carries empty settlements[]/recoveries[] placeholders).
//
// Mounted at /api/expense-advances behind:
//   requireAuth → requireWorkspace → requireExpenseAdvancesFeature
// (requireExpenseAdvancesFeature = expensesEnabled THEN advancesEnabled — see
// middleware/requireFeature.ts; advances live inside the expense module).
//
// Scoping (NON-NEGOTIABLE): every query stamps workspaceId via
// req.workspaceObjectId. Reads use the seesAll admin/finance-all pattern;
// request/resubmit are owner-only; approve/decline/clarify are approver-or-admin;
// disburse is finance-only with whole-chain SoD (canDisburse).

import express from "express";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
import {
  seesAll,
  isFinance as isFinanceUser,
  isAdmin as isAdminUser,
  canDecideAdvance as canDecideAdvanceUser,
  canDisburse as canDisburseUser,
  canRecover as canRecoverUser,
  userIdOf,
} from "../services/expense.access.js";
import { resolveAdvanceApprovalChain } from "../services/reports.service.js";
import {
  applyAdvanceToClaim,
  detachAdvanceFromClaim,
  recordRecovery,
} from "../services/advanceSettlement.service.js";
import ExpenseAdvance from "../models/ExpenseAdvance.js";
import Report from "../models/Report.js";
import ExpenseActivity, { type ExpenseActivityEvent } from "../models/ExpenseActivity.js";
import User from "../models/User.js";
import { refFromId } from "../utils/refFromId.js";
import { parseISTStart, parseISTEnd } from "../utils/dateIST.js";
import { csvRow } from "../utils/exportHelpers.js";
import { sendAdvanceSubmittedEmail } from "../utils/advanceEmails.js";

const router = express.Router();

/* ── Access predicates: delegated to the single source of truth ─────── */
function seesAllAdvances(req: any): boolean {
  return seesAll(req.user);
}
function ownRequesterId(req: any): string {
  return userIdOf(req.user);
}
function isFinance(req: any): boolean {
  return isFinanceUser(req.user);
}
function isAdmin(req: any): boolean {
  return isAdminUser(req.user);
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

/* ── Export columns (single source of truth for CSV + XLSX) — one row per
 * advance, mirroring the expenses export's Col shape + money flagging. ───── */
type AdvCol = { key: string; label: string; money?: boolean };
const ADV_EXPORT_COLUMNS: AdvCol[] = [
  { key: "ref", label: "Ref" },
  { key: "requester", label: "Requester" },
  { key: "email", label: "Email" },
  { key: "purpose", label: "Purpose" },
  { key: "currency", label: "Currency" },
  { key: "amount", label: "Amount", money: true },
  { key: "status", label: "Status" },
  { key: "disbursedAmount", label: "Disbursed Amount", money: true },
  { key: "disbursedOn", label: "Disbursed On" },
  { key: "settled", label: "Settled", money: true },
  { key: "recovered", label: "Recovered", money: true },
  { key: "outstanding", label: "Outstanding", money: true },
  { key: "appliedToClaims", label: "Applied To Claims" },
  { key: "requestedOn", label: "Requested On" },
  { key: "approvedOn", label: "Approved On" },
];

/** IST-formatted date — matches the expenses export (toLocaleDateString en-IN). */
function fmtDate(d: any): string {
  return d ? new Date(d).toLocaleDateString("en-IN") : "";
}

function round2(n: any): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** "partially_settled" → "Partially settled" (mirrors humanizeLifecycle). */
function humanizeStatus(s: any): string {
  const v = String(s || "").replace(/_/g, " ");
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : "";
}

/* ── Activity / audit log for advances ───────────────────────────────
 * Append-only, co-located here (the advance lifecycle is route-resident).
 * Mirrors reports.service.logActivity but keyed by advanceId (NOT reportId).
 * Non-fatal: a logging failure is swallowed so it can never block an action. */
async function logAdvanceActivity(params: {
  workspaceId: mongoose.Types.ObjectId | string;
  advanceId: mongoose.Types.ObjectId | string;
  event: ExpenseActivityEvent;
  actorName: string;
  actorId?: mongoose.Types.ObjectId | string | null;
  note?: string | null;
}): Promise<void> {
  try {
    const actorId =
      params.actorId && mongoose.Types.ObjectId.isValid(String(params.actorId))
        ? new mongoose.Types.ObjectId(String(params.actorId))
        : null;
    await ExpenseActivity.create({
      workspaceId: new mongoose.Types.ObjectId(String(params.workspaceId)),
      advanceId: new mongoose.Types.ObjectId(String(params.advanceId)),
      event: params.event,
      actorId,
      actorName: params.actorName || "System",
      note: params.note ?? null,
    });
  } catch (err: any) {
    console.error("[advance activity log]", params.event, err?.message || err);
  }
}

/** Load an advance by id within the tenant, WITHOUT an owner restriction —
 *  for approval/disburse the actor is the approver/finance, not the requester. */
async function loadAdvanceAny(req: any, id: string) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return ExpenseAdvance.findOne({
    _id: new mongoose.Types.ObjectId(id),
    workspaceId: req.workspaceObjectId,
  });
}

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expense-advances  — request an advance (own).
 * Resolves the approval chain by REUSING the claim resolvers
 * (resolveAdvanceApprovalChain → advanceEscalationThreshold + amount gate). Same
 * never-null / 409 routing as a claim submit: if no approver can be found the
 * advance is NOT created (it would strand in awaiting_approval with nobody able
 * to act).
 * ───────────────────────────────────────────────────────────────────── */
router.post("/", async (req: any, res: any) => {
  try {
    const requesterId = ownRequesterId(req);
    if (!req.workspaceObjectId || !requesterId) {
      return res.status(400).json({ error: "Missing workspace or user context" });
    }

    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "amount must be a positive number" });
    }
    const purpose = String(req.body?.purpose || "").trim();
    if (!purpose) return res.status(400).json({ error: "purpose is required" });

    const currency = String(req.body?.currency || "INR").trim().toUpperCase() || "INR";
    let neededBy: Date | null = null;
    if (req.body?.neededBy) {
      const d = new Date(req.body.neededBy);
      if (!Number.isNaN(d.getTime())) neededBy = d;
    }

    // Resolve the chain BEFORE creating — refuse (409) if no approver, exactly
    // like a claim submit, so we never persist an unroutable advance.
    const { chain, approverId, approver } = await resolveAdvanceApprovalChain(
      req.workspaceObjectId,
      requesterId,
      amount,
    );
    if (!approverId) {
      return res.status(409).json({
        error:
          "No approver available — set a manager for this employee, or add an admin to the workspace.",
      });
    }

    const advance = new ExpenseAdvance({
      workspaceId: req.workspaceObjectId,
      requesterId: new mongoose.Types.ObjectId(requesterId),
      amount,
      currency,
      purpose,
      neededBy,
      status: "awaiting_approval",
      approvalChain: chain,
      currentLevel: 1,
      approverId,
      submittedAt: new Date(),
    });
    advance.ref = refFromId("ADV", advance._id as mongoose.Types.ObjectId);
    await advance.save();

    await logAdvanceActivity({
      workspaceId: req.workspaceObjectId,
      advanceId: advance._id as mongoose.Types.ObjectId,
      event: "requested",
      actorId: requesterId,
      actorName: actorNameOf(req),
    });

    // Approver email — best-effort, never blocks the request.
    if (approver?.email) {
      try {
        await sendAdvanceSubmittedEmail({
          to: approver.email,
          approverName: employeeNameOf(approver),
          requesterName: actorNameOf(req) || "An employee",
          advanceRef: advance.ref,
          advanceId: String(advance._id),
          amount,
          purpose,
        });
      } catch (mailErr: any) {
        console.error("[advance request email]", mailErr?.message || mailErr);
      }
    }

    res.status(201).json({ ok: true, advance: advance.toObject() });
  } catch (err: any) {
    console.error("[Advances POST]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to request advance" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expense-advances/pending-count  — sidebar badge.
 * Declared before /:id so ":id" can't capture "pending-count".
 *  - approvals: advances awaiting MY approval (approverId==me; seesAll → all)
 *  - disburse : approved advances awaiting disbursement (FINANCE; SoD-filtered)
 * ───────────────────────────────────────────────────────────────────── */
router.get("/pending-count", async (req: any, res: any) => {
  try {
    const ws = req.workspaceObjectId;
    const approvalsFilter: Record<string, any> = { workspaceId: ws, status: "awaiting_approval" };
    if (!seesAllAdvances(req)) {
      approvalsFilter.approverId = new mongoose.Types.ObjectId(ownRequesterId(req));
    }
    const approvals = await ExpenseAdvance.countDocuments(approvalsFilter);

    let disburse = 0;
    if (isFinance(req)) {
      const disburseFilter: Record<string, any> = { workspaceId: ws, status: "approved" };
      // Whole-chain SoD (mirrors canDisburse): a non-admin finance user may not
      // disburse an advance they approved at any level. Admin bypasses SoD.
      if (!isAdmin(req)) {
        const me = new mongoose.Types.ObjectId(ownRequesterId(req));
        disburseFilter.approverId = { $ne: me };
        disburseFilter["approvalChain.approverId"] = { $ne: me };
      }
      disburse = await ExpenseAdvance.countDocuments(disburseFilter);
    }

    res.json({ ok: true, approvals, disburse });
  } catch (err: any) {
    console.error("[Advances pending-count]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load count" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expense-advances/analytics?dateFrom=&dateTo=
 * Workspace-wide ADVANCES reporting for finance/admin (seesAll). Returns the
 * cash-advance liability picture: a point-in-time liability snapshot, a "to
 * whom" by-employee outstanding table, aging buckets, a date-ranged settlement
 * cycle, and recovery totals.
 *
 * Tenant isolation (NON-NEGOTIABLE): the workspaceScope plugin does NOT hook
 * .aggregate(), so EVERY aggregation pipeline matches workspaceId explicitly.
 *
 * Range semantics (mirrors /api/expenses/analytics):
 *   • Liability snapshot + by-employee + aging → POINT-IN-TIME (ignore range):
 *     finance needs the FULL current outstanding liability, not a windowed slice.
 *   • Cycle (disbursed/settled in period, avgSettleDays) + recovery → date-ranged
 *     on disbursedAt / derived settledAt / recoveredAt.
 *
 * Declared BEFORE GET /:id so ":id" never captures "analytics".
 * ───────────────────────────────────────────────────────────────────── */
router.get("/analytics", async (req: any, res: any) => {
  try {
    // Workspace-wide view is finance/admin only — never leak who owes what.
    if (!seesAllAdvances(req)) {
      return res.status(403).json({ error: "Forbidden" });
    }

    const workspaceId = req.workspaceObjectId as mongoose.Types.ObjectId;
    if (!workspaceId) {
      return res.status(400).json({ error: "Missing workspace context" });
    }

    const pad = (n: number) => String(n).padStart(2, "0");
    const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
    const round1 = (n: number) => Math.round((Number(n) || 0) * 10) / 10;

    // Default range = last 12 IST calendar months (inclusive) when unspecified.
    const nowMs = Date.now();
    const nowIst = new Date(nowMs + 5.5 * 60 * 60 * 1000);
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

    // Statuses that have reached disbursement (amountDisbursed/outstanding are
    // only meaningful once an advance is disbursed).
    const DISBURSED_PLUS = ["disbursed", "partially_settled", "settled"];
    const DAY_MS = 24 * 60 * 60 * 1000;

    /* ── Block 1: LIABILITY SNAPSHOT (point-in-time, ignores range) ────── */
    const [snapAgg] = await ExpenseAdvance.aggregate([
      { $match: { workspaceId, status: { $in: DISBURSED_PLUS } } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                totalDisbursed: { $sum: { $ifNull: ["$amountDisbursed", 0] } },
                totalOutstanding: { $sum: { $ifNull: ["$outstandingBalance", 0] } },
                countOutstanding: {
                  $sum: { $cond: [{ $gt: [{ $ifNull: ["$outstandingBalance", 0] }, 0] }, 1, 0] },
                },
              },
            },
          ],
          settled: [
            { $unwind: "$settlements" },
            { $match: { "settlements.status": "settled" } },
            {
              $group: {
                _id: null,
                totalSettled: { $sum: { $ifNull: ["$settlements.settledAmount", 0] } },
              },
            },
          ],
          recovered: [
            { $unwind: "$recoveries" },
            {
              $group: {
                _id: null,
                totalRecovered: { $sum: { $ifNull: ["$recoveries.amount", 0] } },
              },
            },
          ],
        },
      },
    ]);
    const snapTotals = snapAgg?.totals?.[0] || {};
    const liability = {
      totalDisbursed: round2(snapTotals.totalDisbursed || 0),
      totalOutstanding: round2(snapTotals.totalOutstanding || 0),
      totalSettled: round2(snapAgg?.settled?.[0]?.totalSettled || 0),
      totalRecovered: round2(snapAgg?.recovered?.[0]?.totalRecovered || 0),
      countOutstanding: snapTotals.countOutstanding || 0,
    };

    /* ── Block 2: BY-EMPLOYEE OUTSTANDING ("to whom") ──────────────────── */
    const byEmpRaw = await ExpenseAdvance.aggregate([
      { $match: { workspaceId, status: { $in: DISBURSED_PLUS }, outstandingBalance: { $gt: 0 } } },
      {
        $group: {
          _id: "$requesterId",
          count: { $sum: 1 },
          outstanding: { $sum: { $ifNull: ["$outstandingBalance", 0] } },
          oldestDisbursedAt: { $min: "$disbursedAt" },
        },
      },
      { $sort: { outstanding: -1 } },
    ]);
    const empIds = byEmpRaw
      .map((r: any) => r._id)
      .filter((id: any) => id && mongoose.Types.ObjectId.isValid(String(id)));
    const empMap = new Map<string, any>();
    if (empIds.length) {
      const users = await User.find({ _id: { $in: empIds } })
        .select("firstName lastName name email")
        .lean();
      users.forEach((u: any) => empMap.set(String(u._id), u));
    }
    const byEmployee = byEmpRaw.map((r: any) => {
      const u = empMap.get(String(r._id));
      return {
        employeeId: String(r._id || ""),
        employeeName: employeeNameOf(u) || "Unknown",
        employeeEmail: (u && u.email) || "",
        count: r.count || 0,
        outstanding: round2(r.outstanding || 0),
        oldestDisbursedAt: r.oldestDisbursedAt || null,
      };
    });

    /* ── Block 3: AGING BUCKETS (point-in-time, days since disbursedAt) ── */
    const outstandingDocs = await ExpenseAdvance.find({
      workspaceId,
      status: { $in: DISBURSED_PLUS },
      outstandingBalance: { $gt: 0 },
    })
      .select("disbursedAt outstandingBalance")
      .lean();
    const aging = {
      "0-7": { count: 0, outstanding: 0 },
      "8-30": { count: 0, outstanding: 0 },
      "30+": { count: 0, outstanding: 0 },
    };
    for (const a of outstandingDocs) {
      const disbursedAt = (a as any).disbursedAt ? new Date((a as any).disbursedAt) : null;
      const days = disbursedAt ? (nowMs - disbursedAt.getTime()) / DAY_MS : Infinity;
      const bucket = days <= 7 ? "0-7" : days <= 30 ? "8-30" : "30+";
      aging[bucket].count += 1;
      aging[bucket].outstanding += Number((a as any).outstandingBalance) || 0;
    }
    aging["0-7"].outstanding = round2(aging["0-7"].outstanding);
    aging["8-30"].outstanding = round2(aging["8-30"].outstanding);
    aging["30+"].outstanding = round2(aging["30+"].outstanding);

    /* ── Block 4: CYCLE (date-ranged) ──────────────────────────────────── */
    // Disbursed in period — Σ amountDisbursed + count where disbursedAt in range.
    const [disbAgg] = await ExpenseAdvance.aggregate([
      {
        $match: {
          workspaceId,
          status: { $in: DISBURSED_PLUS },
          disbursedAt: { $gte: rangeStart, $lte: rangeEnd },
        },
      },
      { $group: { _id: null, amount: { $sum: { $ifNull: ["$amountDisbursed", 0] } }, count: { $sum: 1 } } },
    ]);
    const disbursedInPeriod = {
      amount: round2(disbAgg?.amount || 0),
      count: disbAgg?.count || 0,
    };

    // Settled in period + avg settle days. The advance has no settledAt field, so
    // we DERIVE the moment outstanding hit 0 = the latest settling event (a
    // settled settlement's settledAt or a recovery's recoveredAt).
    const settledDocs = await ExpenseAdvance.find({ workspaceId, status: "settled" })
      .select("disbursedAt settlements recoveries")
      .lean();
    let settledInPeriod = 0;
    let settleDaysSum = 0;
    let settleDaysN = 0;
    for (const a of settledDocs) {
      let settledMs = 0;
      for (const s of ((a as any).settlements || [])) {
        if (s?.status === "settled" && s?.settledAt) {
          settledMs = Math.max(settledMs, new Date(s.settledAt).getTime());
        }
      }
      for (const r of ((a as any).recoveries || [])) {
        if (r?.recoveredAt) settledMs = Math.max(settledMs, new Date(r.recoveredAt).getTime());
      }
      if (!settledMs) continue; // can't place it in time — skip
      const settledAt = new Date(settledMs);
      if (settledAt < rangeStart || settledAt > rangeEnd) continue;
      settledInPeriod += 1;
      const disbursedAt = (a as any).disbursedAt ? new Date((a as any).disbursedAt) : null;
      if (disbursedAt && settledMs >= disbursedAt.getTime()) {
        settleDaysSum += (settledMs - disbursedAt.getTime()) / DAY_MS;
        settleDaysN += 1;
      }
    }
    const avgSettleDays = settleDaysN > 0 ? round1(settleDaysSum / settleDaysN) : null;

    /* ── Block 5: RECOVERY (date-ranged) ───────────────────────────────── */
    const [recAgg] = await ExpenseAdvance.aggregate([
      { $match: { workspaceId } },
      { $unwind: "$recoveries" },
      { $match: { "recoveries.recoveredAt": { $gte: rangeStart, $lte: rangeEnd } } },
      {
        $group: {
          _id: null,
          totalRecovered: { $sum: { $ifNull: ["$recoveries.amount", 0] } },
          count: { $sum: 1 },
        },
      },
    ]);
    const recovery = {
      totalRecovered: round2(recAgg?.totalRecovered || 0),
      count: recAgg?.count || 0,
    };

    res.json({
      ok: true,
      range: { dateFrom: dateFromStr, dateTo: dateToStr },
      liability,
      byEmployee,
      aging,
      cycle: {
        disbursedInPeriod,
        settledInPeriod,
        avgSettleDays,
      },
      recovery,
    });
  } catch (err: any) {
    console.error("[Advances analytics]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load advances analytics" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expense-advances/export?format=csv|xlsx
 * Advances liability export — ONE row per advance. Mirrors the expenses export
 * (GET /api/expenses/export): same format param, same CSV (text/csv) + XLSX
 * (ExcelJS) handling, same content-type/content-disposition shape.
 *
 * Scoping (mirrors the list + expenses export): finance/admin (seesAll) get the
 * whole workspace, optionally narrowed by ?scope=mine or ?requesterId=; a
 * non-admin is FORCE-scoped to their own advances (any ?requesterId/scope=all is
 * ignored). workspaceId is ALWAYS stamped. Honors ?status and ?dateFrom/?dateTo
 * (on createdAt — when the advance was requested).
 *
 * Declared BEFORE GET /:id so ":id" never captures "export".
 * ───────────────────────────────────────────────────────────────────── */
router.get("/export", async (req: any, res: any) => {
  try {
    const format = req.query.format === "xlsx" ? "xlsx" : "csv";

    // Build the same filter the list applies, with export-time date support.
    const filter: Record<string, any> = { workspaceId: req.workspaceObjectId };
    if (!seesAllAdvances(req)) {
      // Non-admin: own advances only — ignore any requesterId/scope override.
      filter.requesterId = new mongoose.Types.ObjectId(ownRequesterId(req));
    } else {
      const scope = String(req.query.scope || "");
      if (scope === "mine") {
        filter.requesterId = new mongoose.Types.ObjectId(ownRequesterId(req));
      } else if (
        req.query.requesterId &&
        mongoose.Types.ObjectId.isValid(String(req.query.requesterId))
      ) {
        filter.requesterId = new mongoose.Types.ObjectId(String(req.query.requesterId));
      }
    }
    if (req.query.status) filter.status = String(req.query.status);
    if (req.query.dateFrom || req.query.dateTo) {
      filter.createdAt = {};
      if (req.query.dateFrom) filter.createdAt.$gte = parseISTStart(String(req.query.dateFrom));
      if (req.query.dateTo) filter.createdAt.$lte = parseISTEnd(String(req.query.dateTo));
    }

    const docs = await ExpenseAdvance.find(filter).sort({ createdAt: -1 }).lean();

    // Resolve requester display names + emails (same lookup the analytics endpoint
    // uses) in ONE query.
    const requesterIds = docs
      .map((d: any) => d.requesterId)
      .filter((id: any) => id && mongoose.Types.ObjectId.isValid(String(id)));
    const userMap = new Map<string, any>();
    if (requesterIds.length) {
      const users = await User.find({ _id: { $in: requesterIds } })
        .select("firstName lastName name email")
        .lean();
      users.forEach((u: any) => userMap.set(String(u._id), u));
    }

    const rows = docs.map((a: any) => {
      const u = userMap.get(String(a.requesterId));
      const settlements = Array.isArray(a.settlements) ? a.settlements : [];
      const recoveries = Array.isArray(a.recoveries) ? a.recoveries : [];
      const settled = settlements.reduce(
        (s: number, x: any) => (x?.status === "settled" ? s + (Number(x.settledAmount) || 0) : s),
        0,
      );
      const recovered = recoveries.reduce((s: number, x: any) => s + (Number(x.amount) || 0), 0);
      return {
        ref: a.ref || "",
        requester: employeeNameOf(u) || "",
        email: (u && u.email) || "",
        purpose: a.purpose || "",
        currency: a.currency || "",
        amount: round2(a.amount),
        status: humanizeStatus(a.status),
        disbursedAmount: round2(a.amountDisbursed),
        disbursedOn: fmtDate(a.disbursedAt),
        settled: round2(settled),
        recovered: round2(recovered),
        outstanding: round2(a.outstandingBalance),
        appliedToClaims: settlements.length,
        requestedOn: fmtDate(a.createdAt),
        approvedOn: fmtDate(a.approvedAt),
      } as Record<string, any>;
    });

    const header = ADV_EXPORT_COLUMNS.map((c) => c.label);

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="advances-export.csv"');
      res.write(csvRow(header));
      rows.forEach((r) => res.write(csvRow(ADV_EXPORT_COLUMNS.map((c) => r[c.key]))));
      return res.end();
    }

    // XLSX — mirror the expenses export ExcelJS pattern.
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Advances");
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    const headerRow = sheet.addRow(header);
    headerRow.font = { bold: true };
    headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EAF0" } };
    ADV_EXPORT_COLUMNS.forEach((c, i) => {
      if (c.money) sheet.getColumn(i + 1).numFmt = "#,##0.00";
    });
    rows.forEach((r) => sheet.addRow(ADV_EXPORT_COLUMNS.map((c) => r[c.key])));

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", 'attachment; filename="advances-export.xlsx"');
    await workbook.xlsx.write(res);
    return res.end();
  } catch (err: any) {
    console.error("[Advances export]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to export advances" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expense-advances
 *  - default       : own (admin/finance: all, optionally ?requesterId=)
 *  - ?queue=approve: advances routed to ME (approverId==me); seesAll → all awaiting
 *  - ?queue=disburse: approved advances awaiting disbursement — FINANCE only,
 *                     SoD-filtered (excludes ones the finance user approved)
 * ───────────────────────────────────────────────────────────────────── */
router.get("/", async (req: any, res: any) => {
  try {
    const queue = String(req.query.queue || "");
    const filter: Record<string, any> = { workspaceId: req.workspaceObjectId };

    if (queue === "approve") {
      filter.status = "awaiting_approval";
      if (!seesAllAdvances(req)) {
        filter.approverId = new mongoose.Types.ObjectId(ownRequesterId(req));
      }
    } else if (queue === "disburse") {
      if (!isFinance(req)) return res.status(403).json({ error: "Finance access required" });
      filter.status = "approved";
      // SoD-filtered from day one (non-admin finance): exclude advances the
      // requesting user approved at ANY level. Admin sees all approved.
      if (!isAdmin(req)) {
        const me = new mongoose.Types.ObjectId(ownRequesterId(req));
        filter.approverId = { $ne: me };
        filter["approvalChain.approverId"] = { $ne: me };
      }
    } else {
      if (!seesAllAdvances(req)) {
        filter.requesterId = new mongoose.Types.ObjectId(ownRequesterId(req));
      } else if (
        req.query.requesterId &&
        mongoose.Types.ObjectId.isValid(String(req.query.requesterId))
      ) {
        filter.requesterId = new mongoose.Types.ObjectId(String(req.query.requesterId));
      }
      if (req.query.status) filter.status = String(req.query.status);
    }

    const advances = await ExpenseAdvance.find(filter)
      .populate("requesterId", "firstName lastName email name")
      .sort({ createdAt: -1 })
      .lean();

    const docs = advances.map((a: any) => {
      const r = a.requesterId;
      return {
        ...a,
        requesterId: r && typeof r === "object" ? r._id : r,
        requesterName: employeeNameOf(r),
      };
    });

    res.json({ ok: true, docs });
  } catch (err: any) {
    console.error("[Advances GET list]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to list advances" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /api/expense-advances/:id  — detail.
 * Visible to: the REQUESTER, an admin/finance (seesAll), or an approver on its
 * chain. Includes requester + approver names, a name-enriched chain, the
 * activity timeline, and canApprove/canDisburse UI hints.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/:id", async (req: any, res: any) => {
  try {
    const advance = await loadAdvanceAny(req, req.params.id);
    if (!advance) return res.status(404).json({ error: "Advance not found" });

    const me = ownRequesterId(req);
    const isOwner = String(advance.requesterId) === me;
    const chainRaw: any[] = Array.isArray((advance as any).approvalChain)
      ? (advance as any).approvalChain
      : [];
    const isApprover =
      (advance.approverId && String(advance.approverId) === me) ||
      chainRaw.some((l) => l?.approverId && String(l.approverId) === me);
    if (!isOwner && !seesAllAdvances(req) && !isApprover) {
      return res.status(404).json({ error: "Advance not found" });
    }

    // Resolve requester + current approver display names.
    const [requester, approver] = await Promise.all([
      User.findById(advance.requesterId).select("firstName lastName email name").lean(),
      advance.approverId
        ? User.findById(advance.approverId).select("firstName lastName email name").lean()
        : Promise.resolve(null),
    ]);

    // Chain-progress stepper: enrich each level with its approver display name.
    const chainNameById = new Map<string, string>();
    const chainApproverIds = chainRaw.map((l) => l.approverId).filter(Boolean);
    if (chainApproverIds.length) {
      const chainUsers = await User.find({
        workspaceId: req.workspaceObjectId,
        _id: { $in: chainApproverIds },
      })
        .select("firstName lastName email name")
        .lean();
      chainUsers.forEach((u: any) => chainNameById.set(String(u._id), employeeNameOf(u)));
    }
    const approvalChain = chainRaw.map((l: any) => ({
      level: l.level,
      approverId: l.approverId ? String(l.approverId) : null,
      approverName: l.approverId ? chainNameById.get(String(l.approverId)) || "" : "",
      status: l.status,
      decidedAt: l.decidedAt ?? null,
      note: l.note ?? null,
    }));

    // Resolve claim refs for the settlement rows (so the UI can name each claim
    // the advance is applied to / settled against).
    const settlements: any[] = Array.isArray((advance as any).settlements)
      ? (advance as any).settlements
      : [];
    const claimRefById = new Map<string, string>();
    const settlementReportIds = settlements.map((s) => s.reportId).filter(Boolean);
    if (settlementReportIds.length) {
      const claims = await Report.find({
        workspaceId: req.workspaceObjectId,
        _id: { $in: settlementReportIds },
      })
        .select("ref name")
        .lean();
      claims.forEach((c: any) => claimRefById.set(String(c._id), c.ref || c.name || ""));
    }
    const appliedToClaims = settlements.map((s: any) => ({
      settlementId: String(s._id),
      reportId: String(s.reportId),
      claimRef: claimRefById.get(String(s.reportId)) || "",
      amountApplied: s.amountApplied,
      settledAmount: s.settledAmount,
      status: s.status,
      appliedAt: s.appliedAt ?? null,
      settledAt: s.settledAt ?? null,
    }));

    const decision = canDecideAdvanceUser(req.user, advance);
    const out = {
      ...advance.toObject(),
      requesterName: employeeNameOf(requester),
      approverName: employeeNameOf(approver),
      approvalChain,
      appliedToClaims,
      viewerIsOwner: isOwner,
      canApprove: advance.status === "awaiting_approval" && decision.ok,
      canDisburse: canDisburseUser(req.user, advance),
      canRecover: canRecoverUser(req.user, advance),
    };

    // Activity timeline (oldest → newest), tenant-scoped + keyed by advanceId.
    const activityDocs = await ExpenseActivity.find({
      workspaceId: req.workspaceObjectId,
      advanceId: advance._id,
    })
      .sort({ createdAt: 1 })
      .lean();
    const activity = activityDocs.map((a: any) => ({
      _id: String(a._id),
      event: a.event,
      actorName: a.actorName,
      actorId: a.actorId ? String(a.actorId) : null,
      note: a.note ?? null,
      createdAt: a.createdAt,
    }));

    res.json({ ok: true, advance: out, activity });
  } catch (err: any) {
    console.error("[Advances GET one]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to load advance" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expense-advances/:id/approve  — awaiting_approval → (next level) or
 * approved. Reuses the claim chain-advance lifecycle: stamp the current level,
 * repoint approverId to the next approver (status stays awaiting_approval) or
 * finalize on the last level.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/approve", async (req: any, res: any) => {
  try {
    const advance = await loadAdvanceAny(req, req.params.id);
    if (!advance) return res.status(404).json({ error: "Advance not found" });
    if (advance.status !== "awaiting_approval") {
      return res.status(409).json({ error: "Only advances awaiting approval can be approved" });
    }

    const { ok, isSelf } = canDecideAdvanceUser(req.user, advance);
    if (!ok) return res.status(403).json({ error: "You are not authorized to approve this advance" });

    const me = ownRequesterId(req);
    const note = String(req.body?.decisionNote || "").trim() || null;

    const chain: any[] = Array.isArray(advance.approvalChain) ? advance.approvalChain : [];
    const totalLevels = chain.length || 1;
    const idx = Math.min(Math.max((advance.currentLevel || 1) - 1, 0), Math.max(chain.length - 1, 0));
    const levelNo = idx + 1;

    if (chain[idx]) {
      chain[idx].status = "approved";
      chain[idx].decidedAt = new Date();
      chain[idx].approverId = new mongoose.Types.ObjectId(me);
      if (note) chain[idx].note = note;
    }
    advance.markModified("approvalChain");

    const hasNext = idx < chain.length - 1;

    if (hasNext) {
      const next = chain[idx + 1];
      advance.currentLevel = levelNo + 1;
      advance.approverId = next.approverId; // denorm pointer → next pending approver
      advance.selfApproved = isSelf;
      await advance.save();

      await logAdvanceActivity({
        workspaceId: req.workspaceObjectId,
        advanceId: advance._id as mongoose.Types.ObjectId,
        event: "approved",
        actorId: me,
        actorName: actorNameOf(req),
        note: `Approved (L${levelNo}) → awaiting L${levelNo + 1}`,
      });

      // Notify the next approver (best-effort).
      if (next?.approverId) {
        try {
          const [nextApprover, requester] = await Promise.all([
            User.findById(next.approverId).select("firstName lastName name email").lean(),
            User.findById(advance.requesterId).select("firstName lastName name email").lean(),
          ]);
          if ((nextApprover as any)?.email) {
            await sendAdvanceSubmittedEmail({
              to: (nextApprover as any).email,
              approverName: employeeNameOf(nextApprover),
              requesterName: employeeNameOf(requester) || "An employee",
              advanceRef: advance.ref,
              advanceId: String(advance._id),
              amount: advance.amount,
              purpose: advance.purpose,
            });
          }
        } catch (mailErr: any) {
          console.error("[advance advance email]", mailErr?.message || mailErr);
        }
      }

      return res.json({ ok: true, advance: advance.toObject() });
    }

    // Final level → approve the advance.
    advance.status = "approved";
    advance.approvedAt = new Date();
    advance.approverId = new mongoose.Types.ObjectId(me); // actual decider
    advance.selfApproved = isSelf;
    if (isSelf) advance.decisionNote = advance.decisionNote || "Self-approved by admin";
    await advance.save();

    await logAdvanceActivity({
      workspaceId: req.workspaceObjectId,
      advanceId: advance._id as mongoose.Types.ObjectId,
      event: "approved",
      actorId: me,
      actorName: actorNameOf(req),
      note:
        totalLevels > 1
          ? `Approved (final, L${levelNo})`
          : isSelf
            ? "Self-approved by admin"
            : null,
    });

    res.json({ ok: true, advance: advance.toObject() });
  } catch (err: any) {
    console.error("[Advances approve]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to approve advance" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expense-advances/:id/decline  — awaiting_approval → declined.
 * decisionNote (reason) REQUIRED. TERMINAL.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/decline", async (req: any, res: any) => {
  try {
    const advance = await loadAdvanceAny(req, req.params.id);
    if (!advance) return res.status(404).json({ error: "Advance not found" });
    if (advance.status !== "awaiting_approval") {
      return res.status(409).json({ error: "Only advances awaiting approval can be declined" });
    }

    const { ok, isSelf } = canDecideAdvanceUser(req.user, advance);
    if (!ok) return res.status(403).json({ error: "You are not authorized to decline this advance" });

    const note = String(req.body?.decisionNote || "").trim();
    if (!note) return res.status(400).json({ error: "A reason is required to decline." });

    const me = ownRequesterId(req);
    const chain: any[] = Array.isArray(advance.approvalChain) ? advance.approvalChain : [];
    const idx = Math.min(Math.max((advance.currentLevel || 1) - 1, 0), Math.max(chain.length - 1, 0));
    const levelNo = idx + 1;
    if (chain[idx]) {
      chain[idx].status = "declined";
      chain[idx].decidedAt = new Date();
      chain[idx].approverId = new mongoose.Types.ObjectId(me);
      chain[idx].note = note;
    }
    advance.markModified("approvalChain");

    advance.status = "declined";
    advance.approverId = new mongoose.Types.ObjectId(me);
    advance.decisionNote = note;
    advance.selfApproved = isSelf;
    await advance.save();

    await logAdvanceActivity({
      workspaceId: req.workspaceObjectId,
      advanceId: advance._id as mongoose.Types.ObjectId,
      event: "declined",
      actorId: me,
      actorName: actorNameOf(req),
      note: (chain.length || 1) > 1 ? `Declined (L${levelNo}): ${note}` : note,
    });

    res.json({ ok: true, advance: advance.toObject() });
  } catch (err: any) {
    console.error("[Advances decline]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to decline advance" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expense-advances/:id/clarify  — awaiting_approval →
 * clarification_required. decisionNote (the question) REQUIRED. Returns to the
 * requester, who edits nothing here but Resubmits (chain re-resolves).
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/clarify", async (req: any, res: any) => {
  try {
    const advance = await loadAdvanceAny(req, req.params.id);
    if (!advance) return res.status(404).json({ error: "Advance not found" });
    if (advance.status !== "awaiting_approval") {
      return res.status(409).json({ error: "Only advances awaiting approval can be sent back for clarification" });
    }

    const { ok, isSelf } = canDecideAdvanceUser(req.user, advance);
    if (!ok) return res.status(403).json({ error: "You are not authorized to action this advance" });

    const note = String(req.body?.decisionNote || "").trim();
    if (!note) return res.status(400).json({ error: "A note is required to request clarification." });

    const me = ownRequesterId(req);
    const chain: any[] = Array.isArray(advance.approvalChain) ? advance.approvalChain : [];
    const idx = Math.min(Math.max((advance.currentLevel || 1) - 1, 0), Math.max(chain.length - 1, 0));
    const levelNo = idx + 1;
    if (chain[idx]) {
      chain[idx].status = "clarification_required";
      chain[idx].decidedAt = new Date();
      chain[idx].approverId = new mongoose.Types.ObjectId(me);
      chain[idx].note = note;
    }
    advance.markModified("approvalChain");

    advance.status = "clarification_required";
    advance.approverId = new mongoose.Types.ObjectId(me);
    advance.decisionNote = note;
    advance.selfApproved = isSelf;
    advance.approvedAt = null;
    await advance.save();

    await logAdvanceActivity({
      workspaceId: req.workspaceObjectId,
      advanceId: advance._id as mongoose.Types.ObjectId,
      event: "clarification_requested",
      actorId: me,
      actorName: actorNameOf(req),
      note: (chain.length || 1) > 1 ? `Clarification (L${levelNo}): ${note}` : note,
    });

    res.json({ ok: true, advance: advance.toObject() });
  } catch (err: any) {
    console.error("[Advances clarify]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to request clarification" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expense-advances/:id/resubmit  — clarification_required →
 * awaiting_approval (REQUESTER only). Re-resolves the chain fresh (mirrors a
 * claim resubmit), so a changed manager/threshold is picked up. Same never-null
 * 409 routing as request.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/resubmit", async (req: any, res: any) => {
  try {
    const advance = await loadAdvanceAny(req, req.params.id);
    if (!advance) return res.status(404).json({ error: "Advance not found" });

    const me = ownRequesterId(req);
    if (String(advance.requesterId) !== me) {
      return res.status(403).json({ error: "Only the requester can resubmit this advance" });
    }
    if (advance.status !== "clarification_required") {
      return res.status(409).json({ error: "Only advances in clarification can be resubmitted" });
    }

    const { chain, approverId } = await resolveAdvanceApprovalChain(
      req.workspaceObjectId,
      me,
      advance.amount,
    );
    if (!approverId) {
      return res.status(409).json({
        error:
          "No approver available — set a manager for this employee, or add an admin to the workspace.",
      });
    }

    advance.approvalChain = chain;
    advance.currentLevel = 1;
    advance.approverId = approverId;
    advance.status = "awaiting_approval";
    advance.submittedAt = new Date();
    advance.decisionNote = null;
    advance.selfApproved = false;
    advance.approvedAt = null;
    await advance.save();

    await logAdvanceActivity({
      workspaceId: req.workspaceObjectId,
      advanceId: advance._id as mongoose.Types.ObjectId,
      event: "resubmitted",
      actorId: me,
      actorName: actorNameOf(req),
    });

    // Notify the (re-resolved) L1 approver — best-effort.
    try {
      const [approver, requester] = await Promise.all([
        User.findById(approverId).select("firstName lastName name email").lean(),
        User.findById(advance.requesterId).select("firstName lastName name email").lean(),
      ]);
      if ((approver as any)?.email) {
        await sendAdvanceSubmittedEmail({
          to: (approver as any).email,
          approverName: employeeNameOf(approver),
          requesterName: employeeNameOf(requester) || "An employee",
          advanceRef: advance.ref,
          advanceId: String(advance._id),
          amount: advance.amount,
          purpose: advance.purpose,
        });
      }
    } catch (mailErr: any) {
      console.error("[advance resubmit email]", mailErr?.message || mailErr);
    }

    res.json({ ok: true, advance: advance.toObject() });
  } catch (err: any) {
    console.error("[Advances resubmit]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to resubmit advance" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expense-advances/:id/disburse  — approved → disbursed (FINANCE).
 * canDisburse: finance-only + whole-chain SoD (a finance user may not disburse
 * an advance they approved); an admin bypasses SoD (owner-operator, logged).
 * Sets amountDisbursed = amount and outstandingBalance = amount (no settlement
 * logic in Phase 1).
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/disburse", async (req: any, res: any) => {
  try {
    const advance = await loadAdvanceAny(req, req.params.id);
    if (!advance) return res.status(404).json({ error: "Advance not found" });
    if (advance.status !== "approved") {
      return res.status(409).json({ error: "Only approved advances can be disbursed" });
    }

    if (!canDisburseUser(req.user, advance)) {
      if (!isFinance(req)) return res.status(403).json({ error: "Finance access required" });
      return res.status(403).json({
        error: "You approved this advance — a different finance user must disburse it.",
      });
    }

    const me = ownRequesterId(req);
    const wasApprover =
      (advance.approverId && String(advance.approverId) === me) ||
      (Array.isArray(advance.approvalChain) &&
        advance.approvalChain.some((l: any) => l?.approverId && String(l.approverId) === me));

    // Optional disbursement metadata.
    const modeRaw = String(req.body?.disbursementMode || "").trim();
    const VALID_MODES = new Set(["bank_transfer", "upi", "cash", "cheque", "other"]);
    const disbursementMode = VALID_MODES.has(modeRaw) ? modeRaw : null;
    const disbursementRef = String(req.body?.disbursementRef || "").trim() || null;

    advance.status = "disbursed";
    advance.amountDisbursed = advance.amount;
    advance.outstandingBalance = advance.amount;
    advance.disbursedAt = new Date();
    advance.disbursedBy = new mongoose.Types.ObjectId(me);
    advance.disbursementMode = disbursementMode as any;
    advance.disbursementRef = disbursementRef;
    await advance.save();

    await logAdvanceActivity({
      workspaceId: req.workspaceObjectId,
      advanceId: advance._id as mongoose.Types.ObjectId,
      event: "disbursed",
      actorId: me,
      actorName: actorNameOf(req),
      note: isAdmin(req) && wasApprover ? "Disbursed (admin SoD override)" : disbursementRef || null,
    });

    res.json({ ok: true, advance: advance.toObject() });
  } catch (err: any) {
    console.error("[Advances disburse]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to disburse advance" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expense-advances/:id/apply  { reportId, amountApplied }
 * EMPLOYEE — earmark this (own, disbursed) advance against an own claim. Records
 * an EARMARKED settlement; the balance is untouched until the claim reimburses
 * (settle-at-reimburse). Validation lives in the settlement engine.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/apply", async (req: any, res: any) => {
  try {
    const reportId = String(req.body?.reportId || "");
    const result = await applyAdvanceToClaim({
      workspaceId: req.workspaceObjectId,
      requesterId: ownRequesterId(req),
      advanceId: req.params.id,
      reportId,
      amountApplied: Number(req.body?.amountApplied),
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    // Log on the CLAIM timeline — the employee is on the claim when applying.
    try {
      await ExpenseActivity.create({
        workspaceId: req.workspaceObjectId,
        reportId: new mongoose.Types.ObjectId(reportId),
        event: "advance_applied",
        actorId: new mongoose.Types.ObjectId(ownRequesterId(req)),
        actorName: actorNameOf(req),
        note: `Applied ${result.advance.ref} — ${result.amountApplied}`,
      });
    } catch (e: any) {
      console.error("[advance apply log]", e?.message || e);
    }

    res.json({ ok: true, advance: result.advance.toObject() });
  } catch (err: any) {
    console.error("[Advances apply]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to apply advance" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expense-advances/:id/detach  { reportId }
 * EMPLOYEE — remove an EARMARKED application of this advance from a claim (only
 * before the claim reimburses). No balance change — none was ever made.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/detach", async (req: any, res: any) => {
  try {
    const reportId = String(req.body?.reportId || "");
    const result = await detachAdvanceFromClaim({
      workspaceId: req.workspaceObjectId,
      requesterId: ownRequesterId(req),
      advanceId: req.params.id,
      reportId,
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    try {
      await ExpenseActivity.create({
        workspaceId: req.workspaceObjectId,
        reportId: new mongoose.Types.ObjectId(reportId),
        event: "advance_detached",
        actorId: new mongoose.Types.ObjectId(ownRequesterId(req)),
        actorName: actorNameOf(req),
        note: `Detached ${result.advance.ref} (${result.amountReleased})`,
      });
    } catch (e: any) {
      console.error("[advance detach log]", e?.message || e);
    }

    res.json({ ok: true, advance: result.advance.toObject() });
  } catch (err: any) {
    console.error("[Advances detach]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to detach advance" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /api/expense-advances/:id/recover  { amount, note? }
 * FINANCE/ADMIN (canRecover SoD gate) — manually recover outstanding cash on a
 * disbursed/partially_settled advance. Reduces outstandingBalance directly
 * (capped at outstanding); status → settled at 0.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/recover", async (req: any, res: any) => {
  try {
    const advance = await loadAdvanceAny(req, req.params.id);
    if (!advance) return res.status(404).json({ error: "Advance not found" });

    if (advance.status !== "disbursed" && advance.status !== "partially_settled") {
      return res.status(409).json({ error: "Only a disbursed advance with an outstanding balance can be recovered" });
    }
    if (Number(advance.outstandingBalance) <= 0) {
      return res.status(409).json({ error: "Nothing outstanding to recover" });
    }
    // Finance/admin + whole-chain SoD (mirrors disburse): a finance user may not
    // recover an advance they approved; an admin may (owner-operator override).
    if (!canRecoverUser(req.user, advance)) {
      if (!isFinance(req)) return res.status(403).json({ error: "Finance access required" });
      return res.status(403).json({
        error: "You approved this advance — a different finance user must recover it.",
      });
    }

    const note = String(req.body?.note || "").trim() || null;
    const result = await recordRecovery({
      advance,
      amount: Number(req.body?.amount),
      note,
      recoveredBy: ownRequesterId(req),
    });
    if (!result.ok) return res.status(result.status).json({ error: result.error });

    await logAdvanceActivity({
      workspaceId: req.workspaceObjectId,
      advanceId: advance._id as mongoose.Types.ObjectId,
      event: "recovered",
      actorId: ownRequesterId(req),
      actorName: actorNameOf(req),
      note: `Recovered ${result.amountRecovered} → ${result.newStatus} (outstanding ${result.newOutstanding})${note ? `: ${note}` : ""}`,
    });

    res.json({ ok: true, advance: result.advance.toObject() });
  } catch (err: any) {
    console.error("[Advances recover]", err?.message);
    res.status(500).json({ error: err?.message || "Failed to recover advance" });
  }
});

export default router;
