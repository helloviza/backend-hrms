// apps/backend/src/models/TripAlert.ts
//
// A single disruption alert raised for a TripWatch. Workspace-scoped.

import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export interface ITripAlert extends Document {
  workspaceId: mongoose.Types.ObjectId;
  tripWatchId: mongoose.Types.ObjectId;
  kind: "CANCELLED" | "DELAY" | "GATE_CHANGE" | "TERMINAL_CHANGE" | "WEATHER";
  detail: string;
  createdAt: Date;
  deliveredAt?: Date | null;
  deliveryStatus: "PENDING" | "SENT" | "FAILED";
  channelUsed?: string | null;
  attempts: number;
}

const TripAlertSchema = new Schema<ITripAlert>({
  // workspaceId added by workspaceScopePlugin.
  tripWatchId: { type: Schema.Types.ObjectId, ref: "TripWatch", required: true, index: true },
  kind: {
    type: String,
    enum: ["CANCELLED", "DELAY", "GATE_CHANGE", "TERMINAL_CHANGE", "WEATHER"],
    required: true,
  },
  detail: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
  deliveredAt: { type: Date, default: null },
  deliveryStatus: { type: String, enum: ["PENDING", "SENT", "FAILED"], default: "PENDING", index: true },
  channelUsed: { type: String, default: null },
  attempts: { type: Number, default: 0 },
});

TripAlertSchema.plugin(workspaceScopePlugin);

const TripAlert =
  (mongoose.models.TripAlert as mongoose.Model<ITripAlert>) ||
  mongoose.model<ITripAlert>("TripAlert", TripAlertSchema);

export default TripAlert;
