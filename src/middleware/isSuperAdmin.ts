import type { Request } from "express";

/**
 * Single source of truth for SUPERADMIN detection.
 * SUPERADMIN bypasses all workspace, role, and feature middleware.
 */
export const isSuperAdmin = (req: Request): boolean => {
  const user = (req as any).user;
  if (!user) return false;
  const roles: string[] = Array.isArray(user.roles) ? user.roles : [];
  return (
    roles.includes("SUPERADMIN") ||
    user.role === "SUPERADMIN" ||
    user.isSuperAdmin === true
  );
};
