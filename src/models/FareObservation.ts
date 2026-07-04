// apps/backend/src/models/FareObservation.ts
//
// Passive, append-only time series of the flight fares we SHOW (chat + hardened
// search). The long-term substrate for route intelligence (Phase 3 "Know").
// Workspace-scoped; kept 180 days via a TTL index on observedAt.

import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export interface IFareObservation extends Document {
  workspaceId: mongoose.Types.ObjectId;
  origin: string;
  destination: string;
  departDate: string; // YYYY-MM-DD as searched
  cabinClass: number | null;
  airline: string;
  flightNo: string;
  fareINR: number;
  fareType: string; // RETAIL | CORPORATE
  isLCC: boolean;
  isRefundable: boolean;
  observedAt: Date;
  source: string; // "TBO_SEARCH"
}

const FareObservationSchema = new Schema<IFareObservation>({
  // workspaceId added by workspaceScopePlugin (ObjectId, required, indexed).
  origin: { type: String, required: true },
  destination: { type: String, required: true },
  departDate: { type: String, required: true },
  cabinClass: { type: Number, default: null },
  airline: { type: String, default: "" },
  flightNo: { type: String, default: "" },
  fareINR: { type: Number, required: true },
  fareType: { type: String, default: "RETAIL" },
  isLCC: { type: Boolean, default: false },
  isRefundable: { type: Boolean, default: false },
  observedAt: { type: Date, default: Date.now },
  source: { type: String, default: "TBO_SEARCH" },
});

FareObservationSchema.plugin(workspaceScopePlugin);

// Route-history read path (Step 2 aggregates by route + recency).
FareObservationSchema.index({ origin: 1, destination: 1, departDate: 1, observedAt: -1 });
// Workspace-scoped recency read (Step 2 scopes to the requesting workspace).
FareObservationSchema.index({ workspaceId: 1, origin: 1, destination: 1, observedAt: -1 });
// Retention: 180 days.
FareObservationSchema.index({ observedAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

const FareObservation =
  (mongoose.models.FareObservation as mongoose.Model<IFareObservation>) ||
  mongoose.model<IFareObservation>("FareObservation", FareObservationSchema);

export default FareObservation;
