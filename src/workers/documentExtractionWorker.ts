// apps/backend/src/workers/documentExtractionWorker.ts
import {
  claimNextPending,
  reclaimStaleProcessing,
  runExtraction,
} from "../services/documentExtraction.service.js";
import logger from "../utils/logger.js";

/**
 * Background sweep for the ExtractedDocument master table.
 *
 * Runs on the primary backend only — workers/index.ts is called from
 * server.ts behind `if (!IS_WA_HOST)`, so the dedicated WhatsApp host never
 * starts this. Multiple App Runner instances of the primary backend DO run it
 * concurrently, which is fine and intended: claimNextPending() is a single
 * atomic findOneAndUpdate, so two instances can never claim the same row. The
 * `isRunning` guard below is only about not double-registering the interval
 * inside one process; it provides no cross-instance safety and isn't meant to.
 *
 * Concurrency is deliberately small. Each slot holds a whole file in memory
 * and an in-flight model call, and the queue is fed by human upload rate, not
 * by a firehose — three at a time drains a realistic backlog quickly without
 * giving the container a reason to page.
 */

const POLL_INTERVAL_MS = 60_000; // ~60s sweep
const CONCURRENCY = 3;
const MAX_PER_TICK = 12; // ceiling on one tick's work, so a large backlog is drained across ticks rather than in one long tick

let isRunning = false;
let tickInFlight = false;

/**
 * One worker slot: keep claiming and running until the queue is empty or this
 * tick's share of the budget is spent. Returns how many rows it processed.
 */
async function drainSlot(budget: { left: number }): Promise<number> {
  let processed = 0;
  while (budget.left > 0) {
    budget.left -= 1;
    const doc = await claimNextPending();
    if (!doc) break; // queue drained
    await runExtraction(doc); // never throws; records its own outcome
    processed += 1;
  }
  return processed;
}

export async function runDocumentExtractionTick(): Promise<number> {
  const reclaimed = await reclaimStaleProcessing();
  if (reclaimed > 0) {
    logger.warn("[DocExtraction] reclaimed stalled rows", { count: reclaimed });
  }

  const budget = { left: MAX_PER_TICK };
  const counts = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => drainSlot(budget)),
  );
  return counts.reduce((a, b) => a + b, 0);
}

export function startDocumentExtractionWorker() {
  if (isRunning) return;
  isRunning = true;

  logger.info("📄 Document extraction worker started");

  setInterval(async () => {
    // A tick that runs long (slow model, big backlog) must not overlap the
    // next one — the claim is safe either way, but overlapping ticks would
    // quietly multiply the effective concurrency.
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      await runDocumentExtractionTick();
    } catch (err) {
      logger.error("[DocExtraction] worker tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      tickInFlight = false;
    }
  }, POLL_INTERVAL_MS);
}
