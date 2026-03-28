// apps/backend/src/workers/leaveAccrual.worker.ts
import cron from "node-cron";
import User from "../models/User.js";
import LeavePolicy from "../models/LeavePolicy.js";
import { runMonthlyAccrual, initializeLeaveBalance } from "../services/leavePolicy.service.js";
import LeaveBalance from "../models/LeaveBalance.js";
import logger from "../utils/logger.js";

export async function executeLeaveAccrual(): Promise<{
  processed: number;
  skipped: number;
  errors: number;
}> {
  const now = new Date();
  const month = now.getMonth() + 1; // 1-indexed
  const year = now.getFullYear();

  const policy = await LeavePolicy.getOrCreate();
  const users = await User.find({ status: { $ne: "INACTIVE" } }).select("_id dateOfJoining").lean();

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  for (const user of users) {
    try {
      // Ensure balance exists
      let balance: any = await LeaveBalance.findOne({ userId: user._id, year });
      if (!balance) {
        const joinDate = user.dateOfJoining
          ? new Date(user.dateOfJoining as string)
          : new Date();
        balance = await initializeLeaveBalance(
          String(user._id),
          joinDate,
          year,
          policy,
        );
      }

      const result = await runMonthlyAccrual(
        String(user._id),
        month,
        year,
        policy,
      );

      if (result && result.lastAccrualMonth === month) {
        processed++;
      } else {
        skipped++;
      }
    } catch (err: any) {
      errors++;
      logger.error("Leave accrual error", {
        userId: String(user._id),
        error: err.message,
      });
    }
  }

  return { processed, skipped, errors };
}

export function startLeaveAccrualWorker(): void {
  // Run at 6 AM on the 1st of every month
  cron.schedule("0 6 1 * *", async () => {
    logger.info("Leave accrual cron triggered");
    try {
      const result = await executeLeaveAccrual();
      logger.info("Leave accrual completed", result);
    } catch (err: any) {
      logger.error("Leave accrual cron failed", { error: err.message });
    }
  });

  logger.info("Leave accrual worker scheduled: 0 6 1 * *");
}
