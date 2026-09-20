// apps/backend/src/services/plumconnect/expenseInFlow.ts
//
// PlumConnect Slice 2 — "is this sender mid-way through an expense
// conversation?", answered READ-ONLY from the expense chain's own state.
// docs/plumconnect/PLUMCONNECT_IMPLEMENTATION_PLAN.md §4 step 1b, D3, §9;
// docs/plumconnect/EXPENSE_SEAM_RECHECK.md seam 5.
//
// The chain has two "mid-flow" signals and no expiry on either:
//   • an ExpenseCapture in awaiting_confirmation / awaiting_correction — the
//     worker's own precedence (expenseCaptureWorker.ts:716-719)
//   • an ExpenseWaSession whose state is not "idle" (:726-727)
// Left alone, an abandoned receipt would keep capturing that sender's next
// text forever (dispatch audit §A). The router therefore applies a freshness
// window over the chain's `updatedAt` and treats anything older as NOT in
// flow — WITHOUT writing to either collection. The stale row stays exactly
// as it is; the chain is never edited from here (D3). If the sender later
// sends a receipt the chain will still handle its own state.
//
// Window: PLUMCONNECT_EXPENSE_FLOW_TTL_MS, default 24h, read live so a test
// can pin it.

import ExpenseCapture from "../../models/ExpenseCapture.js";
import ExpenseWaSession from "../../models/ExpenseWaSession.js";

export const EXPENSE_FLOW_TTL_ENV = "PLUMCONNECT_EXPENSE_FLOW_TTL_MS";
export const DEFAULT_EXPENSE_FLOW_TTL_MS = 24 * 60 * 60 * 1000;

export function expenseFlowTtlMs(): number {
  const raw = Number(process.env[EXPENSE_FLOW_TTL_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EXPENSE_FLOW_TTL_MS;
}

export function isExpenseFlowFresh(updatedAt: Date | null | undefined, now: Date = new Date()): boolean {
  if (!updatedAt) return false;
  const t = new Date(updatedAt).getTime();
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t < expenseFlowTtlMs();
}

export interface ExpenseInFlow {
  /** true only when a signal exists AND is within the window. */
  inFlow: boolean;
  /** Which signal was found (the most recent one wins), or null. */
  source: "capture" | "session" | null;
  updatedAt: Date | null;
  /** A signal exists but is outside the window. */
  stale: boolean;
}

/**
 * Read the chain's state for a sender. `waId` is the bare-digits Meta id —
 * the same key the chain stores (ExpenseCapture.waId / ExpenseWaSession.waId).
 * Two indexed reads, zero writes.
 */
export async function readExpenseInFlow(waId: string, now: Date = new Date()): Promise<ExpenseInFlow> {
  const none: ExpenseInFlow = { inFlow: false, source: null, updatedAt: null, stale: false };
  if (!waId) return none;

  const [capture, session] = await Promise.all([
    ExpenseCapture.findOne({ waId, status: { $in: ["awaiting_confirmation", "awaiting_correction"] } })
      .sort({ updatedAt: -1 })
      .select("updatedAt")
      .lean(),
    ExpenseWaSession.findOne({ waId, state: { $ne: "idle" } }).select("updatedAt").lean(),
  ]);

  const candidates: Array<{ source: "capture" | "session"; updatedAt: Date }> = [];
  if ((capture as any)?.updatedAt) candidates.push({ source: "capture", updatedAt: (capture as any).updatedAt });
  if ((session as any)?.updatedAt) candidates.push({ source: "session", updatedAt: (session as any).updatedAt });
  if (candidates.length === 0) return none;

  candidates.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  const latest = candidates[0];
  const fresh = isExpenseFlowFresh(latest.updatedAt, now);
  return { inFlow: fresh, source: latest.source, updatedAt: new Date(latest.updatedAt), stale: !fresh };
}
