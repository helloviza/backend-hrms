// apps/backend/src/models/VisaDestinationContent.ts
//
// Global (NOT workspace-scoped) editorial content, keyed on destination only
// — NOT on purpose. This is the country-level copy (highlights, entry
// summary, hero image) shown regardless of which VisaRule (purpose/entry
// type/service tier) the applicant ends up matching. Purpose-specific
// copy selection (business vs tourism block) happens in the UI layer, not
// here — this model just holds both blocks.
import mongoose, { Schema, type Document, type Model } from "mongoose";

export const VISA_DESTINATION_CONTENT_STATUSES = ["DRAFT", "PUBLISHED"] as const;
export type VisaDestinationContentStatus = (typeof VISA_DESTINATION_CONTENT_STATUSES)[number];

// Shape: the visa-flow design handoff's country dataset only ever supplied a
// flat list of 3 short highlight phrases per block, not title+description
// pairs — highlights mirrors that. `body` is additive: an optional longer-
// form paragraph for destinations that get real editorial copy beyond a
// highlight list, so a richer write doesn't need a schema change later.
export interface VisaDestinationBlock {
  highlights: string[];
  body?: string;
}

export interface VisaEntrySnapshot {
  visaRequired: boolean;
  headline: string;
  summary: string;
}

export interface VisaDestinationContentDocument extends Document {
  destinationIso2: string; // ISO 3166-1 alpha-2, e.g. "DE" — unique key, purpose-independent
  // Gates whether this content may be rendered to an applicant. Defaults to
  // DRAFT so nothing goes live un-reviewed — in particular, LLM-authored
  // placeholder copy (see scripts/seed-visa-rules.ts's Cambodia/Nepal
  // entries) must stay DRAFT until a human confirms it.
  status: VisaDestinationContentStatus;
  businessBlock: VisaDestinationBlock;
  tourismBlock: VisaDestinationBlock;
  entrySnapshot: VisaEntrySnapshot;
  heroImageUrl?: string;
  lastReviewedAt?: Date;

  // Provenance marker, e.g. "seed-visa-rules@2026-07" — set only on rows
  // written by scripts/seed-visa-rules.ts. See VisaRule.seedSource for the
  // full reasoning; same field, same purpose, mirrored on this model since
  // the seed writes both. Deliberately NOT indexed.
  seedSource?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

const VisaDestinationBlockSchema = new Schema<VisaDestinationBlock>(
  { highlights: { type: [String], default: [] }, body: { type: String, trim: true } },
  { _id: false },
);

const VisaEntrySnapshotSchema = new Schema<VisaEntrySnapshot>(
  {
    visaRequired: { type: Boolean, required: true },
    headline: { type: String, trim: true, default: "" },
    summary: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const VisaDestinationContentSchema = new Schema<VisaDestinationContentDocument>(
  {
    destinationIso2: { type: String, required: true, uppercase: true, trim: true },
    status: { type: String, enum: VISA_DESTINATION_CONTENT_STATUSES, default: "DRAFT", index: true },
    businessBlock: { type: VisaDestinationBlockSchema, default: () => ({ highlights: [] }) },
    tourismBlock: { type: VisaDestinationBlockSchema, default: () => ({ highlights: [] }) },
    entrySnapshot: {
      type: VisaEntrySnapshotSchema,
      default: () => ({ visaRequired: true, headline: "", summary: "" }),
    },
    heroImageUrl: { type: String, trim: true },
    lastReviewedAt: { type: Date },

    // Provenance only — see VisaDestinationContentDocument.seedSource above.
    // No `index`.
    seedSource: { type: String, trim: true },
  },
  { timestamps: true },
);

VisaDestinationContentSchema.index({ destinationIso2: 1 }, { unique: true });

const VisaDestinationContent: Model<VisaDestinationContentDocument> =
  mongoose.models.VisaDestinationContent ||
  mongoose.model<VisaDestinationContentDocument>(
    "VisaDestinationContent",
    VisaDestinationContentSchema,
  );

export default VisaDestinationContent;
