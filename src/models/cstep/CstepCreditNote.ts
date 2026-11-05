// apps/backend/src/models/cstep/CstepCreditNote.ts
import mongoose, { Schema, type Document, type Model } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepCreditNote
 * ---------------
 * Module D — the vendor's credit note for a cancelled booking (one
 * CstepArrangement line). Recorded by the Travel Desk / a CSTEP Admin from
 * ARRANGING until the settlement is finalized
 * (POST /requests/:id/arrangements/:lineId/cancel). Partial credit allowed:
 * 0 < amountInr ≤ the booking's amountInr (the vendor may keep a fee).
 *
 * The booking is marked cancelled and carries a snapshot (cancelled,
 * creditNoteId, creditInr, creditNoteRef, creditAgainstPaid) so the reports
 * read it cheaply. The settlement carries it as a negative CREDIT_NOTE line
 * (sourceId = this _id), so totalCostOfTour nets it.
 *
 * Tally (routes/cstep.tally.ts, vendor payments):
 *   againstPaid — the booking was already PAID when the credit was
 *     recorded: the paid voucher stays as it was, and this note is its own
 *     voucher (Dr the vendor, Cr the expense ledger) dated recordedAt,
 *     numbered from the TALLY series into tallyVoucherNo.
 *   otherwise — the booking is paid (if ever) net: amountInr − credit. A
 *     full credit leaves nothing owed, so nothing is exported for it.
 *
 * A credit note that arrives after the settlement is finalized is out of
 * scope for this build.
 */
export interface ICstepCreditNote extends Document {
  workspaceId: mongoose.Types.ObjectId;
  requestId: mongoose.Types.ObjectId; // ref CstepTravelRequest
  arrangementId: mongoose.Types.ObjectId; // ref CstepArrangement — the cancelled booking

  ref: string; // the vendor's credit-note number
  currency: string; // ISO 3-letter, default INR
  amount: number; // in currency
  exchangeRate?: number; // INR per 1 unit of currency; 1 for INR
  rateDate?: string;
  rateSource?: "LIVE" | "MANUAL";
  amountInr: number; // frozen = amount × exchangeRate, > 0

  /** The booking was already paid when the credit was recorded. */
  againstPaid: boolean;

  recordedBy: mongoose.Types.ObjectId; // ref User
  recordedAt: Date;

  tallyVoucherNo?: number; // againstPaid only — its own TALLY voucher

  createdAt: Date;
  updatedAt: Date;
}

const CstepCreditNoteSchema = new Schema<ICstepCreditNote>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    requestId: { type: Schema.Types.ObjectId, ref: "CstepTravelRequest", required: true, index: true },
    arrangementId: { type: Schema.Types.ObjectId, ref: "CstepArrangement", required: true, unique: true },

    ref: { type: String, required: true, trim: true },
    currency: { type: String, trim: true, uppercase: true, default: "INR" },
    amount: { type: Number, required: true },
    exchangeRate: { type: Number },
    rateDate: { type: String },
    rateSource: { type: String, enum: ["LIVE", "MANUAL"] },
    amountInr: { type: Number, required: true, min: 0.01 },

    againstPaid: { type: Boolean, required: true },

    recordedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    recordedAt: { type: Date, required: true },

    tallyVoucherNo: { type: Number },
  },
  { timestamps: true },
);

CstepCreditNoteSchema.index({ workspaceId: 1, againstPaid: 1, recordedAt: 1 });
CstepCreditNoteSchema.plugin(workspaceScopePlugin);

const CstepCreditNote: Model<ICstepCreditNote> =
  (mongoose.models.CstepCreditNote as Model<ICstepCreditNote>) ||
  mongoose.model<ICstepCreditNote>("CstepCreditNote", CstepCreditNoteSchema);

export default CstepCreditNote;
