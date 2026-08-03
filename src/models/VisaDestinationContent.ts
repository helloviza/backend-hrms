// apps/backend/src/models/VisaDestinationContent.ts
//
// Global (NOT workspace-scoped) editorial content, keyed on destination only
// — NOT on purpose. This is the country-level copy (highlights, entry
// summary, hero image) shown regardless of which VisaRule (purpose/entry
// type/service tier) the applicant ends up matching. Purpose-specific
// copy selection (business vs tourism block) happens in the UI layer, not
// here — this model just holds both blocks.
//
// Country imagery (2026-08-03) — heroImageUrl existed from the original
// schema and had never been used until now; thumbnailUrl is new alongside
// it (task brief: "a second field for the picker thumbnail" — the
// requirements-page hero and the /visa destination-tile thumbnail are
// deliberately different crops/sizes, not one image reused twice).
//
// Ops review, never auto-accept: scripts/fetch-visa-destination-images.ts
// fetches SEVERAL Pixabay candidates per destination and downloads BOTH a
// preview- and full-size copy of each to OUR S3 (never hotlinked — see
// that script's own header for why), writing them to imageCandidates
// below with status PENDING. Nothing here ever sets heroImageUrl/
// thumbnailUrl itself — only a human, via the admin destination-content
// picker (routes/admin.visa.rules.ts's POST .../select-image or
// .../image-upload), moves a candidate's (or an uploaded file's) URL into
// the live fields. An auto-selected top search result would eventually
// put a beer festival on a business visa page (task brief) — this model
// has no code path that could do that.
import mongoose, { Schema, type Document, type Model } from "mongoose";

export const VISA_IMAGE_CANDIDATE_STATUSES = ["PENDING", "SELECTED", "REJECTED"] as const;
export type VisaImageCandidateStatus = (typeof VISA_IMAGE_CANDIDATE_STATUSES)[number];

// One Pixabay search hit, already downloaded to OUR S3 (both sizes) by the
// fetch script — never a live Pixabay URL. `sourceId` is Pixabay's own hit
// id (dedupe across re-runs, and the provenance trail if a takedown or a
// licence question ever comes up); `pageUrl`/`tags` are read-only context
// for whoever is reviewing, not rendered to customers.
//
// contrastRatio/contrastStatus (2026-08-04) — computed once at fetch time
// by utils/heroImageContrast.ts against the EXACT requirements-hero
// treatment (RequirementsPage.tsx's heroBackgroundStyle), not left to ops
// judging a raw, untreated thumbnail against text they can't see. A
// candidate below the 4.5:1 WCAG minimum is still stored (audit trail,
// task brief: "surfaced separately as failing", not silently dropped) but
// routes/admin.visa.rules.ts's POST .../select-image refuses to publish
// it — the gate is enforced server-side, not just a disabled button.
export interface VisaImageCandidate {
  source: "pixabay";
  sourceId: string;
  previewUrl: string; // our S3 copy of Pixabay's previewURL — thumbnail-sized, for the picker grid
  fullUrl: string; // our S3 copy of Pixabay's webformatURL/largeImageURL — hero-sized
  pixabayPageUrl?: string;
  tags?: string;
  status: VisaImageCandidateStatus;
  fetchedAt: Date;
  contrastRatio: number; // worst-case WCAG ratio vs #ffffff over the hero heading/body regions
  contrastStatus: "PASS" | "FAIL"; // ratio >= 4.5 ? "PASS" : "FAIL"
}

export const VISA_DESTINATION_CONTENT_STATUSES = ["DRAFT", "PUBLISHED"] as const;
export type VisaDestinationContentStatus = (typeof VISA_DESTINATION_CONTENT_STATUSES)[number];

// Shape: the visa-flow design handoff's country dataset only ever supplied a
// flat list of 3 short highlight phrases per block, not title+description
// pairs — highlights mirrors that. `body` is additive: an optional longer-
// form paragraph for destinations that get real editorial copy beyond a
// highlight list, so a richer write doesn't need a schema change later.
// highlights stay plain strings deliberately (scannable list items on a
// decision page, not prose) — `body` is the one field that carries
// formatting.
//
// `body` markdown (2026-08-04): a CONSTRAINED subset only — bold, italic,
// links, unordered lists. No headings, images, tables, or raw HTML; nothing
// here enforces that at write time (still just `String, trim: true` below —
// see routes/admin.visa.rules.ts's validateContentBlock, which only checks
// it's a string). The subset is enforced entirely on the READ side —
// frontend/src/components/RestrictedMarkdown.tsx, via react-markdown's
// `allowedElements` — because this is ops-authored content shown to
// customers and has to be treated as untrusted at the point it's rendered,
// not trusted because whoever saved it was staff. Any other consumer that
// ever renders this field (a PDF export, an email digest, anything not
// already going through RestrictedMarkdown) needs its own sanitised
// markdown render, not a raw string interpolation — the string may contain
// `**`/`*`/`[]()`/`- ` syntax, not literal prose.
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
  heroImageUrl?: string; // requirements-page hero background (VerdictBand's dark band)
  thumbnailUrl?: string; // /visa destination-picker tile — deliberately a separate field/crop, not heroImageUrl reused
  // Provenance for whichever image is live — set alongside heroImageUrl/
  // thumbnailUrl by the admin picker (never by the fetch script directly).
  // Kept even for an "upload" source so a future licence question about a
  // PUBLISHED image has an answer beyond "someone pasted a URL."
  imageSource?: { provider: "pixabay" | "upload"; sourceId?: string; pixabayPageUrl?: string };
  // Pending-review candidates from scripts/fetch-visa-destination-images.ts
  // — see that script and VisaImageCandidate above. Replaced wholesale on
  // each script run for a destination (not appended), so this never grows
  // unbounded across re-runs.
  imageCandidates: VisaImageCandidate[];
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

const VisaImageCandidateSchema = new Schema<VisaImageCandidate>(
  {
    source: { type: String, enum: ["pixabay"], required: true },
    sourceId: { type: String, required: true, trim: true },
    previewUrl: { type: String, required: true, trim: true },
    fullUrl: { type: String, required: true, trim: true },
    pixabayPageUrl: { type: String, trim: true },
    tags: { type: String, trim: true },
    status: { type: String, enum: VISA_IMAGE_CANDIDATE_STATUSES, default: "PENDING" },
    fetchedAt: { type: Date, required: true },
    contrastRatio: { type: Number, required: true },
    contrastStatus: { type: String, enum: ["PASS", "FAIL"], required: true },
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
    thumbnailUrl: { type: String, trim: true },
    imageSource: {
      type: new Schema(
        {
          provider: { type: String, enum: ["pixabay", "upload"], required: true },
          sourceId: { type: String, trim: true },
          pixabayPageUrl: { type: String, trim: true },
        },
        { _id: false },
      ),
      required: false,
    },
    imageCandidates: { type: [VisaImageCandidateSchema], default: [] },
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
