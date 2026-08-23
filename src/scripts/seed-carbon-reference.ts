// apps/backend/src/scripts/seed-carbon-reference.ts
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import Airport from "../models/Airport.js";
import EmissionFactor, {
  type DefraCabin,
  type DefraHaulBand,
  type RfVariant,
} from "../models/EmissionFactor.js";

/**
 * Seeds the two carbon REFERENCE tables: Airport Master and the Emission Factor
 * Library. Both are published open data; neither is tenant data.
 *
 *   pnpm -C apps/backend tsx src/scripts/seed-carbon-reference.ts
 *   ... --dry-run     report what would change and write nothing
 *
 * Idempotent and re-runnable: every write is an upsert keyed on the row's
 * natural identity (IATA code; band+cabin+RF+version), so running it twice
 * changes nothing the second time. It never deletes.
 *
 * ── Sources, in full, because a factor without a citation is a rumour ──
 *
 * Airports — OpenFlights `airports.dat`
 *   https://github.com/jpatokal/openflights/blob/master/data/airports.dat
 *   https://openflights.org/data.php  (Open Database Licence)
 *   Filtered to rows with a 3-letter IATA code and usable coordinates:
 *   6,071 of 7,698.
 *
 * Emission factors — UK Government GHG Conversion Factors for Company
 * Reporting 2026 (DESNZ/DEFRA), "Business travel- air"
 *   https://www.gov.uk/government/publications/greenhouse-gas-reporting-conversion-factors-2026
 *   Published 11 June 2026; flat file revised 31 July 2026. The 28 seeded
 *   values were read from the machine-readable flat file and cross-checked cell
 *   for cell against the full set's "Business travel- air" sheet.
 *
 * The JSON under src/data/carbon is the extracted form of those two downloads.
 * It is committed rather than fetched at runtime so a seed run is reproducible
 * and offline, and so the exact bytes behind a published number are in version
 * control alongside the code that used them.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataFile = (name: string) => path.join(__dirname, "../data/carbon", name);
const loadJson = <T>(name: string): T => JSON.parse(readFileSync(dataFile(name), "utf-8")) as T;

/** Identity of the airport dataset, stamped on every row it produces. */
const AIRPORT_SOURCE = "OpenFlights airports.dat";
const AIRPORT_SOURCE_VERSION = "openflights-2026-08-19";

/** Identity of the factor publication. New year -> new version, never an edit. */
const FACTOR_VERSION = "DEFRA-2026-v1";
const FACTOR_SOURCE = "UK Government GHG Conversion Factors for Company Reporting 2026 (DESNZ/DEFRA)";
const FACTOR_SOURCE_REF =
  "DEFRA/DESNZ GHG Conversion Factors 2026, Business travel- air (published 11 Jun 2026, flat file rev. 31 Jul 2026)";
const FACTOR_EFFECTIVE_FROM = new Date("2026-06-11T00:00:00.000Z");

/**
 * Recorded on every factor row. States the unit, the boundary and — because it
 * materially changes the number — which RF variant the row is.
 */
function methodologyFor(rfVariant: RfVariant): string {
  return rfVariant === "With RF"
    ? "kg CO2e per passenger-kilometre, Scope 3 business travel by air. Includes the indirect climate effects of non-CO2 aviation emissions (radiative forcing: contrails, water vapour, NOx), which DEFRA applies as a 70% uplift to the CO2 component. DEFRA advises organisations to include these effects to capture the full climate impact, while noting significant scientific uncertainty in their magnitude."
    : "kg CO2e per passenger-kilometre, Scope 3 business travel by air. Direct effects only (CO2, CH4, N2O); excludes the indirect climate effects of non-CO2 aviation emissions.";
}

interface AirportSeedRow {
  iata: string;
  icao: string | null;
  name: string | null;
  city: string | null;
  country: string | null;
  countryIso3: string | null;
  lat: number;
  lon: number;
  timezone: string | null;
}

interface FactorSeedRow {
  defraId: string;
  scope: string;
  activity: string;
  haulLabel: DefraHaulBand;
  classLabel: DefraCabin;
  rfVariant: RfVariant;
  unit: string;
  value: number;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");

  await mongoose.connect(uri);
  console.log(`[seed-carbon] db=${mongoose.connection.name}${dryRun ? "  (DRY RUN — no writes)" : ""}`);

  /* ── Airport Master ── */
  const airports = loadJson<AirportSeedRow[]>("openflights-airports.json");
  const withIso3 = airports.filter((a) => a.countryIso3).length;
  console.log(
    `[seed-carbon] airports in seed file: ${airports.length} ` +
      `(${withIso3} with a DEFRA country match, ${airports.length - withIso3} without)`,
  );

  const beforeAirports = await Airport.countDocuments({});
  if (!dryRun) {
    // Batched so one 6,071-op bulkWrite doesn't hold a single huge request open.
    const BATCH = 1000;
    for (let i = 0; i < airports.length; i += BATCH) {
      const slice = airports.slice(i, i + BATCH);
      await Airport.bulkWrite(
        slice.map((a) => ({
          updateOne: {
            filter: { iata: a.iata },
            update: {
              $set: {
                icao: a.icao,
                name: a.name,
                city: a.city,
                country: a.country,
                countryIso3: a.countryIso3,
                lat: a.lat,
                lon: a.lon,
                timezone: a.timezone,
                source: AIRPORT_SOURCE,
                sourceVersion: AIRPORT_SOURCE_VERSION,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
      process.stdout.write(`\r[seed-carbon] airports upserted: ${Math.min(i + BATCH, airports.length)}/${airports.length}`);
    }
    process.stdout.write("\n");
  }
  const afterAirports = dryRun ? beforeAirports : await Airport.countDocuments({});
  console.log(`[seed-carbon] Airport collection: ${beforeAirports} -> ${afterAirports}`);

  /* ── Emission Factor Library ── */
  const factors = loadJson<FactorSeedRow[]>("defra-2026-air-factors.json");
  console.log(`[seed-carbon] factors in seed file: ${factors.length}`);

  // Every value must be a real published number. A zero or a NaN here means the
  // extraction from the workbook went wrong, and seeding it would put an
  // invented figure into the library — refuse the whole run instead.
  const bad = factors.filter((f) => !Number.isFinite(f.value) || f.value <= 0);
  if (bad.length) {
    throw new Error(
      `Refusing to seed: ${bad.length} factor row(s) have no usable published value ` +
        `(${bad.map((b) => `${b.haulLabel}/${b.classLabel}/${b.rfVariant}`).join(", ")})`,
    );
  }

  const beforeFactors = await EmissionFactor.countDocuments({});
  if (!dryRun) {
    await EmissionFactor.bulkWrite(
      factors.map((f) => ({
        updateOne: {
          filter: {
            mode: "air",
            haulBand: f.haulLabel,
            cabin: f.classLabel,
            rfVariant: f.rfVariant,
            version: FACTOR_VERSION,
          },
          update: {
            $set: {
              activity: f.activity,
              value: f.value,
              unit: `kg CO2e/${f.unit}`,
              source: FACTOR_SOURCE,
              sourceRef: FACTOR_SOURCE_REF,
              sourceId: f.defraId,
              methodology: methodologyFor(f.rfVariant),
              effectiveFrom: FACTOR_EFFECTIVE_FROM,
              status: "active",
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }
  const afterFactors = dryRun ? beforeFactors : await EmissionFactor.countDocuments({});
  console.log(`[seed-carbon] EmissionFactor collection: ${beforeFactors} -> ${afterFactors}`);

  /* ── What the library does and does not cover ── */
  console.log("\n[seed-carbon] coverage of the seeded factor library (With RF):");
  const bands: DefraHaulBand[] = [
    "Domestic, to/from UK",
    "Short-haul, to/from UK",
    "Long-haul, to/from UK",
    "International, to/from non-UK",
  ];
  const cabins: DefraCabin[] = [
    "Average passenger",
    "Economy class",
    "Premium economy class",
    "Business class",
    "First class",
  ];
  for (const band of bands) {
    const cells = cabins.map((c) => {
      const hit = factors.find(
        (f) => f.haulLabel === band && f.classLabel === c && f.rfVariant === "With RF",
      );
      return `${c.replace(" class", "").replace(" passenger", "")}=${hit ? hit.value : "—"}`;
    });
    console.log(`   ${band.padEnd(30)} ${cells.join("  ")}`);
  }
  console.log(
    "   (— means DEFRA publishes no factor for that band/cabin. The engine falls back to\n" +
      "    that band's Average passenger factor and degrades the row to Medium confidence.)",
  );

  await mongoose.disconnect();
  console.log("\n[seed-carbon] done.");
}

main().catch(async (err) => {
  console.error("[seed-carbon] FAILED:", err?.message || err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
