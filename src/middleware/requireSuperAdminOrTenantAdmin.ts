import type { Request, Response, NextFunction } from "express";

/**
 * Allows the request to proceed if the caller is either:
 * - A platform SuperAdmin (full power across all workspaces), OR
 * - A TENANT_ADMIN (workspace-scoped power; downstream handlers must
 *   enforce workspaceId scoping)
 *
 * Sets req.isPlatformSuperAdmin = true for SuperAdmin callers, so
 * downstream handlers can branch on scope.
 */
export function requireSuperAdminOrTenantAdmin(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const user: any = (req as any).user;
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const roles: string[] = Array.isArray(user.roles)
    ? user.roles.map((r: any) => String(r).toUpperCase())
    : [];
  const isSuper = roles.includes("SUPERADMIN");
  const isTenantAdmin =
    roles.includes("TENANT_ADMIN") || roles.includes("TENANTADMIN");

  if (!isSuper && !isTenantAdmin) {
    return res
      .status(403)
      .json({ error: "Forbidden: requires SuperAdmin or Tenant Admin" });
  }

  (req as any).isPlatformSuperAdmin = isSuper;
  next();
}
