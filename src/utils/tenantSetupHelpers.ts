// apps/backend/src/utils/tenantSetupHelpers.ts
//
// Shared helpers for synchronizing TenantSetupProgress (System A) with
// other onboarding state writes (System B / CustomerWorkspace).

import TenantSetupProgress from "../models/TenantSetupProgress.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import logger from "./logger.js";

const ALL_STAGES = ["WELCOME", "INIT", "MODULES", "TEAM"] as const;

/**
 * Mark a tenant's first-time setup (FTUX) as complete. Idempotent.
 *
 * - Flushes WELCOME/INIT/MODULES/TEAM into stagesCompleted
 * - Sets currentStage = "COMPLETE"
 * - Stamps ftuxCompletedAt = now()
 *
 * Safe to call multiple times; only updates if not already COMPLETE.
 * No-op (with log) if workspace is not SAAS_HRMS.
 */
export async function markTenantSetupComplete(workspaceObjectId: any): Promise<void> {
  try {
    const ws = await CustomerWorkspace.findById(workspaceObjectId, { tenantType: 1 }).lean();
    if (!ws || (ws as any).tenantType !== "SAAS_HRMS") {
      return;
    }

    const progress = await TenantSetupProgress.findOne({ workspaceId: workspaceObjectId });
    if (!progress) {
      await TenantSetupProgress.create({
        workspaceId: workspaceObjectId,
        tenantType: "SAAS_HRMS",
        currentStage: "COMPLETE",
        stagesCompleted: [...ALL_STAGES],
        ftuxCompletedAt: new Date(),
        lastActivityAt: new Date(),
      });
      logger.info("[tenantSetup] Created missing TenantSetupProgress as COMPLETE", {
        workspaceId: String(workspaceObjectId),
      });
      return;
    }

    if (progress.currentStage === "COMPLETE") {
      return;
    }

    const completedSet = new Set([...(progress.stagesCompleted || []), ...ALL_STAGES]);
    progress.stagesCompleted = Array.from(completedSet) as any;
    progress.currentStage = "COMPLETE" as any;
    if (!progress.ftuxCompletedAt) {
      progress.ftuxCompletedAt = new Date();
    }
    progress.lastActivityAt = new Date();
    await progress.save();

    logger.info("[tenantSetup] Marked tenant FTUX complete", {
      workspaceId: String(workspaceObjectId),
    });
  } catch (err: any) {
    logger.error("[tenantSetup] markTenantSetupComplete failed", {
      workspaceId: String(workspaceObjectId),
      error: err?.message,
    });
  }
}
