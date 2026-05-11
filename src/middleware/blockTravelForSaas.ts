import type { Request, Response, NextFunction } from "express";
import { isSuperAdmin } from "./isSuperAdmin.js";
import { verifyToken } from "../utils/jwt.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import User from "../models/User.js";

/**
 * TRAVEL_BLOCKED_PREFIXES
 * Routes that SaaS HRMS tenants must not reach by default. Plumtrips and
 * Travel customer workspaces are unaffected. SUPERADMIN bypasses for ops
 * debugging.
 *
 * `allowFlags` (optional): if SuperAdmin has enabled at least one of the
 * named features on the workspace's `config.features`, the block is lifted
 * for that prefix. This is how a SAAS_HRMS tenant earns access to SBT or
 * approval routes after SuperAdmin grants the corresponding flag.
 *
 * Prefixes WITHOUT `allowFlags` remain blanket-blocked for SAAS_HRMS — they
 * are HOUSE-only operational tools (manual bookings, invoices for Travel,
 * vouchers, vendors/customers, CRM, billing, etc.).
 */
type BlockedPrefix = {
  prefix: string;
  allowFlags?: Array<keyof WorkspaceFeatureFlags>;
};

type WorkspaceFeatureFlags = {
  sbtEnabled?: boolean;
  approvalFlowEnabled?: boolean;
  approvalDirectEnabled?: boolean;
  [key: string]: boolean | undefined;
};

const TRAVEL_BLOCKED_PREFIXES: BlockedPrefix[] = [
  // SBT — lifted when SuperAdmin enables sbtEnabled
  { prefix: "/api/sbt", allowFlags: ["sbtEnabled"] },
  { prefix: "/api/admin/sbt", allowFlags: ["sbtEnabled"] },

  // Travel-approval flow — lifted when either approval feature is enabled
  { prefix: "/api/proposals", allowFlags: ["approvalFlowEnabled", "approvalDirectEnabled"] },
  { prefix: "/api/admin/proposals", allowFlags: ["approvalFlowEnabled", "approvalDirectEnabled"] },
  { prefix: "/api/approvals/admin", allowFlags: ["approvalFlowEnabled", "approvalDirectEnabled"] },

  // HOUSE-only — always blocked for SAAS_HRMS regardless of flags
  { prefix: "/api/v1/flights" },
  { prefix: "/api/travel-forms" },
  { prefix: "/api/booking-history" },
  { prefix: "/api/v1/copilot/travel" },
  { prefix: "/api/admin/manual-bookings" },
  { prefix: "/api/admin/invoices" },
  { prefix: "/api/admin/reports" },
  { prefix: "/api/admin/unified" },
  { prefix: "/api/admin/billing" },
  { prefix: "/api/admin/tasks" },
  { prefix: "/api/admin/tickets" },
  { prefix: "/api/admin/analytics" },
  { prefix: "/api/admin/email-templates" },
  { prefix: "/api/admin/company-settings" },
  { prefix: "/api/admin/payment-orphans" },
  { prefix: "/api/admin/task-automations" },
  { prefix: "/api/admin/account-team" },
  { prefix: "/api/admin/direct-customers" },
  { prefix: "/api/admin/eod-report" },
  { prefix: "/api/admin/vouchers" },
  { prefix: "/api/preview" },
  { prefix: "/api/leads" },
  { prefix: "/api/crm" },
  { prefix: "/api/vouchers" },
  { prefix: "/api/eod-report" },
  { prefix: "/api/presence" },
];

const WS_SELECT = "_id customerId tenantType status config";

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
 *  - SAAS_HRMS workspaces where the matched prefix has `allowFlags` and
 *    SuperAdmin has enabled at least one of them on `config.features`
 *    (e.g. /api/sbt → sbtEnabled; /api/proposals → approval* flags)
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

  const matched = TRAVEL_BLOCKED_PREFIXES.find(
    (entry) => fullPath === entry.prefix || fullPath.startsWith(entry.prefix + "/"),
  );
  if (!matched) {
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

  // SAAS_HRMS tenant hitting a blocked prefix. If this prefix has allowFlags
  // and the workspace has at least one of them enabled, lift the block.
  if (matched.allowFlags && matched.allowFlags.length > 0) {
    const features: WorkspaceFeatureFlags =
      (workspace?.config?.features as WorkspaceFeatureFlags) || {};
    const granted = matched.allowFlags.some((flag) => features[flag] === true);
    if (granted) {
      next();
      return;
    }
  }

  res.status(403).json({
    success: false,
    error: "TRAVEL_MODULE_BLOCKED",
    message: "This module is not available on SaaS HRMS plans.",
    route: req.originalUrl,
  });
}
