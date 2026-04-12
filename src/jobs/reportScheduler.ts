// apps/backend/src/jobs/reportScheduler.ts
import cron from "node-cron";
import ReportSchedule, { type IReportSchedule } from "../models/ReportSchedule.js";
import { getReportData, computeDateRange } from "../routes/reports.js";
import { sendReportEmail } from "../utils/reportMailer.js";

export function startReportScheduler(): void {
  cron.schedule("*/15 * * * *", async () => {
    try {
      await runScheduledReports();
    } catch (err) {
      console.error("[reportScheduler] Unexpected cron error:", err);
    }
  });
  console.log("[reportScheduler] Report scheduler started (*/15 * * * *)");
}

async function runScheduledReports(): Promise<void> {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset);
  const currentHour = ist.getUTCHours();
  const currentMinute = ist.getUTCMinutes();
  const currentDay = ist.getUTCDay(); // 0=Sun, 1=Mon, ...6=Sat
  const currentDate = ist.getUTCDate();

  let schedules: IReportSchedule[];
  try {
    schedules = await ReportSchedule.find({ isActive: true });
  } catch (err) {
    console.error("[reportScheduler] Failed to fetch schedules:", err);
    return;
  }

  for (const schedule of schedules) {
    try {
      const [schedHour, schedMinute] = schedule.timeIST.split(":").map(Number);

      const timeMatches =
        currentHour === schedHour &&
        currentMinute >= schedMinute &&
        currentMinute < schedMinute + 15;

      if (!timeMatches) continue;

      // Frequency check
      if (schedule.frequency === "WEEKLY") {
        // schedule.dayOfWeek: 1=Mon...7=Sun → convert to JS (0=Sun...6=Sat)
        const targetDay = (schedule.dayOfWeek ?? 1) % 7;
        if (currentDay !== targetDay) continue;
      } else if (schedule.frequency === "MONTHLY") {
        if (currentDate !== (schedule.dayOfMonth ?? 1)) continue;
      }
      // DAILY: always proceed if timeMatches

      // Prevent duplicate send within same 15-min window
      if (schedule.lastSentAt) {
        const msSince = now.getTime() - new Date(schedule.lastSentAt).getTime();
        if (msSince < 14 * 60 * 1000) continue;
      }

      // Compute date range
      const { dateFrom, dateTo } = computeDateRange(schedule.dateRangeType, ist);
      const fromStr = dateFrom.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
      const toStr = dateTo.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
      const dateLabel = `${fromStr} – ${toStr}`;

      const data = await getReportData({
        dateFrom: dateFrom.toISOString().slice(0, 10),
        dateTo: dateTo.toISOString().slice(0, 10),
      });

      await sendReportEmail(schedule, data, dateLabel);

      schedule.lastSentAt = now;
      await schedule.save();

      console.log(`[reportScheduler] Sent schedule "${schedule.name}" to ${schedule.recipients.length} recipients`);
    } catch (err) {
      console.error(`[reportScheduler] Error processing schedule "${schedule.name}" (${schedule._id}):`, err);
    }
  }
}
