// apps/backend/src/models/ApprovalWorkflowAudit.ts
//
// Append-only audit trail for approval-workflow config changes
// (docs/audits/request-workflow-audit.md §12.1). Same enforcement as
// TravelPolicyAudit: every update / replace / delete path and every re-save of
// an existing row throws. Written only through
// services/approvalWorkflow/store.ts appendWorkflowAudit.
//
// `actor` is the real person and the capacity they acted in. A script run
// records the operator's name (--actor) with kind SCRIPT.
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export type ApprovalWorkflowAuditAction =
  | "DRAFT_SAVED"
  | "DRAFT_DISCARDED"
  | "VERSION_PUBLISHED"
  | "VERSION_ARCHIVED"
  /** scripts/statusneo-approval-setup.ts: departments, heads, traveller links, reporting managers. */
  | "ORG_DATA_SET";

export interface IApprovalWorkflowAudit extends Document {
  workspaceId: mongoose.Types.ObjectId;
  workspaceName: string;
  action: ApprovalWorkflowAuditAction;
  versionId: string | null;
  versionNumber: number | null;
  summary: string;
  changes: { field: string; from: unknown; to: unknown }[];
  reason: string;
  actor: { id: string; name: string; email: string; kind: string; roles: string[] };
  createdAt: Date;
}

const ApprovalWorkflowAuditSchema = new Schema<IApprovalWorkflowAudit>(
  {
    workspaceName: { type: String, default: "" },
    action: { type: String, required: true },
    versionId: { type: String, default: null },
    versionNumber: { type: Number, default: null },
    summary: { type: String, default: "" },
    changes: { type: [Schema.Types.Mixed] as any, default: [] },
    reason: { type: String, default: "" },
    actor: {
      id: { type: String, default: "" },
      name: { type: String, default: "" },
      email: { type: String, default: "" },
      kind: { type: String, default: "" },
      roles: { type: [String], default: [] },
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ApprovalWorkflowAuditSchema.plugin(workspaceScopePlugin);
ApprovalWorkflowAuditSchema.index({ workspaceId: 1, createdAt: -1 });

export const AW_AUDIT_APPEND_ONLY = "ApprovalWorkflowAudit is append-only: write a new entry instead of editing or deleting history.";
for (const op of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "findOneAndReplace",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
] as const) {
  ApprovalWorkflowAuditSchema.pre(op as any, function (next: any) {
    next(new Error(AW_AUDIT_APPEND_ONLY));
  });
}
ApprovalWorkflowAuditSchema.pre("save", function (next) {
  if (!this.isNew) return next(new Error(AW_AUDIT_APPEND_ONLY));
  next();
});
ApprovalWorkflowAuditSchema.pre("deleteOne", { document: true, query: false } as any, function (next: any) {
  next(new Error(AW_AUDIT_APPEND_ONLY));
});

const ApprovalWorkflowAudit =
  (mongoose.models.ApprovalWorkflowAudit as mongoose.Model<IApprovalWorkflowAudit>) ||
  mongoose.model<IApprovalWorkflowAudit>("ApprovalWorkflowAudit", ApprovalWorkflowAuditSchema);

export default ApprovalWorkflowAudit;
