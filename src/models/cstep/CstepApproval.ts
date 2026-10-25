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
  // Vendor payment on an arrangement line — Finance/Admin, UNPAID <-> PAID.
  | "VENDOR_PAYMENT"
  // Step 4 — the traveller's post-trip Travel Report.
  | "START_REPORT"
  | "SUBMIT_REPORT"
  // Report approval — the Manager approves the submitted report on to the
  // Official (REPORT_UNDER_APPROVAL → REPORT_SUBMITTED).
  | "APPROVE_REPORT"
  // Reduce-only amount correction, reason mandatory: a settlement line
  // (Travel Desk / Admin), a claim line at approval or a report-leg fare
  // during report approval (Manager). The comment carries before → after
  // and the reason.
  | "REDUCE_AMOUNT"
  // Step 5 — Office/Accounts settlement (verification of the CstepSettlement
  // opened once REPORT_SUBMITTED is reached).
  | "START_VERIFICATION"
  | "VERIFY_LINE"
  // A per-diem change at settlement (days / rate / meal deduction), reason
  // mandatory; the comment carries each figure's before → after.
  | "PERDIEM_ADJUST"
  | "SETTLE"
  // Step 6 — hand-off to Finance (not built yet; defined ahead of time so
  // the Processing board's "Transferred to Finance" stage/tab can exist).
  | "TRANSFER_TO_FINANCE"
  // Step 6 — Finance marks the reimbursement paid out (REIMBURSED).
  | "FINANCE_SETTLE"
  // Exit/bounce paths — send-backs after approval. The approval-stage
  // send-back stays RETURN; reject at that stage is REJECT (above).
  | "RETURN_REPORT" // Manager → traveller (REPORT_UNDER_APPROVAL) or Official → traveller (REPORT_SUBMITTED), → REPORT_PENDING
  | "RETURN_TO_OFFICIAL" // Finance → Official: TRANSFERRED_TO_FINANCE → REPORT_SUBMITTED
  // Claims addition — a claim has no Official stage: Finance sends it back
  // to CSTEP Admin verification (TRANSFERRED_TO_FINANCE → APPROVED). The
  // Admin's verification itself reuses ADMIN_VERIFY above.
  | "RETURN_TO_ADMIN"
  // Finance-c — Finance disallows one traveller-paid settlement line (→ ₹0),
  // or every payable item at once ("Reject all"), while the case is with it.
  // Finance's reductions reuse REDUCE_AMOUNT / PERDIEM_ADJUST, stage FINANCE.
  | "FINANCE_REJECT_LINE"
  | "FINANCE_REJECT"
  // Change requests — a cancel / rebook raised against an arranged service
  // (CstepChangeRequest), and the Official's DONE / DECLINED resolution.
  | "CHANGE_REQUEST"
  | "CHANGE_RESOLVE";

export interface ICstepApproval extends Document {
  workspaceId: mongoose.Types.ObjectId;

  entityType: CstepApprovalEntityType;
  entityId: mongoose.Types.ObjectId; // polymorphic — see module note

  stage: string;
  actor: mongoose.Types.ObjectId; // ref User
  action: CstepApprovalAction;
  comment?: string;
  documentHash?: string;
  /** #12 — a Travel Desk action (arrange / change request / settlement) taken
   * by a CSTEP Admin who is not the Travel Desk for this traveller: neither
   * holds the workspace Travel Desk grant nor is the traveller's Official.
   * Allowed — the Admin is top authority — but marked, so it reads as an
   * override, not a desk action. Unset on every other entry. */
  adminOverride?: boolean;
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
      "VENDOR_PAYMENT",
      "START_REPORT",
      "SUBMIT_REPORT",
      "APPROVE_REPORT",
      "REDUCE_AMOUNT",
      "START_VERIFICATION",
      "VERIFY_LINE",
      "PERDIEM_ADJUST",
      "SETTLE",
      "TRANSFER_TO_FINANCE",
      "FINANCE_SETTLE",
      "RETURN_REPORT",
      "RETURN_TO_OFFICIAL",
      "RETURN_TO_ADMIN",
      "FINANCE_REJECT_LINE",
      "FINANCE_REJECT",
      "CHANGE_REQUEST",
      "CHANGE_RESOLVE",
    ],
    required: true,
  },
  comment: { type: String, trim: true },
  documentHash: { type: String, trim: true },
  adminOverride: { type: Boolean },
  at: { type: String, required: true },
});

CstepApprovalSchema.plugin(workspaceScopePlugin);

const CstepApproval =
  (mongoose.models.CstepApproval as mongoose.Model<ICstepApproval>) ||
  mongoose.model<ICstepApproval>("CstepApproval", CstepApprovalSchema);

export default CstepApproval;
