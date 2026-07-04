// apps/backend/src/models/TravelPolicy.ts
//
// Per-workspace travel booking policy for the concierge (Pluto) + SBT flows.
// Standalone (Phase 2): it does NOT read or extend ExpenseBand.
//
// OVERLAP NOTE (deferred): ExpenseBand.maxFlightFarePerPerson /
// maxHotelFarePerNight are per-employee-band caps in the expense module and
// overlap conceptually with maxFlightPriceINR / maxHotelPricePerNightINR here.
// Band-merge (composing ExpenseBand caps into PolicyRules) is DEFERRED to a
// later phase; the evaluator takes a plain PolicyRules interface precisely so
// that merge can happen without touching evaluator logic.

import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export type FareType = "RETAIL" | "CORPORATE";

export interface ITravelPolicy extends Document {
  workspaceId: mongoose.Types.ObjectId;
  // Empty / absent = all fare types allowed.
  allowedFareTypes: FareType[];
  // Nullable = "no cap / not enforced".
  cabinClassCap: number | null;
  maxFlightPriceINR: number | null;
  hotelStarCap: number | null;
  maxHotelPricePerNightINR: number | null;
  approvalAbovePriceINR: number | null;
  requireRefundable: boolean | null;
  allowLCC: boolean | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const TravelPolicySchema = new Schema<ITravelPolicy>(
  {
    // workspaceId is added by workspaceScopePlugin (ObjectId, required, indexed).
    allowedFareTypes: {
      type: [String],
      enum: ["RETAIL", "CORPORATE"],
      default: [],
    },
    cabinClassCap: { type: Number, default: null },
    maxFlightPriceINR: { type: Number, default: null },
    hotelStarCap: { type: Number, default: null },
    maxHotelPricePerNightINR: { type: Number, default: null },
    approvalAbovePriceINR: { type: Number, default: null },
    requireRefundable: { type: Boolean, default: null },
    allowLCC: { type: Boolean, default: null },
    active: { type: Boolean, default: true, index: true },
  },
  { timestamps: true },
);

TravelPolicySchema.plugin(workspaceScopePlugin);

const TravelPolicy =
  (mongoose.models.TravelPolicy as mongoose.Model<ITravelPolicy>) ||
  mongoose.model<ITravelPolicy>("TravelPolicy", TravelPolicySchema);

export default TravelPolicy;
