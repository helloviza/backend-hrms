// apps/backend/src/workers/leaveAccrual.worker.ts
import cron from "node-cron";
import User from "../models/User.js";
import LeavePolicy from "../models/LeavePolicy.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { runMonthlyAccrual, initializeLeaveBalance, runYearEndCarryForward } from "../services/leavePolicy.service.js";
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

  let processed = 0;
  let skipped = 0;
  let errors = 0;

  // Process per workspace to enforce tenant isolation
  const workspaces = await CustomerWorkspace.find({ status: "ACTIVE" }).select("_id").lean();

  for (const workspace of workspaces) {
    try {
      console.log(`[LeaveAccrual] Processing workspace ${workspace._id}`);

      const policy = await LeavePolicy.getOrCreate(workspace._id);
      const users = await User.find({
        workspaceId: workspace._id,
        status: { $ne: "INACTIVE" },
      }).select("_id dateOfJoining").lean();

      for (const user of users) {
        try {
          // Ensure balance exists
          let balance: any = await LeaveBalance.findOne({
            userId: user._id,
            workspaceId: workspace._id,
            year,
          });
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
            workspaceId: String(workspace._id),
            error: err.message,
          });
        }
      }
    } catch (wsErr: any) {
      errors++;
      logger.error("Leave accrual workspace error", {
        workspaceId: String(workspace._id),
        error: wsErr.message,
      });
    }
  }

  return { processed, skipped, errors };
}

export async function executeYearEndCarryForward(): Promise<{
  processed: number;
  errors: number;
}> {
  const fromYear = new Date().getFullYear() - 1;
  const toYear = new Date().getFullYear();

  let processed = 0;
  let errors = 0;

  const workspaces = await CustomerWorkspace.find({ status: "ACTIVE" }).select("_id").lean();

  for (const workspace of workspaces) {
    try {
      logger.info(`[YearEnd] Processing workspace ${workspace._id}`);
      const policy = await LeavePolicy.getOrCreate(workspace._id);
      const users = await User.find({
        workspaceId: workspace._id,
        status: { $ne: "INACTIVE" },
      }).select("_id").lean();

      for (const user of users) {
        try {
          await runYearEndCarryForward(String(user._id), fromYear, toYear, policy);
          processed++;
        } catch (err: any) {
          errors++;
          logger.error("[YearEnd] User carry-forward error", {
            userId: String(user._id),
            error: err.message,
          });
        }
      }

      logger.info(`[YearEnd] Carry-forward complete for workspace ${workspace._id}`);
    } catch (err: any) {
      errors++;
      logger.error(`[YearEnd] Failed for workspace ${workspace._id}:`, {
        error: err.message,
      });
    }
  }

  // Write audit log
  try {
    const mongoose = (await import("mongoose")).default;
    const auditLogCollection = mongoose.connection.collection("workspaceauditlogs");
    for (const ws of workspaces) {
      await auditLogCollection.insertOne({
        workspaceId: String(ws._id),
        event: "YEAR_END_CARRY_FORWARD",
        runAt: new Date(),
        triggeredBy: "cron",
        status: errors > 0 ? "PARTIAL" : "SUCCESS",
        details: `Processed ${processed} users, ${errors} errors`,
      });
    }
  } catch {
    // Non-fatal
  }

  return { processed, errors };
}

async function executeDeclarationReminder(): Promise<{ workspacesChecked: number; remindersSent: number }> {
  const DeclarationWindow = (await import("../models/DeclarationWindow.js")).default;
  const EmployeeDeclaration = (await import("../models/EmployeeDeclaration.js")).default;
  const { sendMail } = await import("../utils/mailer.js");

  let workspacesChecked = 0;
  let remindersSent = 0;

  const workspaces = await CustomerWorkspace.find({ status: "ACTIVE" }).select("_id").lean();
  const now = new Date();
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const oneDayMs = 24 * 60 * 60 * 1000;

  for (const ws of workspaces) {
    try {
      workspacesChecked++;
      const windows: any[] = await DeclarationWindow.find({ workspaceId: ws._id }).lean();

      for (const w of windows) {
        // Check declaration deadline — 7 days away and no reminder sent yet
        if (
          w.declarationOpen && !w.declarationFrozenAt && w.declarationDeadline &&
          w.reminderSentCount === 0
        ) {
          const diff = new Date(w.declarationDeadline).getTime() - now.getTime();
          if (diff > 0 && diff <= 7 * oneDayMs) {
            const submitted = await EmployeeDeclaration.find({
              workspaceId: ws._id,
              declarationWindowId: w._id,
              declarationStatus: { $in: ["SUBMITTED", "FROZEN"] },
            }).select("userId").lean();
            const submittedIds = new Set(submitted.map((d: any) => String(d.userId)));

            const employees = await User.find({
              workspaceId: ws._id,
              status: { $ne: "INACTIVE" },
            }).select("_id email firstName name").lean();

            const deadline = new Date(w.declarationDeadline).toLocaleDateString("en-IN", {
              day: "numeric", month: "long", year: "numeric",
            });

            for (const emp of employees) {
              if (submittedIds.has(String(emp._id))) continue;
              try {
                const empName = emp.firstName || (emp as any).name || "Employee";
                await sendMail({
                  to: (emp as any).email,
                  subject: "Action required: Investment declaration closes in 7 days",
                  html: `<p>Hi ${empName},</p><p>Please submit your investment declarations before <strong>${deadline}</strong>.</p>`,
                  kind: "DEFAULT",
                });
                remindersSent++;
              } catch { /* skip */ }
            }

            await DeclarationWindow.updateOne(
              { _id: w._id },
              { $set: { reminderSentAt: now }, $inc: { reminderSentCount: 1 } },
            );
          }
        }

        // Check proof submission deadline similarly
        if (
          w.proofSubmissionOpen && !w.proofSubmissionClosedAt && w.proofSubmissionDeadline
        ) {
          const diff = new Date(w.proofSubmissionDeadline).getTime() - now.getTime();
          if (diff > 0 && diff <= 7 * oneDayMs) {
            const pending = await EmployeeDeclaration.find({
              workspaceId: ws._id,
              declarationWindowId: w._id,
              proofStatus: { $in: ["NOT_STARTED", "PARTIAL"] },
            }).select("userId").lean();

            const deadline = new Date(w.proofSubmissionDeadline).toLocaleDateString("en-IN", {
              day: "numeric", month: "long", year: "numeric",
            });

            for (const d of pending) {
              try {
                const emp: any = await User.findById(d.userId).select("email firstName name").lean();
                if (!emp) continue;
                const empName = emp.firstName || emp.name || "Employee";
                await sendMail({
                  to: emp.email,
                  subject: "Action required: Submit investment proof documents",
                  html: `<p>Hi ${empName},</p><p>Please upload your proof documents before <strong>${deadline}</strong>.</p>`,
                  kind: "DEFAULT",
                });
                remindersSent++;
              } catch { /* skip */ }
            }
          }
        }
      }
    } catch (err: any) {
      logger.error("Declaration reminder workspace error", {
        workspaceId: String(ws._id),
        error: err.message,
      });
    }
  }

  return { workspacesChecked, remindersSent };
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

  // Year-end carry-forward: 1st January at 1:00 AM
  cron.schedule("0 1 1 1 *", async () => {
    logger.info("Year-end carry-forward cron triggered");
    try {
      const result = await executeYearEndCarryForward();
      logger.info("Year-end carry-forward completed", result);
    } catch (err: any) {
      logger.error("Year-end carry-forward cron failed", { error: err.message });
    }
  });

  // Declaration reminder — daily at 9 AM
  cron.schedule("0 9 * * *", async () => {
    logger.info("Declaration reminder cron triggered");
    try {
      const result = await executeDeclarationReminder();
      logger.info("Declaration reminder completed", result);
    } catch (err: any) {
      logger.error("Declaration reminder cron failed", { error: err.message });
    }
  });

  logger.info("Leave accrual worker scheduled: 0 6 1 * *");
  logger.info("Year-end carry-forward scheduled: 0 1 1 1 *");
  logger.info("Declaration reminder scheduled: 0 9 * * *");
}
