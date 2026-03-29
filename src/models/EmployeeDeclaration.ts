import { Schema, model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

const DonationSchema = new Schema(
  {
    organizationName: { type: String, trim: true },
    amount: { type: Number, default: 0 },
    deductionPercent: { type: Number, default: 50 },
    approvedAmount: { type: Number },
  },
  { _id: false },
);

const DeclarationsSubSchema = new Schema(
  {
    section80C: { type: Number, default: 0 },
    section80CCD1B: { type: Number, default: 0 },
    selfHealthInsurance: { type: Number, default: 0 },
    parentsHealthInsurance: { type: Number, default: 0 },
    parentsAreSenior: { type: Boolean, default: false },
    hraRentPaidAnnual: { type: Number, default: 0 },
    homeLoanInterest: { type: Number, default: 0 },
    educationLoanInterest: { type: Number, default: 0 },
    savingsInterest: { type: Number, default: 0 },
    ltaClaimedThisYear: { type: Number, default: 0 },
    otherDeductions: { type: Number, default: 0 },
    donations: [DonationSchema],
  },
  { _id: false },
);

const EmployeeDeclarationSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    financialYear: { type: String, required: true, trim: true },
    declarationWindowId: { type: Schema.Types.ObjectId, ref: "DeclarationWindow" },

    taxRegime: { type: String, enum: ["OLD", "NEW"], default: "OLD" },

    declarations: { type: DeclarationsSubSchema, default: () => ({}) },

    // Declaration lifecycle
    declarationStatus: {
      type: String,
      enum: ["DRAFT", "SUBMITTED", "FROZEN", "HR_UNLOCKED"],
      default: "DRAFT",
    },
    submittedAt: { type: Date },
    frozenAt: { type: Date },
    unlockedBy: { type: Schema.Types.ObjectId, ref: "User" },
    unlockedAt: { type: Date },
    unlockReason: { type: String, trim: true },

    // HR override
    hrOverride: {
      overriddenBy: { type: Schema.Types.ObjectId, ref: "User" },
      overriddenAt: { type: Date },
      reason: { type: String, trim: true },
      originalDeclarations: { type: Schema.Types.Mixed },
    },

    // Proof submission
    proofStatus: {
      type: String,
      enum: ["NOT_STARTED", "PARTIAL", "SUBMITTED", "VERIFIED", "REJECTED"],
      default: "NOT_STARTED",
    },

    // Verified/approved amounts
    approvedDeclarations: { type: DeclarationsSubSchema },

    verifiedBy: { type: Schema.Types.ObjectId, ref: "User" },
    verifiedAt: { type: Date },
    verificationNotes: { type: String, trim: true },

    // TDS impact
    tdsRecalculatedAt: { type: Date },
    estimatedAnnualTax: { type: Number },
    monthlyTdsFromNextMonth: { type: Number },
  },
  { timestamps: true },
);

EmployeeDeclarationSchema.plugin(workspaceScopePlugin);
EmployeeDeclarationSchema.index({ workspaceId: 1, userId: 1, financialYear: 1 }, { unique: true });
EmployeeDeclarationSchema.index({ workspaceId: 1, declarationWindowId: 1, declarationStatus: 1 });

export default model("EmployeeDeclaration", EmployeeDeclarationSchema);
