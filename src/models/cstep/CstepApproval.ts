// apps/backend/src/models/cstep/CstepApproval.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepApproval
 * -------------
 * CSTEP Travel & Claim Portal — approval trail for both CstepTravelRequest
 * and CstepClaim. entityId is polymorphic (no `ref` — it points at
 * CstepTravelRequest._id when entityType is "REQUEST", CstepClaim._id when
 * "CLAIM"); resolve the target collection from entityType at the call site.
 * Append-only, same discipline as CstepAmendment.
 *
 * Tenant isolation reuses the standard workspaceScopePlugin, same as
 * Expense.ts.
 */

export type CstepApprovalEntityType = "REQUEST" | "CLAIM";
export type CstepApprovalAction =
  | "APPROVE"
  | "RETURN"
  | "REJECT"
  | "CONFIRM_FUNDS"
  | "ADMIN_VERIFY"
  | "ACCOUNTS_VERIFY"
  // Traveller-side pre-trip-request lifecycle actions (Phase 4 addition,
  // additive to the original approver-decision set above).
  | "WITHDRAW"
  | "SUBMIT"
  | "RESUBMIT"
  | "START_REVIEW"
  // Step 1 Polish — owner/Admin cancellation of a not-yet-approved proposal.
  | "CANCEL"
  // Step 3 — the arrangement stage (Official user arranging an APPROVED
  // request's services).
  | "START_ARRANGING"
  | "ARRANGE_SERVICE"
  | "ADD_SERVICE"
  | "MARK_ARRANGED"
  // Step 4 — the traveller's post-trip Travel Report.
  | "START_REPORT"
  | "SUBMIT_REPORT"
  // Step 5 — Office/Accounts settlement (verification of the CstepSettlement
  // opened once REPORT_SUBMITTED is reached).
  | "START_VERIFICATION"
  | "VERIFY_LINE"
  | "SETTLE"
  // Step 6 — hand-off to Finance (not built yet; defined ahead of time so
  // the Processing board's "Transferred to Finance" stage/tab can exist).
  | "TRANSFER_TO_FINANCE";

export interface ICstepApproval extends Document {
  workspaceId: mongoose.Types.ObjectId;

  entityType: CstepApprovalEntityType;
  entityId: mongoose.Types.ObjectId; // polymorphic — see module note

  stage: string;
  actor: mongoose.Types.ObjectId; // ref User
  action: CstepApprovalAction;
  comment?: string;
  documentHash?: string;
  at: string; // ISO string, not Date — see module note
}

const CstepApprovalSchema = new Schema<ICstepApproval>({
  workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },

  entityType: { type: String, enum: ["REQUEST", "CLAIM"], required: true, index: true },
  entityId: { type: Schema.Types.ObjectId, required: true, index: true },

  stage: { type: String, required: true, trim: true },
  actor: { type: Schema.Types.ObjectId, ref: "User", required: true },
  action: {
    type: String,
    enum: [
      "APPROVE",
      "RETURN",
      "REJECT",
      "CONFIRM_FUNDS",
      "ADMIN_VERIFY",
      "ACCOUNTS_VERIFY",
      "WITHDRAW",
      "SUBMIT",
      "RESUBMIT",
      "START_REVIEW",
      "CANCEL",
      "START_ARRANGING",
      "ARRANGE_SERVICE",
      "ADD_SERVICE",
      "MARK_ARRANGED",
      "START_REPORT",
      "SUBMIT_REPORT",
      "START_VERIFICATION",
      "VERIFY_LINE",
      "SETTLE",
      "TRANSFER_TO_FINANCE",
    ],
    required: true,
  },
  comment: { type: String, trim: true },
  documentHash: { type: String, trim: true },
  at: { type: String, required: true },
});

CstepApprovalSchema.plugin(workspaceScopePlugin);

const CstepApproval =
  (mongoose.models.CstepApproval as mongoose.Model<ICstepApproval>) ||
  mongoose.model<ICstepApproval>("CstepApproval", CstepApprovalSchema);

export default CstepApproval;
