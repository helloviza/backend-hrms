// apps/backend/src/utils/plutoMetricsSink.ts

import type { PlutoMetricEvent } from "../types/plutoMetrics.js";

const METRICS_ENABLED = process.env.PLUTO_METRICS === "true";

export async function emitMetric(event: PlutoMetricEvent) {
  const severity = event.severity ?? "info";

  // ERROR / WARN severity events are operational signals, NOT analytics — they
  // must surface regardless of the PLUTO_METRICS flag so failures are visible
  // in logs even when analytics is off.
  if (severity === "error") {
    console.error("📊 PLUTO METRIC [error]", JSON.stringify(event));
    return;
  }
  if (severity === "warn") {
    console.warn("📊 PLUTO METRIC [warn]", JSON.stringify(event));
    return;
  }

  // INFO events stay gated behind the analytics flag (existing behaviour).
  if (!METRICS_ENABLED) return;

  // Replace later with:
  // - DB insert
  // - ClickHouse
  // - BigQuery
  // - Segment / RudderStack

  console.log("📊 PLUTO METRIC");
  console.log(JSON.stringify(event, null, 2));
}