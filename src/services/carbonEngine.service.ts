// apps/backend/src/services/carbonEngine.service.ts
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Airport from "../models/Airport.js";
import EmissionFactor, {
  type DefraCabin,
  type DefraHaulBand,
  type RfVariant,
} from "../models/EmissionFactor.js";
import CarbonRecord, {
  type CabinResolution,
  type CarbonConfidence,
  type CarbonStatus,
} from "../models/CarbonRecord.js";
import type { ExtractedDocumentDoc, ExtractedFlightRow } from "../models/ExtractedDocument.js";

/**
 * The carbon calculation engine.
 * ---------------------------------------------------------------------------
 * Per flight segment per passenger:
 *
 *   resolve From/To in Airport Master
 *     -> haversine great-circle distance
 *     -> resolve cabin from the document's Class string
 *     -> pick the published DEFRA factor for (haul band, cabin)
 *     -> CO2e = distance x factor x pax
 *
 * ── The one rule this file exists to enforce ──
 *
 * A number is emitted only when every input behind it came from somewhere
 * citable. If either endpoint cannot be resolved to a real airport there is no
 * distance, so there is no CO2e — the record carries nulls and says
 * "insufficient_data" rather than a zero or a guess. Nothing here interpolates,
 * averages across bands, or infers a cabin from an airline's typical fleet.
 *
 * ── Distance: great-circle, with no routing uplift ──
 *
 * Haversine over the two airports' published coordinates. Real aircraft fly
 * further than the great circle (holding, airways, weather), and some
 * methodologies add an uplift for it. We apply NONE, because we could not
 * source DEFRA's 2026 uplift figure from the published set, and a plausible-
 * looking multiplier applied to every row is exactly the kind of invented
 * number this engine must not produce. The consequence is stated rather than
 * hidden: these figures are a floor, and the methodology string on every record
 * says "no routing uplift applied" so nobody has to guess whether one was.
 *
 * ── Cabin: only what the document actually says ──
 *
 * Real extracted values include "Economy, Class L", "Economy", "E", "PR", "QR",
 * "RR", "MR", "FL", "GT". The first two name a cabin. The rest are fare/RBD
 * codes — airline-specific buckets that map to a cabin only via a fare table we
 * do not have. IndiGo's "PR" is almost certainly an economy bucket, but
 * "almost certainly" is not a source, so a bare code is treated as CABIN NOT
 * STATED and priced with DEFRA's Average-passenger factor for the band. That is
 * DEFRA's own documented instruction for an unknown class, and it degrades the
 * row to Medium confidence so the softness is visible rather than absorbed.
 *
 * ── Haul band: DEFRA's published country table, not a distance threshold ──
 *
 * DEFRA's bands are defined relative to the UK by a country->haul list shipped
 * in the conversion-factor workbook, not by a kilometre cut-off we could pick
 * ourselves. So the band is looked up, never computed:
 *   both ends UK/Crown dependency -> "Domestic, to/from UK"
 *   exactly one end UK            -> the other country's published haul
 *   neither end UK                -> "International, to/from non-UK"
 * The last line is the common case for an India-based operator, and it is a
 * published band in its own right — not a fallback we invented for traffic
 * DEFRA did not consider.
 */

/* ───────────────────────── versions ───────────────────────── */

/**
 * The engine's methodology version. BUMP THIS whenever the arithmetic, the
 * cabin mapping, the band rule or the distance method changes. A bump writes
 * NEW CarbonRecords alongside the old ones (the uniqueness key includes it) so
 * previously reported numbers stay reproducible — see models/CarbonRecord.ts.
 */
export const CARBON_CALCULATION_VERSION = "1.0.0";

/**
 * DEFRA publishes both an RF and a non-RF factor for every band/cabin. We
 * default to With RF on DEFRA's own advice that organisations "should include
 * the indirect effects of non-CO2 emissions ... to capture the full climate
 * impact". Changing this default changes every number, so it is a named
 * constant recorded on each record, never an inline string.
 */
export const DEFAULT_RF_VARIANT: RfVariant = "With RF";

/** Mean Earth radius, IUGG. The value used by the haversine below, cited on every record. */
const EARTH_RADIUS_KM = 6371.0088;

/* ───────────────────────── DEFRA haul definition ───────────────────────── */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface HaulDefinitionRow {
  territory: string;
  iso3: string;
  /** DEFRA's own labels in the workbook: "Domestic" | "Short Haul" | "Long Haul". */
  haul: string;
}

/**
 * Country -> haul band as published in the 2026 workbook's "Haul definition"
 * sheet. Loaded once at module load; 215 rows. Read from src/data (which the
 * build copies into dist/) rather than imported, matching how routes/
 * sbt.flights.ts loads airports.json.
 */
const HAUL_DEFINITION: HaulDefinitionRow[] = JSON.parse(
  readFileSync(path.join(__dirname, "../data/carbon/defra-2026-haul-definition.json"), "utf-8"),
);

const HAUL_BY_ISO3 = new Map<string, string>(
  HAUL_DEFINITION.map((r) => [r.iso3.toUpperCase(), r.haul]),
);

/**
 * The territories DEFRA classes as "Domestic" — the UK plus the Crown
 * dependencies. Taken from the same sheet, not hardcoded from memory.
 */
const UK_DOMESTIC_ISO3 = new Set(
  HAUL_DEFINITION.filter((r) => r.haul === "Domestic").map((r) => r.iso3.toUpperCase()),
);

/* ───────────────────────── distance ───────────────────────── */

export interface GeoPoint {
  lat: number;
  lon: number;
}

/**
 * Great-circle distance in kilometres. Haversine is numerically stable for the
 * short segments a domestic sector produces, where the simpler spherical law of
 * cosines loses precision.
 */
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const DISTANCE_METHOD = `Great-circle (haversine), Earth radius ${EARTH_RADIUS_KM} km, no routing uplift applied`;

/* ───────────────────────── cabin mapping ───────────────────────── */

/**
 * Class string -> DEFRA cabin. Matches only on words that NAME a cabin.
 *
 * Order matters: "premium economy" must be tested before "economy", and the
 * word-boundary on `first` stops a fare code like "Economy, Class F" being read
 * as First class.
 *
 * A bare fare/RBD code matches nothing and returns null — deliberately. See the
 * file header for why an airline's typical cabin is not a source.
 */
const CABIN_PATTERNS: { pattern: RegExp; cabin: DefraCabin }[] = [
  { pattern: /premium\s*-?\s*econom/i, cabin: "Premium economy class" },
  { pattern: /\bbusiness\b/i, cabin: "Business class" },
  { pattern: /\bfirst\b/i, cabin: "First class" },
  { pattern: /\becon/i, cabin: "Economy class" },
  { pattern: /\bcoach\b/i, cabin: "Economy class" },
];

/**
 * Returns the cabin the document actually named, or null when it named none.
 * Null is a legitimate, expected outcome — 49 of 80 rows in the first live
 * corpus carry a bare fare code and nothing else.
 */
export function resolveCabin(raw: string | null | undefined): DefraCabin | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  for (const { pattern, cabin } of CABIN_PATTERNS) {
    if (pattern.test(text)) return cabin;
  }
  return null;
}

/* ───────────────────────── haul band ───────────────────────── */

export interface AirportLike {
  iata: string;
  name?: string | null;
  city?: string | null;
  country?: string | null;
  countryIso3?: string | null;
  lat: number;
  lon: number;
}

/**
 * The band, looked up from DEFRA's country table. Returns null only when a
 * UK-touching flight's other endpoint has no country in that table — the 53
 * seeded airports (of 6,071) in territories DEFRA does not list. A flight
 * touching neither the UK nor its Crown dependencies never consults the table
 * and so can never fail here.
 */
export function resolveHaulBand(
  origin: Pick<AirportLike, "countryIso3">,
  destination: Pick<AirportLike, "countryIso3">,
): DefraHaulBand | null {
  const o = (origin.countryIso3 || "").toUpperCase();
  const d = (destination.countryIso3 || "").toUpperCase();

  const originUK = UK_DOMESTIC_ISO3.has(o);
  const destUK = UK_DOMESTIC_ISO3.has(d);

  if (originUK && destUK) return "Domestic, to/from UK";
  if (!originUK && !destUK) return "International, to/from non-UK";

  const otherIso3 = originUK ? d : o;
  const haul = HAUL_BY_ISO3.get(otherIso3);
  if (haul === "Short Haul") return "Short-haul, to/from UK";
  if (haul === "Long Haul") return "Long-haul, to/from UK";
  // A country DEFRA lists as Domestic on the non-UK side is impossible here
  // (both-UK was handled above), so anything else means "not in the table".
  return null;
}

/* ───────────────────────── the calculation ───────────────────────── */

export interface FactorLike {
  _id?: any;
  haulBand: DefraHaulBand;
  cabin: DefraCabin;
  rfVariant: RfVariant;
  value: number;
  unit: string;
  version: string;
  sourceRef: string;
}

export interface SegmentInput {
  /** Raw From token off the ticket; null/unresolvable is an expected case. */
  originCode: string | null;
  destinationCode: string | null;
  /** Airport Master hits, or null when the code resolved to nothing. */
  origin: AirportLike | null;
  destination: AirportLike | null;
  /** The document's Class string, verbatim. */
  cabinInput: string | null;
  /** Active factors for the default RF variant. */
  factors: FactorLike[];
}

export interface SegmentComputation {
  status: CarbonStatus;
  confidence: CarbonConfidence;
  distanceKm: number | null;
  distanceMethod: string | null;
  resolvedCabin: DefraCabin | null;
  cabinResolution: CabinResolution | null;
  haulBand: DefraHaulBand | null;
  factor: FactorLike | null;
  co2eKg: number | null;
  pax: number;
  methodology: string;
  notes: string | null;
}

/** Round for storage only — never for the arithmetic, which runs at full precision. */
const round = (n: number, dp: number) => Number(n.toFixed(dp));

/**
 * Pure: no database, no clock. Everything it needs is passed in, which is what
 * makes the arithmetic testable against hand-computed values.
 */
export function calculateSegment(input: SegmentInput): SegmentComputation {
  const pax = 1; // the grain is one passenger on one segment
  const originCode = (input.originCode || "").toUpperCase() || null;
  const destCode = (input.destinationCode || "").toUpperCase() || null;

  /* 1. Both endpoints must resolve, or there is no number to give. */
  if (!input.origin || !input.destination) {
    const missing = [
      !input.origin ? `origin ${originCode ? `"${originCode}"` : "(blank)"}` : null,
      !input.destination ? `destination ${destCode ? `"${destCode}"` : "(blank)"}` : null,
    ]
      .filter(Boolean)
      .join(" and ");
    return {
      status: "insufficient_data",
      confidence: "insufficient",
      distanceKm: null,
      distanceMethod: null,
      resolvedCabin: null,
      cabinResolution: null,
      haulBand: null,
      factor: null,
      co2eKg: null,
      pax,
      methodology:
        `No CO2e calculated: ${missing} could not be resolved to an airport in the Airport Master. ` +
        `Distance is undefined, so no emission factor was applied and no number is reported.`,
      notes: `Unresolved airport code: ${missing}.`,
    };
  }

  /* 2. Distance. */
  const distanceKm = haversineKm(input.origin, input.destination);

  /* 3. Band. */
  const haulBand = resolveHaulBand(input.origin, input.destination);
  if (!haulBand) {
    return {
      status: "insufficient_data",
      confidence: "insufficient",
      distanceKm: round(distanceKm, 1),
      distanceMethod: DISTANCE_METHOD,
      resolvedCabin: null,
      cabinResolution: null,
      haulBand: null,
      factor: null,
      co2eKg: null,
      pax,
      methodology:
        `No CO2e calculated: this is a UK-touching flight and the other endpoint's country ` +
        `(${input.origin.country || "?"} / ${input.destination.country || "?"}) is not in DEFRA's published ` +
        `haul-definition table, so no haul band — and therefore no factor — can be selected. ` +
        `Great-circle distance is ${round(distanceKm, 1)} km.`,
      notes: "Country absent from the DEFRA haul-definition table.",
    };
  }

  /* 4. Cabin, and the factor that goes with it. */
  const statedCabin = resolveCabin(input.cabinInput);
  const pick = (cabin: DefraCabin) =>
    input.factors.find((f) => f.haulBand === haulBand && f.cabin === cabin) || null;

  let factor: FactorLike | null = null;
  let resolvedCabin: DefraCabin | null = null;
  let cabinResolution: CabinResolution;
  let notes: string | null = null;

  if (statedCabin) {
    factor = pick(statedCabin);
    if (factor) {
      resolvedCabin = statedCabin;
      cabinResolution = "stated";
    } else {
      // DEFRA publishes no factor for this cabin in this band — e.g. there is
      // no UK-domestic business-class factor at all. Fall back to the band's
      // Average passenger factor, as DEFRA instructs for an unknown class.
      factor = pick("Average passenger");
      resolvedCabin = factor ? "Average passenger" : null;
      cabinResolution = "no_published_factor_for_cabin";
      notes =
        `Document states ${statedCabin}, but DEFRA publishes no ${statedCabin} factor for ` +
        `"${haulBand}"; priced with the band's Average passenger factor.`;
    }
  } else {
    factor = pick("Average passenger");
    resolvedCabin = factor ? "Average passenger" : null;
    cabinResolution = "not_stated";
    notes = input.cabinInput
      ? `Class "${input.cabinInput}" is a fare/booking code, not a stated cabin; priced with the band's Average passenger factor.`
      : `No class on the document; priced with the band's Average passenger factor.`;
  }

  /* 5. A missing Average-passenger factor means the library is incomplete for
        this band. That is a seeding fault, not a data fault — say so, and still
        refuse to invent a number. */
  if (!factor) {
    return {
      status: "insufficient_data",
      confidence: "insufficient",
      distanceKm: round(distanceKm, 1),
      distanceMethod: DISTANCE_METHOD,
      resolvedCabin: null,
      cabinResolution,
      haulBand,
      factor: null,
      co2eKg: null,
      pax,
      methodology:
        `No CO2e calculated: no active emission factor found for band "${haulBand}". ` +
        `Great-circle distance is ${round(distanceKm, 1)} km.`,
      notes: "Emission factor library has no active row for this band.",
    };
  }

  /* 6. The number, and the sentence that explains it. */
  const co2eKg = distanceKm * factor.value * pax;

  const methodology =
    `CO2e = ${round(distanceKm, 1)} km x ${factor.value} ${factor.unit} x ${pax} passenger ` +
    `= ${round(co2eKg, 2)} kg CO2e. ` +
    `Distance: ${DISTANCE_METHOD}, ${input.origin.iata} (${input.origin.lat}, ${input.origin.lon}) to ` +
    `${input.destination.iata} (${input.destination.lat}, ${input.destination.lon}). ` +
    `Factor: ${factor.sourceRef} — ${haulBand}, ${factor.cabin}, ${factor.rfVariant} [${factor.version}].` +
    (notes ? ` ${notes}` : "");

  return {
    status: "calculated",
    confidence: cabinResolution === "stated" ? "high" : "medium",
    distanceKm: round(distanceKm, 1),
    distanceMethod: DISTANCE_METHOD,
    resolvedCabin,
    cabinResolution,
    haulBand,
    factor,
    co2eKg: round(co2eKg, 2),
    pax,
    methodology,
    notes,
  };
}

/* ───────────────────────── database-backed pass ───────────────────────── */

/** Load the active factor set once and reuse it across a whole compute pass. */
export async function loadActiveFactors(
  rfVariant: RfVariant = DEFAULT_RF_VARIANT,
): Promise<FactorLike[]> {
  return (await EmissionFactor.find({ mode: "air", status: "active", rfVariant })
    .select("haulBand cabin rfVariant value unit version sourceRef")
    .lean()) as unknown as FactorLike[];
}

/** Resolve a set of IATA codes to Airport Master rows in one query. */
export async function loadAirports(codes: string[]): Promise<Map<string, AirportLike>> {
  const wanted = [...new Set(codes.map((c) => (c || "").trim().toUpperCase()).filter(Boolean))];
  if (!wanted.length) return new Map();
  const rows = await Airport.find({ iata: { $in: wanted } })
    .select("iata name city country countryIso3 lat lon")
    .lean();
  return new Map((rows as any[]).map((a) => [a.iata, a as AirportLike]));
}

export interface DocumentComputeResult {
  documentId: string;
  written: number;
  high: number;
  medium: number;
  insufficient: number;
  skippedNonFlight: boolean;
}

/**
 * Compute and persist every segment of one extracted document.
 *
 * Idempotent: upserts on (document, passenger, segment, calculationVersion), so
 * re-running the pass rewrites the same rows rather than accumulating
 * duplicates, and a version bump writes a parallel generation instead of
 * destroying the previous one.
 *
 * Non-flight documents are skipped rather than given a synthetic zero row — the
 * "mode not yet supported" marker the UI shows is derived from the document's
 * own docType, so no placeholder record is needed to carry it.
 */
export async function computeCarbonForDocument(
  doc: Pick<
    ExtractedDocumentDoc,
    "_id" | "workspaceId" | "bookingId" | "docType" | "flightRows"
  >,
  opts?: { factors?: FactorLike[]; airports?: Map<string, AirportLike> },
): Promise<DocumentComputeResult> {
  const result: DocumentComputeResult = {
    documentId: String(doc._id),
    written: 0,
    high: 0,
    medium: 0,
    insufficient: 0,
    skippedNonFlight: false,
  };

  if (doc.docType !== "flight") {
    result.skippedNonFlight = true;
    return result;
  }

  const rows: ExtractedFlightRow[] = Array.isArray(doc.flightRows) ? doc.flightRows : [];
  if (!rows.length) return result;

  const factors = opts?.factors ?? (await loadActiveFactors());
  const airports =
    opts?.airports ??
    (await loadAirports(rows.flatMap((r) => [r.depAirport || "", r.arrAirport || ""])));

  const calculatedAt = new Date();
  const ops: any[] = [];

  for (const row of rows) {
    const originCode = (row.depAirport || "").trim().toUpperCase() || null;
    const destCode = (row.arrAirport || "").trim().toUpperCase() || null;
    const origin = originCode ? airports.get(originCode) || null : null;
    const destination = destCode ? airports.get(destCode) || null : null;

    const c = calculateSegment({
      originCode,
      destinationCode: destCode,
      origin,
      destination,
      cabinInput: row.cabinClass ?? null,
      factors,
    });

    if (c.confidence === "high") result.high++;
    else if (c.confidence === "medium") result.medium++;
    else result.insufficient++;

    ops.push({
      updateOne: {
        filter: {
          extractedDocumentId: doc._id,
          passengerIndex: row.passengerIndex,
          segmentIndex: row.segmentIndex,
          calculationVersion: CARBON_CALCULATION_VERSION,
        },
        update: {
          $set: {
            workspaceId: doc.workspaceId,
            bookingId: doc.bookingId ?? null,
            mode: "air",
            origin: {
              code: originCode,
              resolved: !!origin,
              name: origin?.name ?? null,
              city: origin?.city ?? null,
              country: origin?.country ?? null,
              countryIso3: origin?.countryIso3 ?? null,
              lat: origin?.lat ?? null,
              lon: origin?.lon ?? null,
            },
            destination: {
              code: destCode,
              resolved: !!destination,
              name: destination?.name ?? null,
              city: destination?.city ?? null,
              country: destination?.country ?? null,
              countryIso3: destination?.countryIso3 ?? null,
              lat: destination?.lat ?? null,
              lon: destination?.lon ?? null,
            },
            distanceKm: c.distanceKm,
            distanceMethod: c.distanceMethod,
            cabinInput: row.cabinClass ?? null,
            resolvedCabin: c.resolvedCabin,
            cabinResolution: c.cabinResolution,
            haulBand: c.haulBand,
            factorId: c.factor?._id ?? null,
            factorValue: c.factor?.value ?? null,
            factorUnit: c.factor?.unit ?? null,
            factorVersion: c.factor?.version ?? null,
            factorSource: c.factor?.sourceRef ?? null,
            rfVariant: c.factor?.rfVariant ?? null,
            pax: c.pax,
            co2eKg: c.co2eKg,
            methodology: c.methodology,
            status: c.status,
            confidence: c.confidence,
            notes: c.notes,
            calculatedAt,
          },
        },
        upsert: true,
      },
    });
  }

  if (ops.length) {
    await CarbonRecord.bulkWrite(ops, { ordered: false });
    result.written = ops.length;
  }
  return result;
}

/**
 * Fire-and-forget wrapper for the extraction worker. A carbon failure must
 * never fail or retry an extraction: the document and its flight rows are
 * already saved and correct, and carbon is a derived view over them that the
 * backfill script can rebuild at any time.
 */
export async function computeCarbonSafely(
  doc: Parameters<typeof computeCarbonForDocument>[0],
  logger?: { error: (msg: string, meta?: any) => void },
): Promise<void> {
  try {
    await computeCarbonForDocument(doc);
  } catch (err: any) {
    logger?.error("[Carbon] compute failed (extraction unaffected)", {
      id: String((doc as any)?._id),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
