import { Schema, model, type Document } from "mongoose";

/**
 * SBTWalletLedger — every movement of a workspace's business-wallet (official
 * booking) monthly spend: a DEBIT when a booking reserves its selling total, a
 * CREDIT when it is released (supplier failure, fare change, refund) or a
 * booking is cancelled. `idempotencyKey` is unique, so a retried release or a
 * replayed cancellation can never credit twice.
 *
 * The counter itself stays CustomerWorkspace.sbtOfficialBooking.currentMonthSpend
 * (the conditional update that enforces the limit); this is its audit trail.
 * Written by services/sbtPaymentGate.ts reserveOfficial / creditOfficial.
 */
export interface ISBTWalletLedger extends Document {
  workspaceId: string;
  type: "DEBIT" | "CREDIT";
  amount: number; // rupees, positive
  monthKey: string; // month whose spend counter moved
  spendAfter?: number; // counter after the move (when known)
  reason: string; // BOOKING, RELEASE_SUPPLIER_FAILED, FARE_CHANGED, CANCELLATION, …
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
    type: { type: String, enum: ["DEBIT", "CREDIT"], required: true },
    amount: { type: Number, required: true },
    monthKey: { type: String, required: true },
    spendAfter: { type: Number },
    reason: { type: String, required: true },
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

export default model<ISBTWalletLedger>("SBTWalletLedger", SBTWalletLedgerSchema);
