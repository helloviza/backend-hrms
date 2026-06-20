// apps/backend/src/models/ExpenseActivity.ts
//
// Expense claim activity / audit log — Layer 2 (B3). An append-only stream of
// lifecycle events for a claim (Report), written co-located with the single
// lifecycle writer (services/reports.service.ts) plus the route-resident
// approve/decline/clarify/reimburse/remove transitions. Reads power the claim
// detail "Audit Log & Activity" timeline (oldest → newest).
//
// Tenant isolation reuses workspaceScopePlugin (auto-injects workspaceId on
// reads). Writes set workspaceId explicitly — create()/save() are not
// query-scoped.
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export type ExpenseActivityEvent =
  | "created"
  | "submitted"
  | "resubmitted"
  | "approved"
  | "declined"
  | "clarification_requested"
  | "reimbursed"
  | "expense_added"
  | "expense_removed"
  | "policy_check";

export const EXPENSE_ACTIVITY_EVENTS: ExpenseActivityEvent[] = [
  "created",
  "submitted",
  "resubmitted",
  "approved",
  "declined",
  "clarification_requested",
  "reimbursed",
  "expense_added",
  "expense_removed",
  "policy_check",
];

export interface IExpenseActivity extends Document {
  workspaceId: mongoose.Types.ObjectId;
  reportId: mongoose.Types.ObjectId;
  expenseId?: mongoose.Types.ObjectId | null;
  event: ExpenseActivityEvent;
  // actorId is the real user when known; omitted/null for automated entries.
  actorId?: mongoose.Types.ObjectId | null;
  // Display name: a real user's name, or "Policy Bot" / "System" for automated.
  actorName: string;
  note?: string | null;
  createdAt: Date;
}

const ExpenseActivitySchema = new Schema<IExpenseActivity>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true },
    reportId: { type: Schema.Types.ObjectId, ref: "Report", required: true },
    expenseId: { type: Schema.Types.ObjectId, ref: "Expense", default: null },
    event: { type: String, enum: EXPENSE_ACTIVITY_EVENTS, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    actorName: { type: String, required: true, trim: true },
    note: { type: String, trim: true, default: null },
  },
  // Append-only: createdAt is the timeline key; no updatedAt.
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Timeline read: every event for a claim in chronological order.
ExpenseActivitySchema.index({ reportId: 1, createdAt: 1 });
// Tenant scope.
ExpenseActivitySchema.index({ workspaceId: 1 });
// Analytics scan: cycle-time + policy-flag aggregation matches by workspace and
// filters to a small set of lifecycle events (GET /api/expenses/analytics).
ExpenseActivitySchema.index({ workspaceId: 1, event: 1 });

ExpenseActivitySchema.plugin(workspaceScopePlugin);

const ExpenseActivity =
  (mongoose.models.ExpenseActivity as mongoose.Model<IExpenseActivity>) ||
  mongoose.model<IExpenseActivity>("ExpenseActivity", ExpenseActivitySchema);

export default ExpenseActivity;
