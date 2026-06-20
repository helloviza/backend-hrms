// apps/backend/src/services/advanceSettlement.service.ts
//
// Advance settlement engine (Phase 2). The SINGLE owner of every mutation to
// ExpenseAdvance.settlements / .recoveries / .outstandingBalance / settlement
// status. Co-locating it here keeps the live reimburse-path edit (expenseReports
// reimburse handler) tiny and keeps the balance arithmetic in one drift-proof
// place.
//
// MODEL: explicit-apply, settle-at-reimburse.
//   apply   → push an EARMARKED settlement (does NOT move outstandingBalance).
//   detach  → remove an earmarked settlement (only before the claim reimburses).
//   reimburse → settleEarmarksForClaim: flip earmarks → settled, draw the balance
//               down by the actual settled amount, recompute status.
//   decline → releaseEarmarksForClaim: drop earmarks (no balance ever moved).
//   recover → manual finance cash recovery; reduces the balance directly.
//
// INVARIANT (recomputeOutstanding is the guard):
//   outstandingBalance = amountDisbursed
//                        − Σ (settlements where status='settled').settledAmount
//                        − Σ recoveries.amount     (clamped ≥ 0)

import mongoose from "mongoose";
import ExpenseAdvance, { type IExpenseAdvance } from "../models/ExpenseAdvance.js";
import Expense from "../models/Expense.js";

/** Round money to 2dp (kills float drift on sums/subtractions). */
export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

const oid = (v: mongoose.Types.ObjectId | string) => new mongoose.Types.ObjectId(String(v));

/** Claim total = Σ linked expense amounts (the same figure the lists/queues use). */
export async function claimTotal(
  workspaceId: mongoose.Types.ObjectId | string,
  reportId: mongoose.Types.ObjectId | string,
): Promise<number> {
  const [agg] = await Expense.aggregate([
    { $match: { workspaceId: oid(workspaceId), reportId: oid(reportId) } },
    { $group: { _id: null, total: { $sum: { $ifNull: ["$amount", 0] } } } },
  ]);
  return round2(agg?.total ?? 0);
}

/** Σ amountApplied of EARMARKED settlements pointing at this claim, across every advance. */
export async function earmarkedTotalForClaim(
  workspaceId: mongoose.Types.ObjectId | string,
  reportId: mongoose.Types.ObjectId | string,
): Promise<number> {
  const [agg] = await ExpenseAdvance.aggregate([
    { $match: { workspaceId: oid(workspaceId), "settlements.reportId": oid(reportId) } },
    { $unwind: "$settlements" },
    {
      $match: {
        "settlements.reportId": oid(reportId),
        "settlements.status": "earmarked",
      },
    },
    { $group: { _id: null, total: { $sum: { $ifNull: ["$settlements.amountApplied", 0] } } } },
  ]);
  return round2(agg?.total ?? 0);
}

/** Outstanding that is NOT yet spoken-for by an earmark on this advance. */
export function availableToEarmark(advance: IExpenseAdvance): number {
  const earmarked = (advance.settlements || [])
    .filter((s) => s.status === "earmarked")
    .reduce((sum, s) => sum + (Number(s.amountApplied) || 0), 0);
  return round2((Number(advance.outstandingBalance) || 0) - earmarked);
}

/**
 * Recompute outstandingBalance from the authoritative formula and re-derive the
 * post-disbursement status. Pure derivation → idempotent and drift-proof. Only
 * ever moves status WITHIN {disbursed, partially_settled, settled}; never touches
 * a pre-disbursement / terminal status. Caller saves.
 */
export function recomputeOutstanding(advance: IExpenseAdvance): number {
  const settled = (advance.settlements || [])
    .filter((s) => s.status === "settled")
    .reduce((sum, s) => sum + (Number(s.settledAmount) || 0), 0);
  const recovered = (advance.recoveries || []).reduce(
    (sum, r) => sum + (Number(r.amount) || 0),
    0,
  );
  const disbursed = Number(advance.amountDisbursed) || 0;
  const outstanding = Math.max(0, round2(disbursed - settled - recovered));
  advance.outstandingBalance = outstanding;

  // Status derivation — disbursed-family only (leave draft/approved/declined/etc.).
  if (
    disbursed > 0 &&
    (advance.status === "disbursed" ||
      advance.status === "partially_settled" ||
      advance.status === "settled")
  ) {
    advance.status =
      outstanding <= 0 ? "settled" : outstanding < disbursed ? "partially_settled" : "disbursed";
  }
  return outstanding;
}

// Flat result shapes (optional fields) rather than discriminated unions: this
// package compiles with strictNullChecks:false, where boolean-literal
// discriminants do not narrow. Branch on `ok`; the relevant fields are populated
// per outcome. (Same convention as services/reports.service SubmitReportResult.)
export type ApplyResult = {
  ok: boolean;
  status?: number;
  error?: string;
  advance?: IExpenseAdvance;
  settlementId?: string;
  amountApplied?: number;
};

/**
 * Apply (earmark) an advance against a claim — EMPLOYEE, own advance + own claim.
 * Records an earmarked settlement; outstandingBalance is untouched until reimburse.
 * Validations: own/disbursed/same-workspace, amountApplied ≤ available (outstanding
 * minus existing earmarks on the advance), and Σ applied on the claim ≤ claim total.
 */
export async function applyAdvanceToClaim(params: {
  workspaceId: mongoose.Types.ObjectId | string;
  requesterId: mongoose.Types.ObjectId | string;
  advanceId: string;
  reportId: string;
  amountApplied: number;
}): Promise<ApplyResult> {
  const ws = oid(params.workspaceId);
  const me = String(params.requesterId);

  if (!mongoose.Types.ObjectId.isValid(params.advanceId))
    return { ok: false, status: 404, error: "Advance not found" };
  if (!mongoose.Types.ObjectId.isValid(params.reportId))
    return { ok: false, status: 404, error: "Claim not found" };

  const amountApplied = round2(Number(params.amountApplied));
  if (!Number.isFinite(amountApplied) || amountApplied <= 0)
    return { ok: false, status: 400, error: "amountApplied must be a positive number" };

  const advance = await ExpenseAdvance.findOne({ _id: oid(params.advanceId), workspaceId: ws });
  if (!advance) return { ok: false, status: 404, error: "Advance not found" };
  if (String(advance.requesterId) !== me)
    return { ok: false, status: 403, error: "You can only apply your own advance" };
  if (advance.status !== "disbursed" && advance.status !== "partially_settled")
    return { ok: false, status: 409, error: "Only a disbursed advance with an outstanding balance can be applied" };

  // Claim must be the requester's own and not yet terminal (reimbursed/declined).
  const Report = (await import("../models/Report.js")).default;
  const report: any = await Report.findOne({ _id: oid(params.reportId), workspaceId: ws });
  if (!report) return { ok: false, status: 404, error: "Claim not found" };
  if (String(report.employeeId) !== me)
    return { ok: false, status: 403, error: "You can only apply an advance to your own claim" };
  if (report.status === "reimbursed" || report.status === "declined")
    return { ok: false, status: 409, error: "This claim can no longer take an advance" };

  // One earmark per (advance, claim) — detach first to change the amount.
  const already = (advance.settlements || []).some(
    (s) => s.status === "earmarked" && String(s.reportId) === String(report._id),
  );
  if (already)
    return { ok: false, status: 409, error: "This advance is already applied to this claim — detach it first to change the amount" };

  // Can't earmark more than the advance has left (outstanding minus existing earmarks).
  const available = availableToEarmark(advance);
  if (amountApplied > available)
    return {
      ok: false,
      status: 422,
      error: `Amount exceeds the advance's available balance (${available}).`,
    };

  // Σ earmarked on this claim (all advances) + this one must not exceed the claim total.
  const total = await claimTotal(ws, report._id);
  const alreadyOnClaim = await earmarkedTotalForClaim(ws, report._id);
  if (round2(alreadyOnClaim + amountApplied) > total)
    return {
      ok: false,
      status: 422,
      error: `Applied advances on this claim would exceed the claim total (${total}).`,
    };

  advance.settlements.push({
    reportId: report._id,
    amountApplied,
    settledAmount: 0,
    status: "earmarked",
    appliedAt: new Date(),
    appliedBy: oid(me),
    settledAt: null,
  } as any);
  await advance.save();

  const created = advance.settlements[advance.settlements.length - 1] as any;
  return { ok: true, advance, settlementId: String(created._id), amountApplied };
}

export type DetachResult = {
  ok: boolean;
  status?: number;
  error?: string;
  advance?: IExpenseAdvance;
  amountReleased?: number;
};

/**
 * Detach (remove) an earmarked settlement — EMPLOYEE, own advance. Only an
 * earmarked settlement on a not-yet-reimbursed claim can be detached (a settled
 * one is history). No balance change — none was ever made.
 */
export async function detachAdvanceFromClaim(params: {
  workspaceId: mongoose.Types.ObjectId | string;
  requesterId: mongoose.Types.ObjectId | string;
  advanceId: string;
  reportId: string;
}): Promise<DetachResult> {
  const ws = oid(params.workspaceId);
  const me = String(params.requesterId);

  if (!mongoose.Types.ObjectId.isValid(params.advanceId))
    return { ok: false, status: 404, error: "Advance not found" };

  const advance = await ExpenseAdvance.findOne({ _id: oid(params.advanceId), workspaceId: ws });
  if (!advance) return { ok: false, status: 404, error: "Advance not found" };
  if (String(advance.requesterId) !== me)
    return { ok: false, status: 403, error: "You can only detach your own advance" };

  const idx = (advance.settlements || []).findIndex(
    (s) => s.status === "earmarked" && String(s.reportId) === String(params.reportId),
  );
  if (idx < 0)
    return { ok: false, status: 404, error: "No earmarked application of this advance to that claim" };

  const released = round2(Number(advance.settlements[idx].amountApplied) || 0);
  advance.settlements.splice(idx, 1);
  recomputeOutstanding(advance); // no-op for balance (earmarks don't move it)
  await advance.save();
  return { ok: true, advance, amountReleased: released };
}

export type SettlePerAdvance = {
  advanceId: string;
  advanceRef: string;
  requesterId: string;
  settledAmount: number;
  newStatus: string;
};

/**
 * SETTLE-AT-REIMBURSE — flip every earmarked settlement for this claim to
 * settled, draw each advance's balance down by the amount it actually settles,
 * and recompute each advance's status. Idempotent: re-running finds no earmarked
 * settlements (they're already settled) → no-op, so a reimburse retry can't
 * double-draw. The drawdown budget is capped at the claim total (an employee
 * can't consume more advance than the claim's actual spend), and each per-advance
 * draw is capped at that advance's outstanding balance.
 */
export async function settleEarmarksForClaim(
  workspaceId: mongoose.Types.ObjectId | string,
  reportId: mongoose.Types.ObjectId | string,
): Promise<{ settledTotal: number; claimTotal: number; perAdvance: SettlePerAdvance[] }> {
  const ws = oid(workspaceId);
  const rid = oid(reportId);
  const total = await claimTotal(ws, rid);

  const advances = await ExpenseAdvance.find({
    workspaceId: ws,
    settlements: { $elemMatch: { reportId: rid, status: "earmarked" } },
  }).sort({ _id: 1 });

  let budget = total; // total drawdown can't exceed the claim's actual spend
  let settledTotal = 0;
  const perAdvance: SettlePerAdvance[] = [];

  for (const advance of advances) {
    const s: any = (advance.settlements || []).find(
      (x) => x.status === "earmarked" && String(x.reportId) === String(rid),
    );
    if (!s) continue;

    const draw = round2(
      Math.min(Number(s.amountApplied) || 0, Math.max(0, budget), Number(advance.outstandingBalance) || 0),
    );
    s.status = "settled";
    s.settledAmount = draw;
    s.settledAt = new Date();
    budget = round2(budget - draw);
    settledTotal = round2(settledTotal + draw);

    recomputeOutstanding(advance);
    await advance.save();

    perAdvance.push({
      advanceId: String(advance._id),
      advanceRef: advance.ref,
      requesterId: String(advance.requesterId),
      settledAmount: draw,
      newStatus: advance.status,
    });
  }

  return { settledTotal, claimTotal: total, perAdvance };
}

/**
 * RELEASE — drop every earmarked settlement for this claim (on decline, and on
 * the detach path's claim-wide variant). No balance change: an earmark never
 * moved outstandingBalance, so a declined claim leaves its advances fully
 * outstanding. Settled settlements are history and are NEVER touched here.
 */
export async function releaseEarmarksForClaim(
  workspaceId: mongoose.Types.ObjectId | string,
  reportId: mongoose.Types.ObjectId | string,
): Promise<{ releasedCount: number; advanceIds: string[] }> {
  const ws = oid(workspaceId);
  const rid = oid(reportId);

  const advances = await ExpenseAdvance.find({
    workspaceId: ws,
    settlements: { $elemMatch: { reportId: rid, status: "earmarked" } },
  });

  let releasedCount = 0;
  const advanceIds: string[] = [];
  for (const advance of advances) {
    const before = advance.settlements.length;
    advance.settlements = (advance.settlements || []).filter(
      (s) => !(s.status === "earmarked" && String(s.reportId) === String(rid)),
    ) as any;
    const removed = before - advance.settlements.length;
    if (removed > 0) {
      releasedCount += removed;
      recomputeOutstanding(advance); // no balance change; keeps status consistent
      await advance.save();
      advanceIds.push(String(advance._id));
    }
  }
  return { releasedCount, advanceIds };
}

export type RecoverResult = {
  ok: boolean;
  status?: number;
  error?: string;
  advance?: IExpenseAdvance;
  amountRecovered?: number;
  newOutstanding?: number;
  newStatus?: string;
};

/**
 * Manual recovery (D2) — finance/admin reduce an outstanding advance directly
 * (the route applies the canRecover SoD gate). The amount is capped at the
 * current outstanding balance; recompute re-derives outstanding + status.
 */
export async function recordRecovery(params: {
  advance: IExpenseAdvance;
  amount: number;
  note?: string | null;
  recoveredBy: mongoose.Types.ObjectId | string;
}): Promise<RecoverResult> {
  const advance = params.advance;
  const amt = round2(Number(params.amount));
  if (!Number.isFinite(amt) || amt <= 0)
    return { ok: false, status: 400, error: "amount must be a positive number" };

  const capped = round2(Math.min(amt, Number(advance.outstandingBalance) || 0));
  if (capped <= 0)
    return { ok: false, status: 409, error: "Nothing outstanding to recover" };

  advance.recoveries.push({
    amount: capped,
    recoveredAt: new Date(),
    recoveredBy: oid(params.recoveredBy),
    note: params.note ?? null,
  } as any);
  recomputeOutstanding(advance);
  await advance.save();

  return {
    ok: true,
    advance,
    amountRecovered: capped,
    newOutstanding: advance.outstandingBalance,
    newStatus: advance.status,
  };
}

export type AppliedAdvanceRow = {
  advanceId: string;
  advanceRef: string;
  settlementId: string;
  amountApplied: number;
  settledAmount: number;
  status: string;
};

/** Advances applied (earmarked or settled) to a claim — for the claim detail view. */
export async function listAppliedAdvancesForClaim(
  workspaceId: mongoose.Types.ObjectId | string,
  reportId: mongoose.Types.ObjectId | string,
): Promise<AppliedAdvanceRow[]> {
  const ws = oid(workspaceId);
  const rid = oid(reportId);
  const advances = await ExpenseAdvance.find({
    workspaceId: ws,
    "settlements.reportId": rid,
  })
    .select("ref settlements")
    .lean();

  const rows: AppliedAdvanceRow[] = [];
  for (const a of advances as any[]) {
    for (const s of a.settlements || []) {
      if (String(s.reportId) !== String(rid)) continue;
      rows.push({
        advanceId: String(a._id),
        advanceRef: a.ref,
        settlementId: String(s._id),
        amountApplied: round2(s.amountApplied || 0),
        settledAmount: round2(s.settledAmount || 0),
        status: s.status,
      });
    }
  }
  return rows;
}
