// apps/backend/src/jobs/cstep-report-reminder.ts
//
// #14 — daily at 10:00 IST (services/cstepReportReminders.ts): a CSTEP trip
// whose travel report is still owed 7 days after it ended is reminded to its
// creator (and the traveller), weekly, at most 3 times; the Manager joins
// from the 2nd. Sends nothing while CSTEP notifications are dormant.
//
// Registered from server.ts on the primary host only (not the WA host).
// Several App Runner instances may each fire it; each reminder is claimed on
// the request before it is sent, so only one instance sends it.
// CSTEP_REPORT_REMINDER_DISABLED=true skips scheduling (the
// LOYALTY_SWEEP_DISABLED convention).
import cron from "node-cron";
import { runCstepReportReminders } from "../services/cstepReportReminders.js";
import logger from "../utils/logger.js";

// Prevents overlapping runs if a tick runs slower than the interval.
let running = false;

export function cstepReportReminderDisabled(): boolean {
  return /^(1|true|yes|on)$/i.test(String(process.env.CSTEP_REPORT_REMINDER_DISABLED || "").trim());
}

export async function runCstepReportReminderTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const r = await runCstepReportReminders();
    logger.info("[CstepReportReminder] done", {
      ran: r.ran,
      reason: r.reason,
      today: r.today,
      workspaces: r.workspaces,
      candidates: r.candidates,
      sent: r.sent.length,
      lostClaims: r.lostClaims,
    });
  } catch (err: any) {
    logger.error("[CstepReportReminder] failed", { message: err?.message });
  } finally {
    running = false;
  }
}

export function startCstepReportReminderCron(): void {
  if (cstepReportReminderDisabled()) {
    logger.info("[CstepReportReminder] disabled by CSTEP_REPORT_REMINDER_DISABLED — not scheduled");
    return;
  }
  cron.schedule("0 10 * * *", () => { void runCstepReportReminderTick(); }, { timezone: "Asia/Kolkata" });
  logger.info("[CstepReportReminder] scheduled daily at 10:00 IST (return + 7 days, weekly, max 3)");
}
