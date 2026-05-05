import { env } from "../config/env.js";

/**
 * The 8 User fields that are Travel/SBT-specific and must be projected
 * out of API responses in DEPLOYMENT_MODE=saas.
 *
 * These fields are not deleted from the database — they're only stripped
 * from response payloads in saas mode. In plumbox mode this function is
 * a no-op.
 *
 * Updated: 2026-05-06 (Phase 2 Stage C)
 */
const TRAVEL_FIELDS = [
  "sbtEnabled",
  "sbtBookingType",
  "sbtRole",
  "sbtAssignedBookerId",
  "bandNumber",
  "canRaiseRequest",
  "canViewBilling",
  "vendorId",
] as const;

/**
 * Strips Travel-specific fields from a User-shape object when running
 * in saas mode. Returns a new object; does not mutate input.
 *
 * In plumbox mode (default), returns the input unchanged.
 *
 * @param userObj A plain object representing a User (toJSON output,
 *                .lean() result, or hand-built shape).
 * @returns A new object with TRAVEL_FIELDS removed in saas mode, or
 *          the original input in plumbox mode.
 */
export function stripTravelFields<T extends Record<string, any>>(userObj: T): T {
  if (env.DEPLOYMENT_MODE !== "saas") {
    return userObj;
  }
  if (!userObj || typeof userObj !== "object") {
    return userObj;
  }
  const result: Record<string, any> = { ...userObj };
  for (const field of TRAVEL_FIELDS) {
    delete result[field];
  }
  return result as T;
}
