import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export type ReimbursementClaimStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED" | "PAID";

export interface ReimbursementClaimDocument extends Document {
  workspaceId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  salaryStructureId: mongoose.Types.ObjectId;

  month: string;
  year: number;

  reimbursementKey: string;
  reimbursementLabel: string;

  claimedAmount: number;
  approvedAmount: number;
  declaredMonthlyLimit: number;

  attachments: Array<{
    fileName: string;
    s3Key: string;
    uploadedAt: Date;
  }>;

  description: string;

  status: ReimbursementClaimStatus;

  rejectionReason: string;
  reviewedBy: mongoose.Types.ObjectId;
  reviewedAt: Date;

  payrollRunId: mongoose.Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const ReimbursementClaimSchema = new Schema<ReimbursementClaimDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    salaryStructureId: { type: Schema.Types.ObjectId, ref: "SalaryStructure" },

    month: { type: String, required: true },
    year: { type: Number, required: true },

    reimbursementKey: { type: String, required: true },
    reimbursementLabel: { type: String, default: "" },

    claimedAmount: { type: Number, required: true },
    approvedAmount: { type: Number, default: 0 },
    declaredMonthlyLimit: { type: Number, default: 0 },

    attachments: {
      type: [
        {
          fileName: { type: String },
          s3Key: { type: String },
          uploadedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },

    description: { type: String, default: "" },

    status: {
      type: String,
      enum: ["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "PAID"],
      default: "SUBMITTED",
    },

    rejectionReason: { type: String, default: "" },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },

    payrollRunId: { type: Schema.Types.ObjectId, ref: "PayrollRun" },
  },
  { timestamps: true }
);

ReimbursementClaimSchema.plugin(workspaceScopePlugin);

// One claim per user per month per reimbursement key
ReimbursementClaimSchema.index(
  { workspaceId: 1, userId: 1, month: 1, reimbursementKey: 1 },
  { unique: true }
);
ReimbursementClaimSchema.index({ workspaceId: 1, month: 1, status: 1 });
ReimbursementClaimSchema.index({ workspaceId: 1, payrollRunId: 1 });

const ReimbursementClaim =
  (mongoose.models.ReimbursementClaim as mongoose.Model<ReimbursementClaimDocument>) ||
  mongoose.model<ReimbursementClaimDocument>("ReimbursementClaim", ReimbursementClaimSchema);

export default ReimbursementClaim;
