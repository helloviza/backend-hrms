// apps/backend/src/services/documentExtraction.service.ts
import mongoose from "mongoose";
import ExtractedDocument, {
  type ExtractedDocumentDoc,
  type ExtractedFlightRow,
  type ExtractionDocType,
} from "../models/ExtractedDocument.js";
import {
  extractVoucherViaGemini,
  normalizeToVoucher,
  type RawCandidate,
} from "./voucherExtractorGemini.js";
import { getObjectBuffer } from "../utils/s3Upload.js";
import type { PlumtripsVoucher, VoucherType } from "../types/index.js";
import logger from "../utils/logger.js";
import { computeCarbonSafely } from "./carbonEngine.service.js";

/**
 * Document extraction engine — shared, module-agnostic.
 * -----------------------------------------------------
 * Manual-booking attachments are the FIRST consumer of this, not the only
 * intended one. Nothing below imports a booking model or reasons about
 * bookings: callers hand over (sourceModule, sourceId, workspaceId) plus the
 * file's S3 coordinates, and get back a row in the ExtractedDocument master
 * table. A second module wires itself in by calling enqueueExtraction() with
 * its own sourceModule string — no changes here.
 *
 * Split of responsibilities:
 *   enqueueExtraction()  — request path. One tiny idempotent insert, no AI.
 *   claimNextPending()   — worker. Atomic pending -> processing claim.
 *   runExtraction()      — worker. S3 read -> model -> derive -> persist.
 *
 * The request path NEVER calls the model. That is the whole point of the
 * master table: uploads stay instant and extraction is someone else's problem.
 */

/* ───────────────────────── model selection ───────────────────────── */

/**
 * THE one place this engine names a model. gemini-2.5-flash retires
 * 16 Oct 2026; migrating is a change to this constant (or the GEMINI_MODEL
 * env var, which voucherExtractorGemini.ts already honours and which wins
 * over this at runtime). Recorded per-row as `modelUsed` so a post-migration
 * audit can tell which rows came from which model.
 */
export const EXTRACTION_MODEL = "gemini-2.5-flash";

function activeModelName(): string {
  return (process.env.GEMINI_MODEL && process.env.GEMINI_MODEL.trim()) || EXTRACTION_MODEL;
}

/* ───────────────────────── eligibility ───────────────────────── */

/** Matches the attachment upload allowlist in routes/manualBookings.ts. */
export const EXTRACTABLE_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
];

/**
 * The extractor base64s the whole file into a single inline request part
 * (voucherExtractorGemini.ts), which inflates bytes by ~4/3. The attachment
 * cap is 15 MB, which would become ~20 MB of payload and be rejected by the
 * API — burning all three attempts to learn something we can determine for
 * free right here. Anything above this is parked as `skipped`, which is a
 * terminal, non-retrying state distinct from `failed`.
 */
export const MAX_EXTRACTABLE_BYTES = 7 * 1024 * 1024;

export function isExtractableMime(mimeType: string): boolean {
  return EXTRACTABLE_MIME_TYPES.includes(String(mimeType || "").toLowerCase());
}

/* ───────────────────────── enqueue (request path) ───────────────────────── */

export interface EnqueueExtractionInput {
  sourceModule: string;
  sourceId: string | mongoose.Types.ObjectId;
  workspaceId: string | mongoose.Types.ObjectId;
  /** Optional convenience ref; only set by the manual-bookings consumer. */
  bookingId?: string | mongoose.Types.ObjectId;
  attachmentId?: string | mongoose.Types.ObjectId;
  /** S3 key — the idempotency key. */
  attachmentRef: string;
  originalFilename: string;
  mimeType: string;
  size: number;
  /** Best guess at the document type; corrected by the model. */
  typeHint?: VoucherType;
}

/**
 * Create the pending row for a newly stored file. Idempotent: the unique
 * index on attachmentRef means a repeat call for the same file is a no-op
 * rather than a second extraction, so this is safe to call from a retry, a
 * backfill, or twice by accident.
 *
 * Returns the row, or null when the file isn't a type we extract (the caller
 * is not expected to pre-filter).
 */
export async function enqueueExtraction(
  input: EnqueueExtractionInput,
): Promise<ExtractedDocumentDoc | null> {
  if (!isExtractableMime(input.mimeType)) return null;

  const oversize = Number(input.size || 0) > MAX_EXTRACTABLE_BYTES;

  try {
    return await ExtractedDocument.create({
      sourceModule: input.sourceModule,
      sourceId: new mongoose.Types.ObjectId(String(input.sourceId)),
      bookingId: input.bookingId ? new mongoose.Types.ObjectId(String(input.bookingId)) : undefined,
      workspaceId: new mongoose.Types.ObjectId(String(input.workspaceId)),
      attachmentId: input.attachmentId
        ? new mongoose.Types.ObjectId(String(input.attachmentId))
        : undefined,
      attachmentRef: input.attachmentRef,
      originalFilename: input.originalFilename,
      mimeType: input.mimeType,
      size: Number(input.size || 0),
      // Oversize files are parked immediately rather than queued — the worker
      // would only rediscover this after reading the bytes back from S3.
      status: oversize ? "skipped" : "pending",
      // Immediately eligible — the backoff gate exists to space out RETRIES,
      // and must never delay a file's first attempt.
      nextAttemptAt: new Date(),
      skipReason: oversize
        ? `File is ${(Number(input.size) / 1048576).toFixed(1)} MB; extraction is capped at ${(
            MAX_EXTRACTABLE_BYTES / 1048576
          ).toFixed(0)} MB.`
        : undefined,
      docType: hintToDocType(input.typeHint),
    });
  } catch (err: any) {
    // 11000 = duplicate attachmentRef, i.e. already enqueued. Not an error.
    if (err?.code === 11000) {
      return ExtractedDocument.findOne({ attachmentRef: input.attachmentRef });
    }
    throw err;
  }
}

function hintToDocType(hint?: VoucherType): ExtractionDocType {
  return hint === "hotel" ? "hotel" : hint === "flight" ? "flight" : "other";
}

/* ───────────────────────── model-agnostic wrapper ───────────────────────── */

export interface ExtractionResult {
  docType: ExtractionDocType;
  voucher: PlumtripsVoucher;
  rawCandidate: RawCandidate | null;
  modelUsed: string;
  validationErrorCount: number;
}

/**
 * The single call site for the extractor in this engine. Everything that is
 * specific to "we currently use Gemini via extractVoucherViaGemini" lives
 * here; callers see only ExtractionResult.
 *
 * Handles the forced-type trap: extractVoucherViaGemini()'s `voucherType` is
 * not a hint — it overrides the model's own detected_type when normalizing.
 * We extract once with our best guess, then trust the model's detection and
 * re-normalize locally (no second API call) when the two disagree.
 */
export async function extractDocument(opts: {
  buffer: Buffer;
  mimeType: string;
  typeHint?: VoucherType;
}): Promise<ExtractionResult> {
  const hint: VoucherType = opts.typeHint === "hotel" ? "hotel" : "flight";

  const res = await extractVoucherViaGemini({
    buffer: opts.buffer,
    mimeType: opts.mimeType,
    voucherType: hint,
  });

  const rawCandidate: RawCandidate | null = res.raw?.raw_candidate ?? null;
  const detected = rawCandidate?.detected_type;
  const modelUsed = String(res.raw?.model || activeModelName());
  const validationErrorCount = Array.isArray(res.raw?.validation_errors)
    ? res.raw.validation_errors.length
    : 0;

  let voucher = res.parsed;
  let docType: ExtractionDocType =
    detected === "hotel" ? "hotel" : detected === "flight" ? "flight" : "other";

  if (rawCandidate && (detected === "hotel" || detected === "flight") && detected !== hint) {
    // We guessed wrong. The raw candidate carries both blocks, so re-normalize
    // under the model's own verdict instead of keeping a voucher whose typed
    // half was built from the empty branch.
    voucher = normalizeToVoucher({
      raw: rawCandidate,
      forcedType: detected,
      customLogo: voucher.booking_info.custom_logo,
    });
  }

  return { docType, voucher, rawCandidate, modelUsed, validationErrorCount };
}

/* ───────────────────────── flatten -> review table ───────────────────────── */

function firstNonEmpty(...vals: Array<string | null | undefined>): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Flatten a flight voucher into one row per passenger per segment — the shape
 * the ops review table renders. Pure and exported so it can be re-run over a
 * stored extractedJson (e.g. after a deriver fix) without re-calling the model.
 *
 * Degenerate documents still produce rows: passengers with no segments give
 * one row each with empty flight fields, and segments with no named passenger
 * give one row each with an empty passenger. A voucher with neither yields [].
 *
 * Caveat worth knowing when reading a multi-passenger row's `barcode`: the
 * extractor itself backfills its single best-scoring barcode onto EVERY
 * passenger (voucherExtractorGemini.ts pickBestBarcode + the `|| bestBarcode`
 * at the passenger and segment mappers). So on a multi-passenger document the
 * same barcode can legitimately appear on every row — that's upstream shared
 * behaviour the vouchers module depends on, not something this deriver invents.
 */
export function deriveFlightRows(voucher: PlumtripsVoucher): ExtractedFlightRow[] {
  if (voucher?.type !== "flight") return [];

  const segments = Array.isArray(voucher.flight_details?.segments)
    ? voucher.flight_details!.segments
    : [];
  const passengers = Array.isArray(voucher.passengers) ? voucher.passengers : [];

  const pnr = voucher.booking_info?.pnr ?? null;
  const documentBookingRef = voucher.booking_info?.booking_id ?? null;

  if (!segments.length && !passengers.length) return [];

  const rows: ExtractedFlightRow[] = [];
  const paxList = passengers.length ? passengers : [null];
  const segList = segments.length ? segments : [null];

  // Segment ancillaries are per-SEGMENT, not per-passenger. With exactly one
  // traveller they unambiguously belong to them, so the fallback is safe and
  // useful. With several, falling back would attribute one passenger's seat to
  // another — the document simply doesn't say whose it is, and a wrong seat
  // number is worse than a blank the reviewer can fill. Baggage is exempt:
  // a stated allowance is a fare-level rule that does apply to everyone.
  const singlePassenger = passengers.length <= 1;

  paxList.forEach((pax, passengerIndex) => {
    segList.forEach((seg, segmentIndex) => {
      const anc = seg?.ancillaries;
      rows.push({
        passengerIndex,
        segmentIndex,

        passengerName: pax?.name ?? null,
        passengerType: pax?.type ?? null,

        airline: seg?.airline ?? null,
        flightNo: seg?.flight_no ?? null,
        cabinClass: seg?.class ?? null,
        duration: seg?.duration ?? null,

        depAirport: seg?.origin?.code ?? null,
        depCity: seg?.origin?.city ?? null,
        depDate: seg?.origin?.date ?? null,
        depTime: seg?.origin?.time ?? null,
        depTerminal: seg?.origin?.terminal ?? null,

        arrAirport: seg?.destination?.code ?? null,
        arrCity: seg?.destination?.city ?? null,
        arrDate: seg?.destination?.date ?? null,
        arrTime: seg?.destination?.time ?? null,
        arrTerminal: seg?.destination?.terminal ?? null,

        documentBookingRef,
        pnr,
        ticketNo: pax?.ticket_no ?? null,

        // Identity-bearing values: segment fallback only when there's one
        // passenger to attribute them to (see singlePassenger above).
        seat: singlePassenger ? firstNonEmpty(pax?.seat, anc?.seat) : (pax?.seat ?? null),
        meal: singlePassenger ? firstNonEmpty(pax?.meal, anc?.meal) : (pax?.meal ?? null),
        barcode: singlePassenger
          ? firstNonEmpty(pax?.barcode_string, anc?.barcode_string)
          : (pax?.barcode_string ?? null),

        // No source in the extractor's contract — human-entered only.
        checkinStatus: null,

        // Fare-level allowances: fall back for everyone.
        cabinBaggage: firstNonEmpty(pax?.baggage_cabin, anc?.cabin_bag),
        checkinBaggage: firstNonEmpty(pax?.baggage_check_in, anc?.checkin_bag),
      });
    });
  });

  return rows;
}

/* ───────────────────────── worker-side claim + run ───────────────────────── */

export const MAX_EXTRACTION_ATTEMPTS = 3;
/** A row claimed longer ago than this had its process die mid-flight. */
export const STALE_PROCESSING_MS = 10 * 60 * 1000;
/**
 * How long a failed-but-retryable row waits before it may be claimed again.
 * Flat, not exponential: the point is simply to put a sweep boundary between
 * attempts so a brief upstream outage doesn't consume the whole budget. At one
 * minute, the three attempts land on three different sweeps — which is the
 * entire benefit — and a longer or growing delay buys nothing for a queue fed
 * by human upload rate.
 */
export const RETRY_BACKOFF_MS = 60 * 1000;

/**
 * Atomically move one eligible pending row to processing. findOneAndUpdate is a
 * single document-level atomic operation, so two App Runner instances racing on
 * the same queue cannot both win the same row — this, not the worker's
 * in-process guard, is what makes multi-instance safe.
 *
 * `nextAttemptAt` is what makes the retry budget mean something. Without it,
 * the worker's drain loop re-claims a row it just failed within the same tick,
 * so all three attempts are spent in seconds and no transient fault is ever
 * survived. A fresh row is enqueued with nextAttemptAt = now, so this gate
 * costs it nothing: it is claimable on the very next sweep.
 */
export async function claimNextPending(): Promise<ExtractedDocumentDoc | null> {
  return ExtractedDocument.findOneAndUpdate(
    { status: "pending", nextAttemptAt: { $lte: new Date() } },
    { $set: { status: "processing", claimedAt: new Date() }, $inc: { attempts: 1 } },
    { sort: { createdAt: 1 }, new: true },
  );
}

/**
 * Return rows stranded in `processing` (instance crashed, deploy cycled the
 * container) to the queue, or retire them if they're out of attempts. Without
 * this a single crash parks a document forever.
 */
export async function reclaimStaleProcessing(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MS);

  const requeued = await ExtractedDocument.updateMany(
    { status: "processing", claimedAt: { $lt: cutoff }, attempts: { $lt: MAX_EXTRACTION_ATTEMPTS } },
    {
      $set: {
        status: "pending",
        claimedAt: null,
        // Eligible at once: this row has already been stuck for STALE_PROCESSING_MS,
        // which is far longer than the backoff would impose. Setting it is what
        // keeps a reclaimed row from being stranded behind a stale future
        // nextAttemptAt left over from an earlier failure.
        nextAttemptAt: new Date(),
        error: "Reclaimed after a stalled extraction.",
      },
    },
  );

  const retired = await ExtractedDocument.updateMany(
    { status: "processing", claimedAt: { $lt: cutoff }, attempts: { $gte: MAX_EXTRACTION_ATTEMPTS } },
    {
      $set: {
        status: "failed",
        claimedAt: null,
        error: "Stalled after the maximum number of extraction attempts.",
      },
    },
  );

  return (requeued.modifiedCount || 0) + (retired.modifiedCount || 0);
}

/**
 * Run one claimed row end to end and persist the outcome. Never throws — a
 * failure is recorded on the row (requeued while attempts remain, `failed`
 * once exhausted) so one bad document can't stop the sweep.
 */
export async function runExtraction(doc: ExtractedDocumentDoc): Promise<void> {
  try {
    const buffer = await getObjectBuffer(doc.attachmentRef);

    if (buffer.length > MAX_EXTRACTABLE_BYTES) {
      doc.status = "skipped";
      doc.skipReason = `File is ${(buffer.length / 1048576).toFixed(1)} MB; extraction is capped at ${(
        MAX_EXTRACTABLE_BYTES / 1048576
      ).toFixed(0)} MB.`;
      doc.claimedAt = null;
      await doc.save();
      return;
    }

    const result = await extractDocument({
      buffer,
      mimeType: doc.mimeType,
      typeHint: doc.docType === "hotel" ? "hotel" : "flight",
    });

    doc.docType = result.docType;
    doc.extractedJson = result.voucher;
    doc.flightRows = deriveFlightRows(result.voucher);
    doc.modelUsed = result.modelUsed;
    doc.validationErrorCount = result.validationErrorCount;
    doc.status = "extracted";
    doc.error = undefined;
    doc.claimedAt = null;
    await doc.save();

    // Carbon is a derived view over the rows just saved, so it runs AFTER the
    // save and can never affect it: computeCarbonSafely swallows its own
    // failures rather than turning a good extraction into a retry. A document
    // that misses its carbon pass here is picked up by
    // scripts/compute-carbon-records.ts, which is idempotent.
    await computeCarbonSafely(doc, logger);

    logger.info("[DocExtraction] extracted", {
      id: String(doc._id),
      sourceModule: doc.sourceModule,
      docType: doc.docType,
      rows: doc.flightRows.length,
      model: doc.modelUsed,
      validationErrors: doc.validationErrorCount,
    });
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    doc.status = doc.attempts >= MAX_EXTRACTION_ATTEMPTS ? "failed" : "pending";
    doc.error = message;
    doc.claimedAt = null;
    // Hold a requeued row back until the next sweep, so the remaining attempts
    // are spread over time rather than spent in this same drain loop.
    if (doc.status === "pending") doc.nextAttemptAt = new Date(Date.now() + RETRY_BACKOFF_MS);
    await doc.save();

    logger.error("[DocExtraction] extraction failed", {
      id: String(doc._id),
      attempts: doc.attempts,
      status: doc.status,
      error: message,
    });
  }
}
