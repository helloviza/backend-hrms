// apps/backend/src/jobs/crmSalesPulseCron.ts
//
// SCHEDULER for the CRM Sales Pulse report. Clones jobs/eodCron.ts but fires at
// MULTIPLE IST clock times per day (default 12/2/4/7 PM). node-cron interprets
// each expression in the timezone passed below (Asia/Kolkata), so the IST HH:MM
// is used directly — no UTC conversion.
//
// SAFETY: this is a NO-OP whenever config.enabled is false (the default). The
// report never sends until a SUPERADMIN explicitly enables it from the
// settings page. EOD_CRM_PULSE_DISABLED can hard-disable registration too.

import cron from "node-cron";
import { CrmSalesPulseConfig, normalizeSendTimes } from "../models/CrmSalesPulseConfig.js";
import { sendSalesPulse } from "../services/crmSalesPulseDelivery.js";
import logger from "../utils/logger.js";

let currentJobs: ReturnType<typeof cron.schedule>[] = [];

function stopAll(): void {
  for (const j of currentJobs) {
    try {
      j.stop();
    } catch {
      /* ignore */
    }
  }
  currentJobs = [];
}

export async function startSalesPulseCron(): Promise<void> {
  if (process.env.CRM_SALES_PULSE_DISABLED === "true") {
    logger.info("[SalesPulse] Cron registration disabled via CRM_SALES_PULSE_DISABLED env var");
    stopAll();
    return;
  }

  const config = await CrmSalesPulseConfig.findOne().lean();
  if (!config?.enabled) {
    logger.info("[SalesPulse] Cron disabled (enabled=false) — skipping schedule");
    stopAll();
    return;
  }

  const sendTimes = normalizeSendTimes(config.sendTimes);
  stopAll();

  for (const t of sendTimes) {
    const [hour, minute] = t.split(":").map(Number);
    const cronExpr = `${minute} ${hour} * * *`;
    const job = cron.schedule(
      cronExpr,
      async () => {
        logger.info(`[SalesPulse] Cron triggered (${t} IST) — sending report`);
        try {
          await sendSalesPulse();
        } catch (err) {
          logger.error("[SalesPulse] Cron send failed", { err });
        }
      },
      { timezone: "Asia/Kolkata" },
    );
    currentJobs.push(job);
  }

  logger.info(
    `[SalesPulse] Cron scheduled at ${sendTimes.join(", ")} IST (timezone: Asia/Kolkata) — ${currentJobs.length} job(s)`,
  );
}

export function rescheduleSalesPulseCron(): Promise<void> {
  return startSalesPulseCron();
}

/**
 * Soonest upcoming fire instant (UTC Date) across all configured IST send
 * times. Returns null if none are valid.
 */
export function getNextFireAt(sendTimes: string[], now: Date = new Date()): Date | null {
  const times = normalizeSendTimes(sendTimes);
  const istDateStr = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const candidates: Date[] = [];

  for (const t of times) {
    const [hh, mm] = t.split(":").map(Number);
    const today = new Date(`${istDateStr}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000+05:30`);
    if (today.getTime() > now.getTime()) {
      candidates.push(today);
    } else {
      // roll to tomorrow IST
      const [y, mo, d] = istDateStr.split("-").map(Number);
      const tom = new Date(Date.UTC(y, mo - 1, d));
      tom.setUTCDate(tom.getUTCDate() + 1);
      const nextStr = tom.toISOString().slice(0, 10);
      candidates.push(new Date(`${nextStr}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000+05:30`));
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.getTime() - b.getTime());
  return candidates[0];
}
