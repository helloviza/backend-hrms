// apps/backend/src/models/Report.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

/**
 * Report (Expense Report) — Layer 2 of the expense module.
 * -------------------------------------------------------
 * USER-FACING TERM: "Claim". This model, its collection ("reports"), services
 * and the /api/reports routes deliberately keep the internal "Report" name — the
 * rename to "Claim" is frontend copy + the CLM- ref prefix only (no data
 * migration of names/routes). Treat "report" here and "claim" in the UI as the
 * same thing.
 *
 * A named collection of one employee's expenses, submitted together for
 * approval. Linkage lives on the Expense (expense.reportId, ≤1 report) — there
 * is no expense array here. Per-report counts/totals are aggregated on read,
 * never cached.
 *
 * Layer 2 only drives status up to `submitted`. approved/rejected/reimbursed +
 * approver routing belong to Layer 3 (see the TODO in routes/reports.ts submit).
 */

export type ReportStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "declined"
  | "clarification_required"
  | "reimbursed";

/**
 * Per-level state inside the approval chain (Phase 2). DISTINCT from ReportStatus
 * — this is the disposition of ONE approver's step, not the claim as a whole.
 * "Awaiting L2" is derived from (currentLevel, this array), never a new
 * ReportStatus value.
 */
export type ChainLevelStatus = "pending" | "approved" | "declined" | "clarification_required";

export interface IApprovalChainLevel {
  level: number; // 1-based step index (L1, L2, …)
  approverId?: mongoose.Types.ObjectId | null;
  status: ChainLevelStatus;
  decidedAt?: Date | null;
  note?: string | null;
}

export interface IReport extends Document {
  workspaceId: mongoose.Types.ObjectId;
  employeeId: mongoose.Types.ObjectId;
  name: string;
  ref: string;
  status: ReportStatus;

  submittedAt?: Date | null;
  approvedAt?: Date | null;
  reimbursedAt?: Date | null;

  approverId?: mongoose.Types.ObjectId | null; // Layer 3 — denorm pointer to the CURRENT pending approver (chain[currentLevel-1])
  decisionNote?: string | null; // Layer 3 — required on reject
  selfApproved?: boolean; // audit marker: approver === submitter (admin owner-override)

  // ── Phase 2: multi-level approval chain ──
  // Resolved at submit. Length 1 = today's single-approver behavior. Length ≥2
  // only when the workspace escalation threshold is set AND the claim exceeds it.
  // approverId above stays the denorm pointer to chain[currentLevel-1].approverId.
  approvalChain?: IApprovalChainLevel[];
  currentLevel?: number; // 1-based; which chain step is currently pending

  // ── Phase 2 (advances): net-reimburse record. PURELY ADDITIVE — only written
  // when the claim has applied advances. A claim with NO applied advances
  // reimburses exactly as before and these stay null/0 (regression line). ──
  reimbursedAmount?: number | null; // net cash actually paid = claimTotal − advanceAppliedTotal
  advanceAppliedTotal?: number; // Σ settled settlements applied to this claim at reimburse

  createdAt: Date;
  updatedAt: Date;
}

/**
 * Approval-chain level subdocument. _id disabled — these are positional steps,
 * addressed by `level`, not standalone documents.
 */
const ApprovalChainLevelSchema = new Schema<IApprovalChainLevel>(
  {
    level: { type: Number, required: true },
    approverId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    status: {
      type: String,
      enum: ["pending", "approved", "declined", "clarification_required"],
      default: "pending",
    },
    decidedAt: { type: Date, default: null },
    note: { type: String, trim: true, default: null },
  },
  { _id: false },
);

const ReportSchema = new Schema<IReport>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    employeeId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    name: { type: String, required: true, trim: true },
    ref: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["draft", "submitted", "approved", "declined", "clarification_required", "reimbursed"],
      default: "draft",
      index: true,
    },

    submittedAt: { type: Date, default: null },
    approvedAt: { type: Date, default: null },
    reimbursedAt: { type: Date, default: null },

    approverId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decisionNote: { type: String, trim: true, default: null },
    selfApproved: { type: Boolean, default: false },

    // ── Phase 2: approval chain (resolved at submit; length 1 = today) ──
    approvalChain: { type: [ApprovalChainLevelSchema], default: [] },
    currentLevel: { type: Number, default: 1 },

    // ── Phase 2 (advances): net-reimburse record (additive; null until a
    // reimburse with applied advances writes them). ──
    reimbursedAmount: { type: Number, default: null },
    advanceAppliedTotal: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Reports hub — Claim Report: workspace-scoped, date-ranged, newest-first scan
// over the claim's createdAt (GET /api/reports/export).
ReportSchema.index({ workspaceId: 1, createdAt: -1 });

ReportSchema.plugin(workspaceScopePlugin);

const Report =
  (mongoose.models.Report as mongoose.Model<IReport>) ||
  mongoose.model<IReport>("Report", ReportSchema);

export default Report;
