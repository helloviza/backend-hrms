// apps/backend/src/models/Role.ts
import mongoose, { Schema, Document, Model } from "mongoose";

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

// Avoid model overwrite in watch mode
export const Role: Model<RoleDocument> =
  mongoose.models.Role ||
  mongoose.model<RoleDocument>("Role", RoleSchema);

export default Role;
