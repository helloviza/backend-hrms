// apps/backend/src/middleware/auth.ts
import type { Request, Response, NextFunction } from "express";
import { verifyToken } from "../utils/jwt.js";

function normBool(v: unknown): boolean {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "y";
}

function normEmail(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

function normStr(v: unknown): string {
  const s = String(v ?? "").trim();
  return s || "";
}

function getBearerToken(req: Request): string | null {
  const hdr = req.headers.authorization;
  if (!hdr) return null;
  if (!hdr.startsWith("Bearer ")) return null;
  const token = hdr.slice("Bearer ".length).trim();
  return token || null;
}

/** ✅ read token from cookies for <a href> downloads */
function getCookieToken(req: Request): string | null {
  const c: Record<string, unknown> = ((req as any).cookies || {}) as any;

  const raw =
    c.hrms_accessToken ||
    c.accessToken ||
    c.token ||
    c.jwt ||
    c.auth ||
    null;

  if (!raw) return null;

  const s = String(raw).trim();
  if (!s) return null;

  // tolerate "Bearer xxx" stored as cookie value (just in case)
  if (s.toLowerCase().startsWith("bearer ")) {
    const t = s.slice(7).trim();
    return t || null;
  }

  return s;
}

function parseRolesHeader(v: unknown): string[] {
  if (!v) return [];
  const s = String(v);
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.toUpperCase());
}

function uniqUpper(list: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of list || []) {
    const s = String(v ?? "").trim().toUpperCase();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Normalize/alias IDs so all routes can rely on consistent fields:
 * - customerId == businessId (for Business workspace scope)
 * - vendorId present if any vendor-ish id exists
 */
function normalizeWorkspaceIds(payload: any) {
  const p = payload || {};

  const customerId =
    p.customerId ||
    p.customer_id ||
    p.businessId ||
    p.business_id ||
    p.workspaceCustomerId ||
    p.workspace_id ||
    p.customerWorkspaceId ||
    p.workspaceId ||
    null;

  const vendorId = p.vendorId || p.vendor_id || p.vendorProfileId || null;

  if (customerId) {
    p.customerId = String(customerId);
    p.businessId = String(customerId);
  }
  if (vendorId) {
    p.vendorId = String(vendorId);
  }

  return p;
}

/**
 * DEV BYPASS USER
 */
function attachDevUser(req: Request) {
  const email = normEmail(req.headers["x-dev-email"] || "dev@local");
  const officialEmail = normEmail(req.headers["x-dev-official-email"] || email);
  const sub = normStr(req.headers["x-dev-sub"] || "dev-user");

  const parsed = parseRolesHeader(req.headers["x-dev-roles"]);
  const roles = parsed.length ? parsed : ["SUPERADMIN"]; // fallback

  const name = normStr(req.headers["x-dev-name"] || "Dev User");

  const q: any = (req as any).query || {};

  const headerCustomerId =
    normStr(req.headers["x-dev-customer-id"]) ||
    normStr(req.headers["x-dev-business-id"]) ||
    normStr(q.customerId) ||
    normStr(process.env.DEV_CUSTOMER_ID) ||
    normStr(process.env.DEFAULT_CUSTOMER_BUSINESS_ID) ||
    normStr(process.env.DEFAULT_BUSINESS_ID);

  const headerVendorId =
    normStr(req.headers["x-dev-vendor-id"]) || normStr(q.vendorId);

  const accountType =
    roles.includes("CUSTOMER") || roles.includes("BUSINESS")
      ? "CUSTOMER"
      : roles.includes("VENDOR")
      ? "VENDOR"
      : "EMPLOYEE";

  const devUser: any = {
    sub,
    _id: sub,
    id: sub,
    email,
    officialEmail,
    name,
    roles,
    role: roles[0],
    accountType,
    userType: accountType,
    hrmsAccessRole: roles.includes("HR") ? "HR" : roles[0],
    hrmsAccessLevel:
      roles.includes("SUPERADMIN") || roles.includes("SUPER_ADMIN")
        ? "SUPERADMIN"
        : roles[0],
  };

  if (headerCustomerId) {
    devUser.customerId = String(headerCustomerId);
    devUser.businessId = String(headerCustomerId);
  }
  if (headerVendorId) {
    devUser.vendorId = String(headerVendorId);
  }

  (req as any).user = devUser;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const disableAuth = normBool(process.env.DISABLE_AUTH);

  // ✅ DEV BYPASS — blocked in production
  if (disableAuth) {
    if (process.env.NODE_ENV === "production") {
      console.error("[SECURITY] DISABLE_AUTH=true is not allowed in production. Ignoring.");
    } else {
      attachDevUser(req);
      return next();
    }
  }

  // ✅ NORMAL AUTH (Bearer token OR Cookie token)
  const token = getBearerToken(req) || getCookieToken(req);
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    const payload: any = verifyToken(token);

    normalizeWorkspaceIds(payload);

    const roles = uniqUpper([
      ...(Array.isArray(payload?.roles) ? payload.roles : []),
      payload?.role,
      payload?.accountType,
      payload?.userType,
      payload?.hrmsAccessRole,
      payload?.hrmsAccessLevel,
    ]);

    // compute a stable accountType even if token doesn't include it
    const upperRoles = roles.map((r) => String(r).toUpperCase());
    const accountType =
      payload?.accountType ||
      payload?.userType ||
      (upperRoles.includes("VENDOR") ? "VENDOR" : upperRoles.includes("CUSTOMER") || upperRoles.includes("BUSINESS") ? "CUSTOMER" : "EMPLOYEE");

    const merged: any = {
      ...payload,
      sub: normStr(payload?.sub || payload?._id || payload?.id),
      id: normStr(payload?.id || payload?._id || payload?.sub),
      _id: normStr(payload?._id || payload?.id || payload?.sub),
      email: normEmail(payload?.email),
      officialEmail: normEmail(payload?.officialEmail || payload?.official_email || ""),
      roles,
      accountType,
      userType: accountType,
    };

    normalizeWorkspaceIds(merged);

    (req as any).user = merged;
    return next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

export default requireAuth;
