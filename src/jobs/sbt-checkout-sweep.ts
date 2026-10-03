// SBT checkout backstop — every 5 minutes (services/sbtFulfil.ts sweepCheckouts):
//  - a checkout PAID for 20 minutes but never booked (browser closed and the
//    webhook lost, or a changed cancellation policy never answered) is refunded
//    automatically and ops@ is told;
//  - a checkout stuck mid-booking for 20 minutes (process restart) is flagged
//    NEEDS_OPS and ops@ is told — never refunded blind, the ticket may exist.
import cron from "node-cron";
import logger from "../utils/logger.js";
import { sweepCheckouts } from "../services/sbtFulfil.js";

// Prevents overlapping sweeps if a tick runs slower than the interval.
let running = false;

export async function runSbtCheckoutSweep(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const r = await sweepCheckouts();
    if (r.refunded || r.flagged) logger.warn("[SBTCheckoutSweep] swept", r);
  } catch (err: any) {
    logger.error("[SBTCheckoutSweep] run failed", { error: err?.message });
  } finally {
    running = false;
  }
}

export function startSbtCheckoutSweepCron(): void {
  cron.schedule("*/5 * * * *", () => { void runSbtCheckoutSweep(); });
  logger.info("[SBTCheckoutSweep] Cron scheduled — every 5 minutes");
}
