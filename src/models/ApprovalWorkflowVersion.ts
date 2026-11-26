// apps/backend/src/models/ApprovalWorkflowVersion.ts
//
// One row per approval-workflow VERSION of one customer workspace
// (docs/audits/request-workflow-audit.md §12.1). Built like
// TravelPolicyVersion: the whole config is embedded, so a published version
// is one immutable document.
//
// Off means today's behaviour: a workspace with no PUBLISHED version, or whose
// published version has enabled: false, routes exactly as before
// (pickApproverEmail → resolveSubmitRouting → requestDeciders). There is no
// backfill. services/approvalWorkflow/store.ts activeWorkflowFor() is the one
// reader that decides "in force or not".
//
// Invariants (enforced here and in services/approvalWorkflow/store.ts):
//   • at most one DRAFT per workspace          (partial unique index)
//   • at most one PUBLISHED per workspace      (partial unique index; the
//     previous one is ARCHIVED before the next is published — a crash in
//     between leaves none published, which is "off", never two)
//   • versionNumber unique per workspace, assigned at publish
//   • PUBLISHED / ARCHIVED rows are FROZEN: every update / replace / delete
//     path throws unless the filter targets status "DRAFT" or the caller
//     passes { awInternal: true } (store.ts only: archiving the version a new
//     publish replaces).
//
// The config fields are written only through services/approvalWorkflow/config.ts
// sanitizeWorkflowConfig — never raw.
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";
import type { WorkflowConfig } from "../services/approvalWorkflow/config.js";

export type ApprovalWorkflowStatus = "DRAFT" | "PUBLISHED" | "ARCHIVED";

export interface WorkflowActor {
  id: string;
  name: string;
  email: string;
  kind: "CLIENT_ADMIN" | "CLIENT_MEMBER" | "PLUMTRIPS_STAFF" | "SCRIPT";
  roles: string[];
}

export interface IApprovalWorkflowVersion extends Document, WorkflowConfig {
  workspaceId: mongoose.Types.ObjectId;
  status: ApprovalWorkflowStatus;
  versionNumber: number | null;
  changeSummary: string;
  copiedFrom: { workspaceId: string; versionNumber: number } | null;
  createdBy: WorkflowActor;
  updatedBy: WorkflowActor | null;
  publishedBy: WorkflowActor | null;
  publishedAt: Date | null;
  archivedBy: WorkflowActor | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ActorSchema = new Schema(
  {
    id: { type: String, default: "" },
    name: { type: String, default: "" },
    email: { type: String, default: "" },
    kind: { type: String, enum: ["CLIENT_ADMIN", "CLIENT_MEMBER", "PLUMTRIPS_STAFF", "SCRIPT"], required: true },
    roles: { type: [String], default: [] },
  },
  { _id: false },
);

const StepSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    phase: { type: String, enum: ["REQUEST", "COST"], default: "REQUEST" },
    type: { type: String, required: true },
    role: { type: String, enum: ["APPROVER", "WATCHER"], required: true },
    decisionRule: { type: String, enum: ["ANY", "ALL"], default: "ANY" },
    fallback: { type: String, default: "SKIP" },
    fallbackUserId: { type: String, default: null },
    samePersonRule: { type: String, enum: ["AUTO_PASS", "ASK_AGAIN"], default: "AUTO_PASS" },
    selfRule: { type: String, enum: ["SKIP", "NEXT_IN_LINE", "REFUSE"], default: "NEXT_IN_LINE" },
    watcherEvents: { type: [String], default: [] },
    reminders: { afterHours: { type: [Number], default: [] } },
  },
  { _id: false },
);

const ApprovalWorkflowVersionSchema = new Schema<IApprovalWorkflowVersion>(
  {
    // workspaceId (→ CustomerWorkspace, required, indexed) comes from workspaceScopePlugin.
    status: { type: String, enum: ["DRAFT", "PUBLISHED", "ARCHIVED"], required: true, default: "DRAFT" },
    versionNumber: { type: Number, default: null },
    changeSummary: { type: String, default: "" },
    copiedFrom: { type: Schema.Types.Mixed, default: null },

    enabled: { type: Boolean, default: false },
    template: { type: String, enum: ["STANDARD", "DEPT_HEAD_WATCHER", "MULTI_LEVEL_COST", "CUSTOM"], default: "CUSTOM" },
    raisedBy: { type: String, enum: ["EMPLOYEE", "DESK", "BOTH"], default: "EMPLOYEE" },
    requestOnlyMode: { type: Boolean, default: false },
    purpose: {
      required: { type: Boolean, default: false },
      options: { type: [String], default: [] },
    },
    completion: { type: String, enum: ["FIRST_BOOKING", "ALL_SERVICES_BOOKED"], default: "FIRST_BOOKING" },
    leadersMayDecide: { type: String, enum: ["ALLOW", "DENY", "OVERRIDE_WITH_REASON"], default: "ALLOW" },
    steps: { type: [StepSchema], default: [] },
    groups: { type: [Schema.Types.Mixed] as any, default: [] },
    email: {
      travelAdminEmails: { type: [String], default: [] },
      sender: {
        level: { type: String, enum: ["A"], default: "A" },
        displayName: { type: String, default: "" },
        replyTo: { type: String, default: "" },
      },
      events: { type: Schema.Types.Mixed, default: {} },
    },

    createdBy: { type: ActorSchema, required: true },
    updatedBy: { type: ActorSchema, default: null },
    publishedBy: { type: ActorSchema, default: null },
    publishedAt: { type: Date, default: null },
    archivedBy: { type: ActorSchema, default: null },
    archivedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false },
);

ApprovalWorkflowVersionSchema.plugin(workspaceScopePlugin);

ApprovalWorkflowVersionSchema.index(
  { workspaceId: 1 },
  { unique: true, partialFilterExpression: { status: "DRAFT" }, name: "aw_one_draft_per_workspace" },
);
ApprovalWorkflowVersionSchema.index(
  { workspaceId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "PUBLISHED" }, name: "aw_one_published_per_workspace" },
);
ApprovalWorkflowVersionSchema.index(
  { workspaceId: 1, versionNumber: 1 },
  { unique: true, partialFilterExpression: { versionNumber: { $type: "number" } }, name: "aw_version_number_per_workspace" },
);

/* ── Freeze published versions ────────────────────────────────────────── */

export const AW_FROZEN_MESSAGE = "A published approval-workflow version cannot be edited. Publish a new version instead.";

function targetsDraftOnly(q: any): boolean {
  const f = q.getFilter?.() ?? q.getQuery?.() ?? {};
  return f.status === "DRAFT";
}
function isInternal(q: any): boolean {
  return q.getOptions?.()?.awInternal === true;
}

for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"] as const) {
  ApprovalWorkflowVersionSchema.pre(op as any, function (this: any, next: any) {
    if (targetsDraftOnly(this) || isInternal(this)) return next();
    next(new Error(AW_FROZEN_MESSAGE));
  });
}
for (const op of ["deleteOne", "deleteMany", "findOneAndDelete"] as const) {
  ApprovalWorkflowVersionSchema.pre(op as any, function (this: any, next: any) {
    if (targetsDraftOnly(this)) return next();
    next(new Error(AW_FROZEN_MESSAGE));
  });
}
ApprovalWorkflowVersionSchema.post("init", function (this: any) {
  this.$locals.loadedStatus = this.status;
});
ApprovalWorkflowVersionSchema.pre("save", function (this: any, next: any) {
  if (this.isNew) return next();
  if (this.$locals.loadedStatus && this.$locals.loadedStatus !== "DRAFT") return next(new Error(AW_FROZEN_MESSAGE));
  next();
});
ApprovalWorkflowVersionSchema.pre("deleteOne", { document: true, query: false } as any, function (this: any, next: any) {
  if (this.status === "DRAFT") return next();
  next(new Error(AW_FROZEN_MESSAGE));
});

const ApprovalWorkflowVersion =
  (mongoose.models.ApprovalWorkflowVersion as mongoose.Model<IApprovalWorkflowVersion>) ||
  mongoose.model<IApprovalWorkflowVersion>("ApprovalWorkflowVersion", ApprovalWorkflowVersionSchema);

export default ApprovalWorkflowVersion;
