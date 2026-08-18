// apps/backend/src/models/ExtractedDocument.ts
import { Schema, model, type Document, type Types } from "mongoose";

/**
 * ExtractedDocument — the master files table for AI document extraction.
 * ---------------------------------------------------------------------
 * One row per uploaded source file. It doubles as the processing job (the
 * sweep worker claims `status:"pending"` rows atomically) and the durable
 * store of everything the extractor found, same dual role ExpenseCapture
 * plays for WhatsApp receipts.
 *
 * DELIBERATELY NOT BOOKING-SPECIFIC. Manual-booking attachments are the first
 * consumer, not the only intended one, so the parent pointer is the generic
 * (`sourceModule`, `sourceId`) pair. `bookingId` is an additional, optional
 * convenience ref populated only when sourceModule === "manualBookings" — it
 * exists so booking queries can hit a direct index instead of matching on a
 * string discriminator. A second module points `sourceModule`/`sourceId` at
 * its own parent and simply leaves `bookingId` unset; nothing in
 * services/documentExtraction.service.ts reads `bookingId`.
 *
 * `extractedJson` is the source of truth — the full normalized PlumtripsVoucher
 * as the extractor returned it. `flightRows[]` is a DERIVED flattening of it
 * (one row per passenger per segment) shaped for the ops review table; it is
 * recomputed from extractedJson on every successful extraction, so it must
 * never hold anything that can't be re-derived — with the sole exception of
 * `checkinStatus` and any operator edits, see below.
 */

export const EXTRACTION_STATUSES = [
  "pending",
  "processing",
  "extracted",
  "failed",
  "skipped",
] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export const EXTRACTION_DOC_TYPES = ["flight", "hotel", "other"] as const;
export type ExtractionDocType = (typeof EXTRACTION_DOC_TYPES)[number];

/**
 * One flattened passenger×segment row. Field notes where the value does NOT
 * come straight off the extractor:
 *
 *  - `cabinClass` is the voucher's `class` (renamed only to avoid a bare
 *    `class` key on a TS interface; the UI still labels it "Class").
 *  - `documentBookingRef` is the voucher's OWN booking reference
 *    (booking_info.booking_id) — the supplier/portal ref printed on the
 *    ticket. It is NOT our ManualBooking id; that's the parent row's
 *    `bookingId`. The two are different numbers and must not be conflated.
 *  - `checkinStatus` has NO source in the extractor — nothing in the Gemini
 *    RAW contract produces it. It is always null on extraction and is only
 *    ever written by a human through the review panel.
 *  - `seat`/`meal`/`cabinBaggage`/`checkinBaggage` exist at both passenger
 *    and segment level in the voucher; the deriver prefers the passenger
 *    value and falls back to the segment's ancillaries.
 */
export interface ExtractedFlightRow {
  passengerIndex: number;
  segmentIndex: number;

  passengerName: string | null;
  passengerType: string | null;

  airline: string | null;
  flightNo: string | null;
  cabinClass: string | null;
  duration: string | null;

  depAirport: string | null;
  depCity: string | null;
  depDate: string | null;
  depTime: string | null;
  depTerminal: string | null;

  arrAirport: string | null;
  arrCity: string | null;
  arrDate: string | null;
  arrTime: string | null;
  arrTerminal: string | null;

  documentBookingRef: string | null;
  pnr: string | null;
  ticketNo: string | null;

  seat: string | null;
  checkinStatus: string | null;
  cabinBaggage: string | null;
  checkinBaggage: string | null;
  meal: string | null;
  barcode: string | null;
}

export interface ExtractedDocumentDoc extends Document {
  sourceModule: string;
  sourceId: Types.ObjectId;
  bookingId?: Types.ObjectId;
  workspaceId: Types.ObjectId;

  attachmentId?: Types.ObjectId;
  attachmentRef: string;
  originalFilename: string;
  mimeType: string;
  size: number;

  status: ExtractionStatus;
  docType: ExtractionDocType;

  extractedJson?: unknown;
  flightRows: ExtractedFlightRow[];

  confidence?: number | null;
  validationErrorCount?: number;
  modelUsed?: string;

  attempts: number;
  claimedAt?: Date | null;
  nextAttemptAt?: Date;
  error?: string;
  skipReason?: string;

  verified: boolean;
  verifiedBy?: Types.ObjectId;
  verifiedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const FlightRowSchema = new Schema<ExtractedFlightRow>(
  {
    passengerIndex: { type: Number, required: true, default: 0 },
    segmentIndex: { type: Number, required: true, default: 0 },

    passengerName: { type: String, default: null },
    passengerType: { type: String, default: null },

    airline: { type: String, default: null },
    flightNo: { type: String, default: null },
    cabinClass: { type: String, default: null },
    duration: { type: String, default: null },

    depAirport: { type: String, default: null },
    depCity: { type: String, default: null },
    depDate: { type: String, default: null },
    depTime: { type: String, default: null },
    depTerminal: { type: String, default: null },

    arrAirport: { type: String, default: null },
    arrCity: { type: String, default: null },
    arrDate: { type: String, default: null },
    arrTime: { type: String, default: null },
    arrTerminal: { type: String, default: null },

    documentBookingRef: { type: String, default: null },
    pnr: { type: String, default: null },
    ticketNo: { type: String, default: null },

    seat: { type: String, default: null },
    checkinStatus: { type: String, default: null },
    cabinBaggage: { type: String, default: null },
    checkinBaggage: { type: String, default: null },
    meal: { type: String, default: null },
    barcode: { type: String, default: null },
  },
  { _id: true },
);

const ExtractedDocumentSchema = new Schema<ExtractedDocumentDoc>(
  {
    // Generic parent pointer — see the file header on why this is not a
    // hardcoded booking ref.
    sourceModule: { type: String, required: true, index: true },
    sourceId: { type: Schema.Types.ObjectId, required: true, index: true },
    bookingId: { type: Schema.Types.ObjectId, ref: "ManualBooking", index: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },

    // attachmentRef is the S3 key. It is the idempotency key (unique index
    // below): the upload path mints it with Date.now()+random, so one key is
    // exactly one uploaded file, and re-running the enqueue for a file that
    // already has a row is a no-op rather than a duplicate extraction.
    attachmentId: { type: Schema.Types.ObjectId },
    attachmentRef: { type: String, required: true },
    originalFilename: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true, default: 0 },

    status: { type: String, enum: EXTRACTION_STATUSES, required: true, default: "pending" },
    docType: { type: String, enum: EXTRACTION_DOC_TYPES, required: true, default: "other" },

    extractedJson: { type: Schema.Types.Mixed },
    flightRows: { type: [FlightRowSchema], default: [] },

    // No document-level confidence exists in the extractor's contract (only a
    // per-barcode-candidate one), so this stays null unless a future model
    // reports one. validationErrorCount is the real quality signal today:
    // how many strict-shape errors survived the extractor's repair pass.
    confidence: { type: Number, default: null },
    validationErrorCount: { type: Number, default: 0 },
    modelUsed: { type: String },

    attempts: { type: Number, required: true, default: 0 },
    claimedAt: { type: Date, default: null },
    // Earliest time the worker may claim this row. Set to now on enqueue (so a
    // fresh row is claimable on the very next sweep) and pushed forward on each
    // failed-but-retryable attempt. Without it, drain() re-claims a just-failed
    // row inside the SAME tick and all three attempts burn in a few seconds,
    // which means the retry budget survives nothing transient — a 30-second
    // Gemini or S3 blip would permanently fail a document that would have
    // succeeded a minute later.
    nextAttemptAt: { type: Date, default: Date.now },
    error: { type: String },
    skipReason: { type: String },

    // Review is deliberately NOT a gate: rows are stored and readable whatever
    // this says. `verified` only records that a human looked at the extraction.
    verified: { type: Boolean, required: true, default: false },
    verifiedBy: { type: Schema.Types.ObjectId, ref: "User" },
    verifiedAt: { type: Date },
  },
  { timestamps: true },
);

// The worker's claim query: pending rows whose backoff has elapsed, oldest
// first. Field order matches the query — equality (status), then the range
// (nextAttemptAt), then the sort key (createdAt) — so Mongo can satisfy the
// filter and the sort from this one index without a collection scan or an
// in-memory sort.
ExtractedDocumentSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });
// The stale-reclaim sweep over rows stuck in `processing`.
ExtractedDocumentSchema.index({ status: 1, claimedAt: 1 });

// One row per uploaded file, enforced in the database rather than by a
// read-then-write race in the enqueue path.
ExtractedDocumentSchema.index({ attachmentRef: 1 }, { unique: true });

// Every read path is tenant-scoped; this is the index behind it.
ExtractedDocumentSchema.index({ workspaceId: 1, bookingId: 1 });

export const ExtractedDocument = model<ExtractedDocumentDoc>(
  "ExtractedDocument",
  ExtractedDocumentSchema,
);

export default ExtractedDocument;
