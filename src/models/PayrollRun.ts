import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export type PayrollRunStatus = "DRAFT" | "PROCESSING" | "PROCESSED" | "APPROVED" | "DISBURSED" | "CANCELLED";

export interface PayrollRunDocument extends Document {
  workspaceId: mongoose.Types.ObjectId;
  month: string;
  year: number;
  status: PayrollRunStatus;
  summary: {
    totalEmployees: number;
    totalGross: number;
    totalNetPay: number;
    totalPfEmployee: number;
    totalPfEmployer: number;
    totalEsiEmployee: number;
    totalEsiEmployer: number;
    totalPt: number;
    totalTds: number;
    totalLopDeductions: number;
  };
  processedAt?: Date;
  approvedAt?: Date;
  approvedBy?: mongoose.Types.ObjectId;
  disbursedAt?: Date;
  disbursedBy?: mongoose.Types.ObjectId;
  notes?: string;
  createdBy: mongoose.Types.ObjectId;
}

const PayrollRunSchema = new Schema<PayrollRunDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    month: { type: String, required: true },
    year: { type: Number },
    status: {
      type: String,
      enum: ["DRAFT", "PROCESSING", "PROCESSED", "APPROVED", "DISBURSED", "CANCELLED"],
      default: "DRAFT",
    },

    summary: {
      totalEmployees: { type: Number, default: 0 },
      totalGross: { type: Number, default: 0 },
      totalNetPay: { type: Number, default: 0 },
      totalPfEmployee: { type: Number, default: 0 },
      totalPfEmployer: { type: Number, default: 0 },
      totalEsiEmployee: { type: Number, default: 0 },
      totalEsiEmployer: { type: Number, default: 0 },
      totalPt: { type: Number, default: 0 },
      totalTds: { type: Number, default: 0 },
      totalLopDeductions: { type: Number, default: 0 },
    },

    processedAt: { type: Date },
    approvedAt: { type: Date },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    disbursedAt: { type: Date },
    disbursedBy: { type: Schema.Types.ObjectId, ref: "User" },

    notes: { type: String },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

PayrollRunSchema.plugin(workspaceScopePlugin);
PayrollRunSchema.index({ workspaceId: 1, month: 1 }, { unique: true });
PayrollRunSchema.index({ workspaceId: 1, status: 1 });

const PayrollRun =
  (mongoose.models.PayrollRun as mongoose.Model<PayrollRunDocument>) ||
  mongoose.model<PayrollRunDocument>("PayrollRun", PayrollRunSchema);

export default PayrollRun;
