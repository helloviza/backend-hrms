import type { Request } from "express";

/**
 * Single source of truth for SUPERADMIN detection.
 * SUPERADMIN bypasses all workspace, role, and feature middleware.
 */
export const isSuperAdmin = (req: Request): boolean => {
  const user = (req as any).user;
  if (!user) return false;
  // Demo Platform — refuse SUPERADMIN bypass while impersonating a demo user.
  // Closes the SUPERADMIN escalation hole identified in Demo Platform audit §5.
  if (user._demoImpersonation) return false;
  const roles: string[] = Array.isArray(user.roles) ? user.roles : [];
  return (
    roles.includes("SUPERADMIN") ||
    user.role === "SUPERADMIN" ||
    user.isSuperAdmin === true
  );
};
