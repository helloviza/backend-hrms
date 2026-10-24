// apps/backend/src/utils/bookingMetrics.ts
//
// THE one definition of "a ManualBooking that counts" in a money or volume
// figure — Gross Sales, Net Sales, GST Payable, Net Profit, Booking Count,
// Avg Margin, Total Trips / Total Spend and everything built from them.
//
//   1. Status. With no status filter, only CONFIRMED + INVOICED count —
//      PENDING / WIP are not sales yet and CANCELLED never is. When a caller
//      passes a status through the screen's EXISTING status filter, exactly
//      that status counts instead (so a "Cancelled" filter still shows the
//      cancelled figures, on purpose).
//   2. Soft delete. isActive:false never counts, whatever the status filter.
//   3. Demo. Session-aware: a demo session counts only demo rows, every other
//      caller (including jobs with no user) never sees one.
//
// Rows written before a field existed have NO isActive / isDemo key at all
// (most prod rows). `$ne:false` / `$ne:true` treat a missing key as live / not
// demo, which is the intent; an `$eq:true` style test would silently drop them.
//
// Every figure that reads ManualBooking goes through countedBookingMatch() (a
// $match) or countsInMetrics() (the same rule for rows already in memory, e.g.
// an export TOTALS row). Do not re-type these clauses inline.
//
// Deliberately imports no model, so route tests can mock models freely.

export const BOOKING_STATUSES = ["PENDING", "WIP", "CONFIRMED", "INVOICED", "CANCELLED"] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** The statuses a figure counts when no status filter is passed. */
export const COUNTED_STATUSES: readonly BookingStatus[] = ["CONFIRMED", "INVOICED"];

/** Demo impersonation or a demo login. */
export function isDemoSession(user: any): boolean {
  return user?.isDemoUser === true || user?._demoImpersonation === true;
}

/** Demo rows for a demo session, never a demo row for anyone else. */
export function demoClause(user?: any): Record<string, any> {
  return isDemoSession(user) ? { isDemo: true } : { isDemo: { $ne: true } };
}

/** Not soft-deleted, right side of the demo line. No status clause. */
export function liveBookingMatch(user?: any): Record<string, any> {
  return { isActive: { $ne: false }, ...demoClause(user) };
}

export function isBookingStatus(v: unknown): v is BookingStatus {
  return typeof v === "string" && (BOOKING_STATUSES as readonly string[]).includes(v);
}

export class InvalidStatusFilterError extends Error {
  readonly code = "INVALID_STATUS";
  constructor(readonly value: unknown) {
    super(`status must be one of: ${BOOKING_STATUSES.join(", ")}`);
  }
}

/**
 * A single-status filter param from a query string or body. Blank → undefined
 * (the default rule applies); a valid status (any case) → that status; anything
 * else throws InvalidStatusFilterError, so an unknown value is a 400 rather
 * than a silently empty (or silently unfiltered) report.
 */
export function parseStatusFilter(raw: unknown): BookingStatus | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim().toUpperCase();
  if (!s) return undefined;
  if (!isBookingStatus(s)) throw new InvalidStatusFilterError(raw);
  return s;
}

/**
 * The status clause of the rule. `explicit` is whatever the caller's existing
 * status filter already resolved to (a single status, or an `$in` the list
 * filter built); when absent, the default CONFIRMED + INVOICED applies.
 */
export function countedStatusClause(explicit?: unknown): Record<string, any> {
  if (explicit !== undefined && explicit !== null && explicit !== "") return { status: explicit };
  return { status: { $in: [...COUNTED_STATUSES] } };
}

/** The full rule as a $match fragment: live + right demo side + status. */
export function countedBookingMatch(user?: any, explicitStatus?: unknown): Record<string, any> {
  return { ...liveBookingMatch(user), ...countedStatusClause(explicitStatus) };
}

/**
 * The same rule for a row already loaded. Demo is not re-checked here: every
 * caller's query already applied demoClause, and a row in hand carries no
 * session. `statusFiltered` = the caller passed an explicit status filter, so
 * the rows are already exactly that status.
 */
export function countsInMetrics(row: any, statusFiltered: boolean): boolean {
  if (row?.isActive === false) return false;
  if (statusFiltered) return true;
  return (COUNTED_STATUSES as readonly string[]).includes(String(row?.status || ""));
}

/** Bookings whose flights are not real travel: cancelled or soft-deleted. */
export const CANCELLED_OR_DELETED_MATCH = {
  $or: [{ status: "CANCELLED" }, { isActive: false }],
} as const;
