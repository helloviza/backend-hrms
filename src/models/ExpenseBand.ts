// apps/backend/src/models/ExpenseBand.ts
//
// OVERLAP NOTE (deferred): maxFlightFarePerPerson / maxHotelFarePerNight here
// are per-employee-band caps owned by the expense module. They overlap
// conceptually with TravelPolicy.maxFlightPriceINR / maxHotelPricePerNightINR
// (per-workspace travel policy). Composing band caps into the travel
// PolicyRules is DEFERRED to a later phase; neither model reads the other yet.
import mongoose, { Schema, type Document } from "mongoose";

/**
 * RANK ROW (approval-engine sub-step 3, 2026-09-16). One row per rank 1–10 per
 * workspace. `bandNumber` is the employee RANK (L1–L10, = User.bandNumber),
 * `bandName` is the company's display LABEL for it ("L6 = Team Lead"), and
 * `defaultApprovalLimitBase` is the DEFAULT approval limit for everyone of
 * that rank, in the workspace base currency (config.baseCurrency). null / 0
 * = "this rank does not approve by default" — and the table ships EMPTY: no
 * defaults exist until the company sets them, so nothing routes on rank
 * until then. A person's EFFECTIVE limit is max(rank default, personal grant
 * limit) — services/expenseAuthority.service.ts owns that rule.
 * The travel caps below are the older use of the same row (behind
 * config.features.expenseBandEnabled); untouched.
 */
export interface IExpenseBand extends Document {
  workspaceId: mongoose.Types.ObjectId;
  bandNumber: number;
  bandName: string;
  defaultApprovalLimitBase?: number | null;
  maxFlightFarePerPerson: number;
  maxHotelFarePerNight: number;
  currency: string;
  createdAt: Date;
  updatedAt: Date;
}

const ExpenseBandSchema = new Schema<IExpenseBand>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "CustomerWorkspace",
      required: true,
    },
    bandNumber: {
      type: Number,
      required: true,
      min: 1,
      max: 10,
    },
    bandName: { type: String, default: "" },
    defaultApprovalLimitBase: { type: Number, default: null, min: 0 },
    maxFlightFarePerPerson: { type: Number, default: 0 },
    maxHotelFarePerNight: { type: Number, default: 0 },
    currency: { type: String, default: "INR" },
  },
  { timestamps: true },
);

ExpenseBandSchema.index({ workspaceId: 1, bandNumber: 1 }, { unique: true });

const ExpenseBand =
  (mongoose.models.ExpenseBand as mongoose.Model<IExpenseBand>) ||
  mongoose.model<IExpenseBand>("ExpenseBand", ExpenseBandSchema);

export default ExpenseBand;
