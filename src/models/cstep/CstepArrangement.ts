// apps/backend/src/models/cstep/CstepArrangement.ts
import mongoose, { Schema, type Document, type Model } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepArrangement
 * ----------------
 * CSTEP Travel & Claim Portal — Step 3 (arrangement stage). One row per
 * service the Official user (Travel Administrator) arranges against an
 * APPROVED request, while that request is ARRANGING. A SEPARATE record
 * from CstepTravelRequest — the traveller's original request is NEVER
 * overwritten; this model only ever ADDS rows alongside it.
 *
 * source:
 *   - "REQUESTED": seeded from the traveller's own form fields when the
 *     Official first opens the request for arranging (see routes/cstep.ts's
 *     POST /requests/:id/start-arranging) — requestedType is set, and
 *     arrangedType defaults to the same value (the Official can still pick
 *     a different arrangedType, e.g. Flight requested but Train arranged;
 *     requestedType is never changed after seeding — only what's shown
 *     alongside it, arrangedType, can differ).
 *   - "ADDED": created directly by the Official for something not on the
 *     traveller's original form (Forex, Stationery, etc.) — requestedType
 *     is never set for these.
 *
 * Tenant isolation reuses the standard workspaceScopePlugin, same as every
 * other CSTEP model.
 */

export const CSTEP_SERVICE_TYPES = [
  "FLIGHT",
  "HOTEL",
  "CAB",
  "TRAIN",
  "BUS",
  "VISA",
  "FOREX",
  "STATIONERY",
  "OTHER",
] as const;
export type CstepServiceType = (typeof CSTEP_SERVICE_TYPES)[number];

export type CstepArrangementSource = "REQUESTED" | "ADDED";
export type CstepArrangementStatus = "PENDING" | "ARRANGED";

// Amount + currency addition — LIVE exchange-rate pre-fill, manual
// override, frozen INR. "LIVE" | "MANUAL" record which one actually
// produced the stored exchangeRate; null/absent means no rate has been set
// yet (or currency is INR, where a rate isn't meaningful — see routes/
// cstep.ts's computeArrangementAmountFields, which forces rate=1 there).
export type CstepRateSource = "LIVE" | "MANUAL";

export interface ICstepArrangement extends Document {
  workspaceId: mongoose.Types.ObjectId;
  requestId: mongoose.Types.ObjectId; // ref CstepTravelRequest

  source: CstepArrangementSource;
  requestedType?: CstepServiceType; // set only for source: "REQUESTED" — never edited after seeding
  arrangedType: CstepServiceType; // what the Official actually arranged; may differ from requestedType
  details?: string; // free-text, manual entry

  // Amount + currency (additive, all optional — a row with no amount saves
  // fine). exchangeRate is INR per 1 unit of `currency` (always 1 for
  // INR). amountInr is FROZEN at write time (amount × exchangeRate,
  // computed once by routes/cstep.ts's PATCH/POST handlers) — it is never
  // recomputed on read, even if live rates move later. Feeds the Step 5
  // official-paid settlement later (not built yet).
  currency?: string; // ISO 3-letter code, default "INR"
  amount?: number;
  exchangeRate?: number; // INR per 1 unit of `currency`; 1 for INR
  rateDate?: string; // "YYYY-MM-DD" — date the rate is as-of (live fetch date, or entry date for manual)
  amountInr?: number; // frozen = amount × exchangeRate
  rateSource?: CstepRateSource;

  status: CstepArrangementStatus;

  createdBy: mongoose.Types.ObjectId; // ref User — who created this row (seeding, or the Official who added it)
  arrangedBy?: mongoose.Types.ObjectId; // ref User — who last marked it ARRANGED
  arrangedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const CstepArrangementSchema = new Schema<ICstepArrangement>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    requestId: { type: Schema.Types.ObjectId, ref: "CstepTravelRequest", required: true, index: true },

    source: { type: String, enum: ["REQUESTED", "ADDED"], required: true },
    requestedType: { type: String, enum: CSTEP_SERVICE_TYPES },
    arrangedType: { type: String, enum: CSTEP_SERVICE_TYPES, required: true },
    details: { type: String, trim: true },

    currency: { type: String, trim: true, uppercase: true, default: "INR" },
    amount: { type: Number },
    exchangeRate: { type: Number },
    rateDate: { type: String },
    amountInr: { type: Number },
    rateSource: { type: String, enum: ["LIVE", "MANUAL"] },

    status: { type: String, enum: ["PENDING", "ARRANGED"], default: "PENDING", index: true },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    arrangedBy: { type: Schema.Types.ObjectId, ref: "User" },
    arrangedAt: { type: Date },
  },
  { timestamps: true },
);

CstepArrangementSchema.plugin(workspaceScopePlugin);

const CstepArrangement: Model<ICstepArrangement> =
  (mongoose.models.CstepArrangement as Model<ICstepArrangement>) ||
  mongoose.model<ICstepArrangement>("CstepArrangement", CstepArrangementSchema);

export default CstepArrangement;
