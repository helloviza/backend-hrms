// apps/backend/src/bootstrap/ensurePlutoIndexes.ts
//
// Deploy readiness — deterministically build the Pluto models' indexes at boot
// (after connectDb, before traffic). Mongoose autoIndex is on by default, but it
// is async + unawaited, so there is a boot window where a correctness-critical
// index (the unique {workspaceId, conversationId} on PlutoConversation that the
// handoff dedup + tenant-scope guards depend on) may not exist yet. This runs an
// AWAITED createIndexes() per model — idempotent, never drops other indexes.
//
// LOG-AND-CONTINUE: an index build failure logs a LOUD warning and continues;
// it never crashes boot (a missing index degrades correctness, not availability,
// and can be built manually — see DEPLOY_CHECKLIST_PLUTO.md).

import PlutoConversation from "../models/PlutoConversation.js";
import Itinerary from "../models/Itinerary.js";
import TripWatch from "../models/TripWatch.js";
import TripAlert from "../models/TripAlert.js";
import ArrivalSession from "../models/ArrivalSession.js";
import FareObservation from "../models/FareObservation.js";
import PlutoMetricEvent from "../models/PlutoMetricEvent.js";
import TravelPolicy from "../models/TravelPolicy.js";

const PLUTO_MODELS: Array<[string, any]> = [
  ["PlutoConversation", PlutoConversation], // unique {workspaceId,conversationId} — dedup + leak guard
  ["Itinerary", Itinerary],
  ["TripWatch", TripWatch],
  ["TripAlert", TripAlert],
  ["ArrivalSession", ArrivalSession], // unique tripWatchId — arrival idempotency
  ["FareObservation", FareObservation],
  ["PlutoMetricEvent", PlutoMetricEvent],
  ["TravelPolicy", TravelPolicy],
];

/**
 * Build every Pluto model's schema-defined indexes. Resolves even if some builds
 * fail (each is isolated + logged). Returns the list of models that failed.
 */
export async function ensurePlutoIndexes(
  models: Array<[string, any]> = PLUTO_MODELS,
  log: Pick<Console, "warn" | "log"> = console,
): Promise<{ ok: string[]; failed: string[] }> {
  const ok: string[] = [];
  const failed: string[] = [];
  for (const [name, model] of models) {
    try {
      await model.createIndexes(); // idempotent; creates missing, never drops
      ok.push(name);
    } catch (e: any) {
      failed.push(name);
      log.warn(
        `[PLUTO INDEXES] ⚠ createIndexes FAILED for ${name} — correctness guards (dedup/tenant-scope) may be missing until built manually: ${e?.message || e}`,
      );
    }
  }
  log.log(`[PLUTO INDEXES] ensured ${ok.length}/${models.length} model index sets${failed.length ? ` (failed: ${failed.join(", ")})` : ""}.`);
  return { ok, failed };
}
