import mongoose, { Schema, type Document, type Model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export type InviteStatus = "pending" | "accepted" | "expired" | "revoked";

export interface WorkspaceInviteDocument extends Document {
  workspaceId: Schema.Types.ObjectId;
  email: string;
  name?: string;
  role: string;
  department?: string;
  designation?: string;
  invitedBy: Schema.Types.ObjectId;
  token: string;
  expiresAt: Date;
  status: InviteStatus;
  acceptedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const WorkspaceInviteSchema = new Schema<WorkspaceInviteDocument>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "CustomerWorkspace",
      required: true,
      index: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },
    name: { type: String, trim: true },
    role: { type: String, default: "EMPLOYEE", uppercase: true },
    department: { type: String, trim: true },
    designation: { type: String, trim: true },
    invitedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    expiresAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ["pending", "accepted", "expired", "revoked"],
      default: "pending",
      index: true,
    },
    acceptedAt: { type: Date },
  },
  { timestamps: true },
);

/* ── Compound index: workspace + email for duplicate detection ───── */
WorkspaceInviteSchema.index({ workspaceId: 1, email: 1 });

/* ── Multi-tenant scope plugin ───────────────────────────────────── */
WorkspaceInviteSchema.plugin(workspaceScopePlugin);

const WorkspaceInvite: Model<WorkspaceInviteDocument> =
  (mongoose.models.WorkspaceInvite as Model<WorkspaceInviteDocument>) ||
  mongoose.model<WorkspaceInviteDocument>("WorkspaceInvite", WorkspaceInviteSchema);

export default WorkspaceInvite;
