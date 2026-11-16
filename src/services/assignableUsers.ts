// apps/backend/src/services/assignableUsers.ts
//
// Who may be picked as a Manual Booking's "Assign Person" (2026-11-17).
//
// THE RULE — the /admin/access source of truth (UserPermission), not the
// whole user roster:
//   - HOUSE staff (User.workspaceId = the HOUSE workspace) whose ACTIVE
//     UserPermission gives manualBookings access other than NONE, in the
//     STAFF universe; plus
//   - SUPERADMINs (by role), wherever their login lives;
//   - and in both cases: an ACTIVE user (status ≠ INACTIVE), login not
//     disabled, not a demo user, and never a customer / vendor account
//     (middleware/requireBillingStaff.ts isExternalAccount — customer,
//     onboarding-company and partner logins all carry those markers or
//     live outside the HOUSE workspace).
// Sorted by name. One UserPermission query + one User query; no per-user
// lookups.
//
// Used by GET /admin/manual-bookings/assignable-users (every Assign Person
// picker), GET /assignees (the list's filter), and the create / PUT /
// enquiry validation: a NEW or CHANGED assignPerson must be on this list.

import mongoose from "mongoose";
import User from "../models/User.js";
import { UserPermission } from "../models/UserPermission.js";
import { isExternalAccount } from "../middleware/requireBillingStaff.js";
import { personName } from "./actorNames.js";

export const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254"; // CustomerWorkspace._id
export const ASSIGNEE_NOT_ALLOWED =
  "That person can't be assigned: they don't have Manual Bookings access (or their account is inactive).";

export interface AssignableUser {
  _id: string;
  name: string;
  email: string;
}

const isSuperAdminUser = (u: any) =>
  (Array.isArray(u?.roles) && u.roles.map((r: any) => String(r).toUpperCase()).includes("SUPERADMIN")) ||
  String(u?.role || "").toUpperCase() === "SUPERADMIN" ||
  u?.isSuperAdmin === true;

export async function assignableUsers(): Promise<AssignableUser[]> {
  const perms: any[] = await UserPermission.find({
    status: "active",
    universe: "STAFF",
    "modules.manualBookings.access": { $in: ["READ", "WRITE", "FULL"] },
  })
    .select("userId")
    .lean();
  const permIds = perms.map((p) => String(p.userId)).filter((id) => mongoose.Types.ObjectId.isValid(id));

  const users: any[] = await User.find({
    $or: [
      { _id: { $in: permIds.map((id) => new mongoose.Types.ObjectId(id)) } },
      { roles: "SUPERADMIN" },
    ],
    status: { $ne: "INACTIVE" },
    loginDisabled: { $ne: true },
    isDemoUser: { $ne: true },
  })
    .select("name firstName lastName email roles role userType accountType customerMemberRole workspaceId isSuperAdmin")
    .lean();

  const permSet = new Set(permIds);
  return users
    .filter((u) => !isExternalAccount(u))
    .filter((u) =>
      isSuperAdminUser(u) ||
      (permSet.has(String(u._id)) && String(u.workspaceId ?? "") === HOUSE_WORKSPACE_ID),
    )
    .map((u) => ({ _id: String(u._id), name: personName(u) || String(u.email || ""), email: String(u.email || "") }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.email.localeCompare(b.email));
}

/** One user's display name (any user — for showing a current assignee who is no longer assignable). */
export async function userDisplayName(id: string): Promise<string> {
  if (!mongoose.Types.ObjectId.isValid(id)) return "";
  const u: any = await User.findById(id).select("name firstName lastName email").lean();
  return u ? personName(u) || String(u.email || "") : "";
}

/**
 * Validation for create / PUT / enquiry. `next` is the incoming assignPerson
 * (absent / empty = no change or unassign — always allowed); `current` is
 * the stored value (undefined on create). Only a NEW or CHANGED value is
 * checked, so a booking whose assignee has since lost access stays editable.
 */
export async function assigneeChangeError(next: unknown, current?: unknown): Promise<string | null> {
  const n = String((next as any)?._id ?? next ?? "").trim();
  if (!n) return null;
  if (n === String((current as any)?._id ?? current ?? "")) return null;
  const list = await assignableUsers();
  return list.some((u) => u._id === n) ? null : ASSIGNEE_NOT_ALLOWED;
}
