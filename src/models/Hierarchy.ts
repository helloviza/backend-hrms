import { Schema, model } from "mongoose";
const HierarchySchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: "User", unique: true },
  managerId: { type: Schema.Types.ObjectId, ref: "User" },
  hrOwnerId: { type: Schema.Types.ObjectId, ref: "User" },
});
export default model("Hierarchy", HierarchySchema);
