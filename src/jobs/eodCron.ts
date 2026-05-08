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
