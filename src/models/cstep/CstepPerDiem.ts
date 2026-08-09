// apps/backend/src/models/cstep/CstepPerDiem.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepPerDiem
 * ------------
 * CSTEP Travel & Claim Portal — one per CstepClaim. Per-day breakdown of the
 * per-diem allowance, with computedDays vs. an optional manual override.
 *
 * Tenant isolation reuses the standard workspaceScopePlugin, same as
 * Expense.ts.
 */

export interface ICstepPerDiemDay {
  date?: string; // "YYYY-MM-DD"
  rate?: number;
  currencyRate?: number;
  amountInr?: number;
  excluded?: boolean;
  excludedReason?: string;
}

export interface ICstepPerDiem extends Document {
  workspaceId: mongoose.Types.ObjectId;
  claimId: mongoose.Types.ObjectId; // ref CstepClaim, one per claim

  days: number;
  rate: number;
  currency: string;

  breakdown: ICstepPerDiemDay[];

  computedDays: number;
  overrideDays?: number;
  overrideReason?: string;

  createdBy: mongoose.Types.ObjectId; // ref User

  createdAt: Date;
  updatedAt: Date;
}

const CstepPerDiemDaySchema = new Schema<ICstepPerDiemDay>(
  {
    date: { type: String },
    rate: { type: Number },
    currencyRate: { type: Number },
    amountInr: { type: Number },
    excluded: { type: Boolean, default: false },
    excludedReason: { type: String, trim: true },
  },
  { _id: false },
);

const CstepPerDiemSchema = new Schema<ICstepPerDiem>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    claimId: { type: Schema.Types.ObjectId, ref: "CstepClaim", required: true },

    days: { type: Number, required: true },
    rate: { type: Number, required: true },
    currency: { type: String, default: "INR", uppercase: true },

    breakdown: { type: [CstepPerDiemDaySchema], default: [] },

    computedDays: { type: Number, required: true },
    overrideDays: { type: Number },
    overrideReason: { type: String, trim: true },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

// One CstepPerDiem per claim, per tenant.
CstepPerDiemSchema.index({ workspaceId: 1, claimId: 1 }, { unique: true });

CstepPerDiemSchema.plugin(workspaceScopePlugin);

const CstepPerDiem =
  (mongoose.models.CstepPerDiem as mongoose.Model<ICstepPerDiem>) ||
  mongoose.model<ICstepPerDiem>("CstepPerDiem", CstepPerDiemSchema);

export default CstepPerDiem;
