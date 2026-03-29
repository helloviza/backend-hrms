import { Schema, model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

const HolidaySchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    date: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, default: "GENERAL" },
    region: { type: String, default: "All locations / Company-wide" },
    description: { type: String, default: "" },
  },
  { timestamps: true },
);
HolidaySchema.plugin(workspaceScopePlugin);
HolidaySchema.index({ workspaceId: 1, year: 1 });
export default model("Holiday", HolidaySchema);
