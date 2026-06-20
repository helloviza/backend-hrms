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
  | "policy_check"
  // ── Advance (System B) events — additive; never written against a claim ──
  | "requested"
  | "disbursed";

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
  "requested",
  "disbursed",
];

export interface IExpenseActivity extends Document {
  workspaceId: mongoose.Types.ObjectId;
  // Subject of the event: a claim (reportId) OR an advance (advanceId) — exactly
  // one is set. reportId stays REQUIRED for claim entries (unchanged); it is
  // only optional when this is an advance entry.
  reportId?: mongoose.Types.ObjectId;
  advanceId?: mongoose.Types.ObjectId | null;
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
    // Required for claim entries (always supplied by the claim logger, so this
    // is unchanged for existing writes); optional only when advanceId is set.
    reportId: {
      type: Schema.Types.ObjectId,
      ref: "Report",
      required: function (this: any) {
        return !this.advanceId;
      },
    },
    advanceId: { type: Schema.Types.ObjectId, ref: "ExpenseAdvance", default: null },
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
// Timeline read for an advance (System B), same chronological shape.
ExpenseActivitySchema.index({ advanceId: 1, createdAt: 1 });
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
