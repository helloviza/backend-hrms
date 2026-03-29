import { Schema, model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

const ProofDocumentSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    employeeDeclarationId: { type: Schema.Types.ObjectId, ref: "EmployeeDeclaration", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    financialYear: { type: String, required: true, trim: true },

    // What this proof is for
    declarationSection: {
      type: String,
      required: true,
      enum: ["80C", "80D_SELF", "80D_PARENTS", "HRA", "HOME_LOAN", "80E", "80G", "80TTA", "LTA", "80CCD1B", "OTHER"],
    },
    declarationLabel: { type: String, trim: true },
    declaredAmount: { type: Number, default: 0 },

    // File details
    fileName: { type: String, trim: true },
    fileSize: { type: Number },
    mimeType: { type: String, trim: true },
    s3Key: { type: String, trim: true },

    // Submission
    submittedAt: { type: Date },
    description: { type: String, trim: true },

    // HR verification
    verificationStatus: {
      type: String,
      enum: ["PENDING", "APPROVED", "REJECTED", "PARTIAL"],
      default: "PENDING",
    },
    approvedAmount: { type: Number },
    rejectionReason: { type: String, trim: true },
    verifiedBy: { type: Schema.Types.ObjectId, ref: "User" },
    verifiedAt: { type: Date },
    verifierNotes: { type: String, trim: true },
  },
  { timestamps: true },
);

ProofDocumentSchema.plugin(workspaceScopePlugin);
ProofDocumentSchema.index({ workspaceId: 1, employeeDeclarationId: 1, declarationSection: 1 });

export default model("ProofDocument", ProofDocumentSchema);
