import { Request, Response, NextFunction } from "express";
import { isSuperAdmin } from "./isSuperAdmin.js";

/**
 * TRAVEL_BLOCKED_PREFIXES
 * Routes that SaaS HRMS tenants must not reach. Plumtrips and Travel
 * customer workspaces are unaffected. SUPERADMIN bypasses for ops debugging.
 */
const TRAVEL_BLOCKED_PREFIXES = [
  "/api/sbt",
  "/api/v1/flights",
  "/api/travel-forms",
  "/api/booking-history",
  "/api/v1/copilot/travel",
  "/api/admin/manual-bookings",
  "/api/admin/invoices",
  "/api/admin/reports",
  "/api/admin/unified",
  "/api/admin/billing",
  "/api/admin/sbt",
  "/api/admin/tasks",
  "/api/admin/tickets",
  "/api/admin/analytics",
  "/api/leads",
  "/api/crm",
  "/api/vouchers",
  "/api/approvals/admin",
];

/**
 * blockTravelForSaas
 *
 * Returns 403 if the requesting user belongs to a SaaS HRMS workspace
 * AND the request path matches a Travel-only route prefix.
 *
 * Mount AFTER requireWorkspace (which sets req.workspace) and BEFORE
 * individual route handlers.
 *
 * Bypasses:
 *  - SUPERADMIN role (for Plumtrips ops debugging)
 *  - Workspaces where tenantType is not "SAAS_HRMS" (Plumtrips + Travel customers)
 *  - Unauthenticated requests (no req.user — already filtered by requireAuth/requireWorkspace)
 */
export function blockTravelForSaas(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // No workspace context yet → let downstream middleware decide
  const workspace = (req as any).workspace;
  if (!workspace) {
    return next();
  }

  // Not a SaaS HRMS tenant → unaffected
  if (workspace.tenantType !== "SAAS_HRMS") {
    return next();
  }

  // SUPERADMIN bypass for ops debugging
  if (isSuperAdmin(req)) {
    return next();
  }

  // Check path against blocked prefixes
  const path = req.path; // e.g. "/admin/manual-bookings/123"
  // req.path is the path AFTER the mount point. server.ts mounts this
  // middleware at /api, so we strip /api from the comparison list and
  // match against req.path directly.
  const isBlocked = TRAVEL_BLOCKED_PREFIXES.some((prefix) => {
    const stripped = prefix.replace(/^\/api/, "");
    return path === stripped || path.startsWith(stripped + "/");
  });

  if (isBlocked) {
    res.status(403).json({
      success: false,
      error: "TRAVEL_MODULE_BLOCKED",
      message: "This module is not available on SaaS HRMS plans.",
      route: req.originalUrl,
    });
    return;
  }

  return next();
}
