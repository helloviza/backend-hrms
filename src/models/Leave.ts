// apps/backend/src/models/Leave.ts
import { Schema, model, Document, Types } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export interface LeaveDoc extends Document {
  workspaceId: Types.ObjectId;
  employeeId: Types.ObjectId; // ref to Employee (or User, if you prefer)
  type?: string;              // e.g. "CASUAL", "SICK"
  leaveType?: string;         // alternative name
  status: string;             // PENDING / APPROVED / REJECTED
  startDate: Date;
  endDate: Date;
  days?: number;
  reason?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const LeaveSchema = new Schema<LeaveDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    employeeId: { type: Schema.Types.ObjectId, ref: "Employee", required: true },

    type: { type: String },
    leaveType: { type: String },

    status: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED", "Pending", "Approved", "Rejected"],
      default: "PENDING",
      index: true,
    },

    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    days: { type: Number },

    reason: { type: String },
  },
  {
    timestamps: true,
  }
);

LeaveSchema.plugin(workspaceScopePlugin);
LeaveSchema.index({ workspaceId: 1, employeeId: 1, type: 1 });
LeaveSchema.index({ employeeId: 1, startDate: 1, endDate: 1 });
LeaveSchema.index({ status: 1 });

const Leave = model<LeaveDoc>("Leave", LeaveSchema);
export default Leave;
