// apps/backend/src/models/EmissionFactor.ts
import { Schema, model, type Document } from "mongoose";

/**
 * Emission Factor Library — the published conversion factors the carbon engine
 * multiplies distance by. One row per (mode, haul band, cabin, RF variant,
 * version).
 * ---------------------------------------------------------------------------
 * Seeded from the UK Government GHG Conversion Factors for Company Reporting
 * 2026 (DESNZ/DEFRA), "Business travel- air", published 11 June 2026, flat file
 * revised 31 July 2026:
 *   https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2026
 * Values were read out of the machine-readable flat file and cross-checked cell
 * for cell against the "Business travel- air" sheet of the full set — two
 * independent renderings of the same publication agreeing exactly.
 *
 * ── NOTHING IN THIS COLLECTION IS DERIVED, INTERPOLATED OR ESTIMATED ──
 *
 * Every `value` is a number DEFRA published. Where DEFRA publishes no factor,
 * this library HAS NO ROW — it does not fill the gap. Those gaps are real and
 * load-bearing:
 *   - "Domestic, to/from UK" has an Average-passenger factor ONLY. There is no
 *     published UK-domestic economy/business/first factor.
 *   - "Short-haul, to/from UK" has Average, Economy and Business only — no
 *     premium economy, no first.
 *   - "Long-haul, to/from UK" and "International, to/from non-UK" carry all
 *     five (Average, Economy, Premium economy, Business, First).
 * A domestic business-class segment therefore CANNOT be priced at a domestic
 * business-class rate, because no such published rate exists. The engine falls
 * back to the Average-passenger factor for that band and drops the row's
 * confidence to Medium. That fallback is DEFRA's own documented instruction —
 * "Where the 'haul' of the journey is known, but the class is unknown, the
 * company uses the 'average passenger' factor" (2026 full set, Business travel-
 * air, guidance) — not an invention of ours.
 *
 * ── RF variant ──
 *
 * DEFRA publishes each factor twice: `With RF` includes the indirect climate
 * effects of non-CO2 aviation emissions (contrails, water vapour, NOx), `Without
 * RF` covers direct effects only. Both are seeded because both are published.
 * The engine defaults to `With RF` on DEFRA's own advice: "Organisations should
 * include the indirect effects of non-CO2 emissions when reporting air travel
 * emissions to capture the full climate impact of their travel." DEFRA also
 * notes significant scientific uncertainty in the magnitude of that indirect
 * effect, which is why the variant is recorded on every CarbonRecord rather
 * than being an invisible constant.
 *
 * NOT WORKSPACE-SCOPED — a published national conversion factor is not a
 * tenant's private fact. Only the computed CarbonRecord is tenant data.
 *
 * ── Versioning ──
 *
 * `version` is the publication identity (e.g. "DEFRA-2026-v1"), NOT a row
 * revision. Next year's set is seeded as new rows under a new version and the
 * old ones are marked `superseded`; they are never edited in place, because
 * CarbonRecords already written point at them and must stay explainable. The
 * engine reads `status: "active"` only.
 */

export const EMISSION_FACTOR_STATUSES = ["active", "superseded"] as const;
export type EmissionFactorStatus = (typeof EMISSION_FACTOR_STATUSES)[number];

/** The four haul bands exactly as DEFRA labels them. Not re-worded. */
export const DEFRA_HAUL_BANDS = [
  "Domestic, to/from UK",
  "Short-haul, to/from UK",
  "Long-haul, to/from UK",
  "International, to/from non-UK",
] as const;
export type DefraHaulBand = (typeof DEFRA_HAUL_BANDS)[number];

/** The five cabin labels exactly as DEFRA labels them. Not re-worded. */
export const DEFRA_CABINS = [
  "Average passenger",
  "Economy class",
  "Premium economy class",
  "Business class",
  "First class",
] as const;
export type DefraCabin = (typeof DEFRA_CABINS)[number];

export const RF_VARIANTS = ["With RF", "Without RF"] as const;
export type RfVariant = (typeof RF_VARIANTS)[number];

export interface EmissionFactorDoc extends Document {
  mode: string;
  activity: string;

  haulBand: DefraHaulBand;
  cabin: DefraCabin;
  rfVariant: RfVariant;

  value: number;
  unit: string;

  source: string;
  sourceRef: string;
  sourceId: string;
  methodology: string;

  version: string;
  effectiveFrom: Date;
  status: EmissionFactorStatus;

  createdAt: Date;
  updatedAt: Date;
}

const EmissionFactorSchema = new Schema<EmissionFactorDoc>(
  {
    // "air" today. The field exists so rail/hotel/road factors can join the
    // same library later without a second collection — CarbonRecord already
    // records the mode it priced.
    mode: { type: String, required: true, default: "air", index: true },
    activity: { type: String, required: true, default: "Flights" },

    haulBand: { type: String, required: true, enum: DEFRA_HAUL_BANDS },
    cabin: { type: String, required: true, enum: DEFRA_CABINS },
    rfVariant: { type: String, required: true, enum: RF_VARIANTS },

    // kg CO2e per passenger.km, as published. Never rounded on the way in.
    value: { type: Number, required: true },
    unit: { type: String, required: true, default: "kg CO2e/passenger.km" },

    source: { type: String, required: true },
    /** Human-readable citation, carried onto every record this factor prices. */
    sourceRef: { type: String, required: true },
    /** DEFRA's own row id from the flat file, e.g. "21_316_3180_11_1". */
    sourceId: { type: String, required: true },
    methodology: { type: String, required: true },

    version: { type: String, required: true, index: true },
    effectiveFrom: { type: Date, required: true },
    status: { type: String, required: true, enum: EMISSION_FACTOR_STATUSES, default: "active" },
  },
  { timestamps: true },
);

// The identity of a factor. Re-seeding the same publication updates in place
// instead of duplicating; a new publication is a new `version` and so a new row.
EmissionFactorSchema.index(
  { mode: 1, haulBand: 1, cabin: 1, rfVariant: 1, version: 1 },
  { unique: true },
);

// The engine's lookup: active factors for one mode, band and RF variant.
EmissionFactorSchema.index({ mode: 1, status: 1, rfVariant: 1, haulBand: 1, cabin: 1 });

export const EmissionFactor = model<EmissionFactorDoc>("EmissionFactor", EmissionFactorSchema);

export default EmissionFactor;
