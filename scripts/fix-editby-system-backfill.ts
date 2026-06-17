/**
 * Cleanup: editHistory[].editedBy stored as the BSON string "system:backfill".
 *
 * The combined-date and BUNDLEOJOY-GSTIN backfills wrote editedBy="system:backfill"
 * via raw collection.updateOne, bypassing schema casting. Invoice.editHistory.editedBy
 * is typed ObjectId (ref User, OPTIONAL), so any later Mongoose edit/save of these
 * invoices now throws "Cast to ObjectId failed for value system:backfill".
 *
 * FIX (editedBy is OPTIONAL): $unset editedBy on the string-typed entries ONLY.
 * arrayFilters target only entries where editedBy is a string, so editedAt /
 * fieldsChanged / oldValues / newValues / reason are all preserved, and no other
 * invoice/entry is touched. Idempotent: once cleaned, the filter matches nothing.
 *
 * USAGE
 *   tsx scripts/fix-editby-system-backfill.ts          # DRY (default): plan + backup, NO writes
 *   tsx scripts/fix-editby-system-backfill.ts --apply  # APPLY: $unset on string-typed entries
 */

import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { connectDb } from "../src/config/db.js";
import Invoice from "../src/models/Invoice.js";

const APPLY = process.argv.includes("--apply");
const BAD = "system:backfill";

// The 8 invoices we backfilled this session (scope guard — fail closed).
const EXPECTED = [
  "INV-20260072", "INV-20260075", "INV-20260118", "INV-20260171", "INV-20260179", // GSTIN
  "INV-20260077", "INV-20260164", "INV-20260205",                                  // combined date
].sort();

async function main() {
  await connectDb();
  console.log(`\n=== fix-editby-system-backfill  [${APPLY ? "APPLY" : "DRY-RUN"}] ===\n`);

  // Find every invoice with a string-typed editedBy anywhere in editHistory.
  const docs = await Invoice.find({ "editHistory.editedBy": { $type: "string" } })
    .select("invoiceNo status editHistory")
    .lean<any[]>();

  const found = docs.map((d) => d.invoiceNo).sort();
  console.log(`Invoices with string-typed editedBy: ${found.length}`);
  console.log(`  ${found.join(", ") || "(none)"}\n`);

  // Scope guard: must be exactly the 8 we backfilled.
  const extra = found.filter((n) => !EXPECTED.includes(n));
  const missing = EXPECTED.filter((n) => !found.includes(n));
  if (extra.length || missing.length) {
    console.error("!! SCOPE GUARD: found set != the 8 backfilled invoices.");
    if (extra.length) console.error("   Unexpected extra:", extra.join(", "));
    if (missing.length) console.error("   Expected but absent (already clean?):", missing.join(", "));
    console.error("   ABORTING — review before any write.");
    await mongoose.disconnect();
    process.exit(2);
  }
  console.log(`Scope guard OK — exactly the 8 backfilled invoices.\n`);

  // Backup each affected invoice's FULL editHistory (read-only capture).
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.resolve(process.cwd(), `editby-fix-backup-${ts}.json`);
  fs.writeFileSync(
    backupPath,
    JSON.stringify(
      docs.map((d) => ({ _id: String(d._id), invoiceNo: d.invoiceNo, status: d.status, editHistory: d.editHistory })),
      null, 2,
    ),
    "utf8",
  );
  console.log(`Backup written: ${backupPath}\n`);

  // Dry plan — per invoice/entry.
  let totalBad = 0;
  console.log("Planned cleanup ($unset editedBy on string-typed entries only):");
  for (const d of docs) {
    const badIdx: number[] = [];
    (d.editHistory || []).forEach((e: any, i: number) => { if (typeof e.editedBy === "string" && e.editedBy === BAD) badIdx.push(i); });
    totalBad += badIdx.length;
    console.log(`  ${d.invoiceNo} [${d.status}]: ${(d.editHistory || []).length} entries, unset editedBy at idx [${badIdx.join(", ")}] (preserve editedAt/fieldsChanged/oldValues/newValues/reason)`);
  }
  console.log(`\n  Op per invoice:`);
  console.log(`    Invoice.collection.updateOne(`);
  console.log(`      { _id },`);
  console.log(`      { $unset: { "editHistory.$[e].editedBy": "" } },`);
  console.log(`      { arrayFilters: [ { "e.editedBy": { $type: "string" } } ] },`);
  console.log(`    )`);
  console.log(`\n  Total: ${docs.length} invoices, ${totalBad} entries to clean.`);

  if (!APPLY) {
    console.log(`\nDRY-RUN: nothing written to the DB. Backup captured. Re-run with --apply to clean.\n`);
    await mongoose.disconnect();
    process.exit(0);
  }

  // APPLY — sequential; touches ONLY editedBy on string-typed entries.
  console.log(`\n!! APPLY MODE — unsetting editedBy on string-typed entries.\n`);
  const done: string[] = [];
  try {
    for (const d of docs) {
      const r = await Invoice.collection.updateOne(
        { _id: d._id },
        { $unset: { "editHistory.$[e].editedBy": "" } },
        { arrayFilters: [{ "e.editedBy": { $type: "string" } }] },
      );
      console.log(`  ${d.invoiceNo}: matched=${r.matchedCount} modified=${r.modifiedCount}`);
      done.push(d.invoiceNo);
    }
    console.log(`\nDONE. Cleaned: ${done.join(", ")}`);
  } catch (err: any) {
    console.error(`\n!! FAILURE: ${err?.message}`);
    console.error(`   Succeeded: ${done.join(", ") || "(none)"}`);
    console.error(`   Restore from backup: ${backupPath}`);
    await mongoose.disconnect();
    process.exit(5);
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("FATAL:", err?.message || err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
