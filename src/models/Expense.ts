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
  expenseCaptureId: mongoose.Types.ObjectId;
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
    expenseCaptureId: { type: Schema.Types.ObjectId, ref: "ExpenseCapture", required: true, unique: true },
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
