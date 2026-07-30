// apps/backend/src/models/VisaRule.ts
//
// Global (NOT workspace-scoped) reference data — the visa-requirements
// lookup table. One row per {nationality, destinationIso2, purpose,
// entryType, serviceTier} combination. Shared across every tenant; nothing
// here is customer-specific. A VisaApplication never live-references this —
// it embeds a point-in-time copy (see VisaApplication.ruleSnapshot) so a
// later edit here never retroactively changes an in-flight application.
import mongoose, { Schema, type Document, type Model } from "mongoose";

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

export interface VisaRuleDocument extends Document {
  // ── lookup key ──────────────────────────────────────────────────────
  nationality: string; // applicant's passport/citizenship country, ISO 3166-1 alpha-2 (e.g. "IN")
  destinationIso2: string; // ISO 3166-1 alpha-2 (e.g. "DE")
  purpose: VisaPurpose;
  entryType: VisaEntryType;
  serviceTier: VisaServiceTier;

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
  documentRequirements: VisaDocumentRequirement[];

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

const VisaRuleSchema = new Schema<VisaRuleDocument>(
  {
    nationality: { type: String, required: true, uppercase: true, trim: true },
    destinationIso2: { type: String, required: true, uppercase: true, trim: true },
    purpose: { type: String, enum: VISA_PURPOSES, required: true },
    entryType: { type: String, enum: VISA_ENTRY_TYPES, required: true },
    serviceTier: { type: String, enum: VISA_SERVICE_TIERS, required: true },

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

    embassyFeeInr: { type: Number, min: 0 },
    vfsFeeInr: { type: Number, min: 0 },
    plumtripsServiceFeeInr: { type: Number, min: 0 },
    indicativeVisaCostInr: { type: Number, min: 0 },
    displayMode: { type: String, enum: VISA_RULE_DISPLAY_MODES },
    priceNote: { type: String, trim: true },

    status: { type: String, enum: VISA_RULE_STATUSES, default: "DRAFT", index: true },
    lastReviewedAt: { type: Date },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },

    // Provenance only — see VisaRuleDocument.seedSource above. No `index`.
    seedSource: { type: String, trim: true },
  },
  { timestamps: true },
);

// Natural lookup key — also the primary application-time query path
// (nationality is low-cardinality today, always "IN", but kept first per
// the key order this was specified in).
VisaRuleSchema.index(
  { nationality: 1, destinationIso2: 1, purpose: 1, entryType: 1, serviceTier: 1 },
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
