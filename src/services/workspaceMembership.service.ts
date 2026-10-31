// apps/backend/src/services/workspaceMembership.service.ts
//
// PHASE 1 of the company switcher (docs/audits/multi-workspace-login-audit.md
// §8.5): keep a shadow WorkspaceMembership row in step with the User record.
// Phase 2 reads it for the session (routes/auth.ts sessionMembershipFor,
// middleware/requireWorkspace.ts verifySessionMembership); login calls
// syncMembershipFromUser when a user has no row yet.
//
//   resolveMembershipTarget(user) — which workspace the person's session
//     resolves to TODAY, using the same order login does. Read only. Shared by
//     the backfill script and the write-through so both agree.
//   syncMembershipFromUser(userId) — upsert the user's single membership from
//     their User row. Best effort: NEVER throws, never blocks the caller's
//     request on a failure; it logs and returns null instead.
//
// Still exactly one membership per user: when the resolved workspace changes
// (e.g. promote-customer moves User.workspaceId) the existing row is moved in
// place rather than a second row being added. Phase 4: only the DEFAULT row
// (the User's own company) is synced or moved here; second-company rows
// (routes/admin.workspaceMemberships.ts) are left alone.
//
// The resolution below DUPLICATES routes/auth.ts on purpose (Phase 1 must not
// touch login): isStaffActor (auth.ts:315-340) and the customerId order in
// buildAuthSafeUserCore (auth.ts:599-627), and the workspace lookup of
// middleware/requireWorkspace.ts resolveWorkspaceForUser. Keep them in step.
import mongoose from "mongoose";
import User from "../models/User.js";
import Customer from "../models/Customer.js";
import Vendor from "../models/Vendor.js";
import CustomerMember from "../models/CustomerMember.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import MasterData from "../models/MasterData.js";
import { isCustomerUser } from "../middleware/requireWorkspace.js";
import WorkspaceMembership, {
  MEMBER_ROLES,
  type MembershipKind,
  type MembershipMemberRole,
  type MembershipStatus,
  type WorkspaceMembershipFlags,
} from "../models/WorkspaceMembership.js";

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const normEmail = (v: unknown) => str(v).toLowerCase();
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isOid = (v: unknown) => /^[a-fA-F0-9]{24}$/.test(str(v));

function normalizeRoles(roles: unknown): string[] {
  return (Array.isArray(roles) ? roles : [])
    .map((r) => str(r).toUpperCase())
    .filter(Boolean)
    .map((r) => (r === "SUPER_ADMIN" ? "SUPERADMIN" : r));
}

/** Copy of auth.ts isStaffActor. */
export function isStaffActor(user: any): boolean {
  if (!user) return false;
  const lvl = str(user.hrmsAccessLevel).toUpperCase();
  const at = str(user.accountType).toUpperCase();
  const ut = str(user.userType).toUpperCase();
  if (lvl === "STAFF" || at === "STAFF" || ut === "STAFF") return true;
  const roles = normalizeRoles(user.roles);
  return ["SUPERADMIN", "ADMIN", "HR", "HR_ADMIN", "STAFF", "TENANT_ADMIN", "MANAGER", "EMPLOYEE", "LEAD", "TEAM_LEAD", "OWNER"].some(
    (r) => roles.includes(r),
  );
}

/** Copy of auth.ts ensureWorkspaceAndLeader's role derivation (used when no CustomerMember row exists). */
function memberRoleFromRoles(roles: string[]): MembershipMemberRole {
  if (roles.includes("WORKSPACE_LEADER")) return "WORKSPACE_LEADER";
  if (roles.includes("APPROVER")) return "APPROVER";
  return "REQUESTER";
}

export type CustomerSource = "user.customerId" | "customerMember" | "customer" | "masterData" | "allowlist";

export type MembershipTarget = {
  kind: MembershipKind;
  /** null when no workspace resolves (see `reason`). */
  workspaceId: mongoose.Types.ObjectId | null;
  customerId: string | null;
  customerSource: CustomerSource | null;
  memberRole: MembershipMemberRole | null;
  customerMemberId: mongoose.Types.ObjectId | null;
  reason?: string;
};

/** Login's customerId order for a non-staff user (auth.ts:599-627). */
async function resolveLoginCustomerId(user: any): Promise<{ customerId: string | null; source: CustomerSource | null; vendor: boolean }> {
  const email = normEmail(user.email);
  const rx = email ? new RegExp(`^${escapeRegExp(email)}$`, "i") : null;

  const customer: any =
    (await Customer.findOne({ ownerId: user._id }).select("_id").lean()) ||
    (email ? await Customer.findOne({ $or: [{ email }, { officialEmail: email }, { official_email: email }] }).select("_id").lean() : null);
  const vendor: any =
    (await Vendor.findOne({ ownerId: user._id }).select("_id").lean()) ||
    (email ? await Vendor.findOne({ $or: [{ email }, { officialEmail: email }, { official_email: email }] }).select("_id").lean() : null);
  const isVendor = !!(str(user.vendorId) || vendor?._id || normalizeRoles(user.roles).includes("VENDOR"));

  if (str(user.customerId)) return { customerId: str(user.customerId), source: "user.customerId", vendor: isVendor };

  if (rx) {
    const member: any = await CustomerMember.findOne({ email: rx, $or: [{ isActive: { $exists: false } }, { isActive: true }] })
      .sort({ updatedAt: -1, createdAt: -1 })
      .select("customerId")
      .lean();
    if (str(member?.customerId)) return { customerId: str(member.customerId), source: "customerMember", vendor: isVendor };
  }

  if (customer?._id) return { customerId: String(customer._id), source: "customer", vendor: isVendor };

  if (email) {
    const typeRx = /^(business|customer)$/i;
    const er = new RegExp(`^${escapeRegExp(email)}$`, "i");
    const or: any[] = [
      { email: er }, { officialEmail: er }, { official_email: er },
      { "payload.email": er }, { "payload.officialEmail": er }, { "payload.primaryEmail": er }, { "payload.ownerEmail": er },
      { "payload.createdByEmail": er }, { "payload.companyEmail": er }, { "payload.contactEmail": er },
      { "payload.billingEmail": er }, { "payload.adminEmail": er }, { "payload.contact.email": er }, { "payload.contactEmail.email": er },
    ];
    const uid = String(user._id || "");
    if (uid) or.push({ ownerId: uid }, { "payload.ownerId": uid }, { "payload.createdBy": uid }, { "payload.userId": uid });
    const md: any = await MasterData.findOne({
      $and: [{ $or: [{ type: typeRx }, { entityType: typeRx }, { "payload.type": typeRx }, { "payload.entityType": typeRx }] }, { $or: or }],
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .select("_id")
      .lean();
    if (md?._id) return { customerId: String(md._id), source: "masterData", vendor: isVendor };

    const at = email.lastIndexOf("@");
    const domain = at >= 0 ? email.slice(at + 1) : "";
    const ws: any = await CustomerWorkspace.findOne({ $or: [{ allowedEmails: email }, ...(domain ? [{ allowedDomains: domain }] : [])] })
      .sort({ updatedAt: -1, createdAt: -1 })
      .select("customerId")
      .lean();
    if (str(ws?.customerId)) return { customerId: str(ws.customerId), source: "allowlist", vendor: isVendor };
  }

  return { customerId: null, source: null, vendor: isVendor };
}

/**
 * Which workspace this user's session resolves to today, and as what.
 * READ ONLY — never writes User, CustomerMember or CustomerWorkspace (login's
 * ensureCustomerWorkspace / member upsert are deliberately not replayed).
 */
export async function resolveMembershipTarget(user: any): Promise<MembershipTarget> {
  const userWs = isOid(user?.workspaceId) ? new mongoose.Types.ObjectId(String(user.workspaceId)) : null;

  if (isStaffActor(user)) {
    if (!userWs) return { kind: "STAFF", workspaceId: null, customerId: null, customerSource: null, memberRole: null, customerMemberId: null, reason: "staff user has no workspaceId" };
    const ws: any = await CustomerWorkspace.findById(userWs).select("_id customerId").lean();
    if (!ws) return { kind: "STAFF", workspaceId: null, customerId: null, customerSource: null, memberRole: null, customerMemberId: null, reason: "User.workspaceId points at no CustomerWorkspace" };
    return { kind: "STAFF", workspaceId: ws._id, customerId: str(ws.customerId) || null, customerSource: null, memberRole: null, customerMemberId: null };
  }

  const { customerId, source, vendor } = await resolveLoginCustomerId(user);

  if (!customerId) {
    const kind: MembershipKind = vendor ? "VENDOR" : "CUSTOMER";
    // The token then carries no customerId, so requireWorkspace falls back to
    // User.workspaceId — via findById for a non-customer role set (vendors,
    // SaaS WORKSPACE_ADMIN signups), via findOne({customerId}) for a customer
    // role set, which a workspace _id never matches.
    const loginRoles = [...normalizeRoles(user.roles), ...(vendor ? ["VENDOR"] : [])];
    if (isCustomerUser({ roles: loginRoles })) {
      return { kind, workspaceId: null, customerId: null, customerSource: null, memberRole: null, customerMemberId: null, reason: "customer role but no customer link (User.customerId, CustomerMember, Customer, MasterData, allowlist all empty)" };
    }
    const ws: any = userWs ? await CustomerWorkspace.findById(userWs).select("_id customerId").lean() : null;
    if (!ws) return { kind, workspaceId: null, customerId: null, customerSource: null, memberRole: null, customerMemberId: null, reason: "no customer link and User.workspaceId points at no CustomerWorkspace" };
    const wsCustomerId = str(ws.customerId) || null;
    const email = normEmail(user.email);
    const member: any =
      kind === "CUSTOMER" && wsCustomerId && email
        ? await CustomerMember.findOne({ customerId: wsCustomerId, email: new RegExp(`^${escapeRegExp(email)}$`, "i") }).select("_id role").lean()
        : null;
    const mr = str(member?.role).toUpperCase();
    return {
      kind, workspaceId: ws._id, customerId: wsCustomerId, customerSource: null,
      memberRole: (MEMBER_ROLES as readonly string[]).includes(mr) ? (mr as MembershipMemberRole) : null,
      customerMemberId: member?._id ?? null,
    };
  }

  // requireWorkspace's customer path: CustomerWorkspace by customerId only.
  const ws: any = await CustomerWorkspace.findOne({ customerId }).select("_id customerId").lean();
  if (!ws) {
    const byId: any = isOid(customerId) ? await CustomerWorkspace.findById(customerId).select("_id").lean() : null;
    return {
      kind: "CUSTOMER", workspaceId: null, customerId, customerSource: source, memberRole: null, customerMemberId: null,
      reason: byId
        ? `customerId (from ${source}) is a CustomerWorkspace _id, not a Customer _id`
        : `no CustomerWorkspace for customerId (from ${source}); login would create one`,
    };
  }

  const email = normEmail(user.email);
  const member: any = email
    ? await CustomerMember.findOne({ customerId, email: new RegExp(`^${escapeRegExp(email)}$`, "i") }).select("_id role").lean()
    : null;
  const memberRoleRaw = str(member?.role).toUpperCase();
  const memberRole = (MEMBER_ROLES as readonly string[]).includes(memberRoleRaw)
    ? (memberRoleRaw as MembershipMemberRole)
    : memberRoleFromRoles(normalizeRoles(user.roles));

  return {
    kind: "CUSTOMER",
    workspaceId: ws._id,
    customerId,
    customerSource: source,
    memberRole,
    customerMemberId: member?._id ?? null,
  };
}

function flagsFromUser(u: any): WorkspaceMembershipFlags {
  return {
    sbtEnabled: u.sbtEnabled ?? false,
    sbtBookingType: u.sbtBookingType ?? "both",
    sbtRole: u.sbtRole ?? null,
    sbtAssignedBookerId: u.sbtAssignedBookerId ?? null,
    bandNumber: u.bandNumber ?? null,
    canRaiseRequest: u.canRaiseRequest ?? true,
    canViewBilling: u.canViewBilling ?? false,
    canManageUsers: u.canManageUsers ?? false,
  };
}

/** Phase 1: membership status only mirrors User.status. */
export function membershipStatusFromUser(u: any): MembershipStatus {
  return str(u?.status).toUpperCase() === "INACTIVE" ? "SUSPENDED" : "ACTIVE";
}

export type MembershipWrite = "created" | "updated" | "moved";

/**
 * Upsert the user's single membership for `target`. Throws on a DB error —
 * callers that must not fail go through syncMembershipFromUser.
 */
export async function writeMembership(
  user: any,
  target: MembershipTarget,
  opts: { invitedBy?: unknown } = {},
): Promise<MembershipWrite> {
  if (!target.workspaceId) throw new Error(`no resolvable workspace: ${target.reason || "unknown"}`);
  const userId = new mongoose.Types.ObjectId(String(user._id));
  const fields = {
    customerId: target.customerId,
    kind: target.kind,
    roles: normalizeRoles(user.roles),
    memberRole: target.memberRole,
    customerMemberId: target.customerMemberId,
    flags: flagsFromUser(user),
    status: membershipStatusFromUser(user),
    isDefault: true,
  };

  // 1. The row for this workspace already exists. It is the User's own
  // company, so it is the default; any other row stops being it (Phase 4:
  // still exactly one default per user).
  const same = await WorkspaceMembership.updateOne({ userId, workspaceId: target.workspaceId }, { $set: fields });
  if (same.matchedCount) {
    await WorkspaceMembership.updateMany(
      { userId, workspaceId: { $ne: target.workspaceId }, isDefault: true },
      { $set: { isDefault: false } },
    );
    return "updated";
  }

  // 2. The user's own-company row exists for another workspace — move it.
  // Only the DEFAULT row moves: a second-company membership (Phase 4,
  // isDefault false) is never relocated by a change to the User document.
  const moved = await WorkspaceMembership.updateOne({ userId, isDefault: true }, { $set: { ...fields, workspaceId: target.workspaceId } });
  if (moved.matchedCount) return "moved";

  // 3. None yet.
  const invitedBy = isOid(opts.invitedBy) ? new mongoose.Types.ObjectId(String(opts.invitedBy)) : null;
  try {
    await WorkspaceMembership.updateOne(
      { userId, workspaceId: target.workspaceId },
      { $set: fields, $setOnInsert: { tokenVersion: 0, invitedBy } },
      { upsert: true },
    );
  } catch (err: any) {
    // A concurrent sync inserted the same row first — fall back to an update.
    if (err?.code !== 11000) throw err;
    await WorkspaceMembership.updateOne({ userId, workspaceId: target.workspaceId }, { $set: fields });
    return "updated";
  }
  return "created";
}

/**
 * Write-through from a user-creation / role-change / deactivation path.
 * Best effort: never throws, so a membership failure can never fail the
 * original request. `source` names the caller in the log line.
 */
export async function syncMembershipFromUser(
  userId: unknown,
  opts: { source?: string; invitedBy?: unknown } = {},
): Promise<MembershipWrite | null> {
  const src = opts.source || "unknown";
  try {
    if (!isOid(userId)) return null;
    // Never wait on mongoose's command buffer (no connection = skip, not hang).
    if (mongoose.connection.readyState !== 1) return null;
    const user: any = await User.findById(String(userId)).lean();
    if (!user) return null;
    const target = await resolveMembershipTarget(user);
    if (!target.workspaceId) {
      console.warn(`[membership] sync skipped source=${src} userId=${userId}: ${target.reason}`);
      return null;
    }
    return await writeMembership(user, target, { invitedBy: opts.invitedBy });
  } catch (err: any) {
    console.error(`[membership] sync failed source=${src} userId=${String(userId)}:`, err?.message || err);
    return null;
  }
}
