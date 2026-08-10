// apps/backend/src/services/visaApproval.service.ts
//
// The customer-side visa approval gate: who may approve, who a request
// routes to, and whether the gate applies at all.
//
// This is a PEER of services/reports.service.ts + services/expense.access.ts,
// not a new approval engine. The expenses module already owns a working
// requestor -> approver implementation, cash advances already proved its
// resolvers generalise, and visa is the third caller. Everything here either
// delegates to those resolvers or mirrors their shape deliberately.
//
// See infra/design/visa-approval-flow-2026-08-10.md for the state machine,
// the gate seam, and the two decisions this file encodes (self-route rather
// than refuse; opt-in per workspace, default off).

import mongoose from "mongoose";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import User from "../models/User.js";
import type { IApprovalChainLevel } from "../models/Report.js";
// THE reuse. resolveL1Approver is exported from reports.service.ts purely so
// this file can call it — its logic is untouched, so "who approves this?" is
// answered identically for a claim, a cash advance and a visa request.
import { resolveL1Approver } from "./reports.service.js";

/* ──────────────────────────────────────────────────────────────────────
 * Access model — a VISA-LOCAL mirror of services/expense.access.ts.
 *
 * Same normalization convention (uppercase, then strip spaces / hyphens /
 * underscores), so SUPER_ADMIN, SUPER-ADMIN and SUPERADMIN all collapse to
 * SUPERADMIN and WORKSPACE_LEADER -> WORKSPACELEADER. Same role-bag
 * collection across every field a user shape might carry the signal on.
 * ────────────────────────────────────────────────────────────────────── */

/** The ONE normalization convention for this module (mirrors expense.access). */
function norm(v: any): string {
  return String(v ?? "").trim().toUpperCase().replace(/[\s\-_]/g, "");
}

/**
 * Who counts as a workspace admin for the VISA approval gate.
 *
 * WORKSPACE_LEADER is included as the same deliberate policy expenses
 * applies: a customer workspace leader is the approving authority for THEIR
 * OWN workspace. Tenant scoping (every query in routes/visa.ts stamps
 * req.workspaceObjectId) already confines that authority to their own
 * workspace.
 *
 * TENANT_ADMIN is DELIBERATELY ABSENT — the one place this set does not
 * match services/expense.access.ts's ADMIN_ROLES, which does include it.
 * A visa approver is asserting THIS customer's authority over THIS
 * customer's travel; TENANT_ADMIN is a platform-tier role, and letting it
 * approve a customer's visa request is a tenancy-isolation break rather
 * than an owner-operator convenience. For the same reason this module never
 * uses middleware/rbac.ts's requireAdmin, whose admin set pulls TENANT_ADMIN
 * in. Flagged in the design doc as a conscious narrowing.
 */
export const VISA_ADMIN_ROLES = [
  "ADMIN",
  "SUPERADMIN",
  "WORKSPACE_ADMIN",
  "WORKSPACE_LEADER",
  "HR",
  "HR_ADMIN",
  "OPS",
  "OPS_ADMIN",
].map(norm);

/**
 * Collect every role signal off a user (JWT payload or User doc) — the same
 * shapes expense.access.ts's roleBag reads. Returns normalized tokens.
 */
function roleBag(user: any): string[] {
  if (!user) return [];
  const out: any[] = [];
  if (Array.isArray(user.roles)) out.push(...user.roles);
  if (user.role) out.push(user.role);
  if (user.userType) out.push(user.userType);
  if (user.accountType) out.push(user.accountType);
  if (user.hrmsAccessRole) out.push(user.hrmsAccessRole);
  if (user.hrmsAccessLevel) out.push(user.hrmsAccessLevel);
  return out.map(norm).filter(Boolean);
}

/** Stable user id across JWT (sub/id) and Mongoose doc (_id) shapes. */
export function visaUserIdOf(user: any): string {
  return String(user?.id || user?._id || user?.sub || "");
}

/**
 * Workspace admin for the visa gate. The explicit `isSuperAdmin` flag path
 * mirrors middleware/isSuperAdmin and is demo-guarded — an impersonated demo
 * user never gets the SUPERADMIN bypass via the flag.
 */
export function isVisaAdmin(user: any): boolean {
  const bag = roleBag(user);
  if (bag.some((r) => VISA_ADMIN_ROLES.includes(r))) return true;
  if (user && user.isSuperAdmin === true && !user._demoImpersonation) return true;
  return false;
}

/**
 * Sees every pending request in the workspace, rather than only the ones
 * routed to them. Mirrors expense.access.ts's seesAll — which also folds in
 * a dedicated finance capability. Visa has no finance axis (nothing here
 * pays out), so this is admin alone.
 */
export function visaSeesAll(user: any): boolean {
  return isVisaAdmin(user);
}

/**
 * Approve / decline / request-clarification authority on a single request.
 * Mirrors expense.access.ts's canDecide EXACTLY:
 *   ok    — the snapshotted approver OR an admin ...
 *   SoD   — ... but a NON-admin may NEVER decide their own request. An admin
 *           MAY (owner-operator override), recorded by the route via
 *           selfApproved.
 *
 * Returns the breakdown the routes need (admin / isSelf) so the decision and
 * the audit marker come from one place.
 *
 * NOTE isSelf reads `raisedByUserId` — a VisaRequest's owner field — where a
 * claim reads employeeId and an advance reads requesterId. Same logic, the
 * model's own owner field.
 */
export function canDecideVisaRequest(
  user: any,
  request: any,
): { ok: boolean; admin: boolean; isSelf: boolean } {
  const me = visaUserIdOf(user);
  const admin = isVisaAdmin(user);
  const isApprover = !!(request?.approverId && String(request.approverId) === me);
  const isSelf = String(request?.raisedByUserId) === me;
  const ok = (isApprover || admin) && (!isSelf || admin);
  return { ok, admin, isSelf };
}

/* ──────────────────────────────────────────────────────────────────────
 * The feature gate.
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Is the customer-side approval gate switched on for this workspace?
 *
 * Read with an explicit narrow select rather than off req.workspace, whose
 * projection is decided by middleware/requireWorkspace and is not this
 * module's to depend on. Same pattern reports.service.ts uses to read
 * config.expenseEscalationThreshold.
 *
 * DEFAULTS TO FALSE on every path — flag absent, config absent, workspace
 * not found. "Off" must be what you get when anything is unclear, because
 * off is the behaviour every live workspace has today.
 */
export async function isVisaApprovalRequired(
  workspaceId: mongoose.Types.ObjectId | string,
): Promise<boolean> {
  const ws: any = await CustomerWorkspace.findById(workspaceId)
    .select("config.visaApprovalRequired")
    .lean();
  return ws?.config?.visaApprovalRequired === true;
}

/* ──────────────────────────────────────────────────────────────────────
 * Chain resolution.
 * ────────────────────────────────────────────────────────────────────── */

export type VisaApprovalChainResult = {
  chain: IApprovalChainLevel[];
  approverId: mongoose.Types.ObjectId;
  approver: any | null;
  /** True when no DISTINCT approver existed and the request routed to its
   *  own requestor. Persisted as VisaRequest.selfApproved and activity-logged. */
  selfRouted: boolean;
};

// Enough to notify the approver and to display them. Mirrors
// reports.service.ts's APPROVER_USER_FIELDS, minus the role signals it only
// needs for its own admin-fallback filter (resolveL1Approver does that work
// internally and hands back the resolved user already).
const VISA_APPROVER_USER_FIELDS = "firstName lastName name email";

/**
 * Build the approval chain to snapshot at submit.
 *
 * v1 is ALWAYS length 1 — no L2, no escalation threshold. resolveL2Approver
 * exists and is exported, but visa does not call it: a visa request has no
 * amount at submit time to threshold against (costs are confirmed later, by
 * ops), so there is nothing for an escalation rule to key on yet. The chain
 * array and currentLevel are stamped regardless so that adding a second
 * level later is a change here, not in the approve route — which already
 * walks the chain generically.
 *
 * DECISION 1 (see the design doc): unlike claims, this NEVER returns "no
 * approver". Claims refuse the submit when resolveL1Approver comes back
 * null; refusing here would make the module unusable for exactly the
 * customers most likely to switch the gate on — a small company's owner
 * filing their own visa is the normal case, not an edge case. So the request
 * SELF-ROUTES: approverId = the requestor, selfRouted = true, permanently
 * marked and activity-logged. It goes through and is never stranded, but it
 * is never silently auto-approved either — somebody still has to press
 * approve, and the audit trail records that they approved their own request.
 *
 * resolveL1Approver itself is reused UNTOUCHED; the self-route is a fallback
 * this caller applies to its null return, not a change to the resolver.
 */
export async function resolveVisaApprovalChain(
  workspaceId: mongoose.Types.ObjectId | string,
  requesterId: mongoose.Types.ObjectId | string,
): Promise<VisaApprovalChainResult> {
  const ws = new mongoose.Types.ObjectId(String(workspaceId));
  const requester = new mongoose.Types.ObjectId(String(requesterId));

  const l1 = await resolveL1Approver(ws, requester);

  if (l1.id) {
    return {
      chain: [{ level: 1, approverId: l1.id, status: "pending", decidedAt: null, note: null }],
      approverId: l1.id,
      approver: l1.user,
      selfRouted: false,
    };
  }

  // Self-route. Load the requestor for the notification/display name — the
  // same shape resolveL1Approver would have handed back for a real approver,
  // so every caller downstream treats the two identically.
  const self: any = await User.findOne({ _id: requester, workspaceId: ws })
    .select(VISA_APPROVER_USER_FIELDS)
    .lean();

  return {
    chain: [{ level: 1, approverId: requester, status: "pending", decidedAt: null, note: null }],
    approverId: requester,
    approver: self,
    selfRouted: true,
  };
}

/** Display name for an approver / requestor (mirrors reports.service.ts). */
export function visaUserNameOf(u: any): string {
  if (!u || typeof u !== "object") return "";
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return full || u.name || u.email || "";
}
