import type { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import { isSuperAdmin } from "./isSuperAdmin.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import User from "../models/User.js";
import WorkspaceMembership from "../models/WorkspaceMembership.js";

/* ── Extend Express Request with workspace fields ───────────────── */
declare global {
  namespace Express {
    interface Request {
      workspaceId: string;
      workspaceObjectId: mongoose.Types.ObjectId;
      workspace?: any; // resolved workspace document
    }
  }
}

const CUSTOMER_ROLES = new Set([
  "CUSTOMER",
  "WORKSPACE_LEADER",
  "REQUESTER",
  "APPROVER",
  "BUSINESS",
]);

// TENANT_ADMIN is a staff role — it takes the staff (findById) path
// even if the user also carries WORKSPACE_LEADER in their roles array.
const STAFF_OVERRIDE_ROLES = new Set([
  "TENANT_ADMIN",
  "ADMIN",
  "SUPERADMIN",
  "HR",
  "HR_ADMIN",
  "MANAGER",    // internal Plumtrips staff
  "EMPLOYEE",   // internal Plumtrips staff
  "LEAD",       // internal role key (Role.ts)
  "TEAM_LEAD",  // internal role key (Role.ts)
  "OWNER",      // internal role key (Role.ts)
]);

export function isCustomerUser(user: any): boolean {
  const roles: string[] = Array.isArray(user?.roles)
    ? user.roles.map((r: string) => String(r).toUpperCase())
    : [];
  // If any staff-override role is present, treat as staff regardless
  if (roles.some((r) => STAFF_OVERRIDE_ROLES.has(r))) return false;
  return roles.some((r) => CUSTOMER_ROLES.has(r));
}

const WS_SELECT = "_id customerId status config travelMode tenantType";

/**
 * resolveWorkspaceById — resolves by workspace _id, then falls back to customerId.
 * Used for staff users whose JWT carries a reliable workspaceId.
 */
async function resolveWorkspaceById(raw: string, select: string) {
  let workspace = await CustomerWorkspace.findById(raw)
    .select(select)
    .lean();
  if (!workspace) {
    workspace = await CustomerWorkspace.findOne({ customerId: raw })
      .select(select)
      .lean();
  }
  return workspace;
}

/**
 * resolveWorkspaceByCustomerId — resolves directly via customerId field.
 * Used for customer-type users where workspaceId in JWT may be stale/wrong.
 */
async function resolveWorkspaceByCustomerId(customerId: string, select: string) {
  return CustomerWorkspace.findOne({ customerId })
    .select(select)
    .lean();
}

/**
 * resolveWorkspaceForUser — THE single source of truth for "which
 * CustomerWorkspace does this user belong to." Customer-type users (per
 * isCustomerUser) resolve via customerId — their JWT/DB workspaceId may be
 * stale or point at the wrong workspace (the exact defect that let a
 * customer's /auth/me response return the Plumtrips HOUSE workspace object).
 * Staff users resolve via workspaceId first (reliable for them), falling
 * back to customerId.
 *
 * Every caller that needs "the current user's own workspace" — requireWorkspace
 * below AND GET /auth/me — MUST go through this function rather than
 * hand-rolling their own findById(user.workspaceId). That drift (auth.ts had
 * its own unconditional findById) is exactly what caused the bug; keeping
 * one resolver is what prevents it recurring.
 *
 * `select` lets each caller request only the fields it needs in a single
 * query (requireWorkspace's lightweight WS_SELECT vs /auth/me's richer
 * company-profile fields) without duplicating the resolution algorithm.
 */
export async function resolveWorkspaceForUser(
  user: any,
  select: string = WS_SELECT,
): Promise<any | null> {
  const customerRaw = user?.customerId ?? user?.businessId ?? null;
  const staffRaw = user?.workspaceId ?? user?.customerId ?? user?.businessId ?? null;

  let raw: string | null = isCustomerUser(user) ? customerRaw : staffRaw;

  if (!raw) {
    // JWT/DB record predates workspace fields — DB fallback for existing sessions
    try {
      const userId = user?.sub || user?.id || user?._id;
      if (userId) {
        const userDoc: any = await User.findById(userId)
          .select("workspaceId email")
          .lean();
        if (userDoc?.workspaceId) {
          raw = String(userDoc.workspaceId);
        } else if (userDoc?.email) {
          const domain = String(userDoc.email).split("@")[1]?.toLowerCase();
          const INTERNAL_DOMAINS = new Set(["plumtrips.com", "helloviza.com"]);
          if (domain && INTERNAL_DOMAINS.has(domain)) {
            raw = "69679a7628330a58d29f2254";
          }
        }
      }
    } catch (dbErr) {
      console.error("[resolveWorkspaceForUser] DB fallback failed", dbErr);
    }
  }

  if (!raw) return null;

  return isCustomerUser(user)
    ? resolveWorkspaceByCustomerId(String(raw), select)
    : resolveWorkspaceById(String(raw), select);
}

/* ── Session membership (company switcher Phase 2) ───────────────
 * A token minted from a WorkspaceMembership carries wsid (CustomerWorkspace
 * _id), mid (membership _id) and mver (its tokenVersion). Such a session is
 * bound to exactly that workspace for as long as the membership stays ACTIVE
 * at the same tokenVersion. Tokens without wsid keep the legacy resolution.
 * docs/audits/multi-workspace-login-audit.md §2.6, §8.2.
 *
 * MEMBERSHIP_SESSION_DISABLED=true is the rollback: nothing is stamped and
 * wsid/mid are ignored everywhere, i.e. exactly the pre-Phase-2 behaviour.
 */
export function membershipSessionEnabled(): boolean {
  return String(process.env.MEMBERSHIP_SESSION_DISABLED || "").trim().toLowerCase() !== "true";
}

// Per-request check is one _id lookup, cached in-process for ≤60s keyed by
// mid — so a suspension or tokenVersion bump reaches open sessions within a
// minute (refresh always reads the DB, never this cache).
const MEMBERSHIP_CACHE_TTL_MS = 60_000;
const MEMBERSHIP_CACHE_MAX = 10_000;
const membershipCache = new Map<string, { m: any | null; at: number }>();

export function clearMembershipCache(mid?: string): void {
  if (mid) membershipCache.delete(String(mid));
  else membershipCache.clear();
}

// The fields the session check needs, plus what services/activeMembership.ts
// reads for the per-company roles and flags — one cached row serves both.
const SESSION_MEMBERSHIP_SELECT =
  "userId workspaceId status tokenVersion customerId kind roles memberRole flags isDefault";

async function loadMembershipCached(mid: string): Promise<any | null> {
  const hit = membershipCache.get(mid);
  if (hit && Date.now() - hit.at < MEMBERSHIP_CACHE_TTL_MS) return hit.m;
  const m = await WorkspaceMembership.findById(mid).select(SESSION_MEMBERSHIP_SELECT).lean();
  if (membershipCache.size >= MEMBERSHIP_CACHE_MAX) membershipCache.clear();
  membershipCache.set(mid, { m: m ?? null, at: Date.now() });
  return m ?? null;
}

const isOidStr = (v: unknown) => /^[a-fA-F0-9]{24}$/.test(String(v ?? "").trim());

/**
 * The membership named by these token claims, if it is still the live session
 * for this user (same user, same workspace, ACTIVE, same tokenVersion) — else
 * null. Read through the same ≤60s cache as requireWorkspace.
 */
export async function loadSessionMembership(claims: any): Promise<any | null> {
  const mid = String(claims?.mid ?? "").trim();
  const wsid = String(claims?.wsid ?? "").trim();
  const sub = String(claims?.sub ?? claims?._id ?? claims?.id ?? "").trim();
  if (!isOidStr(mid) || !isOidStr(wsid) || !sub) return null;
  const m = await loadMembershipCached(mid);
  const live =
    !!m &&
    String(m.userId) === sub &&
    String(m.workspaceId) === wsid &&
    m.status === "ACTIVE" &&
    Number(m.tokenVersion ?? 0) === Number(claims.mver);
  return live ? m : null;
}

/** Is the membership named by these token claims still the live session for this user? */
export async function verifySessionMembership(claims: any): Promise<boolean> {
  return !!(await loadSessionMembership(claims));
}

export const MEMBERSHIP_REVOKED_BODY = {
  success: false,
  error: "Your access to this workspace has changed. Please sign in again.",
  code: "MEMBERSHIP_REVOKED",
};

/**
 * requireResolvedWorkspace — the fail-closed companion to requireWorkspace.
 *
 * requireWorkspace deliberately lets a SUPERADMIN through with NO workspace
 * context (see the bypass below), and several routes depend on that — payroll
 * answers such a request with its own 400, admin.task-automations falls back to
 * the SYSTEM workspace. So the bypass itself cannot simply be deleted.
 *
 * The danger is a route that instead feeds the unset value straight into a
 * query. Mongoose strips undefined conditions, so `find({ workspaceId:
 * undefined })` becomes `find({})` — every document of every tenant — and
 * `scopedFindById` degrades to a bare `findById`. That is a silent cross-tenant
 * read, not an error.
 *
 * Mount this immediately after requireWorkspace on any router whose handlers
 * scope by workspace, and the unresolved case is denied instead of widened.
 */
export const requireResolvedWorkspace = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (!req.workspaceObjectId || !req.workspaceId) {
    res.status(403).json({
      success: false,
      error:
        "Workspace context required. Supply workspaceId (body, query, param, or x-workspace-id header).",
    });
    return;
  }
  next();
};

/**
 * requireWorkspace — resolves the actual CustomerWorkspace document
 * and attaches `req.workspaceId` (string _id), `req.workspaceObjectId`
 * (ObjectId _id), and `req.workspace` (lean doc).
 *
 * SUPERADMIN bypass: skips the DB lookup entirely.
 * Instead reads workspaceId from body / query / params / header.
 * If none provided, continues without workspace context.
 *
 * Normal users: a token with wsid resolves exactly that workspace after
 * verifySessionMembership (401 MEMBERSHIP_REVOKED when it fails); a legacy
 * token goes through resolveWorkspaceForUser (workspaceId > customerId >
 * businessId). Returns 403 if none found or workspace not active
 * (non-SUPERADMIN only).
 */
export const requireWorkspace = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const user = (req as any).user;
  if (!user) {
    res.status(403).json({ success: false, error: "Workspace context required" });
    return;
  }

  // ── SUPERADMIN bypass ──
  if (isSuperAdmin(req)) {
    // Try to pick up workspaceId from explicit sources
    const explicit =
      (req.body as any)?.workspaceId ||
      (req.query as any)?.workspaceId ||
      req.params?.workspaceId ||
      req.headers["x-workspace-id"] ||
      // Also fall back to JWT fields if present (SUPERADMIN may still have one)
      user.workspaceId ||
      user.customerId ||
      user.businessId ||
      null;

    if (explicit) {
      const id = String(explicit);
      req.workspaceId = id;
      try {
        req.workspaceObjectId = new mongoose.Types.ObjectId(id);
      } catch {
        req.workspaceObjectId = id as any;
      }
    }
    // If no workspaceId at all — that's fine for SUPERADMIN, continue anyway
    return next();
  }

  // ── TBO certification bypass ──
  const userEmail = (user.email || "").toLowerCase();
  if (userEmail === "tbocertification@plumtrips.com") {
    const certWsId = "69679a7628330a58d29f2254";
    req.workspaceId = certWsId;
    req.workspaceObjectId = new mongoose.Types.ObjectId(certWsId);
    return next();
  }

  // ── Normal users ──
  try {
    let workspace: any;
    if (user.wsid && membershipSessionEnabled()) {
      // Membership session: exactly the token's workspace, membership re-checked.
      if (!(await verifySessionMembership(user))) {
        res.status(401).json(MEMBERSHIP_REVOKED_BODY);
        return;
      }
      workspace = await CustomerWorkspace.findById(String(user.wsid)).select(WS_SELECT).lean();
    } else {
      // Legacy token — shared resolver, see resolveWorkspaceForUser above.
      workspace = await resolveWorkspaceForUser(user, WS_SELECT);
    }

    if (!workspace) {
      res.status(403).json({ success: false, error: "Workspace context required" });
      return;
    }

    if (workspace.status !== "ACTIVE") {
      res.status(403).json({ success: false, error: "Workspace not active" });
      return;
    }

    // Always set to the ACTUAL workspace _id
    req.workspaceId = workspace._id.toString();
    req.workspaceObjectId = workspace._id as mongoose.Types.ObjectId;
    req.workspace = workspace;

    next();
  } catch (err) {
    next(err);
  }
};
