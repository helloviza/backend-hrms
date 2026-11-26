// apps/backend/src/services/sbtManualLinkTrigger.ts
//
// The SBT models' hand-off to services/sbtManualLink.ts (spec §3.1).
//
// The SBTBooking / SBTHotelBooking save hooks and their mirror-resync query
// hooks call queueManualLink(). It NEVER awaits the link in the booking path
// and NEVER throws: the TBO booking is already confirmed when these hooks
// run, so a link failure must not turn into a failed save. The work runs on
// the next tick; failures are recorded on the SBT doc by the service, and the
// sweep (jobs/sbt-manual-link-sweep.ts) retries them.
//
// The service is imported lazily: it imports both SBT models and
// ManualBooking, which import this file — a static import would be a cycle.
import logger from "../utils/logger.js";

export type SbtModelName = "SBTBooking" | "SBTHotelBooking";

const inflight = new Set<Promise<void>>();

export function queueManualLink(model: SbtModelName, idOrDoc: unknown): void {
  const id = String((idOrDoc as any)?._id ?? idOrDoc ?? "");
  if (!id) return;
  const p: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve))
    .then(async () => {
      const svc = await import("./sbtManualLink.js");
      await svc.onSbtBookingWrite(model, id);
    })
    .catch((err: any) => {
      logger.error("[SBT-MANUAL-LINK] hook failed", { model, id, error: err?.message });
    })
    .finally(() => {
      inflight.delete(p);
    });
  inflight.add(p);
}

export function queueManualLinks(model: SbtModelName, ids: unknown[]): void {
  for (const id of ids) queueManualLink(model, id);
}

/** Tests / shutdown: wait until every queued link has finished. */
export async function manualLinksSettled(): Promise<void> {
  while (inflight.size) await Promise.allSettled([...inflight]);
}
