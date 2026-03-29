import { Schema, model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

const ApprovalSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    entity: {
      type: String,
      enum: ["PROFILE", "LEAVE", "VENDOR", "OD"],
      required: true,
    },
    entityId: { type: Schema.Types.ObjectId, required: true },
    requesterId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    approverId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED"],
      default: "PENDING",
    },
    note: String,
  },
  { timestamps: true },
);
ApprovalSchema.plugin(workspaceScopePlugin);
ApprovalSchema.index({ workspaceId: 1, requestId: 1 });
export default model("Approval", ApprovalSchema);
