// apps/backend/src/models/ReceiptExtraction.ts
//
// The SERVER-HELD copy of what the receipt reader saw — one row per stored
// receipt (workspaceId + imageKey), written by the upload route (web) and the
// capture worker (WhatsApp) the moment extraction finishes, success or not.
//
// WHY THIS EXISTS. Until now the only extraction data on an Expense was the
// `rawExtraction` / `perFieldConfidence` blob the browser echoed back on
// POST /expenses — the client could rewrite it in flight. The Approval Bot's
// receipt gate (readable receipt + amount match) reads THIS collection and
// never the client echo, so a submitter cannot make an unreadable or
// mismatching bill look clean. Mirrors ExpenseCapture.extraction for the
// WhatsApp channel, generalised to both channels.
//
//   readable   the reader returned a usable amount (extractReceipt throws when
//              it cannot — that failure is stored here as readable:false with
//              the message, so "attached but unreadable" is a first-class,
//              queryable state rather than an absent record)
//   amount…    the normalised fields exactly as ReceiptFields returns them
//   rawCandidate  the model's raw JSON (audit)
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

export interface IReceiptExtraction extends Document {
  workspaceId: mongoose.Types.ObjectId;
  employeeId: mongoose.Types.ObjectId;
  imageKey: string;
  s3Bucket: string | null;
  mime: string | null;
  sourceChannel: string; // "web" | "whatsapp"
  readable: boolean;
  errorMessage: string | null;
  merchant: string | null;
  date: string | null; // ISO yyyy-mm-dd as extracted
  amount: number | null;
  currency: string | null;
  taxAmount: number | null;
  gstin: string | null;
  suggestedCategory: string | null;
  perFieldConfidence: Record<string, number>;
  extractionModel: string | null;
  rawCandidate: any;
  extractedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ReceiptExtractionSchema = new Schema<IReceiptExtraction>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    employeeId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    imageKey: { type: String, required: true, trim: true },
    s3Bucket: { type: String, trim: true, default: null },
    mime: { type: String, trim: true, default: null },
    sourceChannel: { type: String, default: "web" },
    readable: { type: Boolean, required: true, default: false },
    errorMessage: { type: String, trim: true, default: null },
    merchant: { type: String, trim: true, default: null },
    date: { type: String, trim: true, default: null },
    amount: { type: Number, default: null },
    currency: { type: String, trim: true, uppercase: true, default: null },
    taxAmount: { type: Number, default: null },
    gstin: { type: String, trim: true, default: null },
    suggestedCategory: { type: String, trim: true, default: null },
    perFieldConfidence: { type: Schema.Types.Mixed, default: {} },
    extractionModel: { type: String, trim: true, default: null },
    rawCandidate: { type: Schema.Types.Mixed },
    extractedAt: { type: Date, default: () => new Date() },
  },
  { timestamps: true },
);

// One record per stored receipt. The upload route writes once per upload (a
// fresh key every time); the worker may retry extraction on the same key and
// overwrites its own row.
ReceiptExtractionSchema.index({ workspaceId: 1, imageKey: 1 }, { unique: true });

ReceiptExtractionSchema.plugin(workspaceScopePlugin);

const ReceiptExtraction = mongoose.model<IReceiptExtraction>("ReceiptExtraction", ReceiptExtractionSchema);
export default ReceiptExtraction;
