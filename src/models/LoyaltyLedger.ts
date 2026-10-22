import { Schema, model, type Document } from "mongoose";

/**
 * LoyaltyLedger — every movement of loyalty points, append-only (nothing
 * updates or deletes a row). Copied from SBTWalletLedger with one fix: the
 * insert and the LoyaltyAccount.balances $inc run in ONE transaction
 * (services/loyalty.ts), so the cached balance can never drift from the rows.
 *
 *   bucket       ON_THE_WAY  earned on a SENT / PAYMENT_DECLARED invoice
 *                LOCKED      earned on a PAID invoice, account not yet eligible
 *                READY       earned on a PAID invoice, account eligible
 *   points       signed delta; Σ per (accountId, invoiceId, bucket) is that
 *                invoice's current holding in that bucket
 *   reason       why the delta was written (REDEEM / EXPIRE are reserved for
 *                later phases — nothing writes them yet)
 *   snapshot     the invoice state the reconciler saw (status, earn base,
 *                credited base) — what the next delta's reason is derived from
 *
 * Invoice rows are keyed on invoiceId (Invoice._id); invoiceNo is a display
 * snapshot only (scripts have renumbered invoices). MANUAL rows have no
 * invoiceId and the reconciler never touches them.
 *
 * idempotencyKey is unique. Reconciler keys are
 * "acct:<accountId>:inv:<invoiceId>:<bucket>:n<k>" where k = rows already
 * written for that triple + 1, so two runs planned from the same ledger state
 * collide and the second insert is refused.
 */
export const LOYALTY_BUCKETS = ["ON_THE_WAY", "LOCKED", "READY"] as const;
export type LoyaltyBucket = (typeof LOYALTY_BUCKETS)[number];

export const LOYALTY_REASONS = [
  "EARN",
  "RECONCILE",
  "STATUS_CHANGE",
  "CREDIT_NOTE",
  "ELIGIBILITY_UNLOCK",
  "ACCOUNT_LINK",
  "MANUAL",
  // Reserved — later phases. Nothing writes these yet.
  "REDEEM",
  "EXPIRE",
] as const;
export type LoyaltyReason = (typeof LOYALTY_REASONS)[number];

export interface LoyaltySnapshot {
  status: string;
  earnBase: number;
  creditedBase: number;
}

export interface ILoyaltyLedger extends Document {
  accountId: string;
  customerId: string | null;
  invoiceId: string | null;
  invoiceNo: string | null;
  bucket: LoyaltyBucket;
  points: number;
  reason: LoyaltyReason;
  note?: string;
  snapshot?: LoyaltySnapshot;
  idempotencyKey: string;
  createdBy: string;
  createdAt: Date;
}

const LoyaltyLedgerSchema = new Schema<ILoyaltyLedger>(
  {
    accountId: { type: String, required: true },
    customerId: { type: String, default: null },
    invoiceId: { type: String, default: null },
    invoiceNo: { type: String, default: null },
    bucket: { type: String, enum: LOYALTY_BUCKETS, required: true },
    points: { type: Number, required: true },
    reason: { type: String, enum: LOYALTY_REASONS, required: true },
    note: { type: String },
    snapshot: {
      type: new Schema<LoyaltySnapshot>(
        { status: String, earnBase: Number, creditedBase: Number },
        { _id: false },
      ),
      default: undefined,
    },
    idempotencyKey: { type: String, required: true, unique: true },
    createdBy: { type: String, required: true },
  },
  // createdAt is server time, set by Mongoose; there is no updatedAt —
  // rows are never updated.
  { timestamps: { createdAt: true, updatedAt: false } },
);

LoyaltyLedgerSchema.index({ accountId: 1, createdAt: -1 });
LoyaltyLedgerSchema.index({ accountId: 1, invoiceId: 1, bucket: 1 });
LoyaltyLedgerSchema.index({ invoiceId: 1 });

export default model<ILoyaltyLedger>("LoyaltyLedger", LoyaltyLedgerSchema);
