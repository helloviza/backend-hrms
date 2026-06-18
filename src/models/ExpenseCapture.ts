// apps/backend/src/models/ExpenseCapture.ts
import { Schema, model } from "mongoose";

/**
 * ExpenseCapture
 * --------------
 * Expense Management — Sprint 1 inbound receipt capture.
 *
 * One document per inbound WhatsApp media message. It doubles as both the
 * processing job (the in-process worker claims `status:"queued"` rows) and the
 * resulting Expense draft once the sender is resolved and the file is stored.
 *
 * Lifecycle:
 *   queued               — webhook persisted it; awaiting the worker
 *   processing            — claimed by the worker (atomic findOneAndUpdate)
 *   captured              — media stored in S3, draft linked to an employee/workspace
 *   extracting            — claimed by the extraction stage (Gemini vision)
 *   awaiting_confirmation — parsed fields sent to the sender; awaiting "1"/confirm
 *   awaiting_correction   — sender (or a failed extraction) must supply a value
 *   confirmed             — sender confirmed; an Expense record was persisted.
 *                           Post-confirm conversation (submit / add-to-claim /
 *                           bundling) lives in ExpenseWaSession, keyed per waId.
 *   cancelled             — sender replied "cancel"
 *   unregistered          — sender's waId did not map to any User (reply sent)
 *   failed                — gave up after MAX_ATTEMPTS transient errors
 *
 * NOTE: intentionally NOT scoped with workspaceScopePlugin. A capture starts
 * tenant-less (workspaceId is unknown until the worker resolves the waId), so
 * workspaceId is optional here and filled in on resolution.
 */

export type ExpenseCaptureStatus =
  | "queued"
  | "processing"
  | "captured"
  | "extracting"
  | "awaiting_confirmation"
  | "awaiting_correction"
  | "confirmed"
  | "cancelled"
  | "unregistered"
  | "failed";

const ExpenseCaptureSchema = new Schema(
  {
    // --- Idempotency / source identity (set at webhook enqueue) --------------
    messageId: { type: String, required: true, unique: true }, // WhatsApp wamid
    mediaId: { type: String, required: true },
    mime: { type: String, required: true },
    mediaType: { type: String, enum: ["image", "document"], required: true },
    filename: { type: String, trim: true }, // documents only
    caption: { type: String, trim: true },

    waId: { type: String, required: true, index: true }, // sender (digits only)
    phoneNumberId: { type: String, trim: true }, // tenant hint: which business number received it

    sourceChannel: { type: String, default: "whatsapp" },

    // --- Processing state ----------------------------------------------------
    status: {
      type: String,
      enum: [
        "queued",
        "processing",
        "captured",
        "extracting",
        "awaiting_confirmation",
        "awaiting_correction",
        "confirmed",
        "cancelled",
        "unregistered",
        "failed",
      ],
      default: "queued",
      index: true,
    },
    attempts: { type: Number, default: 0 }, // capture (download/upload) attempts
    extractionAttempts: { type: Number, default: 0 }, // Gemini extraction attempts
    errorMessage: { type: String, trim: true },

    // --- Resolved scope + result (filled by the worker) ----------------------
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", index: true },
    employeeId: { type: Schema.Types.ObjectId, ref: "User", index: true },
    imageKey: { type: String, trim: true }, // S3 object key
    s3Bucket: { type: String, trim: true },

    // --- Extraction result (pending session, before an Expense is persisted) -
    // `extraction` holds the editable draft fields the sender is confirming/
    // correcting; `extractionRaw` is the immutable model audit.
    extraction: {
      merchant: { type: String, trim: true, default: null },
      date: { type: String, trim: true, default: null }, // ISO yyyy-mm-dd
      amount: { type: Number, default: null },
      currency: { type: String, default: "INR" },
      taxAmount: { type: Number, default: null },
      gstin: { type: String, trim: true, default: null },
      suggestedCategory: { type: String, trim: true, default: null },
      perFieldConfidence: { type: Schema.Types.Mixed },
    },
    extractionRaw: { type: Schema.Types.Mixed },
    extractionModel: { type: String, trim: true },

    // Set on confirm — links to the persisted Expense (idempotency guard).
    expenseId: { type: Schema.Types.ObjectId, ref: "Expense", index: true },
  },
  { timestamps: true },
);

export default model("ExpenseCapture", ExpenseCaptureSchema);
