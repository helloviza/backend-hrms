// apps/backend/src/models/VisaDocument.ts
//
// Workspace-scoped, deliberately a SEPARATE collection from VisaApplication
// (not an embedded array like ManualBooking.attachments) — documents get
// versioned (a rejected/re-extracted upload creates a new version rather
// than overwriting) and need an audit trail (who uploaded, who reviewed,
// why rejected), which an embedded array makes awkward to query/index at
// scale. Metadata only; bytes live in S3 — same convention as
// ManualBooking.attachments (see docs/audits/visa-module-recon.md §4).
//
// Key prefix (applied by the upload route, routes/visa.ts):
//   visa-applications/<workspaceId>/<applicationId>/<timestamp>-<random>.<ext>
// workspaceId is IN the path — not just in the workspaceId field — so a key
// can never be reused across tenants even by accident (e.g. a bug that
// forgot the workspaceId filter on a query would still never make one
// tenant's S3 key collide with another's).
//
// Soft delete only (deletedAt/deletedBy) — the S3 object is NEVER removed
// by this model or its routes. A deleted document may still be needed for
// audit; see routes/visa.ts's DELETE /documents/:documentId.
import mongoose, { Schema, type Document, type Model } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

// PENDING -> PROCESSING -> COMPLETED | NEEDS_REVIEW | FAILED (Phase 4b —
// see services/visaPassportExtraction.ts). Two distinct terminal-success
// states, not one ("EXTRACTED" as originally scaffolded before Phase 4b
// decided the actual approach): COMPLETED means every MRZ check digit
// passed; NEEDS_REVIEW means it parsed but at least one check failed —
// collapsing those into a single "done" status would hide exactly the
// distinction check digits exist to provide. FAILED covers no-MRZ-found
// and any extraction error — never blocks the application either way.
export const VISA_DOCUMENT_EXTRACTION_STATUSES = [
  "PENDING", "PROCESSING", "COMPLETED", "NEEDS_REVIEW", "FAILED",
] as const;
export type VisaDocumentExtractionStatus = (typeof VISA_DOCUMENT_EXTRACTION_STATUSES)[number];

export const VISA_DOCUMENT_REVIEW_STATUSES = ["PENDING", "VERIFIED", "REJECTED"] as const;
export type VisaDocumentReviewStatus = (typeof VISA_DOCUMENT_REVIEW_STATUSES)[number];

// Derived from MRZ check-digit results (utils/mrz.ts's deriveConfidence),
// NEVER a raw score the model reports — see services/visaPassportExtraction.ts
// and the Phase 4b build report. This field was originally scaffolded as a
// continuous 0..1 number before Phase 4b defined confidence as a
// deterministic three-way classification off check digits; a numeric
// score here would just be an invented mapping with no real meaning, so
// the field stores the category itself.
export const VISA_MRZ_CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
export type VisaMrzConfidenceLevel = (typeof VISA_MRZ_CONFIDENCE_LEVELS)[number];

export interface VisaExtractedField {
  key: string;
  value: string;
}

export interface VisaDocumentDocument extends Document {
  workspaceId: mongoose.Types.ObjectId; // CustomerWorkspace._id, via workspaceScopePlugin
  applicationId: mongoose.Types.ObjectId; // ref VisaApplication
  docCode: string; // config/visaDocumentCodes.ts key, e.g. "DOC-01"

  s3Key: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedByUserId: mongoose.Types.ObjectId; // ref User
  version: number; // 1-based; a re-upload of the same docCode increments this, never overwrites

  extractionStatus: VisaDocumentExtractionStatus;
  extractedFields: VisaExtractedField[];
  extractionConfidence?: VisaMrzConfidenceLevel;

  reviewStatus: VisaDocumentReviewStatus;
  reviewedBy?: mongoose.Types.ObjectId; // ref User
  reviewedAt?: Date;
  rejectionReason?: string;

  // Soft delete — see file header. Never set one without the other.
  deletedAt?: Date;
  deletedBy?: mongoose.Types.ObjectId; // ref User

  createdAt?: Date;
  updatedAt?: Date;
}

const VisaExtractedFieldSchema = new Schema<VisaExtractedField>(
  { key: { type: String, required: true }, value: { type: String, required: true } },
  { _id: false },
);

const VisaDocumentSchema = new Schema<VisaDocumentDocument>(
  {
    applicationId: {
      type: Schema.Types.ObjectId,
      ref: "VisaApplication",
      required: true,
      index: true,
    },
    docCode: { type: String, required: true },

    s3Key: { type: String, required: true },
    originalFilename: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    uploadedByUserId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    version: { type: Number, required: true, default: 1, min: 1 },

    extractionStatus: {
      type: String,
      enum: VISA_DOCUMENT_EXTRACTION_STATUSES,
      default: "PENDING",
    },
    extractedFields: { type: [VisaExtractedFieldSchema], default: [] },
    extractionConfidence: { type: String, enum: VISA_MRZ_CONFIDENCE_LEVELS },

    reviewStatus: { type: String, enum: VISA_DOCUMENT_REVIEW_STATUSES, default: "PENDING" },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
    rejectionReason: { type: String, trim: true },

    deletedAt: { type: Date, default: null },
    deletedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

VisaDocumentSchema.plugin(workspaceScopePlugin);

// Enforces "never overwrite" at the DB level, not just by the route
// computing "next version" carefully — a second, concurrent upload of the
// same docCode can never land on the same version number. Also serves the
// "latest version per docCode" listing query (routes/visa.ts), which sorts
// desc within docCode and takes the first row per code.
VisaDocumentSchema.index({ applicationId: 1, docCode: 1, version: 1 }, { unique: true });
// General per-application listing.
VisaDocumentSchema.index({ workspaceId: 1, applicationId: 1 });
// Ops review queue across applications.
VisaDocumentSchema.index({ workspaceId: 1, reviewStatus: 1 });
// Soft-deleted rows are excluded from every route's default queries, but
// never physically removed — this index is what keeps "documents for this
// application" fast once a workspace has accumulated deleted history.
VisaDocumentSchema.index({ workspaceId: 1, deletedAt: 1 });

const VisaDocument: Model<VisaDocumentDocument> =
  mongoose.models.VisaDocument ||
  mongoose.model<VisaDocumentDocument>("VisaDocument", VisaDocumentSchema);

export default VisaDocument;
