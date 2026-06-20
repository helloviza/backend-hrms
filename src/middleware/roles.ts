import type { Request, Response, NextFunction } from "express";
import { isSuperAdmin } from "./isSuperAdmin.js";

/**
 * Role aliases — lets workspace-specific role names pass
 * the same guards as canonical roles.
 */
const ROLE_ALIASES: Record<string, string[]> = {
  ADMIN: ["ADMIN", "WORKSPACE_ADMIN", "TENANT_ADMIN"],
  HR: ["HR", "HR_MANAGER"],
  MANAGER: ["MANAGER"],
  EMPLOYEE: ["EMPLOYEE"],
  // Dedicated finance capability role (Expense Management). Recognized here so
  // requireRoles("FINANCE") is first-class; assignment UI lands in a later step.
  FINANCE: ["FINANCE"],
};

export function requireRoles(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (isSuperAdmin(req)) return next();
    const u = (req as any).user as { roles?: string[] };
    const userRoles = u?.roles ?? [];
    const hasRole = roles.some((required) => {
      const aliases = ROLE_ALIASES[required] || [required];
      return userRoles.some((ur) => aliases.includes(ur));
    });
    if (!hasRole) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}

export default requireRoles;
