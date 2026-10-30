// apps/backend/src/services/activeMembership.ts
//
// Company switcher Phase 3a — which company's SBT identity a request acts as
// (docs/audits/multi-workspace-login-audit.md §7.1 SBT rows, §8.5).
//
// getActiveMembership(req) answers "what are this caller's customerId, roles
// and SBT flags IN THE COMPANY THIS SESSION IS IN?" — the question the SBT
// routes used to answer by reading the User document, which only describes one
// company.
//
//   source "membership"  the token's mid names a live membership (same user,
//                        same workspace as req.workspace, ACTIVE, same
//                        tokenVersion) for a company the User document does
//                        NOT describe — i.e. a second company. customerId is
//                        the active workspace's customerId (never the User's),
//                        roles / memberRole / flags are the membership's.
//
//   source "user"        everything else: no mid (legacy token), switch off
//                        (MEMBERSHIP_SESSION_DISABLED), SuperAdmin, a mid that
//                        does not check out, or the membership of the User's
//                        OWN company. These are today's values, read from the
//                        User document exactly as the routes did before.
//
// Why the User's own company still reads the User document: membership flags
// are a write-through copy (Phase 1) and not every path that edits
// User.sbtRole / sbtEnabled / sbtBookingType re-syncs it. Reading the copy for
// a single-company user could therefore change what they are allowed to do.
// Only a second company — which has no User fields of its own — reads the
// membership. "Own company": the membership's customerId equals
// User.customerId; for a User with no customerId, the default membership.
//
// Memoised on the request, so several guards on one route share one lookup.
import mongoose from "mongoose";
import User from "../models/User.js";
import WorkspaceMembership from "../models/WorkspaceMembership.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import { loadSessionMembership, membershipSessionEnabled, resolveWorkspaceForUser } from "../middleware/requireWorkspace.js";

export type ActiveMembershipFlags = {
  sbtEnabled?: boolean;
  sbtBookingType?: string | null;
  sbtRole?: string | null;
  sbtAssignedBookerId?: unknown;
  bandNumber?: number | null;
  canRaiseRequest?: boolean;
  canViewBilling?: boolean;
  canManageUsers?: boolean;
};

export type ActiveMembership = {
  source: "user" | "membership";
  /** The session's CustomerWorkspace _id (req.workspaceObjectId). */
  workspaceId: mongoose.Types.ObjectId | null;
  /** Customer._id of the active company — what SBT compares and writes as customerId.
   *  undefined (not null) when absent, like the User field the routes compared before. */
  customerId: string | undefined;
  roles: string[];
  memberRole: string | null;
  flags: ActiveMembershipFlags;
  /** The caller's User row (name, email) for messages. */
  user: { _id: unknown; name?: string; email?: string };
};

const USER_SELECT =
  "name email roles customerId sbtEnabled sbtBookingType sbtRole sbtAssignedBookerId bandNumber canRaiseRequest canViewBilling canManageUsers";

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

function callerId(req: any): string {
  return str(req.user?._id ?? req.user?.id ?? req.user?.sub);
}

function fromUser(req: any, u: any): ActiveMembership {
  return {
    source: "user",
    workspaceId: req.workspaceObjectId ?? null,
    customerId: u.customerId == null ? undefined : String(u.customerId),
    roles: Array.isArray(u.roles) ? u.roles : [],
    memberRole: req.user?.customerMemberRole ?? null,
    flags: {
      sbtEnabled: u.sbtEnabled,
      sbtBookingType: u.sbtBookingType,
      sbtRole: u.sbtRole,
      sbtAssignedBookerId: u.sbtAssignedBookerId,
      bandNumber: u.bandNumber,
      canRaiseRequest: u.canRaiseRequest,
      canViewBilling: u.canViewBilling,
      canManageUsers: u.canManageUsers,
    },
    user: { _id: u._id, name: u.name, email: u.email },
  };
}

/** Is this membership the company the User document already describes? */
export function isOwnCompany(m: any, u: any): boolean {
  const userCustomerId = str(u.customerId);
  if (userCustomerId) return str(m.customerId) === userCustomerId;
  return m.isDefault === true;
}

async function resolve(req: any): Promise<ActiveMembership | null> {
  const u: any = await User.findById(callerId(req)).select(USER_SELECT).lean();
  if (!u) return null;

  if (!req.user?.mid || !membershipSessionEnabled() || isSuperAdmin(req)) return fromUser(req, u);

  const m = await loadSessionMembership(req.user);
  if (!m || str(m.workspaceId) !== str(req.workspaceObjectId) || isOwnCompany(m, u)) return fromUser(req, u);

  const f = m.flags || {};
  return {
    source: "membership",
    workspaceId: req.workspaceObjectId ?? null,
    // The active workspace's customerId, never the User's (§7.2 design rule).
    customerId: str(req.workspace?.customerId) || str(m.customerId) || undefined,
    roles: Array.isArray(m.roles) ? m.roles : [],
    memberRole: m.memberRole ?? null,
    flags: {
      sbtEnabled: f.sbtEnabled,
      sbtBookingType: f.sbtBookingType,
      sbtRole: f.sbtRole,
      sbtAssignedBookerId: f.sbtAssignedBookerId,
      bandNumber: f.bandNumber,
      canRaiseRequest: f.canRaiseRequest,
      canViewBilling: f.canViewBilling,
      canManageUsers: f.canManageUsers,
    },
    user: { _id: u._id, name: u.name, email: u.email },
  };
}

/**
 * The caller's identity in the session's company, or null when the caller has
 * no User row. Must run after requireAuth + requireWorkspace.
 */
export async function getActiveMembership(req: any): Promise<ActiveMembership | null> {
  if (!req._activeMembership) req._activeMembership = resolve(req);
  return req._activeMembership;
}

/**
 * Does the caller belong to more than one company (ACTIVE memberships)? Lists
 * keyed only by the caller (their own requests, requests assigned to them) are
 * then also scoped to the session's workspace. A one-company user's lists are
 * left exactly as they were.
 */
export async function holdsSeveralCompanies(req: any): Promise<boolean> {
  if (req._holdsSeveralCompanies === undefined) {
    const uid = callerId(req);
    req._holdsSeveralCompanies =
      mongoose.isValidObjectId(uid) && membershipSessionEnabled()
        ? WorkspaceMembership.countDocuments({ userId: uid, status: "ACTIVE" }).then((n) => n > 1, () => false)
        : Promise.resolve(false);
  }
  return req._holdsSeveralCompanies;
}

/** Workspace Leader by the active company's roles. */
export function isActiveWorkspaceLeader(am: ActiveMembership | null): boolean {
  return (am?.roles || []).map((r) => str(r).toUpperCase().replace(/[\s\-_]/g, "")).includes("WORKSPACELEADER");
}

/**
 * Another Workspace Leader of the active company (a request's fallback booker).
 * Own company: the same User query as before. Second company: its memberships.
 */
export async function findOtherWorkspaceLeader(am: ActiveMembership, excludeUserId: unknown): Promise<unknown | null> {
  if (am.source === "user") {
    if (!am.customerId) return null;
    const leader: any = await User.findOne({
      customerId: am.customerId,
      roles: { $in: ["WORKSPACE_LEADER"] },
      _id: { $ne: excludeUserId },
    }).select("_id").lean();
    return leader?._id ?? null;
  }
  const m: any = await WorkspaceMembership.findOne({
    workspaceId: am.workspaceId,
    status: "ACTIVE",
    roles: "WORKSPACE_LEADER",
    userId: { $ne: excludeUserId },
  }).select("userId").lean();
  return m?.userId ?? null;
}

/**
 * Workspace Leader in the session's company: a second company reads its
 * membership's roles; the User's own company keeps the token's roles, exactly
 * as the routes read them before (Phase 3b, approvals routing).
 */
export async function actsAsWorkspaceLeader(req: any): Promise<boolean> {
  // Only a membership session (mid) can be in a second company.
  const am = req.user?.mid ? await getActiveMembership(req) : null;
  if (am?.source === "membership") return isActiveWorkspaceLeader(am);
  return (Array.isArray(req.user?.roles) ? req.user.roles : [])
    .map((r: unknown) => str(r).toUpperCase().replace(/[\s\-_]/g, ""))
    .includes("WORKSPACELEADER");
}

/**
 * The session's company as the ids an ApprovalRequest.customerId may hold:
 * the workspace's customerId and (older rows) the workspace _id. Empty when no
 * workspace resolves — callers then match nothing. Memoised on the request.
 */
export async function sessionCompanyIds(req: any): Promise<string[]> {
  if (!req._sessionCompanyIds) {
    req._sessionCompanyIds = (async () => {
      let ws: any = req.workspace?._id ? req.workspace : null;
      if (!ws && req.workspaceObjectId) ws = await CustomerWorkspace.findById(req.workspaceObjectId).select("_id customerId").lean();
      if (!ws) ws = await resolveWorkspaceForUser(req.user, "_id customerId");
      return ws?._id ? [str(ws.customerId), str(ws._id)].filter(Boolean) : [];
    })();
  }
  return req._sessionCompanyIds;
}
