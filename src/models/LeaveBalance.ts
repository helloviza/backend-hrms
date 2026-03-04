import mongoose, { Schema, Document } from "mongoose";

export interface ILeaveBalance extends Document {
  userId: mongoose.Types.ObjectId;
  year: number;
  balances: {
    CASUAL: number;
    SICK: number;
    PAID: number;
    UNPAID: number;
    MATERNITY: number;
    PATERNITY: number;
    COMPOFF: number;
    BEREAVEMENT: number;
  };
  updatedAt: Date;
}

const LeaveBalanceSchema = new Schema<ILeaveBalance>({
  userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
  year: { type: Number, required: true },
  balances: {
    CASUAL:      { type: Number, default: 12 },
    SICK:        { type: Number, default: 10 },
    PAID:        { type: Number, default: 18 },
    UNPAID:      { type: Number, default: 999 },
    MATERNITY:   { type: Number, default: 182 },
    PATERNITY:   { type: Number, default: 7 },
    COMPOFF:     { type: Number, default: 999 },
    BEREAVEMENT: { type: Number, default: 5 },
  },
  updatedAt: { type: Date, default: Date.now },
}, { timestamps: true });

LeaveBalanceSchema.index({ userId: 1, year: 1 }, { unique: true });

export default mongoose.model<ILeaveBalance>("LeaveBalance", LeaveBalanceSchema);
