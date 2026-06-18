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

export interface IReport extends Document {
  workspaceId: mongoose.Types.ObjectId;
  employeeId: mongoose.Types.ObjectId;
  name: string;
  ref: string;
  status: ReportStatus;

  submittedAt?: Date | null;
  approvedAt?: Date | null;
  reimbursedAt?: Date | null;

  approverId?: mongoose.Types.ObjectId | null; // Layer 3 — snapshot at submit; actual decider on approve/reject
  decisionNote?: string | null; // Layer 3 — required on reject
  selfApproved?: boolean; // audit marker: approver === submitter (admin owner-override)

  createdAt: Date;
  updatedAt: Date;
}

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
  },
  { timestamps: true },
);

ReportSchema.plugin(workspaceScopePlugin);

const Report =
  (mongoose.models.Report as mongoose.Model<IReport>) ||
  mongoose.model<IReport>("Report", ReportSchema);

export default Report;
