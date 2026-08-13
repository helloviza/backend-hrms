// apps/backend/src/models/cstep/CstepReportLeg.ts
import mongoose, { Schema, type Document, type Model } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";
import { CSTEP_SERVICE_TYPES, type CstepServiceType } from "./CstepArrangement.js";

/**
 * CstepReportLeg
 * --------------
 * CSTEP Travel & Claim Portal — Step 4 (Travel Report). One row per leg of
 * the traveller's actual post-trip itinerary, in either the Onward or
 * Return journey table. A SEPARATE record from CstepArrangement (Step 3) —
 * the Official's arrangement rows are never overwritten; this model only
 * ever ADDS rows alongside them, seeded from them once when the traveller
 * starts their report.
 *
 * source:
 *   - "SEEDED": pre-created from the Step 3 CstepArrangement rows when the
 *     traveller starts their report (POST /requests/:id/report/start) —
 *     travelMode/fare/currency carry over the arranged type/amount, paidBy
 *     defaults to "CSTEP" (the Official arranged and paid for these). The
 *     traveller can still edit every field afterwards.
 *   - "ADDED": created directly by the traveller for a leg not covered by
 *     Step 3 (a self-booked cab, an extra hotel night, the return journey
 *     entirely, etc).
 *
 * Tenant isolation reuses the standard workspaceScopePlugin, same as every
 * other CSTEP model.
 */

export type CstepReportDirection = "ONWARD" | "RETURN";
export type CstepReportPaidBy = "CSTEP" | "SELF";
export type CstepReportLegSource = "SEEDED" | "ADDED";

export interface ICstepReportLeg extends Document {
  workspaceId: mongoose.Types.ObjectId;
  requestId: mongoose.Types.ObjectId; // ref CstepTravelRequest

  direction: CstepReportDirection;

  fromLocation?: string;
  fromDate?: string; // "YYYY-MM-DD"
  toLocation?: string;
  toDate?: string; // "YYYY-MM-DD"

  travelMode: CstepServiceType; // same pick-list as CstepArrangement.arrangedType

  fare?: number;
  currency: string; // ISO 3-letter code, default "INR" — no live-rate/FX freeze here, unlike Step 3's Amount column; this is a plain reported figure
  paidBy: CstepReportPaidBy; // "Booked by CSTEP" / "Self Paid, Receipt Attached"

  remarks?: string;

  attachmentId?: mongoose.Types.ObjectId; // ref CstepAttachment — the per-row uploaded receipt/boarding pass, optional
  source: CstepReportLegSource;

  createdBy: mongoose.Types.ObjectId; // ref User — the traveller (or whoever is filing on their behalf)

  createdAt: Date;
  updatedAt: Date;
}

const CstepReportLegSchema = new Schema<ICstepReportLeg>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    requestId: { type: Schema.Types.ObjectId, ref: "CstepTravelRequest", required: true, index: true },

    direction: { type: String, enum: ["ONWARD", "RETURN"], required: true },

    fromLocation: { type: String, trim: true },
    fromDate: { type: String },
    toLocation: { type: String, trim: true },
    toDate: { type: String },

    travelMode: { type: String, enum: CSTEP_SERVICE_TYPES, required: true },

    fare: { type: Number },
    currency: { type: String, trim: true, uppercase: true, default: "INR" },
    paidBy: { type: String, enum: ["CSTEP", "SELF"], required: true, default: "SELF" },

    remarks: { type: String, trim: true },

    attachmentId: { type: Schema.Types.ObjectId, ref: "CstepAttachment" },
    source: { type: String, enum: ["SEEDED", "ADDED"], required: true },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

CstepReportLegSchema.plugin(workspaceScopePlugin);

const CstepReportLeg: Model<ICstepReportLeg> =
  (mongoose.models.CstepReportLeg as Model<ICstepReportLeg>) ||
  mongoose.model<ICstepReportLeg>("CstepReportLeg", CstepReportLegSchema);

export default CstepReportLeg;
