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
  | "cancelled";

export type DisbursementMode = "bank_transfer" | "upi" | "cash" | "cheque" | "other";

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

  // Outstanding balance = amountDisbursed − Σ settlements − Σ recoveries.
  // In Phase 1 it is simply amountDisbursed on disburse (no settlement logic).
  outstandingBalance: number;

  // ── Phase 2 placeholders (schema only — always empty in Phase 1) ──
  settlements: any[];
  recoveries: any[];

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

    // Phase 2 — settlement/recovery application. Mixed (holds an array) and
    // always empty in Phase 1; the concrete sub-schemas land with the settle flow.
    settlements: { type: Schema.Types.Mixed, default: [] },
    recoveries: { type: Schema.Types.Mixed, default: [] },
  },
  { timestamps: true },
);

ExpenseAdvanceSchema.plugin(workspaceScopePlugin);

const ExpenseAdvance =
  (mongoose.models.ExpenseAdvance as mongoose.Model<IExpenseAdvance>) ||
  mongoose.model<IExpenseAdvance>("ExpenseAdvance", ExpenseAdvanceSchema);

export default ExpenseAdvance;
