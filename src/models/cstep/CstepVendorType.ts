// apps/backend/src/models/cstep/CstepVendorType.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepVendorType
 * ---------------
 * The editable list a CstepVendor's type is chosen from (replaces the old
 * fixed category enum on CstepVendor). Per workspace, unique by name.
 * Seeded once with a starter list the first time a workspace uses the
 * Vendor Master (routes/cstep.vendors.ts ensureVendorTypes), then fully
 * CSTEP-Admin editable — rename, deactivate, add, or delete one no vendor
 * uses.
 */
export interface ICstepVendorType extends Document {
  workspaceId: mongoose.Types.ObjectId;
  name: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const CstepVendorTypeSchema = new Schema<ICstepVendorType>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    name: { type: String, required: true, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

CstepVendorTypeSchema.index({ workspaceId: 1, name: 1 }, { unique: true });

CstepVendorTypeSchema.plugin(workspaceScopePlugin);

const CstepVendorType =
  (mongoose.models.CstepVendorType as mongoose.Model<ICstepVendorType>) ||
  mongoose.model<ICstepVendorType>("CstepVendorType", CstepVendorTypeSchema);

export default CstepVendorType;
