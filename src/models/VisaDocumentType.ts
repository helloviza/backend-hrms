// apps/backend/src/models/VisaDocumentType.ts
//
// Phase 10a — global (NOT workspace-scoped) reference data: the canonical
// document-type catalogue, replacing the numbered DOC-01..DOC-25 scheme
// (config/visaDocumentCodes.ts) which had only 9 of its 25 numeric slots
// populated and nowhere to record source-label aliases. `code` is a stable
// semantic string (e.g. "PASSPORT_ORIGINAL") — additive going forward, no
// numeric range to run out of.
//
// Seeded (idempotently) by migrations/2026-08-02-visa-checklist-model-v2.ts
// from config/visaDocumentTypeCatalogue.ts, which is the actual source of
// truth for the catalogue's content — this collection is a queryable,
// alias-searchable materialisation of that same data, not a second place
// to edit it by hand. See that file's header for why the legacy
// config/visaDocumentCodes.ts shim still exists alongside this collection.
import mongoose, { Schema, type Document, type Model } from "mongoose";
import type { VisaDocumentTypeCategory } from "../config/visaDocumentTypeCatalogue.js";

export const VISA_DOCUMENT_TYPE_CATEGORIES = [
  "IDENTITY", "FINANCIAL", "EMPLOYMENT", "BUSINESS", "TRAVEL",
  "SPONSORSHIP", "CIVIL_STATUS", "VISA_HISTORY",
] as const;

export interface VisaDocumentTypeDocument extends Document {
  code: string; // stable semantic code, e.g. "PASSPORT_ORIGINAL" — unique
  name: string;
  category: VisaDocumentTypeCategory;
  defaultDescription: string;
  // Source-label aliases this same document type appears under across
  // different missions' checklists (task brief's own example: Employer NOC
  // is "Leave Approval Letter" in Canada, "Leave Letter From Company" in
  // China) — lets a checklist-import or search step match a source label
  // back to the one canonical type instead of creating a duplicate.
  aliases: string[];
  ocrExtractable: boolean;
  // Set only for the nine types migrated from the old DOC-NN scheme — see
  // config/visaDocumentTypeCatalogue.ts's OLD_TO_NEW_DOC_CODE_MAP, which
  // this mirrors for anyone querying the collection directly (without
  // re-deriving from the static catalogue file).
  legacyCode?: string;

  // Provenance marker, e.g. "visa-checklist-model-v2@2026-08" — set only at
  // creation by migrations/2026-08-02-visa-checklist-model-v2.ts, never
  // overwritten on a later update. Same convention as VisaRule.seedSource.
  // Deliberately NOT indexed — provenance metadata for an occasional
  // migration/admin script, not a query path any request handler runs.
  seedSource?: string;

  createdAt?: Date;
  updatedAt?: Date;
}

const VisaDocumentTypeSchema = new Schema<VisaDocumentTypeDocument>(
  {
    code: { type: String, required: true, trim: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, enum: VISA_DOCUMENT_TYPE_CATEGORIES, required: true },
    defaultDescription: { type: String, required: true, trim: true },
    aliases: { type: [String], default: [] },
    ocrExtractable: { type: Boolean, default: false },
    legacyCode: { type: String, trim: true },
    seedSource: { type: String, trim: true },
  },
  { timestamps: true },
);

VisaDocumentTypeSchema.index({ code: 1 }, { unique: true });
// Legacy-code lookup (the resolver path for old-shape ruleSnapshot/VisaDocument
// rows — see utils/visaDocumentTypeResolver.ts) — sparse, since most rows have
// no legacyCode.
VisaDocumentTypeSchema.index({ legacyCode: 1 }, { sparse: true });
// Alias search — checklist-import matching a source label to a canonical type.
VisaDocumentTypeSchema.index({ aliases: 1 });

const VisaDocumentType: Model<VisaDocumentTypeDocument> =
  mongoose.models.VisaDocumentType ||
  mongoose.model<VisaDocumentTypeDocument>("VisaDocumentType", VisaDocumentTypeSchema);

export default VisaDocumentType;
