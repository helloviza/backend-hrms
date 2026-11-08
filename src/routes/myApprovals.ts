// apps/backend/src/routes/myApprovals.ts
//
// GET /api/my-approvals — items waiting on the CALLER as approver, across
// every source that names a specific approver. See
// services/myApprovals.service.ts for the per-source rules.
//
// Chain: requireAuth → requireWorkspace → resolveSelfWorkspace, so every
// query is bound to one concrete workspace (a SUPERADMIN without one in the
// JWT gets their home workspace; nothing resolves → 403, never find({})).
import { Router, Request, Response } from "express";
import requireAuth from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { resolveSelfWorkspace } from "../middleware/resolveSelfWorkspace.js";
import { collectMyApprovals, type SourceEnablement } from "../services/myApprovals.service.js";
import { featureOn, plumboxMounted } from "../services/mySpaceFeatures.js";

const router = Router();
router.use(requireAuth as any, requireWorkspace as any, resolveSelfWorkspace as any);

/** Which sources' routers would serve this caller — mirrors each mount's gate. */
export function sourceEnablement(req: Request, ws: any): SourceEnablement {
  const plumbox = plumboxMounted();
  const saas = ws?.tenantType === "SAAS_HRMS";
  const on = (k: string) => featureOn(req, ws, k);
  return {
    leave: true, // /api/leaves — no feature gate (server.ts)
    attendanceOd: true, // /api/attendance — no feature gate
    // /api/approvals: plumbox-only mount + router-level
    // requireAnyFeature("approvalFlowEnabled", "approvalDirectEnabled") + the
    // inbox's requireTravelMode("APPROVAL_FLOW", "APPROVAL_DIRECT"). The inbox's
    // own membership / SBT-user refusals are applied by the shared
    // travelRequestInboxQuery (→ "off").
    travelRequest:
      plumbox &&
      (on("approvalFlowEnabled") || on("approvalDirectEnabled")) &&
      travelModeAllows(req, ws, ["APPROVAL_FLOW", "APPROVAL_DIRECT"]),
    // /api/proposals: plumbox-only mount; SaaS tenants blocked unless an approval flag is on (blockTravelForSaas)
    proposal: plumbox && (!saas || on("approvalFlowEnabled") || on("approvalDirectEnabled")),
    // /api/sbt/requests: plumbox-only mount + requireFeature("sbtEnabled")
    sbtRequest: plumbox && on("sbtEnabled"),
    // /api/reports: requireFeature("expensesEnabled")
    expenseClaim: on("expensesEnabled"),
    // /api/expense-advances: expensesEnabled AND advancesEnabled
    advance: on("expensesEnabled") && on("advancesEnabled"),
    // /api/visa: requireFeature("visaEnabled")
    visa: on("visaEnabled"),
  };
}

/**
 * Mirrors middleware/travelModeGuard.ts requireTravelMode: SUPERADMIN / ADMIN
 * token roles pass; otherwise the workspace's config.travelFlow (falling back
 * to legacy travelMode) must be one of the allowed flows.
 */
export function travelModeAllows(req: Request, ws: any, allowed: string[]): boolean {
  const roles: string[] = (req as any).user?.roles || [];
  if (roles.includes("SUPERADMIN") || roles.includes("ADMIN")) return true;
  const flow = ws?.config?.travelFlow || ws?.travelMode;
  return !!flow && allowed.includes(flow);
}

export const myApprovalsDeps = { collectMyApprovals };

router.get("/", async (req: Request, res: Response) => {
  try {
    const userId = String((req as any).user?.sub || (req as any).user?._id || (req as any).user?.id || "");
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const result = await myApprovalsDeps.collectMyApprovals({
      req,
      userId,
      workspaceObjectId: req.workspaceObjectId,
      enabled: sourceEnablement(req, req.workspace),
    });
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error("[my-approvals] failed:", err);
    return res.status(500).json({ error: "Failed to load approvals" });
  }
});

export default router;
