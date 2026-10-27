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
  /** The fare as the traveller submitted it — stamped at every report
   * submit. The Manager may reduce fare from it (with a reason) while the
   * report awaits their approval, never raise it above. */
  claimedFare?: number;
  currency: string; // ISO 3-letter code, default "INR" — no live-rate/FX freeze here, unlike Step 3's Amount column; this is a plain reported figure
  paidBy: CstepReportPaidBy; // "Booked by CSTEP" / "Self Paid, Receipt Attached"

  remarks?: string;

  attachmentId?: mongoose.Types.ObjectId; // ref CstepAttachment — the per-row uploaded receipt/boarding pass, optional
  /** "No bill available" — the traveller has no document for this leg. It
   * passes report/submit without one and is listed on the self-declaration
   * (claimDeclarationItems). Never set alongside an attachmentId. */
  noBill?: boolean;
  source: CstepReportLegSource;

  /** P1 — the booked service (CstepArrangement) this leg was seeded from, or
   * restored from by "+ Add back". Set ⇒ a booked (linked) leg: the Travel
   * Desk's booking document on that arrangement covers it, its
   * travelMode/fare/currency/paidBy are locked, and the traveller adds only
   * travel proof (a boarding pass for a flight). Absent on a leg the
   * traveller added and on every leg seeded before P1 — those keep the
   * attach-a-bill-or-tick-no-bill rule. */
  arrangementId?: mongoose.Types.ObjectId; // ref CstepArrangement
  /** P1 — a linked FLIGHT leg's boarding pass(es), ref CstepAttachment
   * (BOARDING_PASS) — several for a return or connecting flight. */
  boardingPassAttachmentIds?: mongoose.Types.ObjectId[];
  /** P1 — a linked FLIGHT leg ticked "Boarding pass not available": passes
   * report/submit without one and is listed on the self-declaration. Never
   * set alongside a boarding pass. */
  boardingPassUnavailable?: boolean;
  /** P1 — a linked TRAIN / BUS leg's optional travel proof, ref CstepAttachment. */
  travelProofAttachmentIds?: mongoose.Types.ObjectId[];

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
    claimedFare: { type: Number },
    currency: { type: String, trim: true, uppercase: true, default: "INR" },
    paidBy: { type: String, enum: ["CSTEP", "SELF"], required: true, default: "SELF" },

    remarks: { type: String, trim: true },

    attachmentId: { type: Schema.Types.ObjectId, ref: "CstepAttachment" },
    noBill: { type: Boolean, default: false },
    source: { type: String, enum: ["SEEDED", "ADDED"], required: true },

    arrangementId: { type: Schema.Types.ObjectId, ref: "CstepArrangement" },
    boardingPassAttachmentIds: { type: [{ type: Schema.Types.ObjectId, ref: "CstepAttachment" }], default: undefined },
    boardingPassUnavailable: { type: Boolean },
    travelProofAttachmentIds: { type: [{ type: Schema.Types.ObjectId, ref: "CstepAttachment" }], default: undefined },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

CstepReportLegSchema.plugin(workspaceScopePlugin);

const CstepReportLeg: Model<ICstepReportLeg> =
  (mongoose.models.CstepReportLeg as Model<ICstepReportLeg>) ||
  mongoose.model<ICstepReportLeg>("CstepReportLeg", CstepReportLegSchema);

export default CstepReportLeg;
