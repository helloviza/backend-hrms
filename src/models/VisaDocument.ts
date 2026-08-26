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
import { fieldEncryptionPlugin } from "../plugins/fieldEncryption.plugin.js";
import { PII_SUBJECT_TYPES, type PiiSubjectType } from "./SubjectKey.js";

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

/**
 * The two byte stores, mirroring models/ConsumerDocument.ts's
 * CONSUMER_DOCUMENT_DRIVERS exactly — same two values, same meaning.
 *
 * Declared here rather than imported from that model on purpose: these are
 * two independent collections, and a shared import would make a change to
 * the consumer locker's storage options silently redefine what this
 * collection accepts. Two lists that happen to agree, checked by the
 * matching test, beats one list that couples two schemas.
 */
export const VISA_DOCUMENT_DRIVERS = ["s3", "local-disk"] as const;
export type VisaDocumentDriver = (typeof VISA_DOCUMENT_DRIVERS)[number];

export interface VisaExtractedField {
  key: string;
  value: string;
}

export interface VisaDocumentDocument extends Document {
  workspaceId: mongoose.Types.ObjectId; // CustomerWorkspace._id, via workspaceScopePlugin
  applicationId: mongoose.Types.ObjectId; // ref VisaApplication
  docCode: string; // config/visaDocumentCodes.ts key, e.g. "DOC-01"

  /**
   * ⚠ THE NAME IS NOW NARROWER THAN THE FIELD.
   *
   * For a `driver: "s3"` row — which is every row that has ever existed and
   * every B2B upload — this is exactly what it always was: an S3 object key
   * in `bucket` (or in env.S3_BUCKET when `bucket` is absent).
   *
   * For a `driver: "local-disk"` row it holds a DISK PATH instead, relative
   * to the same .devdata/uploads root services/consumerDocumentStorage.ts
   * uses. Renaming it to something honest (`storageKey`, as
   * models/ConsumerDocument.ts calls it) would touch every reader in
   * routes/visa.ts, routes/admin.visa.ts, the extraction service and the
   * scripts — a cross-model rename that is deliberately NOT part of this
   * change. Recorded here so the next reader knows the mismatch is known
   * rather than sloppy.
   */
  s3Key: string;
  /**
   * WHERE the bytes are, recorded on the row rather than inferred from the
   * environment at read time — the same reasoning, and the same two values,
   * as models/ConsumerDocument.ts's own `driver`. A row written by the dev
   * disk driver must stay recognisable as such if the process is later
   * restarted pointing at S3; otherwise the read path builds an S3 key out
   * of a disk path and 404s confusingly.
   *
   * DEFAULT "s3", and that default is load-bearing: every row already in
   * the database predates this field, every one of them is an S3 object,
   * and the default is what keeps them on the presign path without a
   * backfill.
   */
  driver: VisaDocumentDriver;
  /**
   * The S3 bucket, when it is worth being explicit. Optional and usually
   * absent: every writer in this repo uses env.S3_BUCKET, so a null here
   * means "wherever env.S3_BUCKET points", which is what the read path
   * already assumed. Present so a row can name its bucket when the bytes
   * were written by something that is not this process's default.
   */
  bucket?: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  /**
   * NULLABLE as of the D2C plumbing pass — it was `required: true`.
   *
   * B2B is unaffected: routes/visa.ts's upload path sets it on every row it
   * has ever written and still does, so relaxing the constraint removes no
   * guarantee anything actually relied on. What it permits is a row whose
   * uploader is a CONSUMER, who is not a User and has no id in that
   * collection — see uploadedByConsumerId below. Pointing this at some
   * staff id to satisfy a `required` would put a name in the audit trail
   * for an upload that person never touched.
   */
  uploadedByUserId: mongoose.Types.ObjectId | null; // ref User
  /**
   * The D2C counterpart. Exactly one of this and uploadedByUserId is set on
   * a well-formed row; both null is possible only for a legacy row and is
   * not a state anything writes.
   *
   * Two fields rather than one polymorphic {type,id} pair, because `ref`
   * populate and every existing reader of uploadedByUserId keep working
   * untouched — the same shape models/VisaApplication.ts already uses for
   * travellerProfileId vs consumerId.
   */
  uploadedByConsumerId: mongoose.Types.ObjectId | null; // ref Consumer
  version: number; // 1-based; a re-upload of the same docCode increments this, never overwrites

  extractionStatus: VisaDocumentExtractionStatus;
  extractedFields: VisaExtractedField[];
  extractionConfidence?: VisaMrzConfidenceLevel;

  // ── The encryption subject, DENORMALISED ───────────────────────────
  // Whose PII `extractedFields` holds. Denormalised rather than joined on
  // read for two reasons: resolving it live would mean a VisaApplication
  // lookup per document (an N+1 on every document-list read), and the
  // answer must survive scripts/erase-traveller-profile.ts nulling
  // VisaApplication.travellerProfileId.
  //
  // NULL on every row written before encryption was switched on. That is
  // not a gap to backfill: those rows hold PLAINTEXT extractedFields, which
  // the dual-read window passes straight through without ever asking who
  // the subject is. A row only needs a subject once it holds ciphertext,
  // and every path that writes ciphertext stamps these first
  // (services/visaPassportExtraction.ts, routes/visa.ts's upload).
  subjectType: PiiSubjectType | null;
  subjectId: mongoose.Types.ObjectId | null;

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
    // required WITH a default — mongoose applies the default before
    // validating, so an insert that omits it gets "s3" rather than a
    // validation error, and a row can still never end up with the field
    // explicitly unset. Every pre-existing row reads back as "s3" too: an
    // absent path in the database takes the schema default on hydration,
    // which is why this needs no backfill.
    driver: { type: String, enum: VISA_DOCUMENT_DRIVERS, required: true, default: "s3" },
    bucket: { type: String },
    originalFilename: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    // required:false now — see the interface above. B2B still always sets it.
    uploadedByUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    // Indexed because the consumer-facing question "which rows did THIS
    // person upload" is one an erasure has to be able to ask; nothing
    // queries by uploadedByUserId, which is why that one never was.
    uploadedByConsumerId: {
      type: Schema.Types.ObjectId,
      ref: "Consumer",
      default: null,
      index: true,
    },
    version: { type: Number, required: true, default: 1, min: 1 },

    extractionStatus: {
      type: String,
      enum: VISA_DOCUMENT_EXTRACTION_STATUSES,
      default: "PENDING",
    },
    extractedFields: { type: [VisaExtractedFieldSchema], default: [] },
    extractionConfidence: { type: String, enum: VISA_MRZ_CONFIDENCE_LEVELS },

    // See the interface above. Nullable and un-indexed on purpose: nothing
    // queries BY subject — these exist to be read off a document already in
    // hand, so the plugin can find the right key.
    subjectType: { type: String, enum: PII_SUBJECT_TYPES, default: null },
    subjectId: { type: Schema.Types.ObjectId, default: null },

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

/* ── Encryption at rest ─────────────────────────────────────────────── */

/**
 * `extractedFields[].value` — the MRZ/VIZ read off an uploaded passport.
 * Document number, surname, given names, date of birth, nationality, place
 * of birth: the same identity data ConsumerProfile holds, arriving by a
 * different route. The `key` half of each pair is NOT encrypted; it names
 * the field and is what every reader filters on.
 *
 * THE WHOLE ARRAY IS ENCRYPTED, INCLUDING THE NON-PII ENTRIES.
 * extractedFields is heterogeneous — alongside the MRZ it carries
 * `failureCategory`, `error`, `check_*` (passed/failed) and
 * `*_severity`, none of which are PII. Encrypting only the PII keys would
 * mean deciding per element based on a sibling field, which the plugin's
 * path model cannot express; encrypting the whole array's values is the
 * honest alternative, and the entries that are not PII lose nothing by it.
 *
 * ONE REAL COST, and it is not hypothetical: a randomized ciphertext cannot
 * be queried, so `find({ extractedFields: { $elemMatch: { key: "...",
 * value: "..." } } })` no longer works. There was exactly one such query
 * (scripts/rerun-visa-passport-extraction.ts) and it now filters in memory
 * after the read. Anything new that wants to select ON a value has the same
 * constraint — filter after reading, or store a non-PII discriminator in
 * the `key`.
 */
export const ENCRYPTED_PII_FIELDS = [{ path: "extractedFields.$.value" }];

/**
 * The subject is TWO-BRANCH, and getting this wrong would encrypt a
 * consumer's data under a key their erasure never destroys:
 *
 *   B2B  — the applicant is a TravellerProfile (a corporate-roster entity),
 *          reached through VisaApplication.travellerProfileId. This is the
 *          subject scripts/erase-traveller-profile.ts already cascades along.
 *   D2C  — there IS no TravellerProfile. routes/consumer.applications.ts
 *          creates consumer applications with travellerProfileId: null and
 *          consumerId set, deliberately ("the applicant's identity lives on
 *          the ConsumerProfile"). The subject is the CONSUMER — the same
 *          key their ConsumerProfile uses, so one shred covers both.
 *
 * Resolved from the denormalised fields above, never from a join.
 */
VisaDocumentSchema.plugin(fieldEncryptionPlugin, {
  fields: ENCRYPTED_PII_FIELDS,
  subject: (doc: any) =>
    doc?.subjectType && doc?.subjectId
      ? { subjectType: doc.subjectType, subjectId: doc.subjectId }
      : null,
});

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

/**
 * Derive a document's encryption subject from its owning VisaApplication —
 * the ONE place the two-branch rule above is implemented. Every path that
 * is about to write `extractedFields` calls this and stamps the result
 * before saving; nothing re-derives the rule inline.
 *
 * Returns null when the application can name neither (an application whose
 * travellerProfileId has already been nulled by an erasure, with no
 * consumerId). Callers must NOT invent a subject in that case — a wrong
 * subject encrypts data under a key that person's erasure will never
 * destroy, which is worse than failing.
 */
export function subjectFromApplication(
  application: { travellerProfileId?: any; consumerId?: any } | null | undefined,
): { subjectType: PiiSubjectType; subjectId: mongoose.Types.ObjectId } | null {
  if (application?.travellerProfileId) {
    return { subjectType: "TRAVELLER_PROFILE", subjectId: application.travellerProfileId };
  }
  if (application?.consumerId) {
    return { subjectType: "CONSUMER", subjectId: application.consumerId };
  }
  return null;
}

const VisaDocument: Model<VisaDocumentDocument> =
  mongoose.models.VisaDocument ||
  mongoose.model<VisaDocumentDocument>("VisaDocument", VisaDocumentSchema);

export default VisaDocument;
