// apps/backend/src/models/Expense.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

/**
 * Expense
 * -------
 * Expense Management — Sprint 2. The confirmed, employee-owned expense record
 * created once a captured WhatsApp receipt is confirmed (or corrected then
 * confirmed) by the sender.
 *
 * Tenant isolation reuses the standard workspaceScopePlugin (auto-injects a
 * workspaceId filter on reads). The worker creates the doc with workspaceId set
 * explicitly — create()/save() are not query-scoped, so that is safe.
 */

export interface IExpense extends Document {
  workspaceId: mongoose.Types.ObjectId;
  employeeId: mongoose.Types.ObjectId;
  expenseCaptureId?: mongoose.Types.ObjectId;
  ref: string;
  sourceChannel: string;

  imageKey?: string;
  s3Bucket?: string;

  merchant?: string | null;
  date?: Date | null;
  amount: number;
  currency: string;
  taxAmount?: number | null;
  gstin?: string | null;

  // ── Base-currency conversion (FX slice 0, 2026-09-16 — fixes audit F-19) ──
  // `amount` + `currency` above are the TRUE receipt and are never rewritten.
  // Every total, cap, threshold and report sums `amountBase` instead — the
  // amount converted into the workspace's config.baseCurrency at entry time.
  //
  //   exchangeRate  base-currency units per 1 unit of `currency`; 1 when
  //                 currency === baseCurrency.
  //   rateDate      "YYYY-MM-DD" the rate is as-of (API publish date, or the
  //                 entry date for a manual rate).
  //   rateSource    "base"   — same currency, identity rate;
  //                 "api"    — live ExchangeRate-API rate frozen at entry;
  //                 "manual" — typed in by a person (rateEnteredBy / At), either
  //                            because the API was unavailable at entry or
  //                            because finance corrected a wrong frozen rate.
  //                 null     — CONVERSION PENDING: a foreign-currency line whose
  //                            live lookup failed at entry; amountBase is null
  //                            and the claim it sits in cannot be submitted
  //                            until a manual rate resolves it.
  //   amountBase    round2(amount × exchangeRate), FROZEN — never recomputed
  //                 on read. Changes only through the logged manual-rate path.
  //   baseCurrency  snapshot of the workspace base at write time.
  //
  // Rows created before this slice have none of these fields. Read paths treat
  // a missing amountBase on a line whose currency equals the workspace base as
  // amountBase = amount (identity rate); a missing amountBase on a FOREIGN line
  // is conversion-pending exactly like a failed lookup. See
  // services/expenseFx.service.ts for the one expression that encodes this.
  exchangeRate?: number | null;
  rateDate?: string | null;
  rateSource?: "base" | "api" | "manual" | null;
  amountBase?: number | null;
  baseCurrency?: string | null;
  rateEnteredBy?: mongoose.Types.ObjectId | null;
  rateEnteredAt?: Date | null;
  // Append-only trail of every rate write on this line (entry + manual set +
  // finance corrections). The claim timeline (ExpenseActivity) ALSO gets an
  // entry when the line sits in a claim; a loose line has only this.
  rateHistory?: {
    exchangeRate: number;
    rateDate: string | null;
    rateSource: "base" | "api" | "manual";
    amountBase: number;
    setBy?: mongoose.Types.ObjectId | null;
    setAt: Date;
    reason?: string | null;
  }[];

  suggestedCategory?: string | null;
  // Managed category (Layer 1). suggestedCategory is kept as the AI hint;
  // categoryId is the authoritative classification once selected.
  categoryId?: mongoose.Types.ObjectId | null;

  // Report linkage (Layer 2). An expense belongs to at most ONE report.
  reportId?: mongoose.Types.ObjectId | null;
  // Denormalized workflow state, the ONLY user-facing "status". Written solely
  // by propagateLifecycle() whenever report linkage or report.status changes.
  // Taxonomy: pending_to_submit → awaiting_approval →
  //   (approved · declined · clarification_required) → reimbursed.
  // "pending_to_submit" covers BOTH an unlinked expense (reportId null) and one
  // sitting in a DRAFT/clarification report — the two are told apart by reportId.
  lifecycleStatus:
    | "pending_to_submit"
    | "awaiting_approval"
    | "approved"
    | "declined"
    | "clarification_required"
    | "reimbursed";

  // Internal record-state (capture confirmed). NOT user-facing; always
  // "submitted" today. Kept separate from lifecycleStatus on purpose.
  status: "submitted";

  // Audit of what the model produced + its confidences (immutable record).
  rawExtraction?: any;
  perFieldConfidence?: any;
  extractionModel?: string;

  createdAt: Date;
  updatedAt: Date;
}

const ExpenseSchema = new Schema<IExpense>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    employeeId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    // Optional: WhatsApp captures set it (idempotency); web expenses omit it
    // entirely. unique + sparse → uniqueness enforced only for docs that HAVE it.
    expenseCaptureId: { type: Schema.Types.ObjectId, ref: "ExpenseCapture", required: false, unique: true, sparse: true },
    ref: { type: String, required: true, index: true },
    sourceChannel: { type: String, default: "whatsapp" },

    imageKey: { type: String, trim: true },
    s3Bucket: { type: String, trim: true },

    merchant: { type: String, trim: true, default: null },
    date: { type: Date, default: null },
    amount: { type: Number, required: true },
    currency: { type: String, trim: true, uppercase: true, default: "INR" },
    taxAmount: { type: Number, default: null },

    // Base-currency conversion (see the interface note). All default null so a
    // pre-slice row and a conversion-pending row look the same to a reader.
    exchangeRate: { type: Number, default: null },
    rateDate: { type: String, trim: true, default: null },
    rateSource: { type: String, enum: ["base", "api", "manual", null], default: null },
    amountBase: { type: Number, default: null },
    baseCurrency: { type: String, trim: true, uppercase: true, default: null },
    rateEnteredBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    rateEnteredAt: { type: Date, default: null },
    rateHistory: {
      type: [
        new Schema(
          {
            exchangeRate: { type: Number, required: true },
            rateDate: { type: String, default: null },
            rateSource: { type: String, enum: ["base", "api", "manual"], required: true },
            amountBase: { type: Number, required: true },
            setBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
            setAt: { type: Date, required: true },
            reason: { type: String, trim: true, default: null },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    gstin: { type: String, trim: true, default: null },
    suggestedCategory: { type: String, trim: true, default: null },
    categoryId: { type: Schema.Types.ObjectId, ref: "ExpenseCategory", default: null, index: true },

    reportId: { type: Schema.Types.ObjectId, ref: "Report", default: null, index: true, sparse: true },
    lifecycleStatus: {
      type: String,
      enum: [
        "pending_to_submit",
        "awaiting_approval",
        "approved",
        "declined",
        "clarification_required",
        "reimbursed",
      ],
      default: "pending_to_submit",
      index: true,
    },

    status: { type: String, enum: ["submitted"], default: "submitted", index: true },

    rawExtraction: { type: Schema.Types.Mixed },
    perFieldConfidence: { type: Schema.Types.Mixed },
    extractionModel: { type: String, trim: true },
  },
  { timestamps: true },
);

ExpenseSchema.plugin(workspaceScopePlugin);

const Expense =
  (mongoose.models.Expense as mongoose.Model<IExpense>) ||
  mongoose.model<IExpense>("Expense", ExpenseSchema);

export default Expense;
