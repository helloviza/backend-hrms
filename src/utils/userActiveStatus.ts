// apps/backend/src/utils/userActiveStatus.ts
//
// THE active/inactive model for a person (2026-09-16).
//
// Canonical flag: `User.status` ∈ { "ACTIVE", "INACTIVE" }. It lives on the
// identity every gate keys on — login, /auth/refresh, UserPresence.userId,
// CRM assignedTo, attendance, leaves, payroll all resolve a person by
// User._id. `Employee.status` / `Employee.isActive` are per-workspace HR
// mirrors joined via Employee.ownerId and are written ONLY through
// setUserActiveStatus below, never directly. `User.employmentStatus`
// ("Active", "Resigned", "Terminated", ...) is HR display text — with one
// coupling: a TERMINAL value deactivates through the same helper (see
// applyEmploymentStatusCoupling below). It never reactivates.
//
// Read semantics: an ABSENT status is active. Every consumer already
// filtered with `status: { $ne: "INACTIVE" }`, and in MongoDB $ne matches a
// missing field, which is exactly what we want here (legacy rows never had
// the field stamped). Keep that shape — do not "fix" it to an equality on
// "ACTIVE", that would silently drop every unstamped user.
//
// Historical records (bookings, attendance, invoices, audit, id→name
// resolvers) must keep resolving an inactive person by id. Those lookups are
// `User.find({ _id: { $in } })` and are deliberately NOT given this filter.
import mongoose from "mongoose";
import User from "../models/User.js";
import Employee from "../models/Employee.js";
import UserStatusAudit from "../models/UserStatusAudit.js";
import type { PendingWorkSnapshot } from "../services/pendingWork.service.js";

export const USER_STATUS_ACTIVE = "ACTIVE";
export const USER_STATUS_INACTIVE = "INACTIVE";

export type UserActiveStatus = typeof USER_STATUS_ACTIVE | typeof USER_STATUS_INACTIVE;

/** Normalise any status-ish input to the two canonical values. Anything that
 *  is not "INACTIVE" (case-insensitive) is ACTIVE — absent included. */
export function normalizeUserStatus(v: unknown): UserActiveStatus {
  return String(v ?? "").trim().toUpperCase() === USER_STATUS_INACTIVE
    ? USER_STATUS_INACTIVE
    : USER_STATUS_ACTIVE;
}

/** True unless the doc carries an explicit INACTIVE. Works on lean docs,
 *  hydrated docs and populated refs alike. */
export function isUserActive(user: { status?: unknown } | null | undefined): boolean {
  if (!user) return false;
  return normalizeUserStatus(user.status) === USER_STATUS_ACTIVE;
}

/** Mongo filter fragment for "active users" — spread into a User query. */
export function activeUserFilter(): { status: { $ne: string } } {
  return { status: { $ne: USER_STATUS_INACTIVE } };
}

/** Mongo filter fragment for "active employees" — spread into an Employee
 *  query. Employee carries both mirrors, so honour both (a legacy row with
 *  isActive:false and no status, or the reverse, is still inactive). */
export function activeEmployeeFilter(): { status: { $ne: string }; isActive: { $ne: boolean } } {
  return { status: { $ne: USER_STATUS_INACTIVE }, isActive: { $ne: false } };
}

/** Mongo filter fragment for "inactive employees" (the ?status=inactive list). */
export function inactiveEmployeeFilter(): { $or: Array<Record<string, unknown>> } {
  return { $or: [{ status: USER_STATUS_INACTIVE }, { isActive: false }] };
}

/* ── Employment Status coupling (2026-09-16, decision Q1 = value-based) ──
 * `User.employmentStatus` is HR display text, EXCEPT that a terminal value
 * means the person has left: any save that leaves a terminal value on a
 * currently-ACTIVE user deactivates them through setUserActiveStatus — even
 * when the save touched an unrelated field. The reverse is NOT coupled:
 * setting a non-terminal value never reactivates; that stays the explicit
 * Reactivate action. */
export const TERMINAL_EMPLOYMENT_STATUSES = ["RESIGNED", "TERMINATED"] as const;

export function isTerminalEmploymentStatus(v: unknown): boolean {
  const s = String(v ?? "").trim().toUpperCase();
  return (TERMINAL_EMPLOYMENT_STATUSES as readonly string[]).includes(s);
}

export type UserStatusTrigger = "explicit" | "employment_status" | "bulk_update" | "bulk_import" | "script";

export interface UserStatusAuditInput {
  trigger: UserStatusTrigger;
  actorId?: mongoose.Types.ObjectId | string | null;
  actorEmail?: string | null;
  employmentStatus?: string | null;
  acknowledgedPendingWork?: boolean;
  pendingWorkSnapshot?: PendingWorkSnapshot | null;
}

export interface SetUserActiveStatusArgs {
  userId: mongoose.Types.ObjectId | string;
  /** Tenant scope. When given, the User row must belong to this workspace and
   *  only that workspace's Employee mirror is touched. Omit ONLY for a
   *  platform SUPERADMIN acting cross-tenant. */
  workspaceId?: mongoose.Types.ObjectId | string | null;
  status: UserActiveStatus;
  /** Who / why. Every route passes it; a row is written to UserStatusAudit
   *  whenever the status actually changed. */
  audit?: UserStatusAuditInput;
}

export interface SetUserActiveStatusResult {
  userId: string;
  status: UserActiveStatus;
  /** false when no User matched (unknown id, or outside the workspace). */
  userMatched: boolean;
  /** false when the user was already in the requested state (no audit row). */
  changed: boolean;
  employeeMirrorsUpdated: number;
}

/**
 * The ONE write path for (de)activation. Stamps User.status and mirrors it
 * onto every Employee row owned by that user in the same workspace
 * (Employee.status + Employee.isActive), so the Employee-keyed consumers
 * (org chart, manager dashboard, GET /employees) and the User-keyed ones
 * (login, presence, CRM, attendance, payroll) can never disagree.
 *
 * Nothing else is touched: roles, permissions, bookings, attendance,
 * invoices and audit rows keep resolving the person by id.
 */
export async function setUserActiveStatus(args: SetUserActiveStatusArgs): Promise<SetUserActiveStatusResult> {
  const userOid = new mongoose.Types.ObjectId(String(args.userId));
  const status = normalizeUserStatus(args.status);
  const wsScope: Record<string, unknown> = {};
  if (args.workspaceId) wsScope.workspaceId = new mongoose.Types.ObjectId(String(args.workspaceId));

  const before = (await User.findOne({ _id: userOid, ...wsScope }).select("_id status email workspaceId").lean()) as any;
  if (!before) {
    return { userId: String(userOid), status, userMatched: false, changed: false, employeeMirrorsUpdated: 0 };
  }
  const fromStatus = normalizeUserStatus(before.status);

  await User.updateOne({ _id: userOid, ...wsScope }, { $set: { status } });

  // Mirrors are re-stamped even when User.status was already right — that is
  // how a drifted Employee row gets pulled back into line.
  const empResult = await Employee.updateMany(
    { ownerId: userOid, ...wsScope },
    { $set: { status, isActive: status === USER_STATUS_ACTIVE } },
  );

  const changed = fromStatus !== status;
  if (changed && args.audit) {
    await UserStatusAudit.create({
      workspaceId: before.workspaceId ?? (args.workspaceId ? new mongoose.Types.ObjectId(String(args.workspaceId)) : undefined),
      userId: userOid,
      email: before.email,
      fromStatus,
      toStatus: status,
      trigger: args.audit.trigger,
      employmentStatus: args.audit.employmentStatus ?? undefined,
      actorId: args.audit.actorId ? new mongoose.Types.ObjectId(String(args.audit.actorId)) : undefined,
      actorEmail: args.audit.actorEmail ?? undefined,
      acknowledgedPendingWork: args.audit.acknowledgedPendingWork,
      pendingWorkSnapshot: args.audit.pendingWorkSnapshot ?? undefined,
    });
  }

  return {
    userId: String(userOid),
    status,
    userMatched: true,
    changed,
    employeeMirrorsUpdated: empResult.modifiedCount,
  };
}

/**
 * The Employment Status → active-status coupling, called by every writer of
 * `User.employmentStatus` after it has persisted the value (PUT /employees/:id,
 * bulk-import; the interactive create refuses terminal values instead).
 * Value-based: fires whenever the persisted value is terminal and the user is
 * currently ACTIVE. Idempotent otherwise. Returns null when nothing happened.
 */
export async function applyEmploymentStatusCoupling(args: {
  userId: mongoose.Types.ObjectId | string;
  workspaceId?: mongoose.Types.ObjectId | string | null;
  employmentStatus: unknown;
  currentStatus: unknown;
  audit: Omit<UserStatusAuditInput, "trigger" | "employmentStatus"> & { trigger?: UserStatusTrigger };
}): Promise<SetUserActiveStatusResult | null> {
  if (!isTerminalEmploymentStatus(args.employmentStatus)) return null;
  if (normalizeUserStatus(args.currentStatus) === USER_STATUS_INACTIVE) return null;
  return setUserActiveStatus({
    userId: args.userId,
    workspaceId: args.workspaceId,
    status: USER_STATUS_INACTIVE,
    audit: {
      ...args.audit,
      trigger: args.audit.trigger ?? "employment_status",
      employmentStatus: String(args.employmentStatus).trim(),
    },
  });
}
