// apps/backend/src/models/VisaRule.ts
//
// Global (NOT workspace-scoped) reference data — the visa-requirements
// lookup table. One row per {nationality, destinationIso2, purpose,
// entryType, serviceTier} combination. Shared across every tenant; nothing
// here is customer-specific. A VisaApplication never live-references this —
// it embeds a point-in-time copy (see VisaApplication.ruleSnapshot) so a
// later edit here never retroactively changes an in-flight application.
import mongoose, { Schema, type Document, type Model } from "mongoose";
import {
  VisaApplicantPredicateConditionSchema,
  evaluateApplicantPredicate,
  selectMostSpecificRule,
  type VisaApplicantPredicate,
  type VisaApplicantProfile,
} from "./visaAttributes.js";

export const VISA_PURPOSES = ["TOURIST", "BUSINESS", "TOURIST_OR_BUSINESS", "TRANSIT"] as const;
export type VisaPurpose = (typeof VISA_PURPOSES)[number];

export const VISA_ENTRY_TYPES = ["SINGLE", "DOUBLE", "MULTIPLE", "UNSPECIFIED"] as const;
export type VisaEntryType = (typeof VISA_ENTRY_TYPES)[number];

export const VISA_SERVICE_TIERS = [
  "STANDARD", "EXPRESS", "SUPERFAST", "PRIORITY", "SUPER_PRIORITY",
] as const;
export type VisaServiceTier = (typeof VISA_SERVICE_TIERS)[number];

export const VISA_PRODUCT_CLASSES = [
  "VISA", "ARRIVAL_CARD", "FORM_SERVICE", "APPOINTMENT_SERVICE",
] as const;
export type VisaProductClass = (typeof VISA_PRODUCT_CLASSES)[number];

export const VISA_CATEGORIES = ["STICKER", "STAMP", "E_VISA", "VOA", "VISA_FREE"] as const;
export type VisaCategory = (typeof VISA_CATEGORIES)[number];

export const VISA_ETA_BASES = ["BUSINESS", "CALENDAR"] as const;
export type VisaEtaBasis = (typeof VISA_ETA_BASES)[number];

export const VISA_DOC_REQUIREMENT_LEVELS = ["REQUIRED", "CONDITIONAL"] as const;
export type VisaDocRequirementLevel = (typeof VISA_DOC_REQUIREMENT_LEVELS)[number];

export const VISA_RULE_DISPLAY_MODES = ["ITEMISED", "INDICATIVE"] as const;
export type VisaRuleDisplayMode = (typeof VISA_RULE_DISPLAY_MODES)[number];

export const VISA_RULE_STATUSES = ["DRAFT", "PUBLISHED", "RETIRED"] as const;
export type VisaRuleStatus = (typeof VISA_RULE_STATUSES)[number];

export interface VisaDocumentRequirement {
  docCode: string; // config/visaDocumentCodes.ts key, e.g. "DOC-01"
  requirement: VisaDocRequirementLevel;
  condition?: string; // human-readable, only meaningful when requirement === "CONDITIONAL"
}

/**
 * Phase 10a — a requirement as it actually appears on a real checklist: one
 * logical line item that can bundle several document TYPES together (task
 * brief §3's example: France's "Proof of occupation (if employed)" is one
 * requirement containing salary slips, an employment contract, the
 * employer NOC and Form 16 — not four independent rows the applicant has
 * to connect themselves).
 *
 * `docTypeCodes` are ALL required together whenever this group applies —
 * there is no "any one of" alternative semantics here; every real checklist
 * example driving this design bundles documents that are ALL needed, never
 * alternatives (add a matchMode if a real "either/or" case ever surfaces).
 *
 * `appliesWhen` is the STRUCTURED form of what used to be
 * VisaDocumentRequirement's free-text `condition` — an applicant-attribute
 * predicate (models/visaAttributes.ts) the migration can evaluate
 * programmatically instead of a human having to read prose. Not every
 * legacy `condition` string maps cleanly onto one (see
 * migrations/2026-08-02-visa-checklist-model-v2.ts) — `legacyConditionNote`
 * preserves the original text verbatim for those. `appliesWhen` absent/empty
 * means the group always applies once its parent rule is selected (the
 * group-level `requirement` still governs REQUIRED vs CONDITIONAL display
 * for a condition that isn't attribute-shaped, e.g. "if requested by
 * immigration on arrival").
 */
export interface VisaDocumentRequirementGroup {
  key: string; // stable slug within the rule, e.g. "PROOF_OF_OCCUPATION"
  label: string; // human label, e.g. "Proof of occupation (if employed)"
  requirement: VisaDocRequirementLevel;
  appliesWhen?: VisaApplicantPredicate;
  docTypeCodes: string[]; // VisaDocumentType.code refs — all required together
  // Overrides VisaDocumentType.defaultDescription for THIS rule — the
  // catalogue holds what a document IS, the rule holds what THIS mission
  // demands (task brief §4: photo size, bank-balance thresholds, etc. vary
  // per destination even for the "same" document type).
  specification?: string;
  templateCode?: string; // optional ref VisaTemplate.code
  legacyConditionNote?: string; // free text carried over where `condition` couldn't be structured into appliesWhen
}

// A rule-scoped reference into the shared VisaQuestion bank (models/
// VisaQuestion.ts) — just the code; the question's own prompt/answerType/
// options/followUps live there, once, not copied per rule.
export interface VisaRuleQuestionRef {
  questionCode: string;
}

// A one-off question this rule needs that isn't generic enough for the
// shared bank (e.g. a US-specific DS-160 confirmation-number prompt) —
// "rule-specific additions" per task brief §7. Deliberately a much smaller
// shape than VisaQuestion itself: no followUps here — a rule-specific,
// one-off question hasn't shown a need for conditional branching yet; add
// it if a real case demands it rather than speculatively.
export interface VisaRuleInlineQuestion {
  code: string; // rule-scoped, e.g. "US_DS160_CONFIRMATION_NUMBER"
  prompt: string;
  answerType: "BOOLEAN" | "TEXT" | "DATE" | "SELECT" | "COUNTRY";
  options?: string[]; // only meaningful when answerType === "SELECT"
}

export interface VisaRuleDocument extends Document {
  // ── lookup key ──────────────────────────────────────────────────────
  nationality: string; // applicant's passport/citizenship country, ISO 3166-1 alpha-2 (e.g. "IN")
  destinationIso2: string; // ISO 3166-1 alpha-2 (e.g. "DE")
  purpose: VisaPurpose;
  entryType: VisaEntryType;
  serviceTier: VisaServiceTier;
  // Phase 10a — distinguishes multiple complete rule variants that would
  // otherwise collide on the five fields above (task brief §5's Canada
  // case: 20 documents normally, 5 for a holder of a valid US visa — same
  // nationality/destination/purpose/entryType/serviceTier, two totally
  // different checklists). Defaults to "DEFAULT" — every rule created
  // through the existing admin CRUD (routes/admin.visa.rules.ts, untouched
  // by this phase) gets exactly this default, so existing behaviour is
  // unchanged; a second variant for the same corridor is only ever created
  // by something that deliberately sets both variantKey and `applicability`
  // below (out of this phase's route-less scope — see the migration's
  // report for what's schema-ready vs. actually populated).
  variantKey: string;
  variantLabel?: string; // human description of the variant, e.g. "Holds a valid US visa"
  // Which applicant this SPECIFIC variant is for — undefined/empty predicate
  // means this is the fallback (matches whichever applicant no more-specific
  // variant already claimed). See selectMostSpecificRule (models/
  // visaAttributes.ts) for the matching algorithm.
  applicability?: VisaApplicantPredicate;

  // ── destination/product description ─────────────────────────────────
  destinationName: string;
  isSchengen: boolean;
  productClass: VisaProductClass;
  visaCategory: VisaCategory;

  // ── validity / stay ──────────────────────────────────────────────────
  validityDays?: number;
  maxStayDays?: number;
  isExtension: boolean;

  // ── processing time ──────────────────────────────────────────────────
  etaMinDays?: number;
  etaMaxDays?: number;
  etaBasis?: VisaEtaBasis;

  // ── process requirements ─────────────────────────────────────────────
  appointmentRequired: boolean;
  biometricsRequired: boolean;
  // LEGACY, flat shape — still the field routes/admin.visa.rules.ts and
  // routes/visa.ts read/write today. Left completely untouched by this
  // phase (see migrations/2026-08-02-visa-checklist-model-v2.ts's report):
  // rewriting docCode values in place would silently break several
  // hardcoded literal comparisons those routes make against the OLD
  // "DOC-NN" codes. `documentGroups` below is the new, group-based,
  // attribute-aware replacement for how a checklist is actually modelled
  // going forward — the two co-exist during the transition.
  documentRequirements: VisaDocumentRequirement[];
  // Phase 10a — see VisaDocumentRequirementGroup above. The operative
  // structure for any NEW rule variant (and what the migration derives
  // from `documentRequirements` for the seven existing rows) — one entry
  // per real checklist line item, not one row per physical document.
  documentGroups: VisaDocumentRequirementGroup[];

  // Phase 10a — questionnaire (task brief §7): a rule may select from the
  // shared VisaQuestion bank and/or add its own one-off questions. Both
  // default to empty — UAE/Laos/China-style corridors with no
  // questionnaire at all simply never populate either.
  questions: VisaRuleQuestionRef[];
  additionalQuestions: VisaRuleInlineQuestion[];

  // ── fees — all itemised components optional; indicativeVisaCostInr is
  // the fallback when the mission/VFS hasn't published a fee breakdown.
  // displayMode is SERVER-DERIVED (see pre-validate hook below) — never
  // trust a client-submitted value for it.
  embassyFeeInr?: number;
  vfsFeeInr?: number;
  plumtripsServiceFeeInr?: number;
  indicativeVisaCostInr?: number;
  displayMode?: VisaRuleDisplayMode;
  priceNote?: string;

  // ── lifecycle ─────────────────────────────────────────────────────────
  status: VisaRuleStatus;
  // The business date these terms (fees, ETA, doc requirements) take
  // effect — distinct from updatedAt (the technical write timestamp).
  // Defaults to "now" on create; every PATCH /rules/:id and POST
  // /rules/bulk in routes/admin.visa.rules.ts REQUIRES the caller to
  // supply this explicitly, so a pricing edit always carries a deliberate
  // effective date rather than a silently-stamped one. Never touched by
  // publish/retire — those are lifecycle transitions, not term changes.
  effectiveFrom: Date;
  lastReviewedAt?: Date;
  reviewedBy?: mongoose.Types.ObjectId; // ref User

  // Provenance marker, e.g. "seed-visa-rules@2026-07" — set only on rows
  // written by scripts/seed-visa-rules.ts, unset on rows created through the
  // (future) fee-management UI. Lets scripts/purge-visa-seed.ts find and
  // remove exactly the placeholder-fee seed rows without touching real
  // pricing that lands in the same collection. Deliberately NOT indexed —
  // this is provenance metadata for an occasional admin script, not a query
  // path any request handler runs.
  seedSource?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

const VisaDocumentRequirementSchema = new Schema<VisaDocumentRequirement>(
  {
    docCode: { type: String, required: true },
    requirement: { type: String, enum: VISA_DOC_REQUIREMENT_LEVELS, required: true },
    condition: { type: String, trim: true },
  },
  { _id: false },
);

const VisaDocumentRequirementGroupSchema = new Schema<VisaDocumentRequirementGroup>(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    requirement: { type: String, enum: VISA_DOC_REQUIREMENT_LEVELS, required: true },
    appliesWhen: { type: [VisaApplicantPredicateConditionSchema], default: undefined },
    docTypeCodes: { type: [String], required: true, default: [] },
    specification: { type: String, trim: true },
    templateCode: { type: String, trim: true, uppercase: true },
    legacyConditionNote: { type: String, trim: true },
  },
  { _id: false },
);

const VisaRuleQuestionRefSchema = new Schema<VisaRuleQuestionRef>(
  { questionCode: { type: String, required: true, trim: true, uppercase: true } },
  { _id: false },
);

const VisaRuleInlineQuestionSchema = new Schema<VisaRuleInlineQuestion>(
  {
    code: { type: String, required: true, trim: true, uppercase: true },
    prompt: { type: String, required: true, trim: true },
    answerType: { type: String, enum: ["BOOLEAN", "TEXT", "DATE", "SELECT", "COUNTRY"], required: true },
    options: { type: [String], default: [] },
  },
  { _id: false },
);

const VisaRuleSchema = new Schema<VisaRuleDocument>(
  {
    nationality: { type: String, required: true, uppercase: true, trim: true },
    destinationIso2: { type: String, required: true, uppercase: true, trim: true },
    purpose: { type: String, enum: VISA_PURPOSES, required: true },
    entryType: { type: String, enum: VISA_ENTRY_TYPES, required: true },
    serviceTier: { type: String, enum: VISA_SERVICE_TIERS, required: true },
    variantKey: { type: String, required: true, default: "DEFAULT", uppercase: true, trim: true },
    variantLabel: { type: String, trim: true },
    applicability: { type: [VisaApplicantPredicateConditionSchema], default: undefined },

    destinationName: { type: String, required: true, trim: true },
    isSchengen: { type: Boolean, default: false },
    productClass: { type: String, enum: VISA_PRODUCT_CLASSES, required: true },
    visaCategory: { type: String, enum: VISA_CATEGORIES, required: true },

    validityDays: { type: Number },
    maxStayDays: { type: Number },
    isExtension: { type: Boolean, default: false },

    etaMinDays: { type: Number },
    etaMaxDays: { type: Number },
    etaBasis: { type: String, enum: VISA_ETA_BASES },

    appointmentRequired: { type: Boolean, default: false },
    biometricsRequired: { type: Boolean, default: false },
    documentRequirements: { type: [VisaDocumentRequirementSchema], default: [] },
    documentGroups: { type: [VisaDocumentRequirementGroupSchema], default: [] },

    questions: { type: [VisaRuleQuestionRefSchema], default: [] },
    additionalQuestions: { type: [VisaRuleInlineQuestionSchema], default: [] },

    embassyFeeInr: { type: Number, min: 0 },
    vfsFeeInr: { type: Number, min: 0 },
    plumtripsServiceFeeInr: { type: Number, min: 0 },
    indicativeVisaCostInr: { type: Number, min: 0 },
    displayMode: { type: String, enum: VISA_RULE_DISPLAY_MODES },
    priceNote: { type: String, trim: true },

    status: { type: String, enum: VISA_RULE_STATUSES, default: "DRAFT", index: true },
    effectiveFrom: { type: Date, required: true, default: Date.now },
    lastReviewedAt: { type: Date },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },

    // Provenance only — see VisaRuleDocument.seedSource above. No `index`.
    seedSource: { type: String, trim: true },
  },
  { timestamps: true },
);

// Natural lookup key — Phase 10a widens this from 5 fields to 6, adding
// `variantKey` (nationality is low-cardinality today, always "IN", but kept
// first per the key order this was specified in). Before this phase, the
// 5-field key WAS the whole identity of a rule — one rule per corridor,
// full stop. Task brief §5 (the Canada case: 20 documents normally, 5 for a
// holder of a valid US visa) needs two complete rule variants to coexist
// for the exact same corridor, which the old 5-field unique index could
// never allow (a second row would always collide). variantKey defaults to
// "DEFAULT" (see the schema field above), so every rule created through the
// existing admin CRUD (routes/admin.visa.rules.ts, which never sets this
// field) still collides exactly the way it always did — this is a widened,
// not a replaced, uniqueness constraint. This index also still serves the
// original 5-field query path as a prefix (Mongo can use a leading subset
// of a compound index), so no separate non-unique index is needed for that.
// migrations/2026-08-02-visa-checklist-model-v2.ts drops the old 5-field
// unique index and creates this one on the live database — see that
// script's report for what it found/changed.
VisaRuleSchema.index(
  { nationality: 1, destinationIso2: 1, purpose: 1, entryType: 1, serviceTier: 1, variantKey: 1 },
  { unique: true },
);
// Admin/browse path: "show every rule for this destination" without knowing
// purpose/entryType/serviceTier up front.
VisaRuleSchema.index({ destinationIso2: 1, status: 1 });

// displayMode is derived, never trusted from input: ITEMISED when any of the
// three itemised fee components is populated, else INDICATIVE (the fallback
// tier — including the zero-fee/visa-free case, where indicativeVisaCostInr
// is an explicit 0 rather than absent).
VisaRuleSchema.pre("validate", function (next) {
  const hasItemised =
    this.embassyFeeInr != null || this.vfsFeeInr != null || this.plumtripsServiceFeeInr != null;
  this.displayMode = hasItemised ? "ITEMISED" : "INDICATIVE";
  next();
});

const VisaRule: Model<VisaRuleDocument> =
  mongoose.models.VisaRule || mongoose.model<VisaRuleDocument>("VisaRule", VisaRuleSchema);

export default VisaRule;

/**
 * Phase 10a variant selection (task brief §5). Given every PUBLISHED rule
 * row sharing a {nationality, destinationIso2, purpose, entryType,
 * serviceTier} corridor (i.e. every `variantKey` variant of it), returns
 * whichever one applies to THIS applicant — the most-specific matching
 * `applicability` predicate, falling back to the variant with no predicate
 * at all. Returns null if nothing matches (no fallback rule exists for the
 * corridor AND the applicant doesn't satisfy any variant's predicate) —
 * callers must not assume a corridor always resolves to something.
 *
 * Not wired into any route by this phase (schema/migration only) — the
 * existing customer-facing GET /rules (routes/visa.ts) still returns every
 * variant as its own row, unfiltered by applicant attributes, exactly as it
 * did before. This is the selection algorithm a future route would call.
 */
export function selectApplicableVisaRule<
  T extends { applicability?: VisaApplicantPredicate | null },
>(candidates: T[], profile: Partial<VisaApplicantProfile> | null | undefined): T | null {
  return selectMostSpecificRule(candidates, profile);
}

export { evaluateApplicantPredicate };
