// apps/backend/src/services/expense.access.ts
//
// SINGLE source of truth for "who may see / act on expenses & claims".
// Replaces the three divergent inline role sets that previously lived in:
//   • routes/expenses.ts        — FINANCE_ADMIN_ROLES + seesAllExpenses
//   • routes/expenseReports.ts  — FINANCE_ADMIN_ROLES + seesAllReports + isFinance + canDecide
//   • the reimburse gate         — the isFinance() check on POST /reports/:id/reimburse
//
// TWO-AXIS access model:
//   • CAPABILITY role — Admin (broad staff-admin) vs Finance (NEW, additive,
//     dedicated). Drives visibility ("see all") and the act gates.
//   • ACCESS level    — L0 / L1 / L2 derived from User.hrmsAccessRole, reserved
//     for the Phase-2 approval chain. Vestigial today (see levelOf note).
//
// ONE normalization convention for the whole module: uppercase, then strip
// spaces / hyphens / underscores. So SUPER_ADMIN, SUPER-ADMIN and SUPERADMIN all
// collapse to SUPERADMIN; HR_ADMIN → HRADMIN; WORKSPACE_ADMIN → WORKSPACEADMIN.
// (This is why the sets below don't need to list the punctuation variants.)

export type AccessLevel = "L0" | "L1" | "L2";

/** The ONE normalization convention for this module. */
function norm(v: any): string {
  return String(v ?? "").trim().toUpperCase().replace(/[\s\-_]/g, "");
}

/**
 * Broad staff-admin set — preserves the legacy "see all + act" behavior that the
 * old FINANCE_ADMIN_ROLES / requireAdmin sets granted.
 */
export const ADMIN_ROLES = [
  "ADMIN",
  "SUPERADMIN",
  "TENANT_ADMIN",
  "WORKSPACE_ADMIN",
  "HR",
  "HR_ADMIN",
  "OPS",
  "OPS_ADMIN",
].map(norm);

/** NEW dedicated finance capability role — additive, does NOT replace admin. */
export const FINANCE_ROLES = ["FINANCE"].map(norm);

/**
 * No-manager approver fallback set (unchanged — mirrors APPROVER_FALLBACK_ROLES
 * in services/reports.service.ts, normalized here under this module's convention).
 */
export const APPROVER_FALLBACK_ROLES = [
  "ADMIN",
  "SUPERADMIN",
  "HR",
  "HR_ADMIN",
  "OPS",
  "OPS_ADMIN",
].map(norm);

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

/**
 * Broad staff admin. SUPERADMIN is covered through the role bag; the explicit
 * `isSuperAdmin` flag path mirrors middleware/isSuperAdmin and is demo-guarded
 * (an impersonated demo user never gets the SUPERADMIN bypass via the flag).
 */
export function isAdmin(user: any): boolean {
  const bag = roleBag(user);
  if (bag.some((r) => ADMIN_ROLES.includes(r))) return true;
  if (user && user.isSuperAdmin === true && !user._demoImpersonation) return true;
  return false;
}

/** Finance capability = the dedicated FINANCE role OR any admin. */
export function isFinance(user: any): boolean {
  if (isAdmin(user)) return true;
  return roleBag(user).some((r) => FINANCE_ROLES.includes(r));
}

/**
 * Access level L0 / L1 / L2 from User.hrmsAccessRole; default L0.
 *
 * NOTE (vestigial today): hrmsAccessRole currently stores role NAMES
 * (EMPLOYEE / MANAGER / HR / ADMIN / SUPERADMIN — see routes/permissions.ts),
 * NOT L-levels, so this returns "L0" for essentially everyone until a later
 * step writes real L-values. It exists now as forward-looking scaffolding for
 * the Phase-2 approval chain; nothing in Phase 1 branches on it.
 */
export function levelOf(user: any): AccessLevel {
  const m = /^L([012])$/.exec(norm(user?.hrmsAccessRole));
  return m ? (`L${m[1]}` as AccessLevel) : "L0";
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
 *   • same-claim SoD: a finance user may NOT reimburse a claim they themselves
 *     approved (user._id !== report.approverId),
 *   • Admin override: an admin bypasses the SoD check (owner-operator).
 */
export function canReimburse(user: any, report: any): boolean {
  if (!report || report.status !== "approved") return false;
  if (isAdmin(user)) return true; // admin bypasses SoD
  if (!isFinance(user)) return false;
  return userIdOf(user) !== String(report.approverId); // finance SoD
}
