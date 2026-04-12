// apps/backend/src/jobs/eodCron.ts
import cron from "node-cron";
import { EodReportConfig } from "../models/EodReportConfig.js";
import { sendEodReport } from "../services/eodSnapshot.js";
import logger from "../utils/logger.js";

let currentCronJob: ReturnType<typeof cron.schedule> | null = null;

export async function startEodCron(): Promise<void> {
  const config = await EodReportConfig.findOne().lean();
  if (!config?.enabled) {
    logger.info("[EOD] Cron disabled — skipping schedule");
    return;
  }

  const [hour, minute] = (config.sendTime || "19:00").split(":").map(Number);

  // Convert IST (UTC+5:30) → UTC
  // IST HH:MM → UTC: subtract 5h30m, wrap around midnight
  let utcHour: number;
  let utcMinute: number;

  if (minute >= 30) {
    utcMinute = minute - 30;
    utcHour = (hour - 5 + 24) % 24;
  } else {
    utcMinute = minute + 30;
    utcHour = (hour - 6 + 24) % 24;
  }

  const cronExpr = `${utcMinute} ${utcHour} * * *`;

  if (currentCronJob) {
    currentCronJob.stop();
    currentCronJob = null;
  }

  currentCronJob = cron.schedule(cronExpr, async () => {
    logger.info("[EOD] Cron triggered — sending report");
    try {
      await sendEodReport();
    } catch (err) {
      logger.error("[EOD] Cron send failed", { err });
    }
  });

  logger.info(
    `[EOD] Cron scheduled at ${config.sendTime} IST (UTC: ${utcHour}:${String(utcMinute).padStart(2, "0")}) — expr: "${cronExpr}"`,
  );
}

export function rescheduleEodCron(): Promise<void> {
  return startEodCron();
}
