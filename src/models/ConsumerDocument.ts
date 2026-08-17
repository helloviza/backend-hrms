// apps/backend/src/models/ConsumerDocument.ts
//
// The consumer's REUSABLE document locker.
//
// ══════════════════════════════════════════════════════════════════════
// ONE STORE, SHARED. THIS IS THE POINT OF THE COLLECTION.
// ══════════════════════════════════════════════════════════════════════
//
// A document uploaded here is owned by the CONSUMER, not by whatever screen
// happened to collect it. The profile's "My Documents" tab and the future
// Apply page read the SAME rows:
//
//   - "My Documents" lists everything the consumer holds
//   - a passport's front/back scan is a reference to a row here
//     (ConsumerProfile.passports[].frontDocumentId)
//   - an application will reference rows here too, via `linkedApplicationIds`
//
// The alternative — each surface keeping its own copy — is what produces the
// "upload your passport again" experience, and means a consumer who deletes
// a document from one screen still has it live on another. So: no surface
// ever copies a file. It links.
//
// ⚠ CONSEQUENCE FOR DELETION. Because rows are shared, DELETE is a SOFT
// delete (`deletedAt`). Hard-deleting a row that an in-flight application
// depends on would break that application retroactively. See the delete
// handler in routes/consumer.profile.ts.
//
// ── PII ───────────────────────────────────────────────────────────────
// The FILE BYTES are the PII here — passport scans, bank statements,
// payslips. The bytes are not in this collection; this row points at them.
// Encryption-at-rest for the object store is part of the same hardening
// pass as the ConsumerProfile field markers.
import mongoose, { Schema, type Document, type Model } from "mongoose";

/**
 * The locker's shelves. These are the CONSUMER's words for their own
 * documents, deliberately coarse — a consumer does not know what a
 * "COVERING_LETTER" is, and the five buckets below are guessable without
 * help text.
 *
 * NOT the same list as the visa catalogue's docCodes (config/visaDocuments),
 * which is an ops-facing taxonomy with dozens of entries. `docCode` below is
 * the optional bridge between the two.
 */
export const CONSUMER_DOCUMENT_CATEGORIES = [
  "IDENTITY",
  "FINANCIAL",
  "EMPLOYMENT",
  "TRAVEL",
  "OTHER",
] as const;
export type ConsumerDocumentCategory = (typeof CONSUMER_DOCUMENT_CATEGORIES)[number];

/**
 * Where the bytes actually are.
 *
 * `driver` is recorded ON THE ROW rather than inferred from the environment
 * at read time. A row written by the dev local-disk driver must still be
 * recognisable as such if the process is later restarted pointing at S3 —
 * otherwise the read path would build an S3 key from a local-disk path and
 * fail with a confusing 404 instead of an honest "this file lives on the dev
 * disk". See services/consumerDocumentStorage.ts.
 */
export const CONSUMER_DOCUMENT_DRIVERS = ["s3", "local-disk"] as const;
export type ConsumerDocumentDriver = (typeof CONSUMER_DOCUMENT_DRIVERS)[number];

export interface ConsumerDocumentDoc extends Document {
  consumerId: mongoose.Types.ObjectId;
  workspaceId: mongoose.Types.ObjectId;
  category: ConsumerDocumentCategory;
  docCode?: string;
  label?: string;
  driver: ConsumerDocumentDriver;
  storageKey: string;
  bucket?: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  linkedApplicationIds: mongoose.Types.ObjectId[];
  deletedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const ConsumerDocumentSchema = new Schema<ConsumerDocumentDoc>(
  {
    // THE ISOLATION KEY — every query filters on it, taken from
    // req.consumer.id and never from caller input.
    consumerId: {
      type: Schema.Types.ObjectId,
      ref: "Consumer",
      required: true,
      index: true,
    },
    // Stamp, not a boundary (see models/ConsumerProfile.ts).
    workspaceId: { type: Schema.Types.ObjectId, required: true, index: true },

    category: {
      type: String,
      enum: CONSUMER_DOCUMENT_CATEGORIES,
      default: "OTHER",
      index: true,
    },
    // The optional bridge to the ops-facing visa document taxonomy. Set when
    // a document was uploaded against a specific requirement, so the Apply
    // page can offer "you already have this" instead of an empty slot.
    docCode: { type: String, trim: true, uppercase: true, index: true },
    // What the consumer calls it. Falls back to originalFilename in the UI.
    label: { type: String, trim: true },

    driver: { type: String, enum: CONSUMER_DOCUMENT_DRIVERS, required: true },
    storageKey: { type: String, required: true },
    bucket: { type: String },

    originalFilename: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },

    // The reuse ledger. An application that consumes this document appends
    // its id here, which is what makes "is anything relying on this file?"
    // answerable at delete time.
    linkedApplicationIds: {
      type: [{ type: Schema.Types.ObjectId, ref: "VisaApplication" }],
      default: () => [],
    },

    // SOFT delete — see the header.
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true },
);

// The list query: one consumer's live documents, newest first.
ConsumerDocumentSchema.index({ consumerId: 1, deletedAt: 1, createdAt: -1 });

const ConsumerDocument: Model<ConsumerDocumentDoc> =
  mongoose.models.ConsumerDocument ||
  mongoose.model<ConsumerDocumentDoc>("ConsumerDocument", ConsumerDocumentSchema);

export default ConsumerDocument;
