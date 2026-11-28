// apps/backend/src/middleware/rbac.ts
import type { Request, Response, NextFunction } from "express";
import { isSuperAdmin } from "./isSuperAdmin.js";

function norm(v: any) {
  return String(v ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s\-_]/g, "");
}

function collectRoles(user: any): string[] {
  if (!user) return [];
  const out: string[] = [];

  // common shapes across HRMS
  if (Array.isArray(user.roles)) out.push(...user.roles);
  if (user.role) out.push(user.role);
  if (user.userType) out.push(user.userType);
  if (user.accountType) out.push(user.accountType);
  if (user.hrmsAccessRole) out.push(user.hrmsAccessRole);
  if (user.hrmsAccessLevel) out.push(user.hrmsAccessLevel);

  return out.map(norm).filter(Boolean);
}

function hasAnyRole(user: any, allowed: string[]) {
  const roles = collectRoles(user);
  const wanted = allowed.map(norm);
  return roles.some((r) => wanted.includes(r));
}

/** The decision requireAdmin makes, as a side-effect-free predicate. */
export function isAdminRequest(req: Request): boolean {
  if (isSuperAdmin(req)) return true;

  const user: any = (req as any).user;

  // ✅ treat these as admin/staff privileged roles
  return hasAnyRole(user, [
    "ADMIN",
    "SUPERADMIN",
    "SUPER_ADMIN",
    "HR",
    "HR_ADMIN",
    "OPS",
    "OPS_ADMIN",
    "TENANT_ADMIN",
    "WORKSPACE_ADMIN",
  ]);
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ message: "Admin access required" });
  }

  return next();
}
