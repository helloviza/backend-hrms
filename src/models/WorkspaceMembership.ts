// apps/backend/src/models/WorkspaceMembership.ts
//
// One row per (person, workspace) — the future source of truth for "which
// companies can this login act in, and as what" (docs/audits/
// multi-workspace-login-audit.md §8.1).
//
// PHASE 1 (shadow): written by scripts/backfill-workspace-memberships.ts and
// by services/workspaceMembership.service.ts syncMembershipFromUser from the
// user-creation / role-change / deactivation paths. Still exactly one row per
// user (isDefault = true).
//
// PHASE 2 (session): login / refresh stamp the default ACTIVE row into the
// tokens as wsid / mid / mver (routes/auth.ts sessionMembershipFor); refresh,
// requireWorkspace and /auth/me re-check status + tokenVersion. Claims are
// still derived as before. Rollback = MEMBERSHIP_SESSION_DISABLED=true.
//
// No workspaceScopePlugin: a membership lookup is by userId across
// workspaces by design.
import mongoose, { Schema, type Model } from "mongoose";

export const MEMBERSHIP_KINDS = ["STAFF", "CUSTOMER", "VENDOR"] as const;
export type MembershipKind = (typeof MEMBERSHIP_KINDS)[number];

export const MEMBERSHIP_STATUSES = ["ACTIVE", "SUSPENDED", "REMOVED"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const MEMBER_ROLES = ["WORKSPACE_LEADER", "APPROVER", "REQUESTER"] as const;
export type MembershipMemberRole = (typeof MEMBER_ROLES)[number];

export interface WorkspaceMembershipFlags {
  sbtEnabled?: boolean;
  sbtBookingType?: "flight" | "hotel" | "both";
  sbtRole?: "L1" | "L2" | "BOTH" | null;
  sbtAssignedBookerId?: mongoose.Types.ObjectId | null;
  bandNumber?: number | null;
  canRaiseRequest?: boolean;
  canViewBilling?: boolean;
  canManageUsers?: boolean;
}

export interface WorkspaceMembershipDoc {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  /** CustomerWorkspace._id — THE session key. */
  workspaceId: mongoose.Types.ObjectId;
  /** CustomerWorkspace.customerId (Customer._id), denormalised for the legacy claims. */
  customerId: string | null;
  kind: MembershipKind;
  /** Per-membership roles (Phase 1: a copy of User.roles). */
  roles: string[];
  /** Mirrors CustomerMember.role for CUSTOMER memberships. */
  memberRole: MembershipMemberRole | null;
  customerMemberId: mongoose.Types.ObjectId | null;
  /** Staff L1–L8 — filled in a later phase, with UserPermission. */
  levelCode: string | null;
  flags: WorkspaceMembershipFlags;
  status: MembershipStatus;
  /** Landing workspace; exactly one per user. */
  isDefault: boolean;
  /** Bump to revoke this membership's sessions (read from Phase 2). */
  tokenVersion: number;
  invitedBy: mongoose.Types.ObjectId | null;
  removedAt: Date | null;
  removedBy: mongoose.Types.ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

const FlagsSchema = new Schema<WorkspaceMembershipFlags>(
  {
    sbtEnabled: { type: Boolean },
    sbtBookingType: { type: String, enum: ["flight", "hotel", "both"] },
    sbtRole: { type: String, enum: ["L1", "L2", "BOTH", null], default: null },
    sbtAssignedBookerId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    bandNumber: { type: Number, default: null },
    canRaiseRequest: { type: Boolean },
    canViewBilling: { type: Boolean },
    canManageUsers: { type: Boolean },
  },
  { _id: false },
);

const WorkspaceMembershipSchema = new Schema<WorkspaceMembershipDoc>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true },
    customerId: { type: String, trim: true, default: null },
    kind: { type: String, enum: MEMBERSHIP_KINDS, required: true },
    roles: { type: [String], default: [] },
    memberRole: { type: String, enum: [...MEMBER_ROLES, null], default: null },
    customerMemberId: { type: Schema.Types.ObjectId, ref: "CustomerMember", default: null },
    levelCode: { type: String, default: null },
    flags: { type: FlagsSchema, default: () => ({}) },
    status: { type: String, enum: MEMBERSHIP_STATUSES, default: "ACTIVE" },
    isDefault: { type: Boolean, default: false },
    tokenVersion: { type: Number, default: 0 },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    removedAt: { type: Date, default: null },
    removedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, collection: "workspacememberships" },
);

WorkspaceMembershipSchema.index({ userId: 1, workspaceId: 1 }, { unique: true });
WorkspaceMembershipSchema.index({ workspaceId: 1, status: 1 });
WorkspaceMembershipSchema.index({ userId: 1, isDefault: 1 });

const WorkspaceMembership: Model<WorkspaceMembershipDoc> =
  (mongoose.models.WorkspaceMembership as Model<WorkspaceMembershipDoc>) ||
  mongoose.model<WorkspaceMembershipDoc>("WorkspaceMembership", WorkspaceMembershipSchema);

export default WorkspaceMembership;
