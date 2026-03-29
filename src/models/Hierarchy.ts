import { Schema, model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

const HierarchySchema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", unique: true },
  managerId: { type: Schema.Types.ObjectId, ref: "User" },
  hrOwnerId: { type: Schema.Types.ObjectId, ref: "User" },
});
HierarchySchema.plugin(workspaceScopePlugin);
HierarchySchema.index({ workspaceId: 1, employeeId: 1 });
export default model("Hierarchy", HierarchySchema);
