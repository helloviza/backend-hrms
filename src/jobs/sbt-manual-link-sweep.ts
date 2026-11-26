// SBT → Manual Booking link backstop — every 10 minutes (services/sbtManualLink.ts
// sweepManualLinks). Links confirmed SBT bookings the save hook missed (a hook
// failure, a restart mid-link, the index missing for a while). Does nothing
// while SBTConfig "global".manualLinkEnabled is off. Ops are alerted by the
// service after an SBT booking's 3rd failed attempt.
import cron from "node-cron";
import logger from "../utils/logger.js";
import { sweepManualLinks } from "../services/sbtManualLink.js";

let running = false;

export async function runSbtManualLinkSweep(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const r = await sweepManualLinks();
    if (r.scanned) logger.info("[SBTManualLinkSweep] swept", r);
  } catch (err: any) {
    logger.error("[SBTManualLinkSweep] run failed", { error: err?.message });
  } finally {
    running = false;
  }
}

export function startSbtManualLinkSweepCron(): void {
  cron.schedule("*/10 * * * *", () => { void runSbtManualLinkSweep(); });
  logger.info("[SBTManualLinkSweep] Cron scheduled — every 10 minutes");
}
