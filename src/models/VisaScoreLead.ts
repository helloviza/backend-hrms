// apps/backend/src/models/VisaScoreLead.ts
//
// ONE ROW PER PERSON PER CORRIDOR THEY CHECKED A SCORE FOR.
//
// ══════════════════════════════════════════════════════════════════════
// WHY THIS IS NOT A VisaD2CLead
// ══════════════════════════════════════════════════════════════════════
// The obvious move was to reuse the Master Sheet's existing row. It
// cannot hold this, for two structural reasons rather than stylistic
// ones:
//
//   1. VisaD2CLead.consumerId is REQUIRED and refs Consumer. A score
//      checker who typed an email and has no account has no consumerId
//      to put there. The commonest row this collection exists to hold is
//      exactly the row that model forbids.
//   2. It is UNIQUE on {consumerId, destinationIso2}. A score check for
//      Australia and a real application for Australia would collide onto
//      one row — the score write would either invent a row the apply flow
//      then mutates, or be flattened by it. Two different events about
//      the same corridor cannot share one key.
//
// And a semantic reason worth stating: VisaD2CLead's stages are
// DOC_SUBMISSION_IN_PROGRESS … PAYMENT_DONE. Every value describes a
// document or a payment. A score check is neither, and widening that
// enum would change the meaning of a funnel the sheet, the labels and
// the endpoint all read.
//
// ══════════════════════════════════════════════════════════════════════
// WHAT IT MAY NEVER HOLD — DPDP §12.7
// ══════════════════════════════════════════════════════════════════════
// THERE IS NO `answers` FIELD ON THIS SCHEMA, and there must never be
// one. The compliance and character questions behind a Visa Profile
// Score are sensitive personal data; routes/public.visaScore.ts refuses
// to put them in a ticket for that reason, and a marketing sheet is a
// weaker place to keep them, not a stronger one.
//
// What is stored is the OUTPUT: the score, the band, the range. Those are
// the same three values the reader is shown for free on the page, and
// they are what makes the row marketable — "checked Australia, scored
// 749, Excellent" is a sales conversation; the answers behind it are
// nobody's business.
//
// ══════════════════════════════════════════════════════════════════════
// ERASURE REACHES THIS BY TWO KEYS, AND THAT IS THE POINT
// ══════════════════════════════════════════════════════════════════════
// A row here can be identified in two ways: `consumerId` when the address
// matched an account, and `email` always. Erasure that swept only
// consumerId would leave every anonymous-but-emailed row behind — a
// person exercising their DPDP erasure right would be told they were
// erased while a marketable row with their address survived in a sheet
// ops reads daily.
//
// So scripts/lib/consumerErasureCascade.ts collects this collection by
// BOTH keys (consumerId OR email, case-insensitively), and this file is
// the reason that is not optional. See the cascade's own note beside
// VisaScoreLead in CONSUMER_ERASURE_ALLOWED_MODELS.
//
// ══════════════════════════════════════════════════════════════════════
// CONSENT
// ══════════════════════════════════════════════════════════════════════
// The row is only ever created at the breakdown gate, under a disclosure
// shown at the point the address is typed: "Our team may reach out to
// help with your visa requirement." `disclosureShownAt` stamps when that
// text was on screen, and `consentBasis` names which disclosure it was,
// so a later copy change does not retroactively re-characterise rows
// captured under the old one.
//
// It is NOT the marketingConsent shape Consumer carries. That models an
// opt-in a person can toggle on an account they own; this is a one-off
// disclosed capture by somebody who has no account, and pretending it is
// a managed preference would overstate what was agreed to.
import mongoose, { Schema, type Document, type Model } from "mongoose";

import { VisaUtmSchema, type VisaUtm } from "./visaUtm.js";

/**
 * Which disclosure was on screen when the address was given.
 *
 * Versioned deliberately: if the gate's copy changes, add a value rather
 * than editing this one, so rows keep pointing at the words their subject
 * actually read.
 */
export const VISA_SCORE_CONSENT_BASES = ["GATE_DISCLOSURE_V1"] as const;
export type VisaScoreConsentBasis = (typeof VISA_SCORE_CONSENT_BASES)[number];

export interface VisaScoreLeadDocument extends Document {
  /* ── identity ─────────────────────────────────────────────────────
   * `email` is always present — this row is only written at the gate,
   * and the gate cannot be submitted without one. `consumerId` is set
   * only when that address already belonged to an account.
   *
   * BOTH ARE ERASURE KEYS. See the header. */
  email: string;
  name: string | null;
  consumerId: mongoose.Types.ObjectId | null;
  /** Denormalised so the sheet can answer "how many had accounts?" without
   *  a join, and so the answer survives the account being erased. */
  hadAccount: boolean;

  /* ── what they checked ────────────────────────────────────────── */
  destinationIso2: string;
  destinationName: string;

  /* ── the result. OUTPUT ONLY — never the answers. ─────────────── */
  score: number;
  band: string | null;
  rangeLow: number | null;
  rangeHigh: number | null;

  /* ── adoption ──────────────────────────────────────────────────
   * Upserted, not appended: someone who re-checks the same corridor is
   * one lead who checked twice, not two leads. `checkCount` is what
   * keeps the re-check visible without inflating the row count, which is
   * the same argument VisaD2CLead makes for its own unique key. */
  checkCount: number;
  firstCheckedAt: Date;
  lastCheckedAt: Date;

  /** First-touch attribution — $setOnInsert only, like VisaD2CLead. */
  utm: VisaUtm;

  /* ── consent ──────────────────────────────────────────────────── */
  consentBasis: VisaScoreConsentBasis;
  disclosureShownAt: Date;
}

const VisaScoreLeadSchema = new Schema<VisaScoreLeadDocument>(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    name: { type: String, default: null, trim: true },
    consumerId: { type: Schema.Types.ObjectId, ref: "Consumer", default: null, index: true },
    hadAccount: { type: Boolean, default: false, index: true },

    destinationIso2: { type: String, required: true, uppercase: true, trim: true, index: true },
    destinationName: { type: String, required: true, trim: true },

    score: { type: Number, required: true },
    band: { type: String, default: null },
    rangeLow: { type: Number, default: null },
    rangeHigh: { type: Number, default: null },

    checkCount: { type: Number, default: 1 },
    firstCheckedAt: { type: Date, default: Date.now, index: true },
    lastCheckedAt: { type: Date, default: Date.now, index: true },

    utm: { type: VisaUtmSchema, default: () => ({}) },

    consentBasis: {
      type: String,
      enum: VISA_SCORE_CONSENT_BASES,
      default: "GATE_DISCLOSURE_V1",
    },
    disclosureShownAt: { type: Date, default: Date.now },
  },
  { timestamps: true, collection: "visascoreleads" },
);

/* ── THE KEY IS (email, destination), NOT (consumerId, destination) ──
 * email is the only identifier present on every row, so it is the only
 * one that can carry the uniqueness. Keying on consumerId would leave
 * every anonymous row unconstrained and let one person accumulate a row
 * per re-check — the inflation this collection is explicitly designed to
 * avoid.
 *
 * Lowercased at the schema, so "A@b.com" and "a@b.com" are one lead
 * rather than two. */
VisaScoreLeadSchema.index({ email: 1, destinationIso2: 1 }, { unique: true });
/** The sheet's default ordering: newest activity first. */
VisaScoreLeadSchema.index({ lastCheckedAt: -1 });

const VisaScoreLead: Model<VisaScoreLeadDocument> =
  (mongoose.models.VisaScoreLead as Model<VisaScoreLeadDocument>) ||
  mongoose.model<VisaScoreLeadDocument>("VisaScoreLead", VisaScoreLeadSchema);

export default VisaScoreLead;
