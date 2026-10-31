// apps/backend/src/models/UserNameAudit.ts
//
// One row per change of a person's name — written by renameUser
// (services/personNames.ts) and scripts/fix-company-named-users.ts: who
// renamed whom, from what to what, and as whom (themselves, Plumtrips staff,
// their company's Workspace Leader, or a one-off script).
// Append-only.
import { Schema, model } from "mongoose";

const NameSchema = new Schema(
  {
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    name: { type: String, trim: true },
  },
  { _id: false },
);

const UserNameAuditSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", index: true },
    customerId: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    from: { type: NameSchema },
    to: { type: NameSchema, required: true },
    via: { type: String, enum: ["self", "staff", "workspace_leader", "script"], required: true },
    actorId: { type: String, trim: true },
    actorEmail: { type: String, trim: true, lowercase: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

UserNameAuditSchema.index({ userId: 1, createdAt: -1 });

export default model("UserNameAudit", UserNameAuditSchema);
