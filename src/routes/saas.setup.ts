// apps/backend/src/routes/saas.setup.ts
// SaaS HRMS setup-progress API — FTUX stage/step tracking for SAAS_HRMS workspaces
import { Router } from "express";
import { z } from "zod";

import { requireAuth } from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import TenantSetupProgress from "../models/TenantSetupProgress.js";

const r = Router();

// ── Stage transition map — forward-only ──────────────────────────────────────
const VALID_TRANSITIONS: Record<string, string[]> = {
  WELCOME:  ["INIT"],
  INIT:     ["MODULES"],
  MODULES:  ["TEAM"],
  TEAM:     ["COMPLETE"],
  COMPLETE: [],
};

// ── Zod schemas ──────────────────────────────────────────────────────────────
const AdvanceSchema = z.object({
  toStage: z.enum(["INIT", "MODULES", "TEAM", "COMPLETE"]),
});

const StepSchema = z.object({
  stepKey: z.string().min(1).max(80),
  action: z.enum(["complete", "skip"]),
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function serializeProgress(doc: any) {
  const obj = doc.toObject ? doc.toObject() : { ...doc };
  if (obj.moduleProgress instanceof Map) {
    obj.moduleProgress = Object.fromEntries(obj.moduleProgress);
  }
  return obj;
}

function hasTenantAdminRole(req: any): boolean {
  const roles: string[] = (req.user?.roles ?? []).map((r: string) =>
    String(r).toUpperCase(),
  );
  return roles.includes("TENANT_ADMIN") || roles.includes("SUPERADMIN");
}

/* ────────────────────────────────────────────────────────────────────────────
 * GET /api/saas/setup/progress
 * Any authenticated workspace member can read. Lazy-creates if missing.
 * ────────────────────────────────────────────────────────────────────────── */
r.get("/setup/progress", requireAuth, requireWorkspace, async (req, res) => {
  try {
    if ((req as any).workspace?.tenantType !== "SAAS_HRMS") {
      return res.status(404).json({ error: "Setup progress not available for this workspace" });
    }

    let doc = await TenantSetupProgress.findOne({
      workspaceId: (req as any).workspaceObjectId,
    });

    if (doc) {
      if (!doc.firstLoginAt) {
        doc.firstLoginAt = new Date();
        doc.lastActivityAt = new Date();
        await doc.save();
      }
      return res.status(200).json({ success: true, progress: serializeProgress(doc) });
    }

    // Defensive lazy-create — should not be needed post T-040 backfill
    const now = new Date();
    doc = await TenantSetupProgress.create({
      workspaceId: (req as any).workspaceObjectId,
      tenantType: "SAAS_HRMS",
      currentStage: "WELCOME",
      firstLoginAt: now,
      lastActivityAt: now,
    });
    return res.status(200).json({ success: true, progress: serializeProgress(doc), created: true });
  } catch (err: any) {
    console.error("[saas.setup] GET /setup/progress error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * POST /api/saas/setup/advance
 * Moves to the next stage. TENANT_ADMIN or SUPERADMIN only.
 * ────────────────────────────────────────────────────────────────────────── */
r.post("/setup/advance", requireAuth, requireWorkspace, async (req, res) => {
  try {
    if ((req as any).workspace?.tenantType !== "SAAS_HRMS") {
      return res.status(404).json({ error: "Setup progress not available for this workspace" });
    }
    if (!hasTenantAdminRole(req)) {
      return res.status(403).json({ error: "Forbidden — TENANT_ADMIN role required" });
    }

    const parse = AdvanceSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Validation failed", details: parse.error.flatten() });
    }

    const { toStage } = parse.data;

    const doc = await TenantSetupProgress.findOne({
      workspaceId: (req as any).workspaceObjectId,
    });
    if (!doc) {
      return res.status(404).json({ error: "Setup progress record not found" });
    }

    const allowed = VALID_TRANSITIONS[doc.currentStage] ?? [];
    if (!allowed.includes(toStage)) {
      return res.status(400).json({
        error: "Invalid stage transition",
        from: doc.currentStage,
        to: toStage,
        allowed,
      });
    }

    if (!doc.stagesCompleted.includes(doc.currentStage)) {
      doc.stagesCompleted.push(doc.currentStage);
    }
    doc.currentStage = toStage as any;
    doc.currentStep = null;
    doc.lastActivityAt = new Date();

    if (toStage === "COMPLETE" && !doc.ftuxCompletedAt) {
      doc.ftuxCompletedAt = new Date();
    }

    await doc.save();
    return res.status(200).json({ success: true, progress: serializeProgress(doc) });
  } catch (err: any) {
    console.error("[saas.setup] POST /setup/advance error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * POST /api/saas/setup/step
 * Marks a step complete or skipped. TENANT_ADMIN or SUPERADMIN only.
 * ────────────────────────────────────────────────────────────────────────── */
r.post("/setup/step", requireAuth, requireWorkspace, async (req, res) => {
  try {
    if ((req as any).workspace?.tenantType !== "SAAS_HRMS") {
      return res.status(404).json({ error: "Setup progress not available for this workspace" });
    }
    if (!hasTenantAdminRole(req)) {
      return res.status(403).json({ error: "Forbidden — TENANT_ADMIN role required" });
    }

    const parse = StepSchema.safeParse(req.body);
    if (!parse.success) {
      return res.status(400).json({ error: "Validation failed", details: parse.error.flatten() });
    }

    const { stepKey, action } = parse.data;

    const doc = await TenantSetupProgress.findOne({
      workspaceId: (req as any).workspaceObjectId,
    });
    if (!doc) {
      return res.status(404).json({ error: "Setup progress record not found" });
    }

    if (action === "complete") {
      if (!doc.stepsCompleted.includes(stepKey)) {
        doc.stepsCompleted.push(stepKey);
      }
    } else {
      if (!doc.stepsSkipped.includes(stepKey)) {
        doc.stepsSkipped.push(stepKey);
      }
    }

    doc.currentStep = stepKey;
    doc.lastActivityAt = new Date();

    await doc.save();
    return res.status(200).json({ success: true, progress: serializeProgress(doc) });
  } catch (err: any) {
    console.error("[saas.setup] POST /setup/step error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
 * POST /api/saas/setup/complete
 * Idempotent FTUX completion. TENANT_ADMIN or SUPERADMIN only.
 * ────────────────────────────────────────────────────────────────────────── */
r.post("/setup/complete", requireAuth, requireWorkspace, async (req, res) => {
  try {
    if ((req as any).workspace?.tenantType !== "SAAS_HRMS") {
      return res.status(404).json({ error: "Setup progress not available for this workspace" });
    }
    if (!hasTenantAdminRole(req)) {
      return res.status(403).json({ error: "Forbidden — TENANT_ADMIN role required" });
    }

    const doc = await TenantSetupProgress.findOne({
      workspaceId: (req as any).workspaceObjectId,
    });
    if (!doc) {
      return res.status(404).json({ error: "Setup progress record not found" });
    }

    if (doc.ftuxCompletedAt) {
      return res.status(200).json({ success: true, progress: serializeProgress(doc), alreadyComplete: true });
    }

    const now = new Date();
    // Flush any in-progress stages into stagesCompleted
    const allStages = ["WELCOME", "INIT", "MODULES", "TEAM"];
    for (const stage of allStages) {
      if (!doc.stagesCompleted.includes(stage)) {
        doc.stagesCompleted.push(stage);
      }
    }
    doc.currentStage = "COMPLETE";
    doc.ftuxCompletedAt = now;
    doc.lastActivityAt = now;

    await doc.save();
    return res.status(200).json({ success: true, progress: serializeProgress(doc) });
  } catch (err: any) {
    console.error("[saas.setup] POST /setup/complete error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default r;
