// apps/backend/src/models/ExpenseApproverGrant.ts
//
// The DURABLE, PER-PERSON home for expense capabilities (approval engine
// sub-step 1, 2026-09-16 — fixes audit F-01 and F-21).
//
// Before this, the expenses Team page wrote the literal platform `ADMIN` and
// `FINANCE` tokens into User.roles[]: a customer WORKSPACE_LEADER could mint
// platform ADMIN for anyone including themselves (F-01, Red), and any
// AccessConsole level change replaced User.roles wholesale and silently
// wiped those tokens (F-21). Nothing about a person's expense authority
// belongs on the platform role list, so it lives here instead:
//
//   approver              in the routing pool (read by the engine, next steps)
//   limitBase             personal approval limit in the workspace base
//                         currency; null = fall back to the rank default
//   scope.departmentIds   which departments they approve for; [] = all. A
//                         REFERENCE to the existing workspace-scoped
//                         Department collection (models/Department.ts, managed
//                         by masterData.departments.ts) — the same reference
//                         TravellerProfile.departmentId already uses — never
//                         free text.
//   capabilities.finance       may reimburse / disburse / recover
//   capabilities.expenseAdmin  may configure the module for THIS workspace
//                              (Team, Categories, policy, see-all)
//
// One document per (workspace, user). Workspace-local: it survives platform
// role changes, and it confers nothing outside the expense module —
// middleware/rbac.ts#requireAdmin never reads it.
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export interface IExpenseGrantChange {
  at: Date;
  by?: mongoose.Types.ObjectId | null;
  change: Record<string, any>; // the fields that changed, before → after
  reason?: string | null;
}

export interface IExpenseApproverGrant extends Document {
  workspaceId: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;
  approver: boolean;
  limitBase?: number | null;
  scope: { departmentIds: mongoose.Types.ObjectId[] };
  capabilities: { finance: boolean; expenseAdmin: boolean };
  active: boolean;
  grantedBy?: mongoose.Types.ObjectId | null;
  grantedAt: Date;
  updatedBy?: mongoose.Types.ObjectId | null;
  revokedBy?: mongoose.Types.ObjectId | null;
  revokedAt?: Date | null;
  revokeReason?: string | null;
  history: IExpenseGrantChange[];
  createdAt: Date;
  updatedAt: Date;
}

const ExpenseApproverGrantSchema = new Schema<IExpenseApproverGrant>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    approver: { type: Boolean, default: false },
    limitBase: { type: Number, default: null, min: 0 },
    scope: {
      departmentIds: { type: [{ type: Schema.Types.ObjectId, ref: "Department" }], default: [] },
    },
    capabilities: {
      finance: { type: Boolean, default: false },
      expenseAdmin: { type: Boolean, default: false },
    },
    active: { type: Boolean, default: true },
    grantedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    grantedAt: { type: Date, default: () => new Date() },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    revokedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, trim: true, default: null },
    history: {
      type: [
        new Schema(
          {
            at: { type: Date, required: true },
            by: { type: Schema.Types.ObjectId, ref: "User", default: null },
            change: { type: Schema.Types.Mixed, required: true },
            reason: { type: String, trim: true, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { timestamps: true },
);

ExpenseApproverGrantSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
ExpenseApproverGrantSchema.index({ workspaceId: 1, active: 1, approver: 1 });
ExpenseApproverGrantSchema.index({ workspaceId: 1, active: 1, "capabilities.expenseAdmin": 1 });

ExpenseApproverGrantSchema.plugin(workspaceScopePlugin);

const ExpenseApproverGrant =
  (mongoose.models.ExpenseApproverGrant as mongoose.Model<IExpenseApproverGrant>) ||
  mongoose.model<IExpenseApproverGrant>("ExpenseApproverGrant", ExpenseApproverGrantSchema);

export default ExpenseApproverGrant;
