// apps/backend/src/scripts/backfill-carbon-travel-fields.ts
import mongoose from "mongoose";
import ExtractedDocument from "../models/ExtractedDocument.js";
import CarbonRecord from "../models/CarbonRecord.js";
import {
  CARBON_CALCULATION_VERSION,
  parseTravelDate,
  travelMonthOf,
} from "../services/carbonEngine.service.js";

/**
 * Backfill `travelDate`, `travelMonth` and `airline` onto CarbonRecords written
 * before those fields existed.
 *
 *   node --env-file=.env --import tsx src/scripts/backfill-carbon-travel-fields.ts
 *   ... --dry-run
 *
 * ── Why this is an in-place update and NOT a new calculation version ──
 *
 * CarbonRecord's contract is that a METHODOLOGY change writes a new record and
 * never edits an old one, so a number already reported stays reproducible.
 * Nothing here touches a number: distance, factor, CO2e, confidence and the
 * methodology string are all untouched. These three fields are descriptive
 * attributes of the segment that were simply not being carried yet — copied
 * verbatim from the ExtractedDocument row the record was already derived from.
 * Bumping the version instead would double the collection and orphan the
 * dashboard's history for no gain.
 *
 * Idempotent: re-running writes the same values. Rows whose date the parser
 * refuses keep travelDate: null, deliberately (see parseTravelDate).
 */

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri);
  console.log(`[carbon-travel] db=${mongoose.connection.name}${dryRun ? "  (DRY RUN — no writes)" : ""}`);

  // The source of truth for both fields: the flight row each record came from.
  const docs = await ExtractedDocument.find({ docType: "flight" })
    .select("flightRows")
    .lean();

  const source = new Map<string, { depDate: string | null; airline: string | null }>();
  for (const d of docs as any[]) {
    for (const f of d.flightRows || []) {
      source.set(`${String(d._id)}|${f.passengerIndex}|${f.segmentIndex}`, {
        depDate: f.depDate ?? null,
        airline: f.airline ?? null,
      });
    }
  }
  console.log(`[carbon-travel] flight rows available as source: ${source.size}`);

  const records = await CarbonRecord.find({ calculationVersion: CARBON_CALCULATION_VERSION })
    .select("extractedDocumentId passengerIndex segmentIndex")
    .lean();
  console.log(`[carbon-travel] carbon records at v${CARBON_CALCULATION_VERSION}: ${records.length}`);

  const ops: any[] = [];
  let dated = 0, undated = 0, noSource = 0, withAirline = 0;

  for (const r of records as any[]) {
    const key = `${String(r.extractedDocumentId)}|${r.passengerIndex}|${r.segmentIndex}`;
    const src = source.get(key);
    if (!src) { noSource++; continue; }

    const travelDate = parseTravelDate(src.depDate);
    const airline = (src.airline ?? "").trim() || null;
    if (travelDate) dated++; else undated++;
    if (airline) withAirline++;

    ops.push({
      updateOne: {
        filter: { _id: r._id },
        update: { $set: { travelDate, travelMonth: travelMonthOf(travelDate), airline } },
      },
    });
  }

  console.log(`[carbon-travel] resolvable travel date : ${dated}`);
  console.log(`[carbon-travel] date refused as unclear: ${undated}`);
  console.log(`[carbon-travel] airline present        : ${withAirline}`);
  if (noSource) console.log(`[carbon-travel] records with no source row: ${noSource}`);

  if (!dryRun && ops.length) {
    await CarbonRecord.bulkWrite(ops, { ordered: false });
    console.log(`[carbon-travel] updated ${ops.length} records`);

    const months = await CarbonRecord.aggregate([
      { $match: { calculationVersion: CARBON_CALCULATION_VERSION, travelMonth: { $ne: null } } },
      { $group: { _id: "$travelMonth", n: { $sum: 1 }, co2e: { $sum: "$co2eKg" } } },
      { $sort: { _id: 1 } },
    ]);
    console.log("\n[carbon-travel] travel months now on record:");
    for (const m of months) console.log(`   ${m._id}  ${String(m.n).padStart(4)} rows  ${m.co2e.toFixed(1)} kg`);
  }

  await mongoose.disconnect();
  console.log("\n[carbon-travel] done.");
}

main().catch(async (err) => {
  console.error("[carbon-travel] FAILED:", err?.message || err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
