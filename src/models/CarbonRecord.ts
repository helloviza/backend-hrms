// apps/backend/src/models/CarbonRecord.ts
import { Schema, model, type Document, type Types } from "mongoose";
import { DEFRA_HAUL_BANDS, DEFRA_CABINS, RF_VARIANTS } from "./EmissionFactor.js";

/**
 * CarbonRecord — one computed emissions result per flight segment per
 * passenger.
 * ---------------------------------------------------------------------------
 * A SEPARATE COLLECTION, deliberately. It is not a field on
 * ExtractedDocument.flightRows, and that is the whole design:
 *
 *   1. flightRows is documented as a pure re-derivation of `extractedJson` —
 *      "it must never hold anything that can't be re-derived" (see
 *      models/ExtractedDocument.ts). Every successful re-extraction rebuilds
 *      that array from scratch. A CO2e written into it would be silently
 *      destroyed by the next re-run.
 *   2. Carbon results have their own lifecycle. A methodology change or a new
 *      DEFRA publication must produce a NEW result while the old one survives
 *      for audit; extraction has no such requirement.
 *   3. The extraction record is what a supplier's document said. This is what
 *      WE computed from it. Keeping the claim and the derivation in separate
 *      collections is what makes the derivation auditable.
 *
 * ── Never overwritten on a methodology change ──
 *
 * The uniqueness key includes `calculationVersion`. Re-running the SAME engine
 * version over the same segment is idempotent (it upserts the one row). Bumping
 * CARBON_CALCULATION_VERSION writes a second, parallel row and leaves the first
 * untouched, so a number that appeared in a report last quarter can still be
 * reproduced exactly, with the factor and formula it actually used. Nothing in
 * this file ever mutates a record belonging to an older version.
 *
 * Read paths select the engine's current version explicitly rather than "the
 * latest" — an implicit max() would silently change historical reporting the
 * moment a new version is seeded.
 *
 * ── Workspace scoping ──
 *
 * `workspaceId` is copied from the parent ExtractedDocument, which copies it
 * from ManualBooking.workspaceId — i.e. it is a `Customer` id, despite the
 * field name (see routes/admin.extractedDocuments.ts resolveLabels for why).
 * Every tenant-facing read must filter on it. The reference tables this record
 * points at (Airport, EmissionFactor) are deliberately NOT scoped; only the
 * computed output is tenant data.
 *
 * ── Insufficient Data emits no number ──
 *
 * When either endpoint cannot be resolved to an Airport Master row there is no
 * defensible distance, so `distanceKm`, `factorValue` and `co2eKg` stay null
 * and `status` says why. A zero would be a lie that sums and averages
 * downstream; a null cannot be mistaken for a measurement.
 */

export const CARBON_STATUSES = [
  /** A real, sourced number is present. */
  "calculated",
  /** One or both endpoints unresolvable — no number emitted, by design. */
  "insufficient_data",
  /** Non-flight mode (hotel/rail/other): no factor library for it yet. */
  "mode_not_supported",
] as const;
export type CarbonStatus = (typeof CARBON_STATUSES)[number];

export const CARBON_CONFIDENCES = [
  /** Both ends clean IATA, and the cabin the document stated has its own factor. */
  "high",
  /** Both ends clean, but the cabin was unknown or had no published factor. */
  "medium",
  /** No number. Paired with status "insufficient_data" / "mode_not_supported". */
  "insufficient",
] as const;
export type CarbonConfidence = (typeof CARBON_CONFIDENCES)[number];

/** How the cabin used for pricing was arrived at. */
export const CABIN_RESOLUTIONS = [
  /** The document named a cabin and DEFRA publishes a factor for it. */
  "stated",
  /** The document named a cabin but DEFRA publishes no factor for that band. */
  "no_published_factor_for_cabin",
  /** The document gave a bare fare/RBD code or nothing — cabin not stated. */
  "not_stated",
] as const;
export type CabinResolution = (typeof CABIN_RESOLUTIONS)[number];

export interface CarbonEndpoint {
  code: string | null;
  resolved: boolean;
  name?: string | null;
  city?: string | null;
  country?: string | null;
  countryIso3?: string | null;
  lat?: number | null;
  lon?: number | null;
}

export interface CarbonRecordDoc extends Document {
  workspaceId: Types.ObjectId;
  extractedDocumentId: Types.ObjectId;
  bookingId?: Types.ObjectId | null;

  passengerIndex: number;
  segmentIndex: number;

  mode: string;
  calculationVersion: string;

  origin: CarbonEndpoint;
  destination: CarbonEndpoint;

  distanceKm?: number | null;
  distanceMethod?: string | null;

  cabinInput?: string | null;
  resolvedCabin?: string | null;
  cabinResolution?: CabinResolution | null;
  haulBand?: string | null;

  factorId?: Types.ObjectId | null;
  factorValue?: number | null;
  factorUnit?: string | null;
  factorVersion?: string | null;
  factorSource?: string | null;
  rfVariant?: string | null;

  pax: number;
  co2eKg?: number | null;

  /**
   * When the SEGMENT FLEW, parsed from the extracted row's departure date.
   * Null when the document gave no date or gave one too ambiguous to read.
   *
   * Stored rather than joined because every trend query groups by it: joining
   * back to ExtractedDocument.flightRows per query would mean unwinding a
   * subdocument array on every dashboard load to recover a field that never
   * changes once the document is extracted.
   *
   * DISTINCT FROM `calculatedAt`, and the distinction is the point: a trend
   * keyed on calculatedAt would show one enormous spike on the day the backfill
   * ran, which describes our compute schedule and tells you nothing about when
   * anyone travelled.
   */
  travelDate?: Date | null;
  /** "YYYY-MM" of travelDate, for grouping without re-deriving it per query. */
  travelMonth?: string | null;

  /**
   * Operating airline as the document named it, carried for the same reason as
   * travelDate: the by-airline aggregation would otherwise have to $unwind
   * ExtractedDocument.flightRows on every dashboard load to reach it.
   *
   * Null/blank is a real outcome (some screenshots carry no carrier), and the
   * aggregation reports those as "Unattributed" rather than dropping them —
   * a share table whose rows silently vanish cannot be reconciled against the
   * total.
   */
  airline?: string | null;

  /** The exact arithmetic, in words and numbers. Never a template stub. */
  methodology: string;

  status: CarbonStatus;
  confidence: CarbonConfidence;
  /** Why a row degraded or emitted nothing. Empty on a clean High row. */
  notes?: string | null;

  calculatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EndpointSchema = new Schema<CarbonEndpoint>(
  {
    // The raw token off the ticket, uppercased — kept even when it resolves to
    // nothing, because "which code did we fail on" is the first question asked
    // about an Insufficient Data row.
    code: { type: String, default: null },
    resolved: { type: Boolean, required: true, default: false },
    name: { type: String, default: null },
    city: { type: String, default: null },
    country: { type: String, default: null },
    countryIso3: { type: String, default: null },
    // Snapshotted from Airport Master at calculation time, not referenced live:
    // the distance a record reports must stay reproducible even if the airport
    // reference is later re-seeded with corrected coordinates.
    lat: { type: Number, default: null },
    lon: { type: Number, default: null },
  },
  { _id: false },
);

const CarbonRecordSchema = new Schema<CarbonRecordDoc>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    extractedDocumentId: { type: Schema.Types.ObjectId, ref: "ExtractedDocument", required: true, index: true },
    bookingId: { type: Schema.Types.ObjectId, ref: "ManualBooking", default: null },

    // The grain, matching ExtractedDocument.flightRows exactly so the join is
    // an equality on three keys and never a heuristic.
    passengerIndex: { type: Number, required: true },
    segmentIndex: { type: Number, required: true },

    mode: { type: String, required: true, default: "air" },
    calculationVersion: { type: String, required: true, index: true },

    origin: { type: EndpointSchema, required: true },
    destination: { type: EndpointSchema, required: true },

    // Null, never 0, when there is no defensible distance.
    distanceKm: { type: Number, default: null },
    distanceMethod: { type: String, default: null },

    cabinInput: { type: String, default: null },
    resolvedCabin: { type: String, default: null, enum: [...DEFRA_CABINS, null] },
    cabinResolution: { type: String, default: null, enum: [...CABIN_RESOLUTIONS, null] },
    haulBand: { type: String, default: null, enum: [...DEFRA_HAUL_BANDS, null] },

    factorId: { type: Schema.Types.ObjectId, ref: "EmissionFactor", default: null },
    // The factor VALUE is snapshotted, not just referenced, for the same reason
    // the coordinates are: the record has to remain explainable on its own.
    factorValue: { type: Number, default: null },
    factorUnit: { type: String, default: null },
    factorVersion: { type: String, default: null },
    factorSource: { type: String, default: null },
    rfVariant: { type: String, default: null, enum: [...RF_VARIANTS, null] },

    // Always 1: the grain is already one passenger on one segment. It is stored
    // explicitly rather than implied so the methodology string's arithmetic
    // reads as complete, and so a future coarser grain has somewhere to go.
    pax: { type: Number, required: true, default: 1 },
    co2eKg: { type: Number, default: null },

    // Null, never "unknown" or an epoch fallback — an unparseable date must be
    // excludable from a trend, not silently bucketed into 1970.
    travelDate: { type: Date, default: null },
    travelMonth: { type: String, default: null },
    airline: { type: String, default: null },

    methodology: { type: String, required: true },

    status: { type: String, required: true, enum: CARBON_STATUSES },
    confidence: { type: String, required: true, enum: CARBON_CONFIDENCES },
    notes: { type: String, default: null },

    calculatedAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true },
);

// Idempotency AND the never-overwrite rule in one index: same engine version
// over the same segment upserts one row; a new engine version writes a parallel
// row and leaves history intact.
CarbonRecordSchema.index(
  { extractedDocumentId: 1, passengerIndex: 1, segmentIndex: 1, calculationVersion: 1 },
  { unique: true },
);

// The master-page join: current-version records for a page of documents.
CarbonRecordSchema.index({ calculationVersion: 1, extractedDocumentId: 1 });

// Every tenant-facing read is scoped; this is the index behind it.
CarbonRecordSchema.index({ workspaceId: 1, calculationVersion: 1 });

// The dashboard's shape: one tenant (or all), one engine version, bucketed or
// ranged by travel month. Field order matches the $match-then-$group pipeline.
CarbonRecordSchema.index({ calculationVersion: 1, workspaceId: 1, travelMonth: 1 });

export const CarbonRecord = model<CarbonRecordDoc>("CarbonRecord", CarbonRecordSchema);

export default CarbonRecord;
