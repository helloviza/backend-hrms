// apps/backend/src/models/TravelPolicyVersion.ts
//
// One row per travel-policy VERSION of one customer workspace (Travel Policy
// module, docs/audits/travel-policy-audit.md §6). Tiers and rules are
// EMBEDDED so a published version is one immutable document — everything it
// evaluates with is frozen together.
//
// Not the legacy models/TravelPolicy.ts (flat, Pluto-only, decision D1: left
// untouched). Different collection.
//
// Stored status: DRAFT | PUBLISHED | ARCHIVED. "Scheduled / Active /
// Superseded" are derived from effectiveFrom/effectiveTo vs today (IST) —
// core.ts versionState() — so scheduled activation needs no cron.
//
// Invariants (enforced here and in services/travelPolicy.service.ts):
//   • at most one DRAFT per workspace (partial unique index)
//   • versionNumber unique per workspace, assigned at publish
//   • PUBLISHED / ARCHIVED rows are FROZEN: every update / replace / delete
//     path throws unless the filter targets status "DRAFT" or the caller
//     passes the internal option { tpInternal: true } (used ONLY by the
//     service for the audited transitions: closing / reopening effectiveTo,
//     archiving a still-scheduled version, and archiving the version a
//     same-day correction replaces).
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";
import type { Rule, Tier } from "../services/travelPolicy/core.js";

export type TravelPolicyVersionStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

export interface PolicyActor {
  id: string;
  name: string;
  email: string;
  kind: "CLIENT_ADMIN" | "CLIENT_MEMBER" | "PLUMTRIPS_STAFF";
  roles: string[];
}

export interface ITravelPolicyVersion extends Document {
  workspaceId: mongoose.Types.ObjectId;
  status: TravelPolicyVersionStatus;
  versionNumber: number | null;
  name: string;
  changeSummary: string;
  effectiveFrom: string | null; // IST "YYYY-MM-DD"
  effectiveTo: string | null; // null = until superseded
  tiers: Tier[];
  rules: Rule[];
  source: { kind: "TEMPLATE" | "VERSION" | "EXPENSE_BANDS" | "BLANK"; versionId?: string | null; templateVersion?: string | null };
  createdBy: PolicyActor;
  updatedBy: PolicyActor | null;
  publishedBy: PolicyActor | null;
  publishedAt: Date | null;
  archivedBy: PolicyActor | null;
  archivedAt: Date | null;
  archiveReason: string;
  /** Why it is archived: cancelled while still scheduled, or replaced on the day it started. */
  archiveKind: "CANCELLED" | "REPLACED_SAME_DAY" | null;
  replacedByVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const ActorSchema = new Schema(
  {
    id: { type: String, default: "" },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    kind: { type: String, enum: ["CLIENT_ADMIN", "CLIENT_MEMBER", "PLUMTRIPS_STAFF"], required: true },
    roles: { type: [String], default: [] },
  },
  { _id: false },
);

const TierSchema = new Schema(
  {
    tierKey: { type: String, required: true },
    name: { type: String, required: true },
    code: { type: String, default: "" },
    description: { type: String, default: "" },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    designationIds: { type: [String], default: [] },
    bandNumbers: { type: [Number], default: [] },
  },
  { _id: false },
);

const RuleSchema = new Schema(
  {
    ruleKey: { type: String, required: true },
    category: { type: String, enum: ["FLIGHT", "HOTEL", "FOREX", "VISA", "ESIM"], required: true },
    tierKey: { type: String, required: true },
    scope: {
      kind: { type: String, enum: ["DEFAULT", "CITY_CLASS", "REGION", "COUNTRY", "CITY"], required: true },
      value: { type: String, default: null },
    },
    currency: { type: String, default: "INR" },
    // Shape per category is owned by core.ts sanitizeParams — never written raw.
    params: { type: Schema.Types.Mixed, default: {} },
    notes: { type: String, default: "" },
  },
  { _id: false },
);

const TravelPolicyVersionSchema = new Schema<ITravelPolicyVersion>(
  {
    // workspaceId (→ CustomerWorkspace, required, indexed) comes from workspaceScopePlugin.
    status: { type: String, enum: ["DRAFT", "PUBLISHED", "ARCHIVED"], required: true, default: "DRAFT" },
    versionNumber: { type: Number, default: null },
    name: { type: String, default: "" },
    changeSummary: { type: String, default: "" },
    effectiveFrom: { type: String, default: null },
    effectiveTo: { type: String, default: null },
    tiers: { type: [TierSchema], default: [] },
    rules: { type: [RuleSchema], default: [] },
    source: {
      kind: { type: String, enum: ["TEMPLATE", "VERSION", "EXPENSE_BANDS", "BLANK"], default: "BLANK" },
      versionId: { type: String, default: null },
      templateVersion: { type: String, default: null },
    },
    createdBy: { type: ActorSchema, required: true },
    updatedBy: { type: ActorSchema, default: null },
    publishedBy: { type: ActorSchema, default: null },
    publishedAt: { type: Date, default: null },
    archivedBy: { type: ActorSchema, default: null },
    archivedAt: { type: Date, default: null },
    archiveReason: { type: String, default: "" },
    archiveKind: { type: String, enum: ["CANCELLED", "REPLACED_SAME_DAY", null], default: null },
    replacedByVersion: { type: Number, default: null },
  },
  { timestamps: true },
);

TravelPolicyVersionSchema.plugin(workspaceScopePlugin);

// One DRAFT per workspace.
TravelPolicyVersionSchema.index(
  { workspaceId: 1 },
  { unique: true, partialFilterExpression: { status: "DRAFT" }, name: "one_draft_per_workspace" },
);
// versionNumber unique per workspace once assigned.
TravelPolicyVersionSchema.index(
  { workspaceId: 1, versionNumber: 1 },
  { unique: true, partialFilterExpression: { versionNumber: { $type: "number" } }, name: "version_number_per_workspace" },
);
TravelPolicyVersionSchema.index({ workspaceId: 1, status: 1, effectiveFrom: 1 });

/* ── Freeze published versions ────────────────────────────────────────── */

export const FROZEN_MESSAGE = "A published travel-policy version cannot be edited. Create a new version instead.";

function targetsDraftOnly(q: any): boolean {
  const f = q.getFilter?.() ?? q.getQuery?.() ?? {};
  return f.status === "DRAFT";
}
function isInternal(q: any): boolean {
  return q.getOptions?.()?.tpInternal === true;
}

for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"] as const) {
  TravelPolicyVersionSchema.pre(op as any, function (this: any, next: any) {
    if (targetsDraftOnly(this) || isInternal(this)) return next();
    next(new Error(FROZEN_MESSAGE));
  });
}
for (const op of ["deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  TravelPolicyVersionSchema.pre(op as any, function (this: any, next: any) {
    if (targetsDraftOnly(this)) return next();
    next(new Error(FROZEN_MESSAGE));
  });
}
TravelPolicyVersionSchema.post("init", function (this: any) {
  this.$locals.loadedStatus = this.status;
});
TravelPolicyVersionSchema.pre("save", function (this: any, next: any) {
  if (this.isNew) return next();
  if (this.$locals.loadedStatus && this.$locals.loadedStatus !== "DRAFT") return next(new Error(FROZEN_MESSAGE));
  next();
});
TravelPolicyVersionSchema.pre("deleteOne", { document: true, query: false } as any, function (this: any, next: any) {
  if (this.status === "DRAFT") return next();
  next(new Error(FROZEN_MESSAGE));
});

const TravelPolicyVersion =
  (mongoose.models.TravelPolicyVersion as mongoose.Model<ITravelPolicyVersion>) ||
  mongoose.model<ITravelPolicyVersion>("TravelPolicyVersion", TravelPolicyVersionSchema);

export default TravelPolicyVersion;
