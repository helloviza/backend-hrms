// apps/backend/src/models/VisaScoreAssessment.ts
//
// A consumer's Visa Profile Score, as they scored it on a given day.
//
// ══════════════════════════════════════════════════════════════════════
// THERE IS NO `answers` FIELD, AND THAT IS THE FEATURE
// ══════════════════════════════════════════════════════════════════════
// The score is computed from ~14 answers, two of which — `compliance`
// (overstays, removal, misrepresentation) and `character` (criminal
// history) — are sensitive personal data under DPDP §12.7. Until this
// collection existed, the guarantee that they are never stored was
// STRUCTURAL: three of the four score endpoints had no writer at all, and
// the fourth was never handed the sensitive values.
//
// This schema is the first durable writer on that surface, so it inherits
// the burden of keeping that guarantee true. It does so the same way:
// structurally. There is no `answers` path, no `responses`, no generic
// `payload` or `meta` object a future edit could quietly drop a raw answer
// into. Everything stored is the engine's DERIVED output, already filtered
// through services/visaScoreSafeBreakdown.ts.
//
// A reviewer's checklist for this file is therefore short: if a field is
// added that could hold an answer index or an answer label, the guarantee
// is broken, and no amount of care at the call site puts it back.
//
// ── WHY A COLLECTION, NOT A FIELD ON ConsumerProfile ─────────────────
// Three reasons, in order of weight:
//
//   1. IT IS A SERIES, NOT A VALUE. The assessment is retakeable, and the
//      point of keeping the old ones is the sentence "you were at 690,
//      you are at 744 now". A field on a one-document-per-consumer profile
//      either overwrites that history or grows an unbounded array inside a
//      document that is read on every profile page load.
//   2. ConsumerProfile IS FIELD-ENCRYPTED — 14 paths, and its own plugin
//      warns that aggregate() and distinct() bypass decryption. Nothing
//      here is PII of that kind (see below), so putting it there would buy
//      the encryption tax and the aggregate trap for no benefit.
//   3. SavedCountry ALREADY ESTABLISHES THE SHAPE for exactly this: a
//      per-consumer, plaintext, own-scoped side collection. This file is
//      deliberately its sibling, down to the index layout.
//
// ── NOT ENCRYPTED, DELIBERATELY ──────────────────────────────────────
// Same argument SavedCountry makes. A passport number identifies a person;
// a score on a corridor is an ASSESSMENT — private, own-scoped at the
// route, but not identity data. Keeping it plaintext means the account's
// score history can be counted and sorted with ordinary Mongo without the
// decryption caveats the encryption plugin's header sets out.
//
// It is still consumer data, so it is erased with the consumer — see
// scripts/lib/consumerErasureCascade.ts, where this collection is
// registered as a DELETE target.
import mongoose, { Schema, type Document, type Model } from "mongoose";

/** How this assessment came to be recorded. */
export const VISA_SCORE_ASSESSMENT_SOURCES = ["gate", "retake", "account"] as const;
export type VisaScoreAssessmentSource = (typeof VISA_SCORE_ASSESSMENT_SOURCES)[number];

/**
 * One surviving attribution row. Mirrors ScoreFactor from the engine,
 * minus nothing — because by the time a factor reaches this schema the
 * sensitive ones have already been dropped by question id.
 */
export interface StoredScoreFactor {
  questionId: string;
  questionText: string;
  dim: string;
  cite: string;
  answerLabel: string;
  impact: number;
}

export interface StoredScoreFlag {
  code: string;
  severity: string;
  questionId: string;
  message: string;
}

export interface VisaScoreAssessmentDocument extends Document {
  consumerId: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;

  destination: string;
  passport: string;
  rulesetVersion: string;
  mode: string;

  score: number | null;
  band: { name: string; hex: string } | null;
  range: { low: number; high: number; confidence: string; label: string } | null;
  profileStrength: number | null;
  baseScore: number | null;
  capped: string | null;
  suppressed: boolean;

  factors: { helping: StoredScoreFactor[]; holdingBack: StoredScoreFactor[] };
  flags: StoredScoreFlag[];

  source: VisaScoreAssessmentSource;
  submissionId?: string;
  generatedAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const FactorSchema = new Schema<StoredScoreFactor>(
  {
    questionId: { type: String, required: true },
    questionText: { type: String, required: true },
    dim: { type: String, required: true },
    cite: { type: String, default: "" },
    answerLabel: { type: String, default: "" },
    impact: { type: Number, required: true },
  },
  { _id: false },
);

const FlagSchema = new Schema<StoredScoreFlag>(
  {
    code: { type: String, required: true },
    severity: { type: String, required: true },
    questionId: { type: String, required: true },
    message: { type: String, default: "" },
  },
  { _id: false },
);

const VisaScoreAssessmentSchema = new Schema<VisaScoreAssessmentDocument>(
  {
    // THE ISOLATION KEY. Every read takes it from req.consumer.id and
    // never from a request body — the rule every consumer collection
    // states and consumer.saved.ts demonstrates.
    consumerId: {
      type: Schema.Types.ObjectId,
      ref: "Consumer",
      required: true,
      index: true,
    },
    // The synthetic D2C tenant — a STAMP for downstream tenant-shaped
    // code, NOT an isolation boundary: every consumer carries the same
    // value (services/consumerWorkspace.ts).
    workspaceId: { type: Schema.Types.ObjectId, required: true, index: true },

    /**
     * Uppercase ISO-3166-1 alpha-2, or the synthetic "SCHENGEN".
     *
     * `maxlength` is 8 rather than SavedCountry's 2 because the score
     * catalogue carries one non-ISO corridor: the Schengen member average
     * is a real, scoreable destination on this surface and has no
     * two-letter code of its own.
     */
    destination: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 8,
    },
    /** The passport the score was computed for. "IN" today. */
    passport: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
    },

    /**
     * WHICH ENGINE PRODUCED THIS. A stored score without it is unreadable
     * a year later: the bands, the transform and the base rates all move
     * with the ruleset, and two scores from two versions are not
     * comparable however similar the numbers look.
     */
    rulesetVersion: { type: String, required: true },
    /** The averaging window that fed the base rate — "a3" or "a5". */
    mode: { type: String, required: true },

    /** null on an indicative corridor or a suppressed result. Never a guess. */
    score: { type: Number, default: null },
    band: {
      type: new Schema({ name: String, hex: String }, { _id: false }),
      default: null,
    },
    range: {
      type: new Schema(
        { low: Number, high: Number, confidence: String, label: String },
        { _id: false },
      ),
      default: null,
    },
    /**
     * The engine's own 0–100 figure.
     *
     * It IS computed over the sensitive answers along with every other
     * one, and it is stored anyway for the same reason `score` is: it is
     * an aggregate over ~14 questions and cannot be inverted to recover
     * any single answer. The rule this file enforces is that the raw
     * answers and their labels are never stored — not that no number
     * derived from them may be.
     */
    profileStrength: { type: Number, default: null },
    /** Where an average applicant on this route starts. Route-derived. */
    baseScore: { type: Number, default: null },

    /**
     * The hard-stop code, ALREADY SCRUBBED by toSafeBreakdown().
     *
     * Every cap in the shipped ruleset fires on a sensitive question, so
     * in practice this is null whenever a cap applied — writing "misrep"
     * here would name the compliance answer by elimination. The field
     * exists because the ruleset may one day carry a cap that is safe to
     * name, and a nullable column is the honest way to hold that.
     */
    capped: { type: String, default: null },
    suppressed: { type: Boolean, default: false },

    /* THE FILTERED EXPLANATION. What reaches these paths has been through
     * services/visaScoreSafeBreakdown.ts — no factor or flag belonging to
     * a sensitive question survives that call. */
    factors: {
      helping: { type: [FactorSchema], default: () => [] },
      holdingBack: { type: [FactorSchema], default: () => [] },
    },
    flags: { type: [FlagSchema], default: () => [] },

    source: {
      type: String,
      enum: VISA_SCORE_ASSESSMENT_SOURCES,
      required: true,
      default: "gate",
    },
    /**
     * The client-minted id for the assessment sitting behind this row.
     * Carried so a retry that already filed a lead ticket under the same
     * id can be recognised rather than stored twice. Not unique — a
     * consumer may legitimately have no submissionId at all (an in-account
     * retake), and a sparse unique index over an optional string is a trap
     * this collection does not need.
     */
    submissionId: { type: String, default: undefined },

    /** The engine's own timestamp for the computation, not the write. */
    generatedAt: { type: Date, required: true },
  },
  { timestamps: true },
);

/**
 * THE READ PATTERN, AND THE REASON THERE IS NO UNIQUE INDEX.
 *
 * SavedCountry's compound index is `unique` because a bookmark is a set
 * membership: saving Thailand twice is one row. An assessment is the
 * opposite — every retake is a NEW row, deliberately, because the history
 * is the product. A unique index here would make the second assessment of
 * a corridor fail with E11000.
 *
 * Reads are "the latest for this corridor" and "this consumer's recent
 * assessments", so both indexes are newest-first.
 */
VisaScoreAssessmentSchema.index({ consumerId: 1, destination: 1, createdAt: -1 });
VisaScoreAssessmentSchema.index({ consumerId: 1, createdAt: -1 });

const VisaScoreAssessment: Model<VisaScoreAssessmentDocument> =
  mongoose.models.VisaScoreAssessment ||
  mongoose.model<VisaScoreAssessmentDocument>("VisaScoreAssessment", VisaScoreAssessmentSchema);

export default VisaScoreAssessment;
