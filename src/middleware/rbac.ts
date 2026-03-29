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

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (isSuperAdmin(req)) return next();

  const user: any = (req as any).user;

  // ✅ treat these as admin/staff privileged roles
  const ok = hasAnyRole(user, [
    "ADMIN",
    "SUPERADMIN",
    "SUPER_ADMIN",
    "HR",
    "HR_ADMIN",
    "OPS",
    "OPS_ADMIN",
  ]);

  if (!ok) {
    return res.status(403).json({ message: "Admin access required" });
  }

  return next();
}
