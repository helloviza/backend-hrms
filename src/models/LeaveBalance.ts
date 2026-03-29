// apps/backend/src/models/LeaveBalance.ts
import mongoose, { Schema } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

interface IBalanceEntry {
  entitled: number;
  accrued: number;
  used: number;
  pending: number;
  adjusted: number;
  carriedForward?: number; // only EL
}

interface IEventLeaveEntry {
  occurrences: number;
  daysUsed: number;
}

export interface ILeaveBalance {
  workspaceId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  year: number;
  balances: {
    CL: IBalanceEntry;
    SL: IBalanceEntry;
    EL: IBalanceEntry & { carriedForward: number };
  };
  eventLeaves: {
    BEREAVEMENT: IEventLeaveEntry;
    PATERNITY: IEventLeaveEntry;
  };
  adjustmentLog?: {
    adjustedBy: mongoose.Types.ObjectId;
    days: number;
    reason: string;
    leaveType: string;
    adjustedAt: Date;
  }[];
  lastAccrualMonth: number;
  probationEndDate?: Date;
  isConfirmed: boolean;
  joinDate?: Date;
  updatedAt: Date;
}

const BalanceEntrySchema = {
  entitled: { type: Number, default: 0 },
  accrued: { type: Number, default: 0 },
  used: { type: Number, default: 0 },
  pending: { type: Number, default: 0 },
  adjusted: { type: Number, default: 0 },
};

const LeaveBalanceSchema = new Schema<ILeaveBalance>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    year: { type: Number, required: true },

    balances: {
      CL: { ...BalanceEntrySchema },
      SL: { ...BalanceEntrySchema },
      EL: {
        ...BalanceEntrySchema,
        carriedForward: { type: Number, default: 0 },
      },
    },

    eventLeaves: {
      BEREAVEMENT: {
        occurrences: { type: Number, default: 0 },
        daysUsed: { type: Number, default: 0 },
      },
      PATERNITY: {
        occurrences: { type: Number, default: 0 },
        daysUsed: { type: Number, default: 0 },
      },
    },

    adjustmentLog: [
      {
        adjustedBy: { type: Schema.Types.ObjectId, ref: "User" },
        days: Number,
        reason: String,
        leaveType: String,
        adjustedAt: { type: Date, default: Date.now },
      },
    ],

    lastAccrualMonth: { type: Number, default: 0 }, // 1–12
    probationEndDate: { type: Date },
    isConfirmed: { type: Boolean, default: false },
    joinDate: { type: Date },
  },
  { timestamps: true },
);

LeaveBalanceSchema.plugin(workspaceScopePlugin);
LeaveBalanceSchema.index({ workspaceId: 1, userId: 1, year: 1 }, { unique: true });
LeaveBalanceSchema.index({ userId: 1, year: 1 }, { unique: true });

export default mongoose.model<ILeaveBalance>(
  "LeaveBalance",
  LeaveBalanceSchema,
);
