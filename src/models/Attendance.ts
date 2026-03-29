import { Schema, model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

const AttendanceSchema = new Schema({
  workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  date: { type: String, required: true }, // YYYY-MM-DD
  punches: [
    {
      ts: Date,
      type: { type: String, enum: ["IN", "OUT"] },
      geo: { lat: Number, lng: Number },
    },
  ],
  odRequests: [
    {
      reason: String,
      from: String,       // HH:MM
      to: String,         // HH:MM
      status: {
        type: String,
        enum: ["PENDING", "APPROVED", "REJECTED"],
        default: "PENDING",
      },
      requestedAt: { type: Date, default: Date.now },
      reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
      reviewedAt: Date,
      remarks: String,
    },
  ],
});
AttendanceSchema.plugin(workspaceScopePlugin);
AttendanceSchema.index({ workspaceId: 1, userId: 1, date: 1 }, { unique: true });
AttendanceSchema.index({ userId: 1, date: 1 }, { unique: true });
export default model("Attendance", AttendanceSchema);
