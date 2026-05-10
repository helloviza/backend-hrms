import type { Request, Response, NextFunction } from "express";
import { isSuperAdmin } from "./isSuperAdmin.js";
import { verifyToken } from "../utils/jwt.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import User from "../models/User.js";

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
  "/api/admin/email-templates",
  "/api/admin/company-settings",
  "/api/admin/payment-orphans",
  "/api/admin/task-automations",
  "/api/admin/proposals",
  "/api/admin/account-team",
  "/api/admin/direct-customers",
  "/api/admin/eod-report",
  "/api/admin/vouchers",
  "/api/proposals",
  "/api/preview",
  "/api/leads",
  "/api/crm",
  "/api/vouchers",
  "/api/approvals/admin",
  "/api/eod-report",
  "/api/presence",
];

const WS_SELECT = "_id customerId tenantType status";

function getTokenFromRequest(req: Request): string | null {
  const hdr = req.headers.authorization;
  if (hdr && hdr.startsWith("Bearer ")) {
    const t = hdr.slice("Bearer ".length).trim();
    if (t) return t;
  }
  const cookies: Record<string, unknown> = ((req as any).cookies || {}) as any;
  const raw =
    cookies.hrms_accessToken ||
    cookies.accessToken ||
    cookies.token ||
    cookies.jwt ||
    cookies.auth ||
    null;
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.toLowerCase().startsWith("bearer ")) {
    const t = s.slice(7).trim();
    return t || null;
  }
  return s;
}

function payloadIsSuperAdmin(payload: any): boolean {
  if (!payload) return false;
  const roles: string[] = Array.isArray(payload.roles)
    ? payload.roles.map((r: any) => String(r).toUpperCase())
    : [];
  return (
    roles.includes("SUPERADMIN") ||
    String(payload.role || "").toUpperCase() === "SUPERADMIN" ||
    payload.isSuperAdmin === true
  );
}

async function resolveWorkspaceForUser(payload: any): Promise<any | null> {
  const directId =
    payload?.workspaceId || payload?.customerId || payload?.businessId || null;

  if (directId) {
    const idStr = String(directId);
    let ws: any = null;
    try {
      ws = await CustomerWorkspace.findById(idStr).select(WS_SELECT).lean();
    } catch {
      // _id parse failed — fall through to customerId lookup
    }
    if (!ws) {
      ws = await CustomerWorkspace.findOne({ customerId: idStr })
        .select(WS_SELECT)
        .lean();
    }
    if (ws) return ws;
  }

  // DB fallback: User → workspaceId for legacy JWTs that didn't carry it.
  const userId = payload?.sub || payload?.id || payload?._id;
  if (!userId) return null;
  try {
    const userDoc: any = await User.findById(String(userId))
      .select("workspaceId")
      .lean();
    if (userDoc?.workspaceId) {
      return CustomerWorkspace.findById(String(userDoc.workspaceId))
        .select(WS_SELECT)
        .lean();
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * blockTravelForSaas
 *
 * Returns 403 if the requesting user belongs to a SaaS HRMS workspace
 * AND the request path matches a Travel-only route prefix.
 *
 * This middleware is self-sufficient: it resolves the user via JWT and
 * the workspace via the DB on each request that hits a blocked prefix.
 * That makes it work whether mounted globally at /api (before any
 * requireAuth has run) or inside a per-route chain after requireAuth +
 * requireWorkspace. It uses req.originalUrl so prefix matching stays
 * correct in both mount positions.
 *
 * Bypasses:
 *  - SUPERADMIN role (for Plumtrips ops debugging)
 *  - Workspaces where tenantType is not "SAAS_HRMS" (Plumtrips + Travel customers)
 *  - Unauthenticated requests (let downstream auth return 401)
 *  - Paths that don't match any blocked prefix (fast-path)
 */
export async function blockTravelForSaas(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Use the full original URL (without query string) so prefix matching
  // works whether this middleware is mounted globally at /api or inside
  // a per-route chain (where req.path becomes mount-relative).
  const fullPath = (req.originalUrl || req.url || "").split("?")[0];

  const matchedPrefix = TRAVEL_BLOCKED_PREFIXES.find(
    (prefix) => fullPath === prefix || fullPath.startsWith(prefix + "/"),
  );
  if (!matchedPrefix) {
    next();
    return;
  }

  // Prefer an already-authenticated user; otherwise verify the JWT inline.
  let payload: any = (req as any).user;
  if (!payload) {
    const token = getTokenFromRequest(req);
    if (!token) {
      // Let downstream auth handle the 401.
      next();
      return;
    }
    try {
      payload = verifyToken(token);
    } catch {
      next();
      return;
    }
  }

  // SUPERADMIN bypass — works for both raw JWT payloads and the merged
  // user that requireAuth attaches.
  if ((req as any).user ? isSuperAdmin(req) : payloadIsSuperAdmin(payload)) {
    next();
    return;
  }

  let workspace: any = (req as any).workspace;
  if (!workspace) {
    workspace = await resolveWorkspaceForUser(payload);
  }

  if (!workspace || workspace.tenantType !== "SAAS_HRMS") {
    next();
    return;
  }

  res.status(403).json({
    success: false,
    error: "TRAVEL_MODULE_BLOCKED",
    message: "This module is not available on SaaS HRMS plans.",
    route: req.originalUrl,
  });
}
