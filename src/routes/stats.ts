// apps/backend/src/routes/stats.ts
//
// GET /api/stats/dashboard — the caller's own dashboard figures.
// All computation lives in services/mySpaceStats.service.ts.
//
// Errors are real errors (audit H4): a thrown error is a 500, never a 200
// with zeros — the frontend's error states depend on it.
import { Router, Request, Response } from "express";
import requireAuth from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { resolveSelfWorkspaceFor } from "../middleware/resolveSelfWorkspace.js";
import { computeDashboardStats } from "../services/mySpaceStats.service.js";

export type { DashboardStats } from "../services/mySpaceStats.service.js";

const router = Router();

/** Indirection so tests can force a failure without touching the DB. */
export const statsDeps = {
  computeDashboardStats,
  resolveSelfWorkspaceFor,
};

router.use(requireAuth as any);
router.use(requireWorkspace as any);

router.get("/dashboard", async (req: Request, res: Response) => {
  const userId: string = (req as any).user?.sub || "";
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    // Workspace-wide data (holidays) needs a concrete workspace; a SUPERADMIN
    // with none in the JWT gets their home workspace, never an unscoped read.
    const ws = await statsDeps.resolveSelfWorkspaceFor(req);
    const payload = await statsDeps.computeDashboardStats({
      userId,
      workspaceObjectId: ws?._id ? (req as any).workspaceObjectId ?? null : null,
    });
    res.setHeader("Cache-Control", "no-store");
    return res.json(payload);
  } catch (err) {
    console.error("[stats/dashboard] failed:", err);
    return res.status(500).json({ error: "Failed to load dashboard stats" });
  }
});

export default router;
