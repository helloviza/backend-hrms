import { Schema, model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

const PipelineSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    entity: { type: String, enum: ["VENDOR", "BUSINESS"], required: true },
    name: String,
    stage: {
      type: String,
      enum: ["NEW", "SHORTLISTED", "APPROVED", "REJECTED"],
      default: "NEW",
    },
    notes: String,
    ownerId: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);
PipelineSchema.plugin(workspaceScopePlugin);
PipelineSchema.index({ workspaceId: 1, status: 1 });
export default model("Pipeline", PipelineSchema);
