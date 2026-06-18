// apps/backend/src/models/ExpenseWaSession.ts
import { Schema, model } from "mongoose";

/**
 * ExpenseWaSession
 * ----------------
 * Per-waId conversational state for the WhatsApp expense bot. ExpenseCapture is
 * per-message (one inbound receipt) and ExpenseReply is per-text; neither can
 * hold state that SPANS multiple receipts. This model is that missing piece — a
 * single doc per sender that carries the "open claim" being built across several
 * bills plus the current conversational step.
 *
 * USER-FACING TERM: "claim" (the Report model). openClaimId points at a DRAFT
 * Report; abandoning the chat leaves it a draft (nothing discarded, resumable).
 *
 * Tenant-less by waId (like ExpenseCapture/ExpenseReply) — the waId resolves the
 * workspace/employee, both cached here once known.
 *
 * States:
 *   idle               — no active conversation
 *   post_confirm       — an expense was just confirmed; offering Submit / Add to
 *                        claim / Later (pendingExpenseId is that expense)
 *   await_claim_name   — asked the user to name a new claim (next text = name)
 *   await_add_decision — an expense was confirmed while a claim is open; asking
 *                        "Add to ⟨claim⟩?" (Yes/No)
 *   open_claim         — a claim is open; offering Add more / Submit
 */

export type WaSessionState =
  | "idle"
  | "post_confirm"
  | "await_claim_name"
  | "await_add_decision"
  | "open_claim";

const ExpenseWaSessionSchema = new Schema(
  {
    waId: { type: String, required: true, unique: true, index: true }, // sender (digits only)
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", index: true },
    employeeId: { type: Schema.Types.ObjectId, ref: "User", index: true },

    state: {
      type: String,
      enum: ["idle", "post_confirm", "await_claim_name", "await_add_decision", "open_claim"],
      default: "idle",
      index: true,
    },

    // The DRAFT claim being built across receipts (null when none is open).
    openClaimId: { type: Schema.Types.ObjectId, ref: "Report", default: null },
    openClaimName: { type: String, trim: true, default: null },

    // The just-confirmed expense awaiting a Submit / Add / Later / Yes-No decision.
    pendingExpenseId: { type: Schema.Types.ObjectId, ref: "Expense", default: null },
  },
  { timestamps: true },
);

export default model("ExpenseWaSession", ExpenseWaSessionSchema);
