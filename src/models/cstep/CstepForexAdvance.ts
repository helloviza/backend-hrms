// apps/backend/src/models/cstep/CstepForexAdvance.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepForexAdvance
 * -----------------
 * CSTEP Travel & Claim Portal — zero or one per CstepClaim, for
 * international trips where forex was drawn in advance. forexSpent,
 * totalForexExpenses and balancePayable are computed on write, not derived
 * at read time.
 *
 * Tenant isolation reuses the standard workspaceScopePlugin, same as
 * Expense.ts.
 */

export interface ICstepForexAdvance extends Document {
  workspaceId: mongoose.Types.ObjectId;
  claimId: mongoose.Types.ObjectId; // ref CstepClaim, zero or one per claim

  drawnAmount: number;
  drawnCurrency: string;
  drawnRate?: number;
  returnedAmount?: number;

  forexSpent: number; // computed
  totalForexExpenses: number; // computed
  balancePayable: number; // computed, signed (+ traveller owes CSTEP, - CSTEP owes traveller)

  createdBy: mongoose.Types.ObjectId; // ref User

  createdAt: Date;
  updatedAt: Date;
}

const CstepForexAdvanceSchema = new Schema<ICstepForexAdvance>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    claimId: { type: Schema.Types.ObjectId, ref: "CstepClaim", required: true },

    drawnAmount: { type: Number, required: true },
    drawnCurrency: { type: String, required: true, uppercase: true },
    drawnRate: { type: Number },
    returnedAmount: { type: Number, default: 0 },

    forexSpent: { type: Number, default: 0 },
    totalForexExpenses: { type: Number, default: 0 },
    balancePayable: { type: Number, default: 0 },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

// At most one CstepForexAdvance per claim, per tenant.
CstepForexAdvanceSchema.index({ workspaceId: 1, claimId: 1 }, { unique: true });

CstepForexAdvanceSchema.plugin(workspaceScopePlugin);

const CstepForexAdvance =
  (mongoose.models.CstepForexAdvance as mongoose.Model<ICstepForexAdvance>) ||
  mongoose.model<ICstepForexAdvance>("CstepForexAdvance", CstepForexAdvanceSchema);

export default CstepForexAdvance;
