// apps/backend/src/models/WorkspaceFeatureAudit.ts
//
// One row per SUPERADMIN feature toggle — written ONLY by
// PUT /api/superadmin/workspaces/:id/features (routes/superadmin.workspaces.ts).
// `from` is the stored value before the write (null when the key was absent
// from the document); `to` is the value written. A flag forced by the one
// clicked (Approval Direct on → Approval Flow on, SBT off; SBT on → both
// approval flows off) gets its own row with `linkedTo` = the clicked flag,
// only when its stored value actually changed. Append-only.
import { Schema, model } from "mongoose";

const WorkspaceFeatureAuditSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true },
    feature: { type: String, trim: true, required: true },
    from: { type: Boolean, default: null },
    to: { type: Boolean, required: true },
    linkedTo: { type: String, trim: true },
    actorId: { type: Schema.Types.ObjectId, ref: "User" },
    actorEmail: { type: String, trim: true, lowercase: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

WorkspaceFeatureAuditSchema.index({ workspaceId: 1, feature: 1, createdAt: -1 });

export default model("WorkspaceFeatureAudit", WorkspaceFeatureAuditSchema);
