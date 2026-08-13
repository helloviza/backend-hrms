// apps/backend/src/models/cstep/CstepSettlementLine.ts
import mongoose, { Schema, type Document, type Model } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";
import { CSTEP_SERVICE_TYPES, type CstepServiceType } from "./CstepArrangement.js";

/**
 * CstepSettlementLine
 * --------------------
 * CSTEP Travel & Claim Portal — Step 5, one verifiable expense row under a
 * CstepSettlement. Seeded ONCE at /settlement/start from two streams — see
 * routes/cstep.ts's buildSeedSettlementLines — and never overwrites the
 * source records:
 *   - "ARRANGEMENT": every Step 3 CstepArrangement row for this request
 *     (CSTEP arranged and paid for these) — classification defaults
 *     "OFFICIAL".
 *   - "REPORT_LEG": every Step 4 CstepReportLeg marked Self-paid
 *     (classification "PERSONAL", reimbursable), plus any CSTEP-paid leg
 *     the traveller added themselves during reporting (source "ADDED" —
 *     legs seeded from an arrangement are already represented via that
 *     arrangement's own line above, so they are not seeded again here to
 *     avoid double-counting; classification "OFFICIAL").
 *
 * classification starts from the seed above (Paid-By) and can be flipped by
 * the Official (classificationOverridden + classificationOverrideReason,
 * reason mandatory on override) — see PATCH /settlement/lines/:lineId.
 *
 * Tenant isolation reuses the standard workspaceScopePlugin, same as every
 * other CSTEP model.
 */

export type CstepSettlementLineSource = "ARRANGEMENT" | "REPORT_LEG";
export type CstepSettlementLineClassification = "OFFICIAL" | "PERSONAL";

export interface ICstepSettlementLine extends Document {
  workspaceId: mongoose.Types.ObjectId;
  settlementId: mongoose.Types.ObjectId; // ref CstepSettlement
  requestId: mongoose.Types.ObjectId; // ref CstepTravelRequest

  source: CstepSettlementLineSource;
  sourceId: mongoose.Types.ObjectId; // polymorphic — CstepArrangement._id or CstepReportLeg._id per `source`

  description?: string;
  mode: CstepServiceType; // maps to a bucket — see SETTLEMENT_BUCKET_BY_MODE in routes/cstep.ts
  amountInr: number; // Official-confirmed/corrected amount — starts as the source record's own amount

  classification: CstepSettlementLineClassification;
  classificationOverridden: boolean;
  classificationOverrideReason?: string;

  verified: boolean;
  attachmentId?: mongoose.Types.ObjectId; // ref CstepAttachment — carried over from the source report leg, if any; ARRANGEMENT-sourced lines have none

  createdBy: mongoose.Types.ObjectId; // ref User — who ran /settlement/start (the seeding action)
  verifiedBy?: mongoose.Types.ObjectId; // ref User
  verifiedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const CstepSettlementLineSchema = new Schema<ICstepSettlementLine>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    settlementId: { type: Schema.Types.ObjectId, ref: "CstepSettlement", required: true, index: true },
    requestId: { type: Schema.Types.ObjectId, ref: "CstepTravelRequest", required: true, index: true },

    source: { type: String, enum: ["ARRANGEMENT", "REPORT_LEG"], required: true },
    sourceId: { type: Schema.Types.ObjectId, required: true },

    description: { type: String, trim: true },
    mode: { type: String, enum: CSTEP_SERVICE_TYPES, required: true },
    amountInr: { type: Number, default: 0 },

    classification: { type: String, enum: ["OFFICIAL", "PERSONAL"], required: true },
    classificationOverridden: { type: Boolean, default: false },
    classificationOverrideReason: { type: String, trim: true },

    verified: { type: Boolean, default: false },
    attachmentId: { type: Schema.Types.ObjectId, ref: "CstepAttachment" },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    verifiedBy: { type: Schema.Types.ObjectId, ref: "User" },
    verifiedAt: { type: Date },
  },
  { timestamps: true },
);

CstepSettlementLineSchema.plugin(workspaceScopePlugin);

const CstepSettlementLine: Model<ICstepSettlementLine> =
  (mongoose.models.CstepSettlementLine as Model<ICstepSettlementLine>) ||
  mongoose.model<ICstepSettlementLine>("CstepSettlementLine", CstepSettlementLineSchema);

export default CstepSettlementLine;
