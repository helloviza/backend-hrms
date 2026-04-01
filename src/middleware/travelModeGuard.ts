// apps/backend/src/middleware/travelModeGuard.ts
import type { Request, Response, NextFunction } from "express";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

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
