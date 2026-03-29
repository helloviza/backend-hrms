// apps/backend/src/models/Role.ts
import mongoose, { Schema, Document, Model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export type RoleKey =
  | "EMPLOYEE"
  | "MANAGER"
  | "LEAD"
  | "TEAM_LEAD"
  | "HR"
  | "ADMIN"
  | "SUPERADMIN"
  | "OWNER"
  | "VENDOR";

export interface RoleDocument extends Document {
  workspaceId: Schema.Types.ObjectId;
  key: RoleKey;            // machine key used in code / JWT / profile
  label: string;           // human label -> "HR Manager", "Employee"
  description?: string;    // optional description for UI / docs

  // simple flags for quick checks
  isPeopleManager: boolean; // can see team reports, approve leaves etc.
  isAdmin: boolean;         // full admin capabilities

  // optional granular permissions
  permissions: string[];    // e.g. ["leaves.approve", "attendance.export"]

  createdAt: Date;
  updatedAt: Date;
}

const RoleSchema = new Schema<RoleDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    key: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    isPeopleManager: {
      type: Boolean,
      default: false,
    },
    isAdmin: {
      type: Boolean,
      default: false,
    },
    permissions: {
      type: [String],
      default: [],
    },
  },
  {
    timestamps: true,
    collection: "roles",
  },
);

RoleSchema.plugin(workspaceScopePlugin);
RoleSchema.index({ workspaceId: 1, name: 1 }, { unique: true });

// Avoid model overwrite in watch mode
export const Role: Model<RoleDocument> =
  mongoose.models.Role ||
  mongoose.model<RoleDocument>("Role", RoleSchema);

export default Role;
