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
  // FX slice 0: a manual / finance exchange-rate write on a line in this claim
  // (PATCH /expenses/:id/rate). The note carries old → new rate + amountBase.
  | "fx_rate_set"
  // Owner withdrew a submitted-but-untouched claim back to draft (audit F-14).
  | "withdrawn"
  // ── Audit trail / actor plumbing (approval-engine sub-step 2) ──
  // The routing decision at submit — the "why" (details.routing). Written by
  // the system actor today from the current manager→admin resolver; the
  // engine (sub-step 5) fills the same shape richly (limits, climb, rule).
  | "routed"
  // Sub-step 8: the engine moved a waiting item to a new approver because the
  // one it was sitting with was deactivated or lost approver rights. Carries
  // the former/new approver and the full routing decision in details.
  | "re_routed"
  // Sub-step 8: the engine could NOT place it after that departure — an admin
  // has to intervene. Pairs with Report/ExpenseAdvance.needsAttention.
  | "needs_attention"
  // Reserved for the Approval Bot (sub-step 5): a bot decision is a chain
  // level AND this event, actorType "bot".
  | "auto_approved"
  // Reserved: the claim climbed / was flagged over-limit / four-eyes appended.
  | "escalated"
  // ── Advance (System B) events — additive ──
  | "requested"
  | "disbursed"
  // Settlement engine (Phase 2): apply/detach are logged on the CLAIM timeline;
  // settled/recovered on the ADVANCE timeline.
  | "advance_applied"
  | "advance_detached"
  | "settled"
  | "recovered";

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
  "fx_rate_set",
  "withdrawn",
  "routed",
  "re_routed",
  "needs_attention",
  "auto_approved",
  "escalated",
  "requested",
  "disbursed",
  "advance_applied",
  "advance_detached",
  "settled",
  "recovered",
];

/** WHO or WHAT acted. "user" = a person; "bot" = the Approval Bot / Policy
 *  Bot; "system" = the platform itself (routing, migrations). Rows written
 *  before sub-step 2 have no actorType — readers normalise from actorName
 *  ("Policy Bot" → bot, "System" → system, else user). */
export type ExpenseActorType = "user" | "bot" | "system";

/** The canonical bot identity — the engine and the policy checker both use it. */
export const APPROVAL_BOT_ACTOR = { actorType: "bot" as ExpenseActorType, actorId: null, actorName: "Approval Bot" };
export const SYSTEM_ACTOR = { actorType: "system" as ExpenseActorType, actorId: null, actorName: "System" };

export function normalizeActorType(a: { actorType?: string | null; actorName?: string | null; actorId?: any }): ExpenseActorType {
  if (a?.actorType === "user" || a?.actorType === "bot" || a?.actorType === "system") return a.actorType;
  const n = String(a?.actorName || "").trim().toLowerCase();
  if (n.endsWith("bot")) return "bot";
  if (n === "system" || n === "routing") return "system";
  return "user";
}

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
  // WHO vs WHAT (sub-step 2). See normalizeActorType for pre-existing rows.
  actorType?: ExpenseActorType;
  note?: string | null;
  // ── Timing (sub-step 2): every entry carries its own clock ──
  // elapsedMs   ms since the PREVIOUS entry on the same claim / advance
  //             (null on the first entry). Computed by the writer, never
  //             by the reader, so the trail is reconstructable offline.
  // heldMs      for a decision / payment: ms the item sat with THIS actor —
  //             from the moment it was routed to them (chain level routedAt,
  //             or submittedAt / approvedAt) to the moment they acted. null
  //             when the event is not an actor's turn ending.
  elapsedMs?: number | null;
  heldMs?: number | null;
  prevActivityId?: mongoose.Types.ObjectId | null;
  // ── Structured payload (sub-step 2) — the audit-grade "how" ──
  // Free shape per event, documented at each writer: e.g. `submitted` carries
  // the base total + every line's original AND converted amount; `routed`
  // carries the routing decision; `approved` carries level / heldMs / note;
  // `reimbursed` carries the payout figures + the SoD-override marker;
  // `fx_rate_set` carries from → to. Corrections never edit an earlier row —
  // they are a NEW row whose details reference the old values.
  details?: Record<string, any> | null;
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
    actorType: { type: String, enum: ["user", "bot", "system"], default: "user" },
    note: { type: String, trim: true, default: null },
    elapsedMs: { type: Number, default: null },
    heldMs: { type: Number, default: null },
    prevActivityId: { type: Schema.Types.ObjectId, ref: "ExpenseActivity", default: null },
    details: { type: Schema.Types.Mixed, default: null },
  },
  // Append-only: createdAt is the timeline key; no updatedAt.
  { timestamps: { createdAt: true, updatedAt: false } },
);

/* ── APPEND-ONLY, enforced (sub-step 2) ───────────────────────────────
 * The trail is never edited or deleted through the model. Every Mongoose
 * update / replace / delete path throws; a re-save of an existing document
 * throws. The only way to change history is to append a new row. (Raw
 * collection access — migrations, the audit cleanup script — deliberately
 * bypasses this; that is an explicit, visible choice at the call site.) */
const APPEND_ONLY = "ExpenseActivity is append-only: write a new entry instead of editing or deleting history.";
for (const op of [
  "updateOne",
  "updateMany",
  "findOneAndUpdate",
  "findOneAndReplace",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
] as const) {
  ExpenseActivitySchema.pre(op as any, function (next: any) {
    next(new Error(APPEND_ONLY));
  });
}
ExpenseActivitySchema.pre("save", function (next) {
  if (!this.isNew) return next(new Error(APPEND_ONLY));
  next();
});
ExpenseActivitySchema.pre("deleteOne", { document: true, query: false } as any, function (next: any) {
  next(new Error(APPEND_ONLY));
});

// Timeline read: every event for a claim in chronological order.
ExpenseActivitySchema.index({ reportId: 1, createdAt: 1 });
// Timeline read for an advance (System B), same chronological shape.
ExpenseActivitySchema.index({ advanceId: 1, createdAt: 1 });
// Tenant scope.
ExpenseActivitySchema.index({ workspaceId: 1 });
// Analytics scan: cycle-time + policy-flag aggregation matches by workspace and
// filters to a small set of lifecycle events (GET /api/expenses/analytics).
ExpenseActivitySchema.index({ workspaceId: 1, event: 1 });
// Reports hub — Activity Logs report: workspace-scoped, date-ranged, newest-first
// scan across BOTH claim and advance entries (GET /api/expense-activity).
ExpenseActivitySchema.index({ workspaceId: 1, createdAt: -1 });

ExpenseActivitySchema.plugin(workspaceScopePlugin);

const ExpenseActivity =
  (mongoose.models.ExpenseActivity as mongoose.Model<IExpenseActivity>) ||
  mongoose.model<IExpenseActivity>("ExpenseActivity", ExpenseActivitySchema);

export default ExpenseActivity;
