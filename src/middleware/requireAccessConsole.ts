// apps/backend/src/middleware/requireAccessConsole.ts
//
// Who may reach the Access Console API (routes/permissions.ts).
//
// ── WHY THIS REPLACED A PURE ROLE CHECK ───────────────────────────────
// The router used to sit behind requireSuperAdminOrTenantAdmin, i.e. a
// hard check for SUPERADMIN or TENANT_ADMIN in user.roles[]. That put the
// backend at odds with the rest of the system, which decides Access
// Console rights from the `accessConsole` MODULE PERMISSION:
//
//   router.tsx      <PermissionGuard module="accessConsole" minAccess="READ">
//   permissions.ts  requireSuperAdminOrTenantAdmin        <- disagreed
//
// The consequence was a grant that could be authored, displayed and
// audited but never honoured: wassiqa@plumtrips.com held
// accessConsole { access: FULL, scope: WORKSPACE } from 2026-07-01, passed
// the route guard, loaded the console, and got 403 on every call it made.
// A permission the product lets you grant must be a permission the server
// obeys — otherwise it is a lie told to whoever granted it.
//
// So: SUPERADMIN and TENANT_ADMIN keep working exactly as before (no
// behaviour change for anyone who works today), and TWO more doors open
// beside them -- the ADMIN role, and a holder of a non-NONE `accessConsole`
// grant.
//
// ADMIN is admitted by explicit decision (2026-08-31). It is the HRMS
// administrator role, it already administers people, onboarding, payroll and
// workspace settings, and withholding only permission management from it was
// the inconsistency that started this. At the time of the change exactly ONE
// account in production carries it -- wassiqa@plumtrips.com, People & Culture
// Manager in the HOUSE workspace -- so the practical blast radius is that one
// person; the four SaaS tenant admins carry TENANT_ADMIN and the four
// platform admins carry SUPERADMIN, neither of which this clause touches.
//
// ── WHAT A PERMISSION HOLDER CAN ACTUALLY DO ──────────────────────────
// Being admitted here is not full power. `req.isPlatformSuperAdmin` stays
// FALSE for a permission holder, exactly as it does for a TENANT_ADMIN,
// so every downstream tenant-scoping branch already in permissions.ts
// applies unchanged: /list is filtered to the caller's own workspace and
// the STAFF universe, /grant refuses users outside it, /update refuses
// docs outside it. A WORKSPACE-scoped grant therefore reaches exactly the
// caller's own workspace, which is what the scope says.
//
// `req.accessConsoleAccess` carries the tier so the router can hold write
// operations to a WRITE/FULL grant and leave READ holders read-only —
// see requireAccessConsoleWrite below.
import type { Request, Response, NextFunction } from "express";
import { isSuperAdmin } from "./isSuperAdmin.js";
import { UserPermission } from "../models/UserPermission.js";

export type AccessConsoleTier = "READ" | "WRITE" | "FULL";

function rolesOf(user: any): string[] {
  return Array.isArray(user?.roles) ? user.roles.map((r: any) => String(r).toUpperCase()) : [];
}

/**
 * Admits SUPERADMIN, TENANT_ADMIN, ADMIN, or a holder of a non-NONE
 * `accessConsole` module permission. Sets:
 *
 *   req.isPlatformSuperAdmin  true ONLY for a real platform SUPERADMIN
 *   req.accessConsoleAccess   "READ" | "WRITE" | "FULL"
 */
export async function requireAccessConsole(req: Request, res: Response, next: NextFunction) {
  const user: any = (req as any).user;
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // Path 1 — platform SUPERADMIN. isSuperAdmin() is the single source of
  // truth (and refuses the bypass while impersonating a demo user).
  if (isSuperAdmin(req)) {
    (req as any).isPlatformSuperAdmin = true;
    (req as any).accessConsoleAccess = "FULL" as AccessConsoleTier;
    return next();
  }

  const roles = rolesOf(user);

  // Path 2 — TENANT_ADMIN. Workspace-scoped power over their own tenant,
  // unchanged from requireSuperAdminOrTenantAdmin.
  if (roles.includes("TENANT_ADMIN") || roles.includes("TENANTADMIN")) {
    (req as any).isPlatformSuperAdmin = false;
    (req as any).accessConsoleAccess = "FULL" as AccessConsoleTier;
    return next();
  }

  // Path 3 — ADMIN. Workspace-scoped, exactly like a tenant admin: this sets
  // isPlatformSuperAdmin FALSE, so /list stays filtered to the caller's own
  // workspace and STAFF universe, /grant refuses users outside it, /update
  // refuses docs outside it. An ADMIN administers their own workspace's
  // people, never the platform.
  //
  // The SuperAdmin level ceiling in routes/permissions.ts
  // (refuseSuperAdminLevel) is what stops this door being a self-promotion
  // route: an ADMIN cannot grant L8 to anyone, themselves included.
  if (roles.includes("ADMIN")) {
    (req as any).isPlatformSuperAdmin = false;
    (req as any).accessConsoleAccess = "FULL" as AccessConsoleTier;
    return next();
  }

  // Path 4 — an explicit accessConsole grant, for someone who holds the
  // permission without holding one of the roles above. The only door that
  // reads the database.
  try {
    const perm = await UserPermission.findOne({ userId: String(user._id ?? user.id ?? "") })
      .select("modules.accessConsole status")
      .lean();

    const access = String((perm as any)?.modules?.accessConsole?.access ?? "NONE").toUpperCase();
    // A suspended or revoked grant is not a grant. /list already filters on
    // this for the rows it returns; the door itself must apply it too.
    const status = String((perm as any)?.status ?? "").toLowerCase();
    const statusOk = !status || status === "active";

    if (statusOk && (access === "READ" || access === "WRITE" || access === "FULL")) {
      (req as any).isPlatformSuperAdmin = false;
      (req as any).accessConsoleAccess = access as AccessConsoleTier;
      return next();
    }
  } catch (err: any) {
    // A lookup failure must not silently admit anyone.
    return res.status(500).json({ error: "Permission lookup failed" });
  }

  return res.status(403).json({
    error:
      "Forbidden: requires SuperAdmin, Admin, Tenant Admin, or an Access Console permission",
  });
}

/**
 * Write half. Mount on the routes that CHANGE permissions so a READ-only
 * accessConsole holder can look at the console without being able to
 * re-grant anything.
 */
export function requireAccessConsoleWrite(req: Request, res: Response, next: NextFunction) {
  const tier = (req as any).accessConsoleAccess as AccessConsoleTier | undefined;
  if (tier === "WRITE" || tier === "FULL") return next();
  return res.status(403).json({
    error: "Forbidden: this action requires WRITE or FULL Access Console permission",
  });
}
