// apps/backend/src/utils/bookingCustomerAccess.ts
/**
 * Access predicate for a CUSTOMER viewing/downloading their own
 * ManualBooking's attachments via GET /api/my-bookings/:bookingRef/attachments*.
 *
 * Deliberately separate from utils/bookingAccess.ts's canAccessBooking(),
 * which models STAFF access (RBAC permission scope, creator, HOUSE
 * assignment/triage) — none of that applies to a customer caller. See
 * infra/audit/booking-attachments-customer-access-audit.md, section C2, for
 * why the staff predicate can't be reused here.
 *
 * CRITICAL id-space note (same audit, Finding F1): ManualBooking.workspaceId
 * is a Customer._id. It must be compared against the caller's OWN
 * Customer._id (req.workspace.customerId) — NEVER req.workspaceObjectId
 * (a CustomerWorkspace._id, a different id space for the same tenant).
 * Getting this backwards either fails closed for every legitimate customer
 * (workspaceObjectId never matches a Customer._id) or, if ever "fixed" by
 * comparing the wrong pair, could rejoin the cross-tenant class of bug
 * bookingAccess.ts already documents as F10/F11.
 */

export interface CustomerBookingAccessContext {
  /** Caller's own Customer._id, i.e. req.workspace?.customerId. */
  customerId?: string | null;
  /** WORKSPACE_LEADER / approver / staff-admin — sees every booking for the tenant. */
  isOrgScope: boolean;
  /** Caller's own login email — matched case-insensitively against booking.passengers[].email. */
  email?: string | null;
}

export interface CustomerBookingAccessRecord {
  /** ManualBooking.workspaceId — a Customer._id (or populated {_id} doc). */
  workspaceId?: unknown;
  passengers?: Array<{ email?: string | null } | null | undefined> | null;
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
 * A customer may access a booking's attachments iff:
 *   1. TENANT GATE — the booking's tenant (ManualBooking.workspaceId, a
 *      Customer._id) matches the caller's own Customer._id. Fails closed if
 *      either side is missing/unresolved.
 *   2. Either the caller is ORG-scope (leader/approver/staff-admin — sees
 *      every booking for the tenant), OR the caller's own login email
 *      case-insensitively matches one of the booking's passengers[].email.
 */
export function canCustomerAccessBookingAttachments(
  ctx: CustomerBookingAccessContext,
  booking: CustomerBookingAccessRecord,
): boolean {
  if (!ctx.customerId) return false;
  const bookingCustomerId = idOf(booking.workspaceId);
  if (!bookingCustomerId || bookingCustomerId !== String(ctx.customerId)) return false;

  if (ctx.isOrgScope) return true;

  const email = String(ctx.email || "").trim().toLowerCase();
  if (!email) return false;

  const passengers = Array.isArray(booking.passengers) ? booking.passengers : [];
  return passengers.some((p) => String(p?.email || "").trim().toLowerCase() === email);
}
