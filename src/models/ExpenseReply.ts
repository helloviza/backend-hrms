// apps/backend/src/models/ExpenseReply.ts
import { Schema, model } from "mongoose";

/**
 * ExpenseReply
 * ------------
 * Expense Management — Sprint 2. One document per inbound WhatsApp TEXT message.
 *
 * The webhook enqueues these (idempotent on the WhatsApp messageId, exactly like
 * ExpenseCapture) and the worker drains them, matching each reply to the pending
 * ExpenseCapture for the same waId (awaiting_confirmation / awaiting_correction).
 * Keeping replies in their own queue avoids stuffing text into the media-shaped
 * ExpenseCapture model and keeps the webhook ack fast.
 *
 * Lifecycle: queued -> processing -> done | failed
 *   (tenant-less, like ExpenseCapture — the waId resolves the workspace).
 */

export type ExpenseReplyStatus = "queued" | "processing" | "done" | "failed";

const ExpenseReplySchema = new Schema(
  {
    messageId: { type: String, required: true, unique: true }, // WhatsApp wamid
    waId: { type: String, required: true, index: true }, // sender (digits only)
    phoneNumberId: { type: String, trim: true },
    text: { type: String, default: "" },

    status: {
      type: String,
      enum: ["queued", "processing", "done", "failed"],
      default: "queued",
      index: true,
    },
    attempts: { type: Number, default: 0 },
    errorMessage: { type: String, trim: true },
  },
  { timestamps: true },
);

export default model("ExpenseReply", ExpenseReplySchema);
