// apps/backend/src/models/LeavePolicy.ts
import mongoose, { Schema, Document, Model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export interface ILeavePolicy extends Document {
  workspaceId: mongoose.Types.ObjectId;
  probationDays: number;
  leaveYearStart: string;
  slCreditMode: "MONTHLY" | "UPFRONT";
  elCarryForwardCap: number;
  allowNegativeSL: boolean;
  negativeSLLimit: number;
  entitlements: {
    CL: number;
    SL: number;
    EL: number;
    BEREAVEMENT: number;
    PATERNITY: number;
    MATERNITY: number;
    COMPOFF: number;
    UNPAID: number;
  };
  prorateELForNewJoiners: boolean;
  prorateCLForNewJoiners: boolean;
  prorateSLForNewJoiners: boolean;
  restrictCLInNoticePeriod: boolean;
  allowELInNoticePeriod: boolean;
}

interface ILeavePolicyModel extends Model<ILeavePolicy> {
  getOrCreate(workspaceId?: mongoose.Types.ObjectId): Promise<ILeavePolicy>;
}

const LeavePolicySchema = new Schema<ILeavePolicy>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },

    // Probation
    probationDays: { type: Number, default: 90 },

    // Leave year
    leaveYearStart: { type: String, default: "01-01" }, // MM-DD

    // SL credit mode
    slCreditMode: {
      type: String,
      enum: ["MONTHLY", "UPFRONT"],
      default: "UPFRONT",
    },

    // Carry forward
    elCarryForwardCap: { type: Number, default: 45 },

    // Negative balance
    allowNegativeSL: { type: Boolean, default: true },
    negativeSLLimit: { type: Number, default: 2 },

    // Annual entitlements
    entitlements: {
      CL: { type: Number, default: 9 },
      SL: { type: Number, default: 6 },
      EL: { type: Number, default: 18 },
      BEREAVEMENT: { type: Number, default: 5 },
      PATERNITY: { type: Number, default: 5 },
      MATERNITY: { type: Number, default: 182 },
      COMPOFF: { type: Number, default: 999 },
      UNPAID: { type: Number, default: 999 },
    },

    // Proration
    prorateELForNewJoiners: { type: Boolean, default: true },
    prorateCLForNewJoiners: { type: Boolean, default: true },
    prorateSLForNewJoiners: { type: Boolean, default: false },

    // Notice period restrictions
    restrictCLInNoticePeriod: { type: Boolean, default: true },
    allowELInNoticePeriod: { type: Boolean, default: true },
  },
  { timestamps: true },
);

LeavePolicySchema.plugin(workspaceScopePlugin);
LeavePolicySchema.index({ workspaceId: 1, name: 1 });

LeavePolicySchema.statics.getOrCreate = async function (
  workspaceId?: mongoose.Types.ObjectId,
): Promise<ILeavePolicy> {
  const filter = workspaceId ? { workspaceId } : { workspaceId: null };
  let doc = await this.findOne(filter);
  if (!doc) {
    doc = await this.create(filter);
  }
  return doc;
};

export default mongoose.model<ILeavePolicy, ILeavePolicyModel>(
  "LeavePolicy",
  LeavePolicySchema,
);
