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

// CLAIM_LINE (claims addition): seeded at a claim's approval from the claim's
// own lines — sourceId is the travelLines/foodLines subdocument _id, or the
// request's own _id for its single "Other expenses" line.
export type CstepSettlementLineSource = "ARRANGEMENT" | "REPORT_LEG" | "CLAIM_LINE";
export type CstepSettlementLineClassification = "OFFICIAL" | "PERSONAL";

export interface ICstepSettlementLine extends Document {
  workspaceId: mongoose.Types.ObjectId;
  settlementId: mongoose.Types.ObjectId; // ref CstepSettlement
  requestId: mongoose.Types.ObjectId; // ref CstepTravelRequest

  source: CstepSettlementLineSource;
  sourceId: mongoose.Types.ObjectId; // polymorphic — CstepArrangement._id, CstepReportLeg._id or a claim line's _id per `source`

  description?: string;
  mode: CstepServiceType; // maps to a bucket — see SETTLEMENT_BUCKET_BY_MODE in routes/cstep.ts
  amountInr: number; // Official-confirmed/corrected amount — starts as the source record's own amount
  /** The ceiling for reductions: amountInr as seeded (the figure the line
   * arrived with). amountInr may go down from it, with a reason, never above
   * it. Absent on lines seeded before reduce-only — PATCH /settlement/lines
   * then takes the current amount as the ceiling and stores it. */
  claimedAmountInr?: number;

  classification: CstepSettlementLineClassification;
  classificationOverridden: boolean;
  classificationOverrideReason?: string;

  verified: boolean;
  attachmentId?: mongoose.Types.ObjectId; // ref CstepAttachment — carried over from the source report leg, if any; an ARRANGEMENT-sourced line carries the document of the SEEDED CSTEP-paid leg that mirrors it (paired at seed time by order + travelMode)

  createdBy: mongoose.Types.ObjectId; // ref User — who ran /settlement/start (the seeding action)
  verifiedBy?: mongoose.Types.ObjectId; // ref User
  verifiedAt?: Date;

  /** Finance-c — disallowed by Finance while the case was with it: amountInr
   * went to 0 from financeRejectedFromInr, with the reason, who and when. */
  financeRejected?: boolean;
  financeRejectedFromInr?: number;
  financeRejectedReason?: string;
  financeRejectedBy?: mongoose.Types.ObjectId; // ref User
  financeRejectedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const CstepSettlementLineSchema = new Schema<ICstepSettlementLine>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    settlementId: { type: Schema.Types.ObjectId, ref: "CstepSettlement", required: true, index: true },
    requestId: { type: Schema.Types.ObjectId, ref: "CstepTravelRequest", required: true, index: true },

    source: { type: String, enum: ["ARRANGEMENT", "REPORT_LEG", "CLAIM_LINE"], required: true },
    sourceId: { type: Schema.Types.ObjectId, required: true },

    description: { type: String, trim: true },
    mode: { type: String, enum: CSTEP_SERVICE_TYPES, required: true },
    amountInr: { type: Number, default: 0 },
    claimedAmountInr: { type: Number },

    classification: { type: String, enum: ["OFFICIAL", "PERSONAL"], required: true },
    classificationOverridden: { type: Boolean, default: false },
    classificationOverrideReason: { type: String, trim: true },

    verified: { type: Boolean, default: false },
    attachmentId: { type: Schema.Types.ObjectId, ref: "CstepAttachment" },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    verifiedBy: { type: Schema.Types.ObjectId, ref: "User" },
    verifiedAt: { type: Date },

    financeRejected: { type: Boolean },
    financeRejectedFromInr: { type: Number },
    financeRejectedReason: { type: String, trim: true },
    financeRejectedBy: { type: Schema.Types.ObjectId, ref: "User" },
    financeRejectedAt: { type: Date },
  },
  { timestamps: true },
);

CstepSettlementLineSchema.plugin(workspaceScopePlugin);

const CstepSettlementLine: Model<ICstepSettlementLine> =
  (mongoose.models.CstepSettlementLine as Model<ICstepSettlementLine>) ||
  mongoose.model<ICstepSettlementLine>("CstepSettlementLine", CstepSettlementLineSchema);

export default CstepSettlementLine;
