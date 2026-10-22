import { Schema, model, type Document } from "mongoose";

/**
 * LoyaltySettings — the ONE programme-wide settings row (key "global").
 * Read through getLoyaltySettings() (services/loyalty.ts), which creates it
 * with the PRD v1.1 defaults on first read.
 *
 *   programmeEnabled     kill switch: false = reconcile/touch/sweep write nothing
 *   launchDate           2026-11-01 00:00 IST; an invoice earns only when BOTH its
 *                        invoiceDate and createdAt are on/after the start date
 *                        (account.startDateOverride wins over this)
 *   rateHistory          effective-dated earn rates: an invoice earns at the rate
 *                        in force at its createdAt (server time), so a new rate
 *                        never changes points already earned. A new rate is
 *                        Super Admin only, effectiveFrom >= now, reason required.
 *                        Seeded with 1 point per ₹100 from launchDate.
 *   thresholdInr         cumulative business that makes an account eligible
 *   minRedemption, defaultCapPct, validityMonths — stored for later phases
 *   enrolBusinessesOnly  true = only registered businesses earn (services/loyalty.ts isEnrolled)
 *   redemptionOpen       true = clients are told they can use points (the Rewards card and
 *                        tab show the usage cap); false = "Using points opens soon". Wording
 *                        only — redemption itself is not built. Super Admin + reason.
 *
 * changeLog is append-only: every field change, who, when, old → new, reason.
 */
export interface LoyaltyChange {
  at: Date;
  by: string;
  field: string;
  old: unknown;
  new: unknown;
  reason?: string;
  /** Extra context, e.g. the points a disable removed. */
  detail?: unknown;
}

export interface LoyaltyRate {
  pointsPer100: number;
  effectiveFrom: Date;
  setBy: string;
  setAt?: Date;
  reason: string;
}

export interface ILoyaltySettings extends Document {
  key: "global";
  programmeEnabled: boolean;
  launchDate: Date;
  rateHistory: LoyaltyRate[];
  thresholdInr: number;
  minRedemption: number;
  defaultCapPct: number;
  validityMonths: number;
  enrolBusinessesOnly: boolean;
  redemptionOpen: boolean;
  changeLog: LoyaltyChange[];
}

/** The seeded rate: 1 point per ₹100. */
export const DEFAULT_POINTS_PER_100 = 1;

/** 2026-11-01 00:00 IST. */
export const DEFAULT_LAUNCH_DATE = new Date("2026-11-01T00:00:00+05:30");

export const LOYALTY_SETTINGS_DEFAULTS = {
  programmeEnabled: true,
  launchDate: DEFAULT_LAUNCH_DATE,
  thresholdInr: 2_000_000,
  minRedemption: 1000,
  defaultCapPct: 25,
  validityMonths: 24,
  enrolBusinessesOnly: true,
  redemptionOpen: false,
} as const;

export const loyaltyChangeSchema = new Schema<LoyaltyChange>(
  {
    at: { type: Date, required: true },
    by: { type: String, required: true },
    field: { type: String, required: true },
    old: { type: Schema.Types.Mixed },
    new: { type: Schema.Types.Mixed },
    reason: { type: String },
    detail: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const loyaltyRateSchema = new Schema<LoyaltyRate>(
  {
    pointsPer100: { type: Number, required: true, min: 0 },
    effectiveFrom: { type: Date, required: true },
    setBy: { type: String, required: true },
    setAt: { type: Date },
    reason: { type: String, required: true },
  },
  { _id: false },
);

const LoyaltySettingsSchema = new Schema<ILoyaltySettings>(
  {
    key: { type: String, enum: ["global"], default: "global", unique: true },
    programmeEnabled: { type: Boolean, default: LOYALTY_SETTINGS_DEFAULTS.programmeEnabled },
    launchDate: { type: Date, default: () => new Date(DEFAULT_LAUNCH_DATE) },
    // Seeded on first read (services/loyalty.ts getLoyaltySettings) from launchDate.
    rateHistory: { type: [loyaltyRateSchema], default: [] },
    thresholdInr: { type: Number, default: LOYALTY_SETTINGS_DEFAULTS.thresholdInr, min: 0 },
    minRedemption: { type: Number, default: LOYALTY_SETTINGS_DEFAULTS.minRedemption, min: 0 },
    defaultCapPct: { type: Number, default: LOYALTY_SETTINGS_DEFAULTS.defaultCapPct, min: 0, max: 100 },
    validityMonths: { type: Number, default: LOYALTY_SETTINGS_DEFAULTS.validityMonths, min: 1 },
    enrolBusinessesOnly: { type: Boolean, default: LOYALTY_SETTINGS_DEFAULTS.enrolBusinessesOnly },
    redemptionOpen: { type: Boolean, default: LOYALTY_SETTINGS_DEFAULTS.redemptionOpen },
    changeLog: { type: [loyaltyChangeSchema], default: [] },
  },
  { timestamps: true },
);

export default model<ILoyaltySettings>("LoyaltySettings", LoyaltySettingsSchema);
