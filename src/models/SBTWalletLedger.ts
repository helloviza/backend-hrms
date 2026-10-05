import { Schema, model, type Document } from "mongoose";

/**
 * SBTWalletLedger — every movement of a company's SBT Business Wallet, a
 * CREDIT LINE (CustomerWorkspace.sbtOfficialBooking: creditLimit, used):
 *
 *   entryType            type    moves `used`   written by
 *   BOOKING              DEBIT   +amount        reserveOfficial (checkout, wallet claim, reissue difference)
 *   CANCELLATION_REFUND  CREDIT  −amount        creditOfficial: cancellations, failed / refunded checkouts
 *   PAYMENT_RECEIVED     CREDIT  −amount        Super Admin: payment from the company
 *   ADJUSTMENT           either  ±amount        Super Admin, reason required
 *   LIMIT_CHANGE         NONE    —              Super Admin, reason required (limitBefore → limitAfter)
 *
 * `usedAfter` is the company's `used` right after the move. `idempotencyKey`
 * is unique, so a retried release, a replayed cancellation or a double-submitted
 * payment can never move the balance twice. Rows written before the credit
 * line have no entryType (DEBIT = BOOKING, CREDIT = CANCELLATION_REFUND).
 * Booking / traveller / trip details are read from the payment row and the
 * booking at display time (services/sbtWallet.ts), never stored as a copy.
 */
export type WalletEntryType = "BOOKING" | "CANCELLATION_REFUND" | "PAYMENT_RECEIVED" | "ADJUSTMENT" | "LIMIT_CHANGE";
export const WALLET_ENTRY_TYPES: WalletEntryType[] = ["BOOKING", "CANCELLATION_REFUND", "PAYMENT_RECEIVED", "ADJUSTMENT", "LIMIT_CHANGE"];
export type WalletPaymentMode = "NEFT" | "UPI" | "CHEQUE" | "OTHER";
export const WALLET_PAYMENT_MODES: WalletPaymentMode[] = ["NEFT", "UPI", "CHEQUE", "OTHER"];

export interface ISBTWalletLedger extends Document {
  workspaceId: string;
  type: "DEBIT" | "CREDIT" | "NONE";
  entryType?: WalletEntryType;
  amount: number; // rupees, positive
  monthKey: string; // month of the entry (informational since the credit line)
  spendAfter?: number; // LEGACY: monthly counter after the move
  usedAfter?: number; // `used` after the move
  reason: string; // BOOKING, RELEASE_SUPPLIER_FAILED, FARE_CHANGED, CANCELLATION, PAYMENT, ADJUSTMENT, LIMIT_CHANGE…
  /** Customer-visible text: the adjustment / limit-change reason, the payment note. */
  remark?: string;
  /** Staff-only note (Business Wallets page). */
  internalNote?: string;
  payment?: { mode: WalletPaymentMode; reference?: string; paymentDate?: Date };
  limitBefore?: number;
  limitAfter?: number;
  paymentId?: string; // SBTPayment._id
  bookingDocId?: string; // SBTBooking / SBTHotelBooking _id
  product?: "FLIGHT" | "HOTEL";
  actorUserId?: string;
  idempotencyKey: string;
  isTest: boolean;
  createdAt: Date;
}

const SBTWalletLedgerSchema = new Schema<ISBTWalletLedger>(
  {
    workspaceId: { type: String, required: true, index: true },
    type: { type: String, enum: ["DEBIT", "CREDIT", "NONE"], required: true },
    entryType: { type: String, enum: WALLET_ENTRY_TYPES },
    amount: { type: Number, required: true },
    monthKey: { type: String, required: true },
    spendAfter: { type: Number },
    usedAfter: { type: Number },
    reason: { type: String, required: true },
    remark: { type: String },
    internalNote: { type: String },
    payment: {
      type: new Schema(
        { mode: { type: String, enum: WALLET_PAYMENT_MODES }, reference: { type: String }, paymentDate: { type: Date } },
        { _id: false },
      ),
      default: undefined,
    },
    limitBefore: { type: Number },
    limitAfter: { type: Number },
    paymentId: { type: String, index: true },
    bookingDocId: { type: String },
    product: { type: String, enum: ["FLIGHT", "HOTEL"] },
    actorUserId: { type: String },
    idempotencyKey: { type: String, required: true, unique: true },
    isTest: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

SBTWalletLedgerSchema.index({ workspaceId: 1, monthKey: 1, createdAt: -1 });
SBTWalletLedgerSchema.index({ workspaceId: 1, createdAt: -1 });

export default model<ISBTWalletLedger>("SBTWalletLedger", SBTWalletLedgerSchema);
