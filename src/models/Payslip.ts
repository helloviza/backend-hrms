import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export type PayslipStatus = "DRAFT" | "FINAL" | "PUBLISHED";

export interface PayslipDocument extends Document {
  workspaceId: mongoose.Types.ObjectId;
  payrollRunId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  month: string;
  year: number;

  employeeSnapshot: {
    name: string;
    employeeCode: string;
    designation: string;
    department: string;
    dateOfJoining: string;
    pan: string;
    uanNumber: string;
    bankName: string;
    bankAccountNumber: string;
    bankIfsc: string;
    pfNumber: string;
    esiNumber: string;
    taxRegimePreference: string;
  };

  attendance: {
    workingDays: number;
    present: number;
    absent: number;
    halfDay: number;
    leaveDays: number;
    lopDays: number;
    late: number;
  };

  earnings: {
    basic: number;
    hra: number;
    specialAllowance: number;
    lta: number;
    medicalAllowance: number;
    conveyanceAllowance: number;
    childrenEducationAllowance: number;
    otherAllowances: number;
    lopDeduction: number;
    grossEarnings: number;
    reimbursements: number;
    taxableReimbursements: number;
    nonTaxableReimbursements: number;
  };

  reimbursementDetails: Array<{
    key: string;
    label: string;
    claimedAmount: number;
    approvedAmount: number;
    taxFreeAmount: number;
    taxableAmount: number;
  }>;

  deductions: {
    pfEmployee: number;
    esiEmployee: number;
    pt: number;
    tds: number;
    otherDeductions: number;
    totalDeductions: number;
  };

  employerContributions: {
    pfEmployer: number;
    esiEmployer: number;
  };

  netPay: number;

  section10Summary: {
    hra: number;
    lta: number;
    section10_14i: number;
    section10_14ii: number;
    total: number;
  };

  tdsWorkings: {
    regime: string;
    annualizedGross: number;
    section10Total: number;
    standardDeduction: number;
    totalDeductionsAllowed: number;
    taxableIncome: number;
    taxBeforeRebate: number;
    rebate87A: number;
    surcharge: number;
    cess: number;
    annualTax: number;
    monthlyTds: number;
    tdsPaidSoFar: number;
    tdsBalanceForYear: number;
  };

  status: PayslipStatus;
  publishedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const PayslipSchema = new Schema<PayslipDocument>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    payrollRunId: { type: Schema.Types.ObjectId, ref: "PayrollRun", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    month: { type: String },
    year: { type: Number },

    employeeSnapshot: {
      name: { type: String, default: "" },
      employeeCode: { type: String, default: "" },
      designation: { type: String, default: "" },
      department: { type: String, default: "" },
      dateOfJoining: { type: String, default: "" },
      pan: { type: String, default: "" },
      uanNumber: { type: String, default: "" },
      bankName: { type: String, default: "" },
      bankAccountNumber: { type: String, default: "" },
      bankIfsc: { type: String, default: "" },
      pfNumber: { type: String, default: "" },
      esiNumber: { type: String, default: "" },
      taxRegimePreference: { type: String, default: "NEW" },
    },

    attendance: {
      workingDays: { type: Number, default: 0 },
      present: { type: Number, default: 0 },
      absent: { type: Number, default: 0 },
      halfDay: { type: Number, default: 0 },
      leaveDays: { type: Number, default: 0 },
      lopDays: { type: Number, default: 0 },
      late: { type: Number, default: 0 },
    },

    earnings: {
      basic: { type: Number, default: 0 },
      hra: { type: Number, default: 0 },
      specialAllowance: { type: Number, default: 0 },
      lta: { type: Number, default: 0 },
      medicalAllowance: { type: Number, default: 0 },
      conveyanceAllowance: { type: Number, default: 0 },
      childrenEducationAllowance: { type: Number, default: 0 },
      otherAllowances: { type: Number, default: 0 },
      lopDeduction: { type: Number, default: 0 },
      grossEarnings: { type: Number, default: 0 },
      reimbursements: { type: Number, default: 0 },
      taxableReimbursements: { type: Number, default: 0 },
      nonTaxableReimbursements: { type: Number, default: 0 },
    },

    reimbursementDetails: {
      type: [
        {
          key: { type: String },
          label: { type: String },
          claimedAmount: { type: Number, default: 0 },
          approvedAmount: { type: Number, default: 0 },
          taxFreeAmount: { type: Number, default: 0 },
          taxableAmount: { type: Number, default: 0 },
        },
      ],
      default: [],
    },

    deductions: {
      pfEmployee: { type: Number, default: 0 },
      esiEmployee: { type: Number, default: 0 },
      pt: { type: Number, default: 0 },
      tds: { type: Number, default: 0 },
      otherDeductions: { type: Number, default: 0 },
      totalDeductions: { type: Number, default: 0 },
    },

    employerContributions: {
      pfEmployer: { type: Number, default: 0 },
      esiEmployer: { type: Number, default: 0 },
    },

    netPay: { type: Number, default: 0 },

    section10Summary: {
      hra: { type: Number, default: 0 },
      lta: { type: Number, default: 0 },
      section10_14i: { type: Number, default: 0 },
      section10_14ii: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },

    tdsWorkings: {
      regime: { type: String, default: "NEW" },
      annualizedGross: { type: Number, default: 0 },
      section10Total: { type: Number, default: 0 },
      standardDeduction: { type: Number, default: 0 },
      totalDeductionsAllowed: { type: Number, default: 0 },
      taxableIncome: { type: Number, default: 0 },
      taxBeforeRebate: { type: Number, default: 0 },
      rebate87A: { type: Number, default: 0 },
      surcharge: { type: Number, default: 0 },
      cess: { type: Number, default: 0 },
      annualTax: { type: Number, default: 0 },
      monthlyTds: { type: Number, default: 0 },
      tdsPaidSoFar: { type: Number, default: 0 },
      tdsBalanceForYear: { type: Number, default: 0 },
    },

    status: { type: String, enum: ["DRAFT", "FINAL", "PUBLISHED"], default: "DRAFT" },
    publishedAt: { type: Date },
  },
  { timestamps: true }
);

PayslipSchema.plugin(workspaceScopePlugin);
PayslipSchema.index({ workspaceId: 1, payrollRunId: 1, userId: 1 }, { unique: true });
PayslipSchema.index({ workspaceId: 1, userId: 1, month: 1 });
PayslipSchema.index({ workspaceId: 1, month: 1, status: 1 });

const Payslip =
  (mongoose.models.Payslip as mongoose.Model<PayslipDocument>) ||
  mongoose.model<PayslipDocument>("Payslip", PayslipSchema);

export default Payslip;
