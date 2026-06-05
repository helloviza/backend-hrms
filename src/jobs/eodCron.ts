// apps/backend/src/jobs/eodCron.ts
import cron from "node-cron";
import { EodReportConfig } from "../models/EodReportConfig.js";
import { sendEodReport } from "../services/eodSnapshot.js";
import logger from "../utils/logger.js";

let currentCronJob: ReturnType<typeof cron.schedule> | null = null;

export async function startEodCron(): Promise<void> {
  // LIVE EOD scheduler. This in-process node-cron is the production scheduler,
  // running on the always-on Fargate WhatsApp host (WA_HOST=true). EOD_CRON_DISABLED
  // is NOT set in production, so this path is the one that actually fires the report.
  //
  // ABANDONED ALTERNATIVE (never wired) — see
  // infra/audit/eod-render-lambda-plan-2026-05-27.md: an EventBridge + runEodOnce.ts
  // Fargate Scheduled Task was planned to move scheduling out-of-process, but was
  // never built. If EOD_CRON_DISABLED were ever set, this cron skips and that
  // external scheduler would own execution.
  if (process.env.EOD_CRON_DISABLED === "true") {
    logger.info("[EOD] Cron registration disabled via EOD_CRON_DISABLED env var (Fargate mode)");
    return;
  }

  const config = await EodReportConfig.findOne().lean();
  if (!config?.enabled) {
    logger.info("[EOD] Cron disabled — skipping schedule");
    return;
  }

  const [hour, minute] = (config.sendTime || "19:00").split(":").map(Number);

  // node-cron interprets the expression in the timezone passed below
  // (Asia/Kolkata), so the IST HH:MM is used directly — no UTC conversion.
  const cronExpr = `${minute} ${hour} * * *`;

  if (currentCronJob) {
    currentCronJob.stop();
    currentCronJob = null;
  }

  currentCronJob = cron.schedule(
    cronExpr,
    async () => {
      logger.info("[EOD] Cron triggered — sending report");
      try {
        await sendEodReport();
      } catch (err) {
        logger.error("[EOD] Cron send failed", { err });
      }
    },
    { timezone: "Asia/Kolkata" },
  );

  logger.info(
    `[EOD] Cron scheduled at ${config.sendTime} IST — expr: "${cronExpr}" (timezone: Asia/Kolkata)`,
  );
}

export function rescheduleEodCron(): Promise<void> {
  return startEodCron();
}

/**
 * Compute the next fire instant (UTC Date) given an IST "HH:MM" send time.
 * Returns null if the input is malformed.
 */
export function getNextFireAt(sendTime: string, now: Date = new Date()): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(sendTime ?? "");
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;

  // Today's IST calendar date
  const istDateStr = now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const candidate = new Date(
    `${istDateStr}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000+05:30`,
  );

  if (candidate.getTime() > now.getTime()) return candidate;

  // Already past today — roll to tomorrow
  const [y, mo, d] = istDateStr.split("-").map(Number);
  const tomorrow = new Date(Date.UTC(y, mo - 1, d));
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const nextStr = tomorrow.toISOString().slice(0, 10);
  return new Date(
    `${nextStr}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00.000+05:30`,
  );
}
