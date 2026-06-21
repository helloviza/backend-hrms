// apps/backend/src/models/ExpenseAdvance.ts
//
// ExpenseAdvance — Phase 1 of the cash-advance flow, a SYSTEM-B PEER of Report
// (the Claim). An advance is money paid to an employee BEFORE spend, against
// which expenses are later settled (Phase 2 — schema-only here). It deliberately
// does NOT extend Report/Expense: it has its OWN status enum and its OWN
// disbursement/outstanding fields, so the claim/reimburse code paths are never
// touched.
//
// Lifecycle (this model's own enum — NOT the 6-state expense/claim enum):
//   draft → awaiting_approval → approved → disbursed
//                 ├→ declined (terminal)
//                 └→ clarification_required → (resubmit) → awaiting_approval
//   cancelled (terminal; schema value, no Phase-1 route writes it yet)
//
// Approval reuses the Report chain resolvers (services/reports.service
// resolveAdvanceApprovalChain) and the same chain-level subdocument shape, so
// approve/decline/clarify/resubmit behave exactly like a claim. Disbursement is
// finance-only (services/expense.access canDisburse — SoD against the chain).
//
// Tenant isolation: workspaceScopePlugin + an explicit workspaceId on every
// write (create()/save() are not query-scoped).

import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";
import type { IApprovalChainLevel, ChainLevelStatus } from "./Report.js";

export type ExpenseAdvanceStatus =
  | "draft"
  | "awaiting_approval"
  | "approved"
  | "declined"
  | "clarification_required"
  | "disbursed"
  // ── Phase 2 settlement states (post-disbursement only) ──
  | "partially_settled" // 0 < outstandingBalance < amountDisbursed
  | "settled" // outstandingBalance == 0
  | "cancelled";

export type DisbursementMode = "bank_transfer" | "upi" | "cash" | "cheque" | "other";

/**
 * Settlement (Phase 2) — an EXPLICIT application of this advance against ONE
 * claim (Report). Created EARMARKED when the employee attaches the advance to a
 * claim; flipped SETTLED at the claim's reimburse (settle-at-reimburse), where
 * `settledAmount` is the amount that actually drew down the balance (== amountApplied
 * in the normal case; capped at the claim total / outstanding in the degenerate
 * over-application case). An earmarked settlement does NOT move outstandingBalance.
 * At most one settlement per (advance, reportId) pair.
 */
export type SettlementStatus = "earmarked" | "settled";

export interface ISettlement {
  reportId: mongoose.Types.ObjectId;
  amountApplied: number;
  settledAmount: number; // actual drawdown stamped at settle (0 until settled)
  status: SettlementStatus;
  appliedAt: Date;
  appliedBy?: mongoose.Types.ObjectId | null;
  settledAt?: Date | null;
}

/**
 * Recovery (Phase 2 / D2) — a MANUAL cash recovery of an outstanding advance by
 * finance (e.g. payroll deduction, cash returned). Reduces outstandingBalance
 * directly. Distinct from a settlement (which is netted at a claim's reimburse).
 */
export interface IRecovery {
  amount: number;
  recoveredAt: Date;
  recoveredBy?: mongoose.Types.ObjectId | null;
  note?: string | null;
}

export interface IExpenseAdvance extends Document {
  workspaceId: mongoose.Types.ObjectId;
  requesterId: mongoose.Types.ObjectId;
  ref: string;

  amount: number;
  currency: string;
  purpose: string;
  neededBy?: Date | null;

  status: ExpenseAdvanceStatus;

  // ── Approval chain (resolved at request; reuses the claim resolvers) ──
  // Same subdocument shape as Report.approvalChain. Length 1 = single approver;
  // length ≥2 only when advanceEscalationThreshold is set AND amount exceeds it.
  approvalChain?: IApprovalChainLevel[];
  currentLevel?: number; // 1-based; which chain step is currently pending
  approverId?: mongoose.Types.ObjectId | null; // denorm pointer → chain[currentLevel-1]
  decisionNote?: string | null;
  selfApproved?: boolean; // approver === requester (admin owner-override)

  submittedAt?: Date | null;
  approvedAt?: Date | null;

  // ── Disbursement (finance) ──
  amountDisbursed: number;
  disbursedAt?: Date | null;
  disbursedBy?: mongoose.Types.ObjectId | null;
  disbursementMode?: DisbursementMode | null;
  disbursementRef?: string | null;

  // Outstanding balance — ALWAYS recomputable as
  //   amountDisbursed − Σ (settled settlements).settledAmount − Σ recoveries.amount
  // (clamped ≥ 0). Persisted as a denormalized read field; recomputeOutstanding()
  // in services/advanceSettlement.service is the single writer + drift guard.
  outstandingBalance: number;

  // ── Phase 2: explicit settlements + manual recoveries ──
  settlements: ISettlement[];
  recoveries: IRecovery[];

  createdAt: Date;
  updatedAt: Date;
}

/**
 * Approval-chain level subdocument — identical shape to Report's (positional
 * steps addressed by `level`, _id disabled). Kept as its own declaration rather
 * than importing the Report schema instance, since a Mongoose sub-schema is
 * bound to its parent; the TYPE (IApprovalChainLevel) is shared.
 */
const AdvanceApprovalChainLevelSchema = new Schema<IApprovalChainLevel>(
  {
    level: { type: Number, required: true },
    approverId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    status: {
      type: String,
      enum: ["pending", "approved", "declined", "clarification_required"] as ChainLevelStatus[],
      default: "pending",
    },
    decidedAt: { type: Date, default: null },
    note: { type: String, trim: true, default: null },
  },
  { _id: false },
);

/** Settlement subdocument — keeps its _id so a specific earmark can be detached. */
const SettlementSchema = new Schema<ISettlement>(
  {
    reportId: { type: Schema.Types.ObjectId, ref: "Report", required: true },
    amountApplied: { type: Number, required: true },
    settledAmount: { type: Number, default: 0 },
    status: { type: String, enum: ["earmarked", "settled"], default: "earmarked" },
    appliedAt: { type: Date, default: Date.now },
    appliedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    settledAt: { type: Date, default: null },
  },
  { _id: true },
);

/** Recovery subdocument — manual cash recovery against an outstanding advance. */
const RecoverySchema = new Schema<IRecovery>(
  {
    amount: { type: Number, required: true },
    recoveredAt: { type: Date, default: Date.now },
    recoveredBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, trim: true, default: null },
  },
  { _id: true },
);

const ExpenseAdvanceSchema = new Schema<IExpenseAdvance>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    requesterId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    ref: { type: String, required: true, index: true },

    amount: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    purpose: { type: String, required: true, trim: true },
    neededBy: { type: Date, default: null },

    status: {
      type: String,
      enum: [
        "draft",
        "awaiting_approval",
        "approved",
        "declined",
        "clarification_required",
        "disbursed",
        "partially_settled",
        "settled",
        "cancelled",
      ],
      default: "draft",
      index: true,
    },

    approvalChain: { type: [AdvanceApprovalChainLevelSchema], default: [] },
    currentLevel: { type: Number, default: 1 },
    approverId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decisionNote: { type: String, trim: true, default: null },
    selfApproved: { type: Boolean, default: false },

    submittedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },

    amountDisbursed: { type: Number, default: 0 },
    disbursedAt: { type: Date, default: null },
    disbursedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    disbursementMode: {
      type: String,
      enum: ["bank_transfer", "upi", "cash", "cheque", "other"],
      default: null,
    },
    disbursementRef: { type: String, trim: true, default: null },

    outstandingBalance: { type: Number, default: 0 },

    // Phase 2 — explicit settlements (earmark → settle-at-reimburse) + manual
    // finance recoveries. Both empty until an advance is disbursed and applied.
    settlements: { type: [SettlementSchema], default: [] },
    recoveries: { type: [RecoverySchema], default: [] },
  },
  { timestamps: true },
);

// Compound index for the finance reporting aggregations (GET /analytics):
// the liability snapshot + by-employee outstanding + disbursed-in-period blocks
// all match {workspaceId, status} and group/sort by requesterId. The
// workspaceId+status prefix also covers the queue/pending-count filters.
ExpenseAdvanceSchema.index({ workspaceId: 1, status: 1, requesterId: 1 });

ExpenseAdvanceSchema.plugin(workspaceScopePlugin);

const ExpenseAdvance =
  (mongoose.models.ExpenseAdvance as mongoose.Model<IExpenseAdvance>) ||
  mongoose.model<IExpenseAdvance>("ExpenseAdvance", ExpenseAdvanceSchema);

export default ExpenseAdvance;
