import mongoose, { Schema, type Document, type Model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export interface DesignationDocument extends Document {
  workspaceId: mongoose.Types.ObjectId;
  name: string;
  department?: string;
  level?: number;
  isActive: boolean;
  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const DesignationSchema = new Schema<DesignationDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    name: { type: String, required: true, trim: true },
    department: { type: String, trim: true },
    level: { type: Number },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

DesignationSchema.plugin(workspaceScopePlugin);
DesignationSchema.index({ workspaceId: 1, name: 1 }, { unique: true });

const Designation: Model<DesignationDocument> =
  (mongoose.models.Designation as Model<DesignationDocument>) ||
  mongoose.model<DesignationDocument>("Designation", DesignationSchema);

export default Designation;
