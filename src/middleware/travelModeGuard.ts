// apps/backend/src/middleware/travelModeGuard.ts
import type { Request, Response, NextFunction } from "express";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

/**
 * requireTravelMode for routes where Plumtrips staff act on a CUSTOMER's
 * record (proposal draft / submit / record-decision). Staff log in with the
 * HOUSE workspace, so checking the caller's flow refused every OPS-role agent
 * (and ADMIN/SUPERADMIN skipped the check entirely). Staff are checked against
 * the flow of the workspace that owns the record; anyone else gets exactly
 * requireTravelMode (their own workspace). A record that cannot be resolved
 * is left to the route (which answers 404).
 */
export function requireTravelModeFor(
  opts: { isStaff: (user: any) => boolean; resolveWorkspaceId: (req: Request) => Promise<unknown> },
  ...allowedFlows: string[]
) {
  const forCaller = requireTravelMode(...allowedFlows);
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      if (!user) return res.status(401).json({ error: "Unauthorized" });
      if (!opts.isStaff(user)) return forCaller(req, res, next);

      const wsId = await opts.resolveWorkspaceId(req);
      if (!wsId) return next();
      const ws: any = await CustomerWorkspace.findById(wsId).select("config.travelFlow travelMode").lean();
      const travelFlow = ws?.config?.travelFlow || ws?.travelMode;
      if (!allowedFlows.includes(travelFlow)) {
        return res.status(403).json({
          error: "This flow is not enabled for your workspace",
          workspaceFlow: travelFlow,
          requiredFlow: allowedFlows,
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireTravelMode(...allowedFlows: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      // SUPERADMIN and ADMIN always bypass
      const roles: string[] = user.roles || [];
      if (roles.includes("SUPERADMIN") || roles.includes("ADMIN")) {
        return next();
      }

      // Use workspace already resolved by requireWorkspace, or fall back to DB lookup
      let ws = (req as any).workspace;
      if (!ws) {
        const customerId = user.customerId || user.businessId;
        if (!customerId) {
          return res.status(403).json({
            error: "No workspace assigned to this user",
          });
        }
        ws = await CustomerWorkspace.findOne({ customerId });
      }

      if (!ws) {
        return res.status(403).json({
          error: "Workspace not configured",
        });
      }

      // Read from config.travelFlow first, fall back to legacy travelMode
      const travelFlow = ws.config?.travelFlow || ws.travelMode;

      if (!allowedFlows.includes(travelFlow)) {
        return res.status(403).json({
          error: "This flow is not enabled for your workspace",
          workspaceFlow: travelFlow,
          requiredFlow: allowedFlows,
        });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
