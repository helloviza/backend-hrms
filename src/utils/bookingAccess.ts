// apps/backend/src/utils/bookingAccess.ts
/**
 * Shared per-record access predicate for ManualBooking, covering the
 * cross-tenant gap documented in infra/audit/manual-bookings-access-verification.md
 * (F10/F11 in the earlier audits — PUT /:id had no per-record check at all, and
 * GET /:id's own check never verified tenant, only createdBy/HOUSE carve-outs).
 *
 * ID-space note (verification report, section B): ManualBooking.workspaceId is
 * a Customer._id, while req.workspaceObjectId (from requireWorkspace) is a
 * CustomerWorkspace._id — two different spaces for the "same" tenant. The
 * tenant gate below checks BOTH: ctx.customerId (= req.workspace.customerId,
 * itself a Customer._id string already resolved by requireWorkspace with zero
 * extra query) covers the expected case; ctx.workspaceObjectId is a fallback
 * for the ~26 real prod bookings found written with workspaceId in the wrong
 * (CustomerWorkspace._id) space (verification report, section B3).
 */

import mongoose from "mongoose";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import { reportingTreeUserIds } from "./reportingTree.js";

export const HOUSE_CUSTOMER_ID = "6a4e0d2ea90c293c9e129f48"; // Customer._id
export const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254"; // CustomerWorkspace._id

export type BookingAccessLevel = "READ" | "WRITE";

export interface BookingAccessContext {
  /** Caller's own user id (String(req.user._id || req.user.id || req.user.sub)). */
  callerId: string;
  /** req.workspace?.customerId — caller's own tenant in Customer._id space. */
  customerId?: string | null;
  /** req.workspaceObjectId — caller's own tenant in CustomerWorkspace._id space. */
  workspaceObjectId?: unknown;
  /** req.permissionScope, as set by requirePermission(). */
  permissionScope?: string;
  /**
   * True for a genuine platform SUPERADMIN (middleware/isSuperAdmin.ts).
   * SUPERADMIN bypasses all workspace/role/feature middleware elsewhere in
   * this codebase (see that file's own doc comment) and frequently has no
   * resolved req.workspace at all (requireWorkspace's SUPERADMIN branch only
   * sets workspace fields when the caller explicitly supplies one) — so the
   * tenant gate below would otherwise incorrectly deny a real SuperAdmin who
   * omitted a workspaceId. Preserving this bypass is not a weakening of the
   * fix: SUPERADMIN already has unconditional access to everything via
   * requirePermission's own bypass (scope='ALL', access='FULL') before this
   * helper is ever reached.
   */
  isSuperAdmin?: boolean;
  /**
   * permissionScope TEAM only: the caller + their reporting tree
   * (utils/reportingTree.ts). Absent for TEAM means "not resolved" and the
   * rule falls back to the caller alone — narrower, never wider.
   */
  teamIds?: string[];
}

export interface BookingAccessRecord {
  workspaceId?: unknown;
  createdBy?: unknown;
  assignPerson?: unknown;
  assignmentStatus?: string;
}

/** Unwraps a populated Mongoose ref ({_id: ...}) or returns the raw id as a string. */
function idOf(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object" && v !== null && "_id" in (v as Record<string, unknown>)) {
    return String((v as { _id?: unknown })._id ?? "");
  }
  return String(v);
}

/**
 * Is this caller's own tenant the HOUSE tenant?
 *
 * In practice this is decided by the `workspaceObjectId === HOUSE_WORKSPACE_ID`
 * check below, not the `customerId` check above it. Verified against real prod
 * data (infra/audit/manual-bookings-access-fix-verification.md, Finding 1):
 * HOUSE_CUSTOMER_ID is a purpose-built placeholder Customer record — its own
 * description says it exists only to be ManualBooking.workspaceId for
 * intake/triage rows, "not a real client" — and no CustomerWorkspace links to
 * it. Real HOUSE staff's req.workspace.customerId resolves to a *different*
 * Customer record entirely (the one their actual CustomerWorkspace happens to
 * reference), so ctx.customerId === HOUSE_CUSTOMER_ID never fires for a real
 * logged-in HOUSE user today. The customerId check is kept as a forward-
 * compatible fallback (e.g. if that placeholder Customer ever gets its own
 * linked CustomerWorkspace) — it's not dead code, just not the path that
 * currently identifies HOUSE staff in production.
 */
export function isHouseCallerContext(ctx: BookingAccessContext): boolean {
  if (ctx.customerId === HOUSE_CUSTOMER_ID) return true;
  return idOf(ctx.workspaceObjectId) === HOUSE_WORKSPACE_ID;
}

function isHouseBookingRecord(booking: BookingAccessRecord): boolean {
  return idOf(booking.workspaceId) === HOUSE_CUSTOMER_ID;
}

/* ── THE visibility rule (2026-11-16) ─────────────────────────────────
 * One rule for every Manual Bookings read and write: the list, GET /export,
 * the Team Summary (bookingScopeClause, a Mongo clause) and every single-
 * booking route (canAccessBooking, a per-record predicate). Both derive from
 * bookingVisibility() below, so they cannot drift apart.
 *
 *  SUPERADMIN                     → every booking
 *  scope ALL                      → every booking (inside the tenant gate)
 *  scope WORKSPACE, HOUSE caller  → every booking (HOUSE staff work every
 *                                   client). A non-HOUSE WORKSPACE caller
 *                                   stays on the OWN rule, as before.
 *  scope TEAM                     → created by OR assigned to anyone in
 *                                   ctx.teamIds (caller + reporting tree)
 *  anything else (OWN)            → created by OR assigned to the caller
 *  TEAM and OWN keep the HOUSE intake triage carve-out: unassigned
 *  (PENDING_TO_ASSIGN) rows on the HOUSE customer.
 *
 * CHANGED 2026-11-16: "assigned to the caller" used to count only on HOUSE-
 * customer rows; it now counts on any row. The tenant gate still runs first,
 * so a non-HOUSE caller never reaches another tenant's row.
 * The ADMIN role gets no automatic widening — scope decides.
 */
export type BookingVisibility = { all: boolean; people: string[] };

export function bookingVisibility(ctx: BookingAccessContext): BookingVisibility {
  if (ctx.isSuperAdmin) return { all: true, people: [] };
  if (ctx.permissionScope === "ALL") return { all: true, people: [] };
  if (ctx.permissionScope === "WORKSPACE" && isHouseCallerContext(ctx)) return { all: true, people: [] };
  if (ctx.permissionScope === "TEAM") {
    const team = (ctx.teamIds ?? []).map(String);
    return { all: false, people: [...new Set([ctx.callerId, ...team])].filter(Boolean) };
  }
  return { all: false, people: ctx.callerId ? [ctx.callerId] : [] };
}

/**
 * The Mongo form of the rule, WITHOUT the tenant gate (that stays in
 * applyBookingReadGates). null = no restriction.
 */
export function bookingScopeClause(ctx: BookingAccessContext): Record<string, any> | null {
  const v = bookingVisibility(ctx);
  if (v.all) return null;
  const oids = v.people
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  return {
    $or: [
      { createdBy: { $in: v.people } },
      { assignPerson: { $in: oids } },
      { workspaceId: new mongoose.Types.ObjectId(HOUSE_CUSTOMER_ID), assignmentStatus: "PENDING_TO_ASSIGN" },
    ],
  };
}

/** Caller-side context without the TEAM tree (enough for tenant / HOUSE checks). */
export function bookingAccessBaseContext(req: any): BookingAccessContext {
  return {
    callerId: String(req.user?._id ?? req.user?.id ?? req.user?.sub ?? ""),
    customerId: req.workspace?.customerId ? String(req.workspace.customerId) : null,
    workspaceObjectId: req.workspaceObjectId,
    permissionScope: req.permissionScope,
    isSuperAdmin: isSuperAdmin(req),
  };
}

/**
 * The full context, with the TEAM tree resolved (scope TEAM only; one query
 * per level). Memoised on the request so a route checking many records walks
 * the tree once.
 */
export async function bookingAccessContext(req: any): Promise<BookingAccessContext> {
  const ctx = bookingAccessBaseContext(req);
  if (ctx.permissionScope === "TEAM" && !ctx.isSuperAdmin) {
    if (!req._bookingTeamIds) req._bookingTeamIds = await reportingTreeUserIds(ctx.callerId);
    ctx.teamIds = req._bookingTeamIds;
  }
  return ctx;
}

/**
 * canAccessBooking — per-record access predicate for ManualBooking.
 *
 * Same predicate governs READ and WRITE (per the verification report's
 * recommendation — WRITE is not currently more permissive than READ in any
 * legitimate flow found). `level` is accepted for call-site clarity/future
 * use but does not currently change the outcome; the WRITE-vs-READ
 * distinction is enforced upstream by requirePermission("manualBookings",
 * "WRITE"|"READ") on the route itself, which callers must already pass
 * before this helper runs.
 *
 * Order:
 *  a. TENANT GATE — HOUSE callers pass unconditionally (HOUSE staff manage
 *     all tenants). Non-HOUSE callers must match the booking's tenant in
 *     either id-space; otherwise denied outright, before any per-record rule
 *     below is even considered.
 *  b. THE visibility rule above (bookingVisibility): wide scopes allow;
 *     else created by / assigned to someone in scope, or a HOUSE
 *     PENDING_TO_ASSIGN intake row.
 */
export function canAccessBooking(
  ctx: BookingAccessContext,
  booking: BookingAccessRecord,
  level: BookingAccessLevel,
): boolean {
  void level;

  if (ctx.isSuperAdmin) return true;

  if (!isHouseCallerContext(ctx)) {
    const bookingWorkspaceId = idOf(booking.workspaceId);
    const tenantMatches =
      (!!ctx.customerId && bookingWorkspaceId === ctx.customerId) ||
      (ctx.workspaceObjectId != null && bookingWorkspaceId === idOf(ctx.workspaceObjectId));
    if (!tenantMatches) return false;
  }

  const v = bookingVisibility(ctx);
  if (v.all) return true;

  const createdBy = idOf(booking.createdBy);
  const assignee = idOf(booking.assignPerson);
  if (createdBy && v.people.includes(createdBy)) return true;
  if (assignee && v.people.includes(assignee)) return true;

  if (isHouseBookingRecord(booking) && booking.assignmentStatus === "PENDING_TO_ASSIGN") return true;

  return false;
}
