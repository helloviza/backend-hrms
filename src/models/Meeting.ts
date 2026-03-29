import { Schema, model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

const MeetingSchema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
  roomId: { type: String, required: true, unique: true },
  title: { type: String, required: true },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  createdAt: { type: Date, default: Date.now },
});
MeetingSchema.plugin(workspaceScopePlugin);
MeetingSchema.index({ workspaceId: 1, createdBy: 1, date: -1 });

export default model("Meeting", MeetingSchema);
