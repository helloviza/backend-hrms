import { Schema, model, type Document } from "mongoose";
import { loyaltyChangeSchema, type LoyaltyChange } from "./LoyaltySettings.js";

/**
 * LoyaltyAccount — the unit that earns. One or more Customers (legal
 * entities, keyed by Customer._id as a string) pool their business here; a
 * Customer belongs to at most ONE account (unique multikey index below).
 *
 * Accounts are created automatically, one per customer, the first time that
 * customer is reconciled (services/loyalty.ts ensureAccountForCustomer), and
 * by scripts/loyalty-reconcile.ts. Staff link further customers in.
 *
 * Everything under "cached" is derived by the reconciler and can be rebuilt
 * from LoyaltyLedger + the invoices at any time:
 *   cumulativeInr  Σ earn base of every counted invoice of every member,
 *                  regardless of start date
 *   eligibleAt     first time cumulativeInr reached the threshold — STICKY,
 *                  never cleared automatically
 *   balances       Σ LoyaltyLedger.points per bucket, moved in the same
 *                  transaction as each ledger insert
 *
 * unlockNotice records the one "You've unlocked" email of an unlock (Phase 2,
 * services/loyaltyUnlockEmail.ts): claimed once per eligibleAt, whether or
 * not any member workspace had the client view switched on at that moment.
 *
 * lockedUntil / lockOwner are the per-account reconcile lease;
 * rerunRequested is set by a touch that found the lease taken, so the holder
 * runs once more before releasing it.
 */
export interface LoyaltyBalances {
  onTheWay: number;
  locked: number;
  ready: number;
}

export interface LoyaltyUnlockNotice {
  /** The eligibleAt this notice is for — one notice per unlock, ever. */
  eligibleAt: Date;
  claimedAt: Date;
  /** Member workspaces that had loyaltyRewardsEnabled on when the notice was claimed. */
  workspaceIds: string[];
  /** Addresses queued (0 when every member workspace had the switch off). */
  recipients: number;
}

export interface ILoyaltyAccount extends Document {
  name: string;
  memberCustomerIds: string[];
  enabled: boolean;
  startDateOverride: Date | null;
  capPctOverride: number | null;
  eligibleAt: Date | null;
  cumulativeInr: number;
  balances: LoyaltyBalances;
  lastReconciledAt: Date | null;
  unlockNotice: LoyaltyUnlockNotice | null;
  lockedUntil: Date | null;
  lockOwner: string | null;
  rerunRequested: boolean;
  changeLog: LoyaltyChange[];
  createdAt: Date;
  updatedAt: Date;
}

const LoyaltyAccountSchema = new Schema<ILoyaltyAccount>(
  {
    name: { type: String, required: true, trim: true },
    memberCustomerIds: { type: [String], default: [] },
    enabled: { type: Boolean, default: true },
    startDateOverride: { type: Date, default: null },
    capPctOverride: { type: Number, default: null, min: 0, max: 100 },
    eligibleAt: { type: Date, default: null },
    cumulativeInr: { type: Number, default: 0 },
    balances: {
      type: new Schema<LoyaltyBalances>(
        {
          onTheWay: { type: Number, default: 0 },
          locked: { type: Number, default: 0 },
          ready: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      default: () => ({ onTheWay: 0, locked: 0, ready: 0 }),
    },
    lastReconciledAt: { type: Date, default: null },
    unlockNotice: {
      type: new Schema<LoyaltyUnlockNotice>(
        {
          eligibleAt: { type: Date, required: true },
          claimedAt: { type: Date, required: true },
          workspaceIds: { type: [String], default: [] },
          recipients: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      default: null,
    },
    lockedUntil: { type: Date, default: null },
    lockOwner: { type: String, default: null },
    rerunRequested: { type: Boolean, default: false },
    changeLog: { type: [loyaltyChangeSchema], default: [] },
  },
  { timestamps: true },
);

// A customer may belong to at most one account. Partial on "has a string
// member": a multikey unique index keys an EMPTY array as one value, so
// without the filter two accounts left with no members would collide.
LoyaltyAccountSchema.index(
  { memberCustomerIds: 1 },
  { unique: true, partialFilterExpression: { memberCustomerIds: { $type: "string" } } },
);
LoyaltyAccountSchema.index({ eligibleAt: 1 });

export default model<ILoyaltyAccount>("LoyaltyAccount", LoyaltyAccountSchema);
