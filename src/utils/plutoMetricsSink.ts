// apps/backend/src/utils/plutoMetricsSink.ts

import mongoose from "mongoose";
import type { PlutoMetricEvent } from "../types/plutoMetrics.js";
import PlutoMetricEventModel from "../models/PlutoMetricEvent.js";

const METRICS_ENABLED = process.env.PLUTO_METRICS === "true";

/**
 * Durable, tenant-scoped persistence — FIRE-AND-FORGET. Not awaited: a metrics
 * insert failure must NEVER fail (or slow) a request. Requires a valid
 * workspaceId (tenant scope); events without one are still logged but not stored.
 */
function persist(event: PlutoMetricEvent): void {
  const wsid: any = event.workspaceId;
  if (!wsid || !mongoose.Types.ObjectId.isValid(wsid)) return;

  const payload = {
    ...(event.metadata || {}),
    ...(event.reason != null ? { reason: event.reason } : {}),
    ...(event.conversationId != null ? { conversationId: event.conversationId } : {}),
  };

  PlutoMetricEventModel.create({
    type: event.type,
    severity: event.severity ?? "info",
    workspaceId: new mongoose.Types.ObjectId(wsid),
    requestId: event.requestId ?? null,
    payload,
  }).catch((e: any) => console.error("[plutoMetricsSink] persist failed", e?.message));
}

export async function emitMetric(event: PlutoMetricEvent) {
  const severity = event.severity ?? "info";

  // 1) Durable store (fire-and-forget, tenant-scoped).
  persist(event);

  // 2) Console routing (dev/prod visibility). ERROR / WARN severity events are
  // operational signals that must surface regardless of the PLUTO_METRICS flag;
  // INFO events stay gated behind it.
  if (severity === "error") {
    console.error("📊 PLUTO METRIC [error]", JSON.stringify(event));
    return;
  }
  if (severity === "warn") {
    console.warn("📊 PLUTO METRIC [warn]", JSON.stringify(event));
    return;
  }

  if (!METRICS_ENABLED) return;

  console.log("📊 PLUTO METRIC");
  console.log(JSON.stringify(event, null, 2));
}
