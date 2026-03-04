// apps/backend/src/utils/plutoMetricsSink.ts

import type { PlutoMetricEvent } from "../types/plutoMetrics.js";

const METRICS_ENABLED = process.env.PLUTO_METRICS === "true";

export async function emitMetric(event: PlutoMetricEvent) {
  if (!METRICS_ENABLED) return;

  // Replace later with:
  // - DB insert
  // - ClickHouse
  // - BigQuery
  // - Segment / RudderStack

  console.log("📊 PLUTO METRIC");
  console.log(JSON.stringify(event, null, 2));
}