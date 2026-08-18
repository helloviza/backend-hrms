// apps/backend/src/scripts/compute-carbon-records.ts
import mongoose from "mongoose";
import ExtractedDocument from "../models/ExtractedDocument.js";
import CarbonRecord from "../models/CarbonRecord.js";
import {
  CARBON_CALCULATION_VERSION,
  calculateSegment,
  computeCarbonForDocument,
  loadActiveFactors,
  loadAirports,
} from "../services/carbonEngine.service.js";

/**
 * Compute pass over every already-extracted flight document, writing one
 * CarbonRecord per passenger per segment.
 *
 *   pnpm -C apps/backend tsx src/scripts/compute-carbon-records.ts
 *   ... --dry-run              calculate and report, write nothing
 *   ... --workspace <id>       limit to one workspace
 *   ... --document <id>        limit to one extracted document
 *
 * Safe to re-run: the engine upserts on
 * (document, passenger, segment, calculationVersion), so a second run over
 * unchanged data rewrites the same rows and changes no totals. Bumping
 * CARBON_CALCULATION_VERSION makes this script write a NEW generation of
 * records beside the old ones rather than replacing them.
 *
 * Reads nothing it does not need: only the document-level fields and
 * flightRows, never the extractedJson blob.
 */

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const workspaceId = argValue("--workspace");
  const documentId = argValue("--document");

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri);

  const filter: Record<string, any> = { status: "extracted" };
  if (workspaceId) filter.workspaceId = new mongoose.Types.ObjectId(workspaceId);
  if (documentId) filter._id = new mongoose.Types.ObjectId(documentId);

  console.log(
    `[carbon-compute] db=${mongoose.connection.name} engine=v${CARBON_CALCULATION_VERSION}` +
      `${dryRun ? "  (DRY RUN — no writes)" : ""}`,
  );

  const docs = await ExtractedDocument.find(filter)
    .select("workspaceId bookingId docType flightRows originalFilename")
    .lean();

  const flightDocs = docs.filter((d: any) => d.docType === "flight");
  const otherDocs = docs.filter((d: any) => d.docType !== "flight");
  const totalRows = flightDocs.reduce(
    (n: number, d: any) => n + (Array.isArray(d.flightRows) ? d.flightRows.length : 0),
    0,
  );

  console.log(
    `[carbon-compute] ${docs.length} extracted documents: ` +
      `${flightDocs.length} flight (${totalRows} passenger-segment rows), ` +
      `${otherDocs.length} non-flight (mode not yet supported, no records written)`,
  );

  // Load the factor set and every airport this pass could need up front: two
  // queries for the whole run instead of two per document.
  const factors = await loadActiveFactors();
  console.log(`[carbon-compute] active factors loaded: ${factors.length} (With RF)`);
  if (!factors.length) {
    throw new Error(
      "No active emission factors. Run scripts/seed-carbon-reference.ts before the compute pass.",
    );
  }

  const codes: string[] = [];
  for (const d of flightDocs as any[]) {
    for (const r of d.flightRows || []) codes.push(r.depAirport || "", r.arrAirport || "");
  }
  const airports = await loadAirports(codes);
  console.log(`[carbon-compute] airport codes referenced: ${new Set(codes.filter(Boolean)).size}, resolved: ${airports.size}`);

  const totals = { written: 0, high: 0, medium: 0, insufficient: 0 };

  for (const d of flightDocs as any[]) {
    if (dryRun) {
      // Same engine, same inputs — just not persisted. Counting is done by
      // re-running the pure calculation rather than by predicting it.
      for (const row of d.flightRows || []) {
        const originCode = (row.depAirport || "").trim().toUpperCase() || null;
        const destCode = (row.arrAirport || "").trim().toUpperCase() || null;
        const c = calculateSegment({
          originCode,
          destinationCode: destCode,
          origin: originCode ? airports.get(originCode) || null : null,
          destination: destCode ? airports.get(destCode) || null : null,
          cabinInput: row.cabinClass ?? null,
          factors,
        });
        if (c.confidence === "high") totals.high++;
        else if (c.confidence === "medium") totals.medium++;
        else totals.insufficient++;
      }
      continue;
    }

    const r = await computeCarbonForDocument(d, { factors, airports });
    totals.written += r.written;
    totals.high += r.high;
    totals.medium += r.medium;
    totals.insufficient += r.insufficient;
  }

  const computed = totals.high + totals.medium + totals.insufficient;
  console.log("\n[carbon-compute] ── spread ──");
  console.log(`   High             : ${totals.high}`);
  console.log(`   Medium           : ${totals.medium}`);
  console.log(`   Insufficient Data: ${totals.insufficient}`);
  console.log(`   total rows       : ${computed}${dryRun ? " (nothing written)" : `, written: ${totals.written}`}`);

  if (!dryRun) {
    const stored = await CarbonRecord.countDocuments({
      calculationVersion: CARBON_CALCULATION_VERSION,
    });
    console.log(`   CarbonRecords at v${CARBON_CALCULATION_VERSION}: ${stored}`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("[carbon-compute] FAILED:", err?.message || err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
