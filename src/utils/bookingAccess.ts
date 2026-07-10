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
 *  b. EXISTING per-record rules, unchanged from the prior GET /:id logic:
 *     permissionScope "ALL" (now bounded by the tenant gate above) → allow;
 *     else creator, or a HOUSE PENDING_TO_ASSIGN intake row, or a HOUSE row
 *     assigned to the caller.
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

  if (ctx.permissionScope === "ALL") return true;

  if (idOf(booking.createdBy) === ctx.callerId) return true;

  const houseBooking = isHouseBookingRecord(booking);
  if (houseBooking && booking.assignmentStatus === "PENDING_TO_ASSIGN") return true;
  if (houseBooking && idOf(booking.assignPerson) === ctx.callerId) return true;

  return false;
}
