// apps/backend/src/models/LeaveBalance.ts
import mongoose, { Schema } from "mongoose";

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

    lastAccrualMonth: { type: Number, default: 0 }, // 1–12
    probationEndDate: { type: Date },
    isConfirmed: { type: Boolean, default: false },
    joinDate: { type: Date },
  },
  { timestamps: true },
);

LeaveBalanceSchema.index({ userId: 1, year: 1 }, { unique: true });

export default mongoose.model<ILeaveBalance>(
  "LeaveBalance",
  LeaveBalanceSchema,
);
