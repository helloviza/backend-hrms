// apps/backend/src/models/UserStatusAudit.ts
//
// One row per (de)activation of a person — written ONLY by
// setUserActiveStatus (utils/userActiveStatus.ts). Carries the pending-work
// snapshot taken at the moment of deactivation (services/pendingWork.service)
// so there is a record of what was open when the admin proceeded. Append-only.
import { Schema, model } from "mongoose";

const UserStatusAuditSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    email: { type: String, trim: true, lowercase: true },
    fromStatus: { type: String, trim: true },
    toStatus: { type: String, trim: true, required: true },
    /** What caused the flip. */
    trigger: {
      type: String,
      enum: ["explicit", "employment_status", "bulk_update", "bulk_import", "script"],
      required: true,
    },
    /** The employmentStatus value that drove an "employment_status" flip. */
    employmentStatus: { type: String, trim: true },
    actorId: { type: Schema.Types.ObjectId, ref: "User" },
    actorEmail: { type: String, trim: true, lowercase: true },
    /** true when the admin proceeded past a non-empty pending-work guard. */
    acknowledgedPendingWork: { type: Boolean },
    /** summarizePendingWork() output — counts per source, flags, totals. */
    pendingWorkSnapshot: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

UserStatusAuditSchema.index({ userId: 1, createdAt: -1 });

export default model("UserStatusAudit", UserStatusAuditSchema);
