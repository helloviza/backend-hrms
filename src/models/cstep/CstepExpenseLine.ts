// apps/backend/src/models/cstep/CstepExpenseLine.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepExpenseLine
 * ----------------
 * CSTEP Travel & Claim Portal — one journey-leg / expense row, filled in by
 * the traveller against a CstepClaim. amountInr is computed on write from
 * amount/exchangeRate — never derived at read time.
 *
 * Tenant isolation reuses the standard workspaceScopePlugin, same as
 * Expense.ts.
 */

export type CstepExpenseMode =
  | "AIR"
  | "RAIL"
  | "CAB"
  | "BUS"
  | "HOTEL"
  | "VISA"
  | "INSURANCE"
  | "REGISTRATION"
  | "TELECOM"
  | "FOREX"
  | "OTHER";

export interface ICstepExpenseLine extends Document {
  workspaceId: mongoose.Types.ObjectId;
  claimId: mongoose.Types.ObjectId; // ref CstepClaim

  stream: "TRAVELLER" | "CSTEP";
  date?: string; // "YYYY-MM-DD"
  from?: string;
  to?: string;
  segment: "ONWARD" | "RETURN" | "LOCAL" | "STAY";

  mode: CstepExpenseMode;
  paidBy: "SELF" | "CSTEP";
  amount: number;
  currency: string;
  exchangeRate?: number;
  rateDate?: string; // "YYYY-MM-DD"
  amountInr: number; // computed on write

  vendorId?: mongoose.Types.ObjectId; // ref CstepVendor, optional
  vendorNameFree?: string; // for unlisted vendors
  remarks?: string;

  attachmentId?: mongoose.Types.ObjectId; // ref CstepAttachment, optional

  createdBy: mongoose.Types.ObjectId; // ref User

  createdAt: Date;
  updatedAt: Date;
}

const CstepExpenseLineSchema = new Schema<ICstepExpenseLine>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    claimId: { type: Schema.Types.ObjectId, ref: "CstepClaim", required: true, index: true },

    stream: { type: String, enum: ["TRAVELLER", "CSTEP"], required: true, index: true },
    date: { type: String },
    from: { type: String, trim: true },
    to: { type: String, trim: true },
    segment: { type: String, enum: ["ONWARD", "RETURN", "LOCAL", "STAY"], required: true },

    mode: {
      type: String,
      enum: ["AIR", "RAIL", "CAB", "BUS", "HOTEL", "VISA", "INSURANCE", "REGISTRATION", "TELECOM", "FOREX", "OTHER"],
      required: true,
    },
    paidBy: { type: String, enum: ["SELF", "CSTEP"], required: true },
    amount: { type: Number, required: true },
    currency: { type: String, default: "INR", uppercase: true },
    exchangeRate: { type: Number },
    rateDate: { type: String },
    amountInr: { type: Number, required: true },

    vendorId: { type: Schema.Types.ObjectId, ref: "CstepVendor" },
    vendorNameFree: { type: String, trim: true },
    remarks: { type: String, trim: true },

    attachmentId: { type: Schema.Types.ObjectId, ref: "CstepAttachment" },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

CstepExpenseLineSchema.plugin(workspaceScopePlugin);

const CstepExpenseLine =
  (mongoose.models.CstepExpenseLine as mongoose.Model<ICstepExpenseLine>) ||
  mongoose.model<ICstepExpenseLine>("CstepExpenseLine", CstepExpenseLineSchema);

export default CstepExpenseLine;
