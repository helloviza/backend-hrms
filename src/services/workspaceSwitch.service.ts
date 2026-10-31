// apps/backend/src/services/workspaceSwitch.service.ts
//
// Company switcher Phase 4 (docs/audits/multi-workspace-login-audit.md §8.2):
// who may pick / switch companies, which companies they may pick, and the
// session a SECOND company is minted with.
//
// Everything here is behind MULTI_WORKSPACE_LOGIN=true (and the Phase 2
// session switch). With the flag off, or for anyone with fewer than two
// switchable memberships, login, refresh and /me behave exactly as before.
//
//   switchable   an ACTIVE CUSTOMER membership whose CustomerWorkspace is
//                ACTIVE and is not HOUSE.
//   eligible     not SuperAdmin, not demo, not staff (HOUSE staff keep one
//                workspace, §7.3), not a HOUSE-homed user.
//
// The OWN company (the one the User document describes, activeMembership.ts
// isOwnCompany) is always minted by login's own path, so its claims are
// exactly today's. Only a SECOND company is minted from its membership here:
// roles / customerMemberRole from the membership, customerId from the
// workspace (never the User — §7.2 design rule), no platform roles.
import crypto from "crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import WorkspaceMembership from "../models/WorkspaceMembership.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { membershipSessionEnabled } from "../middleware/requireWorkspace.js";
import { isStaffActor } from "./workspaceMembership.service.js";
import { signLogoUrl } from "../utils/signLogoUrl.js";
import { stripTravelFields } from "../utils/stripTravelFields.js";

const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";
const SUPERADMIN_EMAILS = ["admin@plumtrips.com", "imran.ali@plumtrips.com"];

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());

export function multiWorkspaceLoginEnabled(): boolean {
  return String(process.env.MULTI_WORKSPACE_LOGIN || "").trim().toLowerCase() === "true" && membershipSessionEnabled();
}

/** Why this User may never pick or switch companies, or null when they may. */
export function switchIneligibleReason(user: any): string | null {
  if (!user) return "no user";
  const roles = (Array.isArray(user.roles) ? user.roles : []).map((r: unknown) => str(r).toUpperCase().replace(/[\s\-_]/g, ""));
  if (roles.includes("SUPERADMIN") || str(user.hrmsAccessRole).toUpperCase() === "SUPERADMIN" || SUPERADMIN_EMAILS.includes(str(user.email).toLowerCase())) {
    return "superadmin";
  }
  if (user.isDemoUser === true) return "demo";
  if (isStaffActor(user)) return "staff";
  if (str(user.workspaceId) === HOUSE_WORKSPACE_ID && !str(user.customerId)) return "house";
  return null;
}

/** Same, for the claims of a presented access token. */
export function tokenIneligibleReason(claims: any): string | null {
  if (claims?._demoImpersonation === true || claims?.isDemoUser === true) return "demo";
  return null;
}

export type SwitchableCompany = {
  membership: any;
  workspace: any;
};

/**
 * The user's switchable memberships (ACTIVE CUSTOMER rows on ACTIVE, non-HOUSE
 * workspaces), own company first. [] when the flag is off or the user is not
 * eligible — callers treat fewer than two as "today's behaviour".
 */
export async function switchableCompanies(user: any): Promise<SwitchableCompany[]> {
  if (!multiWorkspaceLoginEnabled() || switchIneligibleReason(user)) return [];
  if (!mongoose.isValidObjectId(str(user._id))) return [];
  const ms: any[] = await WorkspaceMembership.find({ userId: user._id, status: "ACTIVE", kind: "CUSTOMER" }).lean();
  return ms.length ? withWorkspaces(ms) : [];
}

async function withWorkspaces(ms: any[]): Promise<SwitchableCompany[]> {
  const wss: any[] = await CustomerWorkspace.find({ _id: { $in: ms.map((m) => m.workspaceId) } })
    .select("_id customerId companyName name companyLogo companyLogoKey status")
    .lean();
  const byId = new Map(wss.map((w) => [str(w._id), w]));
  return ms
    .map((m) => ({ membership: m, workspace: byId.get(str(m.workspaceId)) }))
    .filter((x) => x.workspace && x.workspace.status === "ACTIVE" && str(x.workspace._id) !== HOUSE_WORKSPACE_ID)
    .sort((a, b) => Number(b.membership.isDefault === true) - Number(a.membership.isDefault === true));
}

/** The one switchable company for this workspace id, or null. */
export async function switchableCompany(user: any, workspaceId: unknown): Promise<SwitchableCompany | null> {
  const id = str(workspaceId);
  if (!mongoose.isValidObjectId(id)) return null;
  return (await switchableCompanies(user)).find((c) => str(c.workspace._id) === id) ?? null;
}

/** What the picker and the switcher show for one company. */
export async function companyCard(c: SwitchableCompany, current?: string | null) {
  const ws = c.workspace;
  let logo = "";
  if (ws.companyLogoKey) {
    try {
      logo = await signLogoUrl(ws.companyLogoKey);
    } catch {
      logo = "";
    }
  } else if (/^https?:\/\//i.test(str(ws.companyLogo))) {
    logo = str(ws.companyLogo);
  }
  return {
    workspaceId: str(ws._id),
    companyName: str(ws.companyName) || str(ws.name) || "Company",
    logo,
    role: c.membership.memberRole || null,
    isHome: c.membership.isDefault === true,
    lastSelectedAt: c.membership.lastSelectedAt ?? null,
    current: current ? str(ws._id) === str(current) : false,
  };
}

/* ── pick token ──────────────────────────────────────────────────────
 * Proves "this person passed the password check a few minutes ago" between
 * /login and /select-workspace. Signed with a key DERIVED from JWT_SECRET,
 * so neither requireAuth (JWT_SECRET) nor /auth/refresh (JWT_REFRESH_SECRET)
 * accepts it as a session. Bound to the password hash: a password change
 * kills an outstanding pick token. */
const PICK_TTL = "5m";
const PICK_TYP = "ws_pick";

function pickSecret(): string {
  const base = process.env.JWT_SECRET;
  if (!base) throw new Error("Missing env: JWT_SECRET");
  return crypto.createHmac("sha256", base).update("plumbox:workspace-pick:v1").digest("hex");
}

function passwordStamp(user: any): string {
  return crypto.createHash("sha256").update(str(user?.passwordHash)).digest("hex").slice(0, 16);
}

export function signPickToken(user: any): string {
  return jwt.sign({ sub: str(user._id), typ: PICK_TYP, pv: passwordStamp(user) }, pickSecret(), { expiresIn: PICK_TTL });
}

/** The user id a pick token was issued for, or null (bad, expired, wrong kind). */
export function verifyPickToken(token: unknown): { sub: string; pv: string } | null {
  if (typeof token !== "string" || !token) return null;
  try {
    const p: any = jwt.verify(token, pickSecret());
    if (p?.typ !== PICK_TYP || !p.sub) return null;
    return { sub: String(p.sub), pv: String(p.pv || "") };
  } catch {
    return null;
  }
}

export function pickTokenMatchesUser(pick: { pv: string }, user: any): boolean {
  return pick.pv === passwordStamp(user);
}

/* ── second-company session ──────────────────────────────────────── */

// Never carried into a second company's token: platform / staff / vendor roles.
const NON_CUSTOMER_ROLES = new Set([
  "SUPERADMIN", "SUPER_ADMIN", "ADMIN", "HR", "HR_ADMIN", "STAFF", "TENANT_ADMIN", "MANAGER", "EMPLOYEE",
  "LEAD", "TEAM_LEAD", "OWNER", "OPS", "OPS_ADMIN", "WORKSPACE_ADMIN", "VENDOR",
]);

export function secondCompanyRoles(m: any): string[] {
  const out = ["CUSTOMER"];
  for (const r of Array.isArray(m?.roles) ? m.roles : []) {
    const v = str(r).toUpperCase();
    if (v && !NON_CUSTOMER_ROLES.has(v) && !out.includes(v)) out.push(v);
  }
  const mr = str(m?.memberRole).toUpperCase();
  if ((mr === "WORKSPACE_LEADER" || mr === "APPROVER") && !out.includes(mr)) out.push(mr);
  return out;
}

/** Token claims for a session in a SECOND company (signAccessToken params minus userId/email). */
export function secondCompanyClaims(m: any, ws: any) {
  const customerId = str(ws.customerId) || str(m.customerId) || undefined;
  return {
    roles: secondCompanyRoles(m),
    workspaceId: undefined as string | undefined,
    customerId,
    businessId: customerId,
    vendorId: undefined as string | undefined,
    customerMemberRole: str(m.memberRole).toUpperCase() || undefined,
    isDemoUser: false,
  };
}

/**
 * The session user object (login / refresh / /me `user`) for a second
 * company: the User's profile with that company's identity, roles and flags.
 */
export function overlaySecondCompany(safe: any, m: any, ws: any) {
  const claims = secondCompanyClaims(m, ws);
  const f = m.flags || {};
  const out: any = {
    ...safe,
    roles: claims.roles,
    role: claims.roles[0],
    accountType: "CUSTOMER",
    userType: "CUSTOMER",
    hrmsAccessRole: "CUSTOMER",
    hrmsAccessLevel: "CUSTOMER",
    customerMemberRole: claims.customerMemberRole,
    customerId: claims.customerId,
    businessId: claims.businessId,
    workspaceId: str(ws._id),
  };
  delete out.vendorId;
  for (const k of ["sbtEnabled", "sbtBookingType", "sbtRole", "sbtAssignedBookerId", "bandNumber", "canRaiseRequest", "canViewBilling", "canManageUsers"]) {
    out[k] = f[k] ?? null;
  }
  return stripTravelFields(out);
}
