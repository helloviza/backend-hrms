// apps/backend/src/models/Expense.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

/**
 * Expense
 * -------
 * Expense Management — Sprint 2. The confirmed, employee-owned expense record
 * created once a captured WhatsApp receipt is confirmed (or corrected then
 * confirmed) by the sender.
 *
 * Tenant isolation reuses the standard workspaceScopePlugin (auto-injects a
 * workspaceId filter on reads). The worker creates the doc with workspaceId set
 * explicitly — create()/save() are not query-scoped, so that is safe.
 */

export interface IExpense extends Document {
  workspaceId: mongoose.Types.ObjectId;
  employeeId: mongoose.Types.ObjectId;
  expenseCaptureId?: mongoose.Types.ObjectId;
  ref: string;
  sourceChannel: string;

  imageKey?: string;
  s3Bucket?: string;

  merchant?: string | null;
  date?: Date | null;
  amount: number;
  currency: string;
  taxAmount?: number | null;
  gstin?: string | null;
  suggestedCategory?: string | null;
  // Managed category (Layer 1). suggestedCategory is kept as the AI hint;
  // categoryId is the authoritative classification once selected.
  categoryId?: mongoose.Types.ObjectId | null;

  // Report linkage (Layer 2). An expense belongs to at most ONE report.
  reportId?: mongoose.Types.ObjectId | null;
  // Denormalized workflow state, the ONLY user-facing "status". Written solely
  // by propagateLifecycle() whenever report linkage or report.status changes.
  // Taxonomy: pending_to_submit → awaiting_approval →
  //   (approved · declined · clarification_required) → reimbursed.
  // "pending_to_submit" covers BOTH an unlinked expense (reportId null) and one
  // sitting in a DRAFT/clarification report — the two are told apart by reportId.
  lifecycleStatus:
    | "pending_to_submit"
    | "awaiting_approval"
    | "approved"
    | "declined"
    | "clarification_required"
    | "reimbursed";

  // Internal record-state (capture confirmed). NOT user-facing; always
  // "submitted" today. Kept separate from lifecycleStatus on purpose.
  status: "submitted";

  // Audit of what the model produced + its confidences (immutable record).
  rawExtraction?: any;
  perFieldConfidence?: any;
  extractionModel?: string;

  createdAt: Date;
  updatedAt: Date;
}

const ExpenseSchema = new Schema<IExpense>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    employeeId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // Optional: WhatsApp captures set it (idempotency); web expenses omit it
    // entirely. unique + sparse → uniqueness enforced only for docs that HAVE it.
    expenseCaptureId: { type: Schema.Types.ObjectId, ref: "ExpenseCapture", required: false, unique: true, sparse: true },
    ref: { type: String, required: true, index: true },
    sourceChannel: { type: String, default: "whatsapp" },

    imageKey: { type: String, trim: true },
    s3Bucket: { type: String, trim: true },

    merchant: { type: String, trim: true, default: null },
    date: { type: Date, default: null },
    amount: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    taxAmount: { type: Number, default: null },
    gstin: { type: String, trim: true, default: null },
    suggestedCategory: { type: String, trim: true, default: null },
    categoryId: { type: Schema.Types.ObjectId, ref: "ExpenseCategory", default: null, index: true },

    reportId: { type: Schema.Types.ObjectId, ref: "Report", default: null, index: true, sparse: true },
    lifecycleStatus: {
      type: String,
      enum: [
        "pending_to_submit",
        "awaiting_approval",
        "approved",
        "declined",
        "clarification_required",
        "reimbursed",
      ],
      default: "pending_to_submit",
      index: true,
    },

    status: { type: String, enum: ["submitted"], default: "submitted", index: true },

    rawExtraction: { type: Schema.Types.Mixed },
    perFieldConfidence: { type: Schema.Types.Mixed },
    extractionModel: { type: String, trim: true },
  },
  { timestamps: true },
);

ExpenseSchema.plugin(workspaceScopePlugin);

const Expense =
  (mongoose.models.Expense as mongoose.Model<IExpense>) ||
  mongoose.model<IExpense>("Expense", ExpenseSchema);

export default Expense;
