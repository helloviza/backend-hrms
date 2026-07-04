// apps/backend/src/models/PlutoMetricEvent.ts
//
// Durable, workspace-scoped store for Pluto metric events. Self-prunes after
// 90 days via a TTL index on createdAt.

import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export interface IPlutoMetricEvent extends Document {
  type: string;
  severity: string;
  workspaceId: mongoose.Types.ObjectId;
  requestId?: string | null;
  payload?: Record<string, any>;
  createdAt: Date;
}

const PlutoMetricEventSchema = new Schema<IPlutoMetricEvent>({
  // workspaceId added by workspaceScopePlugin (ObjectId, required, indexed).
  type: { type: String, required: true, index: true },
  severity: { type: String, default: "info" },
  requestId: { type: String, default: null },
  payload: { type: Object, default: {} },
  createdAt: { type: Date, default: Date.now },
});

PlutoMetricEventSchema.plugin(workspaceScopePlugin);

// TTL: metric events are ephemeral operational telemetry — prune after 90 days.
PlutoMetricEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const PlutoMetricEvent =
  (mongoose.models.PlutoMetricEvent as mongoose.Model<IPlutoMetricEvent>) ||
  mongoose.model<IPlutoMetricEvent>("PlutoMetricEvent", PlutoMetricEventSchema);

export default PlutoMetricEvent;
