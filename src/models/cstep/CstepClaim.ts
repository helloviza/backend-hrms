// apps/backend/src/models/cstep/CstepClaim.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepClaim
 * ----------
 * CSTEP Travel & Claim Portal — the claim file, opened once a
 * CstepTravelRequest is approved. Settlement fields (totalCostOfTour,
 * amountClaimed, advanceTaken, amountDueByCstep, amountDueToCstep) are
 * STORED on write by whichever route/service computes them — never derived
 * at read time — same "compute once, persist" discipline as
 * SBTBooking.marginAmount.
 *
 * Tenant isolation reuses the standard workspaceScopePlugin, same as
 * Expense.ts. travelRequestId/travelerProfileId are soft references — see
 * the module note on CstepTravelRequest.ts.
 */

export type CstepClaimStatus =
  | "CLAIM_IN_PROGRESS"
  | "CLAIM_SUBMITTED"
  | "REWORK_REQUESTED"
  | "ADMIN_VERIFIED"
  | "ACCOUNTS_VERIFIED"
  | "SETTLED"
  | "CANCELLED";

export interface ICstepClaim extends Document {
  workspaceId: mongoose.Types.ObjectId;
  travelerProfileId: mongoose.Types.ObjectId; // soft ref -> TravellerProfile._id
  travelRequestId: mongoose.Types.ObjectId; // ref CstepTravelRequest

  claimReference: string; // "<travelerId>/MMYY"
  type: "DOMESTIC" | "INTERNATIONAL";
  status: CstepClaimStatus;

  // Computed settlement fields — stored on write, not derived at read. INR.
  totalCostOfTour: number;
  amountClaimed: number;
  advanceTaken: number;
  amountDueByCstep: number;
  amountDueToCstep: number;

  certifiedByTraveller: boolean;

  createdBy: mongoose.Types.ObjectId; // ref User

  createdAt: Date;
  updatedAt: Date;
}

const CstepClaimSchema = new Schema<ICstepClaim>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    travelerProfileId: { type: Schema.Types.ObjectId, ref: "TravellerProfile", required: true, index: true },
    travelRequestId: { type: Schema.Types.ObjectId, ref: "CstepTravelRequest", required: true, index: true },

    claimReference: { type: String, required: true, trim: true },
    type: { type: String, enum: ["DOMESTIC", "INTERNATIONAL"], required: true },
    status: {
      type: String,
      enum: [
        "CLAIM_IN_PROGRESS",
        "CLAIM_SUBMITTED",
        "REWORK_REQUESTED",
        "ADMIN_VERIFIED",
        "ACCOUNTS_VERIFIED",
        "SETTLED",
        "CANCELLED",
      ],
      default: "CLAIM_IN_PROGRESS",
      index: true,
    },

    totalCostOfTour: { type: Number, default: 0 },
    amountClaimed: { type: Number, default: 0 },
    advanceTaken: { type: Number, default: 0 },
    amountDueByCstep: { type: Number, default: 0 },
    amountDueToCstep: { type: Number, default: 0 },

    certifiedByTraveller: { type: Boolean, default: false },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

// Claim reference is unique per tenant, mirroring ExpenseCategory's
// { workspaceId, name } uniqueness pattern.
CstepClaimSchema.index({ workspaceId: 1, claimReference: 1 }, { unique: true });

CstepClaimSchema.plugin(workspaceScopePlugin);

const CstepClaim =
  (mongoose.models.CstepClaim as mongoose.Model<ICstepClaim>) ||
  mongoose.model<ICstepClaim>("CstepClaim", CstepClaimSchema);

export default CstepClaim;
