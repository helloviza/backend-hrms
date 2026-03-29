import mongoose, { Schema, type Document, type Model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export interface DepartmentDocument extends Document {
  workspaceId: mongoose.Types.ObjectId;
  name: string;
  code?: string;
  description?: string;
  managerId?: mongoose.Types.ObjectId;
  parentDepartmentId?: mongoose.Types.ObjectId;
  isActive: boolean;
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const DepartmentSchema = new Schema<DepartmentDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, trim: true },
    description: { type: String, trim: true },
    managerId: { type: Schema.Types.ObjectId, ref: "User" },
    parentDepartmentId: { type: Schema.Types.ObjectId, ref: "Department" },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

DepartmentSchema.plugin(workspaceScopePlugin);
DepartmentSchema.index({ workspaceId: 1, name: 1 }, { unique: true });
DepartmentSchema.index({ workspaceId: 1, isActive: 1 });

const Department: Model<DepartmentDocument> =
  (mongoose.models.Department as Model<DepartmentDocument>) ||
  mongoose.model<DepartmentDocument>("Department", DepartmentSchema);

export default Department;
