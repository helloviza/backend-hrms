// apps/backend/src/services/expense.access.ts
//
// SINGLE source of truth for "who may see / act on expenses & claims".
// Replaces the three divergent inline role sets that previously lived in:
//   • routes/expenses.ts        — FINANCE_ADMIN_ROLES + seesAllExpenses
//   • routes/expenseReports.ts  — FINANCE_ADMIN_ROLES + seesAllReports + isFinance + canDecide
//   • the reimburse gate         — the isFinance() check on POST /reports/:id/reimburse
//
// TWO SOURCES, one predicate each (approval engine sub-step 1, 2026-09-16):
//   • STRUCTURAL workspace roles — SUPERADMIN / TENANT_ADMIN / WORKSPACE_ADMIN /
//     WORKSPACE_LEADER / HR / HR_ADMIN / OPS / OPS_ADMIN — the people who
//     administer a workspace by construction (signup, AccessConsole). Read from
//     the role bag exactly as before.
//   • The PER-PERSON GRANT (models/ExpenseApproverGrant.ts) — finance and
//     expense-admin capabilities, approver flag, personal limit, department
//     scope. Read from `user.expenseGrant`, which attachExpenseGrant
//     (services/expenseGrants.service.ts) parks on req.user once per request
//     and withGrants() attaches to User docs.
//
// The literal `ADMIN` and `FINANCE` tokens on User.roles[] are NO LONGER READ
// here. They were what the Team page used to write (audit F-01: a customer
// WORKSPACE_LEADER could mint platform ADMIN; F-21: AccessConsole wiped them).
// scripts/migrate-expense-capabilities-to-grants-2026-09-16.ts moves existing
// holders into grants so nobody loses a capability they had.
//
// ONE normalization convention for the whole module: uppercase, then strip
// spaces / hyphens / underscores. So SUPER_ADMIN, SUPER-ADMIN and SUPERADMIN all
// collapse to SUPERADMIN; HR_ADMIN → HRADMIN; WORKSPACE_ADMIN → WORKSPACEADMIN.
// (This is why the sets below don't need to list the punctuation variants.)

/** The ONE normalization convention for this module. */
function norm(v: any): string {
  return String(v ?? "").trim().toUpperCase().replace(/[\s\-_]/g, "");
}

/**
 * STRUCTURAL workspace-admin roles — expense-admin by construction. The bare
 * platform `ADMIN` token is deliberately NOT here any more: platform admins who
 * should administer expenses hold an expenseAdmin grant (the migration gives
 * every existing holder one), and the Team page can no longer create one.
 *
 * WORKSPACE_LEADER stays as a deliberate policy: a customer workspace leader is
 * the full expense-admin for THEIR OWN workspace. Tenant scoping confines it;
 * this set is EXPENSE-LOCAL and never consulted by middleware/rbac.ts.
 */
export const ADMIN_ROLES = [
  "SUPERADMIN",
  "TENANT_ADMIN",
  "WORKSPACE_ADMIN",
  "WORKSPACE_LEADER",
  "HR",
  "HR_ADMIN",
  "OPS",
  "OPS_ADMIN",
].map(norm);

/** Coarse Mongo prefilter that agrees with ADMIN_ROLES (used by the approver
 *  candidate scans in reports.service.ts; isAdmin() remains the authority). */
export const ADMIN_ROLE_PREFILTER: RegExp[] = [
  /SUPER[\s_-]?ADMIN/i,
  /TENANT[\s_-]?ADMIN/i,
  /WORKSPACE[\s_-]?ADMIN/i,
  /LEADER/i,
  /^HR$/i,
  /^HR[\s_-]?ADMIN$/i,
  /^OPS$/i,
  /^OPS[\s_-]?ADMIN$/i,
];

/**
 * Collect every role signal off a user (JWT payload or User doc) — the same
 * shapes the old inline predicates read. Returns normalized tokens.
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
export function userIdOf(user: any): string {
  return String(user?.id || user?._id || user?.sub || "");
}

/** The attached grant view (null when none / not attached). */
function grantOf(user: any): {
  approver: boolean;
  limitBase: number | null;
  departmentIds: string[];
  finance: boolean;
  expenseAdmin: boolean;
} | null {
  const g = user?.expenseGrant;
  return g && typeof g === "object" ? g : null;
}

/**
 * Expense admin = a STRUCTURAL workspace role, the SUPERADMIN flag (demo-
 * guarded, mirrors middleware/isSuperAdmin), OR an active grant with
 * capabilities.expenseAdmin. Nothing here reads the bare ADMIN token.
 */
export function isAdmin(user: any): boolean {
  const bag = roleBag(user);
  if (bag.some((r) => ADMIN_ROLES.includes(r))) return true;
  if (user && user.isSuperAdmin === true && !user._demoImpersonation) return true;
  if (grantOf(user)?.expenseAdmin) return true;
  return false;
}

/** Finance capability = grant.finance OR any expense admin. Nothing reads the FINANCE token. */
export function isFinance(user: any): boolean {
  if (isAdmin(user)) return true;
  return !!grantOf(user)?.finance;
}

/** In the approval-routing pool (engine, next steps). Admins are not implicitly approvers. */
export function isApprover(user: any): boolean {
  return !!grantOf(user)?.approver;
}

/** Personal approval limit from the grant (null = none / use rank default). */
export function personalLimitOf(user: any): number | null {
  const g = grantOf(user);
  return g && g.limitBase != null ? Number(g.limitBase) : null;
}

/** Department scope from the grant ([] = whole workspace). */
export function departmentScopeOf(user: any): string[] {
  return grantOf(user)?.departmentIds ?? [];
}

/** Finance OR Admin → sees every expense / claim in the workspace. */
export function seesAll(user: any): boolean {
  return isAdmin(user) || isFinance(user);
}

/**
 * Approve / decline authority on a single claim.
 *   ok    — the snapshotted approver OR an admin …
 *   SoD   — … but a NON-admin may never decide their OWN claim. An admin may
 *           (owner-operator override), recorded by the route via selfApproved.
 * Returns the breakdown the routes need (admin / isSelf) so the decision and the
 * audit marker come from one place.
 */
export function canDecide(
  user: any,
  report: any,
): { ok: boolean; admin: boolean; isSelf: boolean } {
  const me = userIdOf(user);
  const admin = isAdmin(user);
  const isApprover = !!(report?.approverId && String(report.approverId) === me);
  const isSelf = String(report?.employeeId) === me;
  const ok = (isApprover || admin) && (!isSelf || admin);
  return { ok, admin, isSelf };
}

/**
 * Reimburse authority on a single claim.
 *   • the claim must be APPROVED,
 *   • the actor must be Finance,
 *   • whole-chain SoD: a finance user may NOT reimburse a claim where they were
 *     ANY approver — at any level of the approval chain (Phase 2). Falls back to
 *     the denorm approverId for legacy claims that have no chain.
 *   • Admin override: an admin bypasses the SoD check (owner-operator).
 */
export function canReimburse(user: any, report: any): boolean {
  if (!report || report.status !== "approved") return false;
  if (isAdmin(user)) return true; // admin bypasses SoD
  if (!isFinance(user)) return false;

  const me = userIdOf(user);
  const approverIds = new Set<string>();
  if (Array.isArray(report.approvalChain)) {
    for (const lvl of report.approvalChain) {
      if (lvl?.approverId) approverIds.add(String(lvl.approverId));
    }
  }
  if (report.approverId) approverIds.add(String(report.approverId)); // legacy fallback
  return !approverIds.has(me); // finance SoD across every level the user approved
}

/* ──────────────────────────────────────────────────────────────────────
 * Cash advances (System B). These peers of canDecide/canReimburse use the
 * advance's OWN owner field (requesterId, not employeeId) but are otherwise the
 * SAME normalization and SoD logic — the claim predicates above are untouched.
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Approve / decline authority on a single advance — mirrors canDecide, but the
 * self-check reads `advance.requesterId` (an advance has no employeeId).
 *   ok    — the snapshotted approver OR an admin …
 *   SoD   — … but a NON-admin may never decide their OWN advance. An admin may
 *           (owner-operator override), recorded via selfApproved.
 */
export function canDecideAdvance(
  user: any,
  advance: any,
): { ok: boolean; admin: boolean; isSelf: boolean } {
  const me = userIdOf(user);
  const admin = isAdmin(user);
  const isApprover = !!(advance?.approverId && String(advance.approverId) === me);
  const isSelf = String(advance?.requesterId) === me;
  const ok = (isApprover || admin) && (!isSelf || admin);
  return { ok, admin, isSelf };
}

/**
 * Disburse authority on a single advance — mirrors canReimburse:
 *   • the advance must be APPROVED,
 *   • the actor must be Finance,
 *   • whole-chain SoD: a finance user may NOT disburse an advance where they
 *     were ANY approver — at any level of the chain. Falls back to the denorm
 *     approverId for advances with no chain.
 *   • Admin override: an admin bypasses the SoD check (owner-operator) — the
 *     route logs the override.
 */
export function canDisburse(user: any, advance: any): boolean {
  if (!advance || advance.status !== "approved") return false;
  if (isAdmin(user)) return true; // admin bypasses SoD
  if (!isFinance(user)) return false;

  const me = userIdOf(user);
  const approverIds = new Set<string>();
  if (Array.isArray(advance.approvalChain)) {
    for (const lvl of advance.approvalChain) {
      if (lvl?.approverId) approverIds.add(String(lvl.approverId));
    }
  }
  if (advance.approverId) approverIds.add(String(advance.approverId)); // legacy fallback
  return !approverIds.has(me); // finance SoD across every level the user approved
}

/**
 * Manual-recovery authority on a single advance (Phase 2 / D2). Same finance +
 * whole-chain SoD + admin-bypass shape as canDisburse, but it applies to an
 * already-disbursed advance with an outstanding balance (disbursed /
 * partially_settled), NOT an approved-pending-disbursement one. A finance user
 * may not recover an advance they approved at any level; an admin may.
 */
export function canRecover(user: any, advance: any): boolean {
  if (!advance) return false;
  const recoverable =
    advance.status === "disbursed" || advance.status === "partially_settled";
  if (!recoverable) return false;
  if (Number(advance.outstandingBalance) <= 0) return false;
  if (isAdmin(user)) return true; // admin bypasses SoD
  if (!isFinance(user)) return false;

  const me = userIdOf(user);
  const approverIds = new Set<string>();
  if (Array.isArray(advance.approvalChain)) {
    for (const lvl of advance.approvalChain) {
      if (lvl?.approverId) approverIds.add(String(lvl.approverId));
    }
  }
  if (advance.approverId) approverIds.add(String(advance.approverId)); // legacy fallback
  return !approverIds.has(me); // finance SoD across every level the user approved
}
