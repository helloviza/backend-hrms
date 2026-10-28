// apps/backend/src/middleware/requirePlatformAdmin.ts
//
// The door in front of PLATFORM admin routes: anything that reads or writes
// another company's data, or Plumtrips-wide settings (refunds, all-customer
// billing and exports, other companies' users and permissions, TBO account,
// session logs, travel-flow config …).
//
// requireAdmin (rbac.ts) checks the role NAME only. A customer company's own
// admin (TENANT_ADMIN / WORKSPACE_ADMIN, or an ADMIN / HR role set inside a
// customer workspace) carries the same names, so on a platform route it got
// Plumtrips staff reach. This adds the missing half: the caller must also be in
// the Plumtrips HOUSE workspace. Super Admin passes as before.
//
// Tenant-scoped admin pages (every query filtered to the caller's own
// workspace) keep plain requireAdmin — see docs/audits/admin-gates-classification.md.
import type { Request, Response, NextFunction } from "express";
import { isSuperAdmin } from "./isSuperAdmin.js";
import { requireAdmin } from "./rbac.js";
import { resolveWorkspaceForUser } from "./requireWorkspace.js";

export const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";

/**
 * The caller's own workspace id as already known on the request: what
 * requireWorkspace resolved, else the staff token's workspaceId. Customer
 * tokens never carry workspaceId (routes/auth.ts), so a customer login cannot
 * read as HOUSE here. Non-SuperAdmins cannot steer requireWorkspace's value.
 */
function knownWorkspaceId(req: any): string {
  return String(
    req.workspaceObjectId ?? req.workspaceId ?? req.workspace?._id ?? req.user?.workspaceId ?? "",
  );
}

const INTERNAL_DOMAINS = new Set(["plumtrips.com", "helloviza.com"]);

/**
 * Is this token (or User document) a HOUSE login? Its workspaceId is HOUSE —
 * or it has no workspace and no customer at all and an internal email domain,
 * the same fallback resolveWorkspaceForUser applies to old staff logins that
 * predate workspace fields. A customer company's admin always carries its own
 * workspaceId or customerId, so it never matches.
 */
export function isHouseUser(user: any): boolean {
  if (!user) return false;
  const ws = String(user.workspaceId ?? "");
  if (ws) return ws === HOUSE_WORKSPACE_ID;
  if (user.customerId || user.businessId || user.vendorId) return false;
  const domain = String(user.email ?? "").split("@")[1]?.toLowerCase();
  return !!domain && INTERNAL_DOMAINS.has(domain);
}

/**
 * Synchronous HOUSE check for inline role checks inside handlers. Super Admin
 * counts as platform staff. Demo impersonation never does (isSuperAdmin
 * already refuses it, and the demo user's workspace is not HOUSE).
 * Uses the workspace requireWorkspace resolved when it ran, else the token.
 */
export function isPlatformStaff(req: any): boolean {
  if (isSuperAdmin(req)) return true;
  if (req?.user?._demoImpersonation) return false;
  const ws = String(req?.workspaceObjectId ?? req?.workspaceId ?? req?.workspace?._id ?? "");
  if (ws) return ws === HOUSE_WORKSPACE_ID;
  return isHouseUser(req?.user);
}

/**
 * Express middleware: Super Admin, or requireAdmin's roles held by a caller in
 * the HOUSE workspace. Works with or without requireWorkspace in front: when
 * nothing on the request names a workspace it resolves the caller's own the
 * same way requireWorkspace does, and refuses when none is found.
 */
export async function requirePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  if (isSuperAdmin(req)) return next();
  try {
    let ws = knownWorkspaceId(req);
    if (!ws && isHouseUser((req as any).user)) ws = HOUSE_WORKSPACE_ID;
    if (!ws && (req as any).user) {
      const resolved = await resolveWorkspaceForUser((req as any).user, "_id");
      ws = resolved?._id ? String(resolved._id) : "";
    }
    if (ws !== HOUSE_WORKSPACE_ID) {
      return res.status(403).json({ message: "Plumtrips staff access required" });
    }
  } catch (err) {
    return next(err);
  }
  return requireAdmin(req, res, next);
}

/**
 * Express middleware: Super Admin, or any caller in the HOUSE workspace —
 * no role requirement. For Plumtrips surfaces whose own per-route grant
 * (requirePermission) decides who among the staff may act, e.g. the staff
 * invoice console, where HOUSE employees hold the invoices grant without an
 * admin role. Resolves the workspace the same way requirePlatformAdmin does.
 */
export async function requirePlatformStaff(req: Request, res: Response, next: NextFunction) {
  if (isSuperAdmin(req)) return next();
  if ((req as any).user?._demoImpersonation) {
    return res.status(403).json({ message: "Plumtrips staff access required" });
  }
  try {
    let ws = knownWorkspaceId(req);
    if (!ws && isHouseUser((req as any).user)) ws = HOUSE_WORKSPACE_ID;
    if (!ws && (req as any).user) {
      const resolved = await resolveWorkspaceForUser((req as any).user, "_id");
      ws = resolved?._id ? String(resolved._id) : "";
    }
    if (ws !== HOUSE_WORKSPACE_ID) {
      return res.status(403).json({ message: "Plumtrips staff access required" });
    }
  } catch (err) {
    return next(err);
  }
  return next();
}

export default requirePlatformAdmin;

/**
 * Roles a customer company's own admin may hand out inside its own workspace.
 * Anything else — SUPERADMIN, OPS, STAFF, INTERNAL, SYSTEM … — is a Plumtrips
 * role. Before this, POST /api/employees, PUT /api/employees/:id,
 * /api/users/create-staff and /api/users/admin/grant-access copied the role
 * from the request body, so a tenant admin could make itself SUPERADMIN.
 * Compared with separators stripped, like rbac.ts norm().
 */
const TENANT_ASSIGNABLE_ROLES = new Set(
  [
    "EMPLOYEE", "MANAGER", "HR", "HR_MANAGER", "HR_ADMIN", "ADMIN", "FINANCE",
    "TENANT_ADMIN", "WORKSPACE_ADMIN", "WORKSPACE_LEADER", "APPROVER", "REQUESTER", "TRAVELLER",
  ].map((r) => r.replace(/[\s\-_]/g, "")),
);

/**
 * null when the caller may assign every role in `roles`; otherwise a refusal
 * message naming the first role it may not. Super Admin and HOUSE staff are
 * unchanged (no restriction here).
 */
export function roleAssignmentRefusal(req: any, roles: unknown): string | null {
  if (isPlatformStaff(req)) return null;
  const list = (Array.isArray(roles) ? roles : [roles]).filter((r) => r != null && String(r).trim() !== "");
  for (const r of list) {
    const n = String(r).trim().toUpperCase().replace(/[\s\-_]/g, "");
    if (!TENANT_ASSIGNABLE_ROLES.has(n)) {
      return `Only Plumtrips can assign the role ${String(r).toUpperCase()}`;
    }
  }
  return null;
}
