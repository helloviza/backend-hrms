// apps/backend/src/services/fareObservations.ts
//
// Passive fare logging. FIRE-AND-FORGET: recordFareObservations returns
// immediately; the bulk insert is not awaited and its failure only emits a
// metric — a logging failure must NEVER slow or fail a flight search.

import FareObservation from "../models/FareObservation.js";
import { deriveFareType } from "./policyEvaluator.js";
import { emitMetric } from "../utils/plutoMetricsSink.js";
import { fareObsWriteFailed } from "../utils/plutoMetricsBuilder.js";

const MAX_ROWS_PER_SEARCH = 30;

export interface RecordFareArgs {
  workspaceObjectId: any;
  origin: string;
  destination: string;
  departDate: string;
  requestId?: string;
  /** Raw TBO Result rows (already deduped + capped by the caller is fine). */
  rawRows: any[];
}

/**
 * Build up to 30 observation docs from raw TBO rows and bulk-insert them
 * fire-and-forget. No-op when there is no workspace scope or no usable rows.
 */
export function recordFareObservations(args: RecordFareArgs): void {
  const { workspaceObjectId, origin, destination, departDate, requestId, rawRows } = args;
  if (!workspaceObjectId || !Array.isArray(rawRows) || rawRows.length === 0) return;

  const docs: any[] = [];
  for (const r of rawRows.slice(0, MAX_ROWS_PER_SEARCH)) {
    const seg = r?.Segments?.[0]?.[0];
    const fareINR = r?.Fare?.OfferedFare ?? r?.Fare?.PublishedFare ?? r?.Fare?.TotalFare;
    if (typeof fareINR !== "number" || fareINR <= 0) continue;
    const airlineCode = seg?.Airline?.AirlineCode ?? "";
    docs.push({
      workspaceId: workspaceObjectId,
      origin,
      destination,
      departDate,
      cabinClass: seg?.CabinClass ?? null,
      airline: airlineCode,
      flightNo: `${airlineCode}-${seg?.Airline?.FlightNumber ?? ""}`,
      fareINR,
      fareType: deriveFareType(r),
      isLCC: r?.IsLCC === true,
      isRefundable: r?.IsRefundable === true,
      observedAt: new Date(),
      source: "TBO_SEARCH",
    });
  }
  if (docs.length === 0) return;

  // Fire-and-forget: NOT awaited. ordered:false so one bad row can't drop the batch.
  FareObservation.insertMany(docs, { ordered: false }).catch((e: any) => {
    void emitMetric(
      fareObsWriteFailed({
        workspaceId: String(workspaceObjectId),
        requestId,
        reason: e?.message || "insert_failed",
      }),
    );
  });
}
