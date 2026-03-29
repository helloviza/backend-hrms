import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export interface ReimbursementHead {
  key: string;
  label: string;
  section: string;
  annualAmount: number;
  approvedAnnualAmount: number;
  annualTaxFreeLimit: number;
  cappedByStatute: boolean;
  isCustom: boolean;
  requiresBills: boolean;
  description: string;
  isActive: boolean;
}

export interface SalaryStructureDocument extends Document {
  workspaceId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  effectiveFrom: Date;
  effectiveTo?: Date;
  isActive: boolean;
  ctcAnnual: number;
  earnings: {
    basic: number;
    hra: number;
    specialAllowance: number;
    lta: number;
    medicalAllowance: number;
    conveyanceAllowance: number;
    childrenEducationAllowance: number;
    otherAllowances: number;
    totalReimbursements: number;
  };
  reimbursements: ReimbursementHead[];
  employerContributions: {
    pfEmployer: number;
    esiEmployer: number;
    gratuity: number;
    bonus: number;
  };
  monthly: {
    grossEarnings: number;
    totalDeductions: number;
    netPay: number;
    totalReimbursements: number;
    taxableReimbursements: number;
    nonTaxableReimbursements: number;
  };
  createdBy: mongoose.Types.ObjectId;
  updatedAt: Date;
}

const ReimbursementHeadSchema = new Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    section: { type: String, default: "" },
    annualAmount: { type: Number, default: 0 },
    approvedAnnualAmount: { type: Number, default: 0 },
    annualTaxFreeLimit: { type: Number, default: 0 },
    cappedByStatute: { type: Boolean, default: false },
    isCustom: { type: Boolean, default: false },
    requiresBills: { type: Boolean, default: false },
    description: { type: String, default: "" },
    isActive: { type: Boolean, default: true },
  },
  { _id: false }
);

const SalaryStructureSchema = new Schema<SalaryStructureDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },

    effectiveFrom: { type: Date, required: true },
    effectiveTo: { type: Date },
    isActive: { type: Boolean, default: true },

    ctcAnnual: { type: Number, required: true },

    earnings: {
      basic: { type: Number, default: 0 },
      hra: { type: Number, default: 0 },
      specialAllowance: { type: Number, default: 0 },
      lta: { type: Number, default: 0 },
      medicalAllowance: { type: Number, default: 0 },
      conveyanceAllowance: { type: Number, default: 0 },
      childrenEducationAllowance: { type: Number, default: 0 },
      otherAllowances: { type: Number, default: 0 },
      totalReimbursements: { type: Number, default: 0 },
    },

    reimbursements: { type: [ReimbursementHeadSchema], default: [] },

    employerContributions: {
      pfEmployer: { type: Number, default: 0 },
      esiEmployer: { type: Number, default: 0 },
      gratuity: { type: Number, default: 0 },
      bonus: { type: Number, default: 0 },
    },

    monthly: {
      grossEarnings: { type: Number, default: 0 },
      totalDeductions: { type: Number, default: 0 },
      netPay: { type: Number, default: 0 },
      totalReimbursements: { type: Number, default: 0 },
      taxableReimbursements: { type: Number, default: 0 },
      nonTaxableReimbursements: { type: Number, default: 0 },
    },

    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

SalaryStructureSchema.plugin(workspaceScopePlugin);
SalaryStructureSchema.index({ workspaceId: 1, userId: 1, isActive: 1 });
SalaryStructureSchema.index({ workspaceId: 1, userId: 1, effectiveFrom: -1 });

const SalaryStructure =
  (mongoose.models.SalaryStructure as mongoose.Model<SalaryStructureDocument>) ||
  mongoose.model<SalaryStructureDocument>("SalaryStructure", SalaryStructureSchema);

export default SalaryStructure;
