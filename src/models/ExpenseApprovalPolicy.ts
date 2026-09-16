// apps/backend/src/models/ExpenseApprovalPolicy.ts
//
// The company's expense-approval RULEBOOK — one document per workspace
// (approval-engine sub-step 4, 2026-09-16). Everything here ships EMPTY /
// OFF: with a default policy the engine is off, the bot is off, no category
// rule exists, and a claim routes exactly as it does today (manager → admin).
//
//   engineEnabled          master switch for limit-based routing (sub-step 5
//                          flips live submit onto it; stored now, OFF)
//   bot                    auto-approve clean claims under thresholdBase
//   managerAllowance (D3)  a manager with NO limit of their own may finally
//                          approve up to limitBase; off = endorse only
//   categoryRules (D5)     per ExpenseCategory: never auto-approve / minimum
//                          approver limit / count as ×weight — mixed-category
//                          claim → the STRICTEST of each lever wins
//   departmentScopeEnforced  approvers' grant department scope (Department ids,
//                          sub-step 1) is applied when choosing an approver
//   topOfChain (D4)        what happens when nobody's limit covers the claim
//   firstStep (D2)         manager first, or authority pool only
//   legacyEscalation       the three scalars that used to live on
//                          CustomerWorkspace.config (expenseEscalationThreshold,
//                          advanceEscalationThreshold, seniorApproverId) —
//                          moved here by scripts/migrate-expense-policy-
//                          thresholds-2026-09-16.ts so there is ONE settings
//                          home; the pre-engine resolver reads them from here
//                          until sub-step 5 retires the walk that uses them.
//
// Amounts are in the workspace base currency (CustomerWorkspace.config.
// baseCurrency, FX slice 0). `version` bumps on every save and is snapshotted
// onto each routed claim, so a later rule change never rewrites why an old
// claim went where it did.
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export type TopOfChainMode = "TOP_APPROVES_FLAGGED_FOUR_EYES" | "TOP_APPROVES_FLAGGED" | "REFUSE_SUBMIT";
export type FirstStepMode = "MANAGER_THEN_AUTHORITY" | "AUTHORITY_ONLY";

export interface ICategoryRule {
  categoryId: mongoose.Types.ObjectId;
  neverAutoApprove: boolean; // (a) the bot must skip claims containing this category
  minApproverLimitBase?: number | null; // (b) approver must hold at least this limit
  weight?: number | null; // (c) count the claim as amount × weight for routing (≥ 1)
}

export interface IExpenseApprovalPolicy extends Document {
  workspaceId: mongoose.Types.ObjectId;
  version: number;
  engineEnabled: boolean;
  bot: {
    enabled: boolean;
    thresholdBase: number | null;
    require: { receipt: boolean; category: boolean; noDuplicate: boolean; positiveAmounts: boolean };
  };
  managerAllowance: { enabled: boolean; limitBase: number | null };
  categoryRules: ICategoryRule[];
  departmentScopeEnforced: boolean;
  topOfChain: TopOfChainMode;
  firstStep: FirstStepMode;
  legacyEscalation: {
    claimThresholdBase: number | null;
    advanceThresholdBase: number | null;
    seniorApproverId: mongoose.Types.ObjectId | null;
  };
  updatedBy?: mongoose.Types.ObjectId | null;
  history: { at: Date; by?: mongoose.Types.ObjectId | null; version: number; change: Record<string, any> }[];
  createdAt: Date;
  updatedAt: Date;
}

const CategoryRuleSchema = new Schema<ICategoryRule>(
  {
    categoryId: { type: Schema.Types.ObjectId, ref: "ExpenseCategory", required: true },
    neverAutoApprove: { type: Boolean, default: false },
    minApproverLimitBase: { type: Number, default: null, min: 0 },
    weight: { type: Number, default: null, min: 1 },
  },
  { _id: false },
);

const ExpenseApprovalPolicySchema = new Schema<IExpenseApprovalPolicy>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, unique: true, index: true },
    version: { type: Number, default: 1 },
    engineEnabled: { type: Boolean, default: false },
    bot: {
      enabled: { type: Boolean, default: false },
      thresholdBase: { type: Number, default: null, min: 0 },
      require: {
        receipt: { type: Boolean, default: true },
        category: { type: Boolean, default: true },
        noDuplicate: { type: Boolean, default: true },
        positiveAmounts: { type: Boolean, default: true },
      },
    },
    managerAllowance: {
      enabled: { type: Boolean, default: false },
      limitBase: { type: Number, default: null, min: 0 },
    },
    categoryRules: { type: [CategoryRuleSchema], default: [] },
    departmentScopeEnforced: { type: Boolean, default: false },
    topOfChain: {
      type: String,
      enum: ["TOP_APPROVES_FLAGGED_FOUR_EYES", "TOP_APPROVES_FLAGGED", "REFUSE_SUBMIT"],
      default: "TOP_APPROVES_FLAGGED_FOUR_EYES",
    },
    firstStep: { type: String, enum: ["MANAGER_THEN_AUTHORITY", "AUTHORITY_ONLY"], default: "MANAGER_THEN_AUTHORITY" },
    legacyEscalation: {
      claimThresholdBase: { type: Number, default: null, min: 0 },
      advanceThresholdBase: { type: Number, default: null, min: 0 },
      seniorApproverId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    history: {
      type: [
        new Schema(
          {
            at: { type: Date, required: true },
            by: { type: Schema.Types.ObjectId, ref: "User", default: null },
            version: { type: Number, required: true },
            change: { type: Schema.Types.Mixed, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);

ExpenseApprovalPolicySchema.plugin(workspaceScopePlugin);

const ExpenseApprovalPolicy =
  (mongoose.models.ExpenseApprovalPolicy as mongoose.Model<IExpenseApprovalPolicy>) ||
  mongoose.model<IExpenseApprovalPolicy>("ExpenseApprovalPolicy", ExpenseApprovalPolicySchema);

export default ExpenseApprovalPolicy;
