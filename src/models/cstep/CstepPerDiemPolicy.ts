// apps/backend/src/models/cstep/CstepPerDiemPolicy.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepPerDiemPolicy
 * ------------------
 * CSTEP Travel & Claim Portal — per-tenant per-diem rate policy, keyed by
 * trip type (and country for international). CstepPerDiem rows are computed
 * against whichever policy is effective on the travel date.
 *
 * Tenant isolation reuses the standard workspaceScopePlugin, same as
 * Expense.ts.
 */

export interface ICstepPerDiemPolicy extends Document {
  workspaceId: mongoose.Types.ObjectId;

  tripType: "DOMESTIC" | "INTERNATIONAL";
  country?: string;
  rate: number;
  currency: string;
  halfDayRule?: any;

  effectiveFrom?: string; // "YYYY-MM-DD"
  effectiveTo?: string; // "YYYY-MM-DD"

  createdBy: mongoose.Types.ObjectId; // ref User

  createdAt: Date;
  updatedAt: Date;
}

const CstepPerDiemPolicySchema = new Schema<ICstepPerDiemPolicy>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },

    tripType: { type: String, enum: ["DOMESTIC", "INTERNATIONAL"], required: true, index: true },
    country: { type: String, trim: true },
    rate: { type: Number, required: true },
    currency: { type: String, default: "INR", uppercase: true },
    halfDayRule: { type: Schema.Types.Mixed },

    effectiveFrom: { type: String },
    effectiveTo: { type: String },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

CstepPerDiemPolicySchema.index({ workspaceId: 1, tripType: 1, country: 1 });

CstepPerDiemPolicySchema.plugin(workspaceScopePlugin);

const CstepPerDiemPolicy =
  (mongoose.models.CstepPerDiemPolicy as mongoose.Model<ICstepPerDiemPolicy>) ||
  mongoose.model<ICstepPerDiemPolicy>("CstepPerDiemPolicy", CstepPerDiemPolicySchema);

export default CstepPerDiemPolicy;
