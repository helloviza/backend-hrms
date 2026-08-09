// apps/backend/src/models/cstep/CstepSettlement.ts
import mongoose, { Schema, type Document, type Model } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepSettlement
 * ----------------
 * CSTEP Travel & Claim Portal — Step 5 (Office/Accounts settlement). One row
 * per CstepTravelRequest (unique on requestId), opened once the traveller's
 * Travel Report reaches REPORT_SUBMITTED. A SEPARATE record from the
 * request, its CstepArrangement rows (Step 3), and its CstepReportLeg rows
 * (Step 4) — this layer never overwrites any of those; CstepSettlementLine
 * rows are seeded FROM them once, at /settlement/start, and only ever
 * verified/corrected here.
 *
 * status: "VERIFYING" while the Official is checking/correcting lines and
 * per diem; "FINALIZED" once /settlement/finalize has run — at that point
 * buckets/totals/outcome are frozen and every settlement route (except GET)
 * refuses further writes.
 *
 * buckets/totalCostOfTour/amountClaimed are always RECOMPUTED from the
 * current CstepSettlementLine rows + perDiem.amountInr on every write here
 * (never free-typed) — see recomputeSettlementTotals in routes/cstep.ts.
 *
 * Tenant isolation reuses the standard workspaceScopePlugin, same as every
 * other CSTEP model.
 */

export type CstepSettlementStatus = "VERIFYING" | "FINALIZED";
export type CstepSettlementOutcome = "CLOSE" | "TO_FINANCE";

export interface ICstepSettlementPerDiem {
  days: number; // the days actually used in the amount below — overrideDays if set, else computedDays
  rate: number; // INR per day
  currency: string; // always "INR" — per-diem is a domestic-rupee figure, unlike Step 3's foreign-currency arrangements
  amountInr: number; // = days * rate, recomputed on every perdiem/line write
  computedDays: number; // from the trip's departureDate/returnDate — never edited directly
  overrideDays?: number; // Official's override of computedDays, reason mandatory (see routes/cstep.ts)
  overrideReason?: string;
}

export interface ICstepSettlementBuckets {
  airRailBus: number;
  perDiem: number;
  boardingLodging: number;
  cab: number;
  other: number;
}

export interface ICstepSettlement extends Document {
  workspaceId: mongoose.Types.ObjectId;
  requestId: mongoose.Types.ObjectId; // ref CstepTravelRequest — one settlement per request

  status: CstepSettlementStatus;

  perDiem: ICstepSettlementPerDiem;
  buckets: ICstepSettlementBuckets;

  totalCostOfTour: number; // all official + personal lines + per diem
  amountClaimed: number; // personal (reimbursable) lines + per diem owed to the traveller
  outcome?: CstepSettlementOutcome; // set only at finalize

  startedBy: mongoose.Types.ObjectId; // ref User — who ran /settlement/start
  startedAt: Date;
  finalizedBy?: mongoose.Types.ObjectId; // ref User — who ran /settlement/finalize
  finalizedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const CstepSettlementPerDiemSchema = new Schema<ICstepSettlementPerDiem>(
  {
    days: { type: Number, default: 0 },
    rate: { type: Number, default: 0 },
    currency: { type: String, default: "INR", uppercase: true },
    amountInr: { type: Number, default: 0 },
    computedDays: { type: Number, default: 0 },
    overrideDays: { type: Number },
    overrideReason: { type: String, trim: true },
  },
  { _id: false },
);

const CstepSettlementBucketsSchema = new Schema<ICstepSettlementBuckets>(
  {
    airRailBus: { type: Number, default: 0 },
    perDiem: { type: Number, default: 0 },
    boardingLodging: { type: Number, default: 0 },
    cab: { type: Number, default: 0 },
    other: { type: Number, default: 0 },
  },
  { _id: false },
);

const CstepSettlementSchema = new Schema<ICstepSettlement>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    requestId: { type: Schema.Types.ObjectId, ref: "CstepTravelRequest", required: true },

    status: { type: String, enum: ["VERIFYING", "FINALIZED"], default: "VERIFYING", required: true, index: true },

    perDiem: { type: CstepSettlementPerDiemSchema, default: () => ({}) },
    buckets: { type: CstepSettlementBucketsSchema, default: () => ({}) },

    totalCostOfTour: { type: Number, default: 0 },
    amountClaimed: { type: Number, default: 0 },
    outcome: { type: String, enum: ["CLOSE", "TO_FINANCE"] },

    startedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    startedAt: { type: Date, required: true },
    finalizedBy: { type: Schema.Types.ObjectId, ref: "User" },
    finalizedAt: { type: Date },
  },
  { timestamps: true },
);

CstepSettlementSchema.index({ workspaceId: 1, requestId: 1 }, { unique: true });

CstepSettlementSchema.plugin(workspaceScopePlugin);

const CstepSettlement: Model<ICstepSettlement> =
  (mongoose.models.CstepSettlement as Model<ICstepSettlement>) ||
  mongoose.model<ICstepSettlement>("CstepSettlement", CstepSettlementSchema);

export default CstepSettlement;
