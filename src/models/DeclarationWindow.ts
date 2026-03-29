import { Schema, model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

const DeclarationWindowSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    financialYear: { type: String, required: true, trim: true }, // e.g. '2025-26'

    // Phase 1: Declaration window
    declarationOpen: { type: Boolean, default: false },
    declarationOpenedAt: { type: Date },
    declarationOpenedBy: { type: Schema.Types.ObjectId, ref: "User" },
    declarationDeadline: { type: Date },
    declarationFrozenAt: { type: Date },
    declarationFrozenBy: { type: Schema.Types.ObjectId, ref: "User" },

    // Phase 2: Proof submission window
    proofSubmissionOpen: { type: Boolean, default: false },
    proofSubmissionOpenedAt: { type: Date },
    proofSubmissionOpenedBy: { type: Schema.Types.ObjectId, ref: "User" },
    proofSubmissionDeadline: { type: Date },
    proofSubmissionClosedAt: { type: Date },
    proofSubmissionClosedBy: { type: Schema.Types.ObjectId, ref: "User" },

    // Reminder
    reminderSentAt: { type: Date },
    reminderSentCount: { type: Number, default: 0 },

    notes: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

DeclarationWindowSchema.plugin(workspaceScopePlugin);
DeclarationWindowSchema.index({ workspaceId: 1, financialYear: 1 }, { unique: true });

export default model("DeclarationWindow", DeclarationWindowSchema);
