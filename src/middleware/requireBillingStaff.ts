// apps/backend/src/middleware/requireBillingStaff.ts
//
// The door in front of the STAFF invoice and credit-note routers
// (/api/admin/invoices, /api/admin/credit-notes). It only decides WHO may knock;
// what they may do is decided per route by requirePermission("invoices" |
// "creditnotes", READ / WRITE / FULL) — the grant given in /admin/access.
//
// Admits:
//   1. Super Admin.
//   2. Anyone requireAdmin admitted before (ADMIN / HR / OPS / TENANT_ADMIN /
//      WORKSPACE_ADMIN …) — unchanged, so no tenant loses or gains anything.
//   3. Plumtrips staff at ANY level: a caller in the HOUSE workspace who is not
//      a customer or vendor account. Before this, an L1–L4 Plumtrips employee
//      (role EMPLOYEE / MANAGER) holding the grant was refused here with
//      "Admin access required", so the grant alone never opened billing.
//
// Never admits customer or vendor accounts through (3), whatever workspace they
// sit in. Tenant isolation inside the routers (invoiceTenantClause etc.) is
// untouched.
import type { Request, Response, NextFunction } from "express";
import { isSuperAdmin } from "./isSuperAdmin.js";
import { requireAdmin } from "./rbac.js";

const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";

const norm = (v: unknown) => String(v ?? "").trim().toUpperCase().replace(/[\s\-_]/g, "");

const EXTERNAL_MARKERS = new Set([
  "CUSTOMER", "BUSINESS", "CLIENT", "CORPORATE", "VENDOR", "SUPPLIER",
  "WORKSPACELEADER", "REQUESTER", "APPROVER", "TRAVELLER", "TRAVELER",
]);

/** A customer / vendor account — never staff, whatever its workspace. */
export function isExternalAccount(user: any): boolean {
  if (!user) return true;
  if (user.customerMemberRole) return true;
  const signals = [
    ...(Array.isArray(user.roles) ? user.roles : []),
    user.role, user.userType, user.accountType,
  ].map(norm).filter(Boolean);
  return signals.some((s) => EXTERNAL_MARKERS.has(s));
}

function isHouseStaff(req: any): boolean {
  const ws = String(req.workspaceObjectId ?? req.workspaceId ?? req.user?.workspaceId ?? "");
  return ws === HOUSE_WORKSPACE_ID && !isExternalAccount(req.user);
}

export function requireBillingStaff(req: Request, res: Response, next: NextFunction) {
  if (isSuperAdmin(req)) return next();
  if (isHouseStaff(req)) return next();
  return requireAdmin(req, res, next);
}
