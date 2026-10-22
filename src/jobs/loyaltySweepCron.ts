// apps/backend/src/jobs/loyaltySweepCron.ts
//
// Daily loyalty sweep at 02:30 IST (services/loyalty.ts runLoyaltySweep):
// creates missing accounts for customers with counted invoices, then
// reconciles EVERY loyalty account. It heals anything an inline loyaltyTouch
// missed — a script, a raw write, a crash between the finance write and the
// touch.
//
// Registered from server.ts on the primary host only (not the WA host), like
// the other in-process jobs. Several App Runner instances may each fire it;
// the run is claimed by inserting the day's unique runKey, so only one sweeps.
// LOYALTY_SWEEP_DISABLED=true skips scheduling (the EOD_CRON_DISABLED convention).
import cron from "node-cron";
import { runLoyaltySweep } from "../services/loyalty.js";
import logger from "../utils/logger.js";

export function startLoyaltySweepCron(): void {
  if (String(process.env.LOYALTY_SWEEP_DISABLED || "").toLowerCase() === "true") {
    logger.info("[LoyaltySweep] disabled by LOYALTY_SWEEP_DISABLED — not scheduled");
    return;
  }
  cron.schedule(
    "30 2 * * *",
    async () => {
      try {
        const r = await runLoyaltySweep();
        if (!r.claimed) logger.info("[LoyaltySweep] run already claimed by another instance", { runKey: r.runKey });
        else logger.info("[LoyaltySweep] done", r);
      } catch (err: any) {
        logger.error("[LoyaltySweep] failed", { message: err?.message });
      }
    },
    { timezone: "Asia/Kolkata" },
  );
  logger.info("[LoyaltySweep] scheduled daily at 02:30 IST");
}
