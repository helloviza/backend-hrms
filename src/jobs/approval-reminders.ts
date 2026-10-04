// Approval reminders — every 15 minutes (services/approvalReminders.ts):
// a request or proposal still waiting for a decision 24h / 48h / 72h after it
// reached the approver gets a reminder to the approver and Workspace Leaders,
// with fresh decision links. At most 3; stops once it is decided, revoked or
// cancelled.
import cron from "node-cron";
import logger from "../utils/logger.js";
import { runApprovalReminders } from "../services/approvalReminders.js";

// Prevents overlapping runs if a tick runs slower than the interval.
let running = false;

export async function runApprovalRemindersTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const r = await runApprovalReminders();
    if (r.requests || r.proposals) logger.info("[ApprovalReminders] sent", r);
  } catch (err: any) {
    logger.error("[ApprovalReminders] run failed", { error: err?.message });
  } finally {
    running = false;
  }
}

export function startApprovalRemindersCron(): void {
  cron.schedule("*/15 * * * *", () => { void runApprovalRemindersTick(); });
  logger.info("[ApprovalReminders] Cron scheduled — every 15 minutes (24h/48h/72h, max 3)");
}
