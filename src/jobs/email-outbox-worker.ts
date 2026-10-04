// Email outbox retry worker — every minute (services/emailOutbox.ts):
// approval-flow emails whose first send failed are tried again (2 min, then
// 10 min later); after the last failed try the row is FAILED, listed for staff
// and alerted to the ops desk.
import cron from "node-cron";
import logger from "../utils/logger.js";
import { processOutbox } from "../services/emailOutbox.js";

// Prevents overlapping passes if a tick runs slower than the interval.
let running = false;

export async function runEmailOutboxWorker(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const r = await processOutbox();
    if (r.tried) logger.info("[EmailOutbox] retry pass", r);
  } catch (err: any) {
    logger.error("[EmailOutbox] retry pass failed", { error: err?.message });
  } finally {
    running = false;
  }
}

export function startEmailOutboxWorker(): void {
  cron.schedule("* * * * *", () => { void runEmailOutboxWorker(); });
  logger.info("[EmailOutbox] Retry worker scheduled — every minute (3 tries, then FAILED + desk alert)");
}
