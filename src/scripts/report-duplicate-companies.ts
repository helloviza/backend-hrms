// apps/backend/src/scripts/report-duplicate-companies.ts
//
// READ-ONLY. Likely duplicate companies (services/companyDuplicates.ts): same
// normalised name (Pvt Ltd / Private Limited / Ltd / LLP … variants, case,
// punctuation, spaces), same GSTIN / PAN, or same company email domain. For
// every record in a group: name, GSTIN / PAN, created date, workspace, wallet
// on/off + limit / used, margin override, and counts of linked data (users,
// approval requests, SBT bookings, manual bookings, invoices, credit notes,
// wallet entries). "MAIN" marks the record with the most linked data — a
// suggestion only. Also lists workspaces with no name anywhere.
// Prints to the console and writes a CSV file locally. Nothing in the database
// is written.
//
//   npx tsx src/scripts/report-duplicate-companies.ts --expect-db=<db> [--out=<file.csv>]
import "dotenv/config";
import fs from "node:fs";
import mongoose from "mongoose";
import { collectDuplicateReport, reportCsv } from "../services/companyDuplicates.js";

async function main() {
  const args = process.argv.slice(2);
  const expectDb = args.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
  const out = args.find((a) => a.startsWith("--out="))?.slice(6) || `duplicate-companies-${new Date().toISOString().slice(0, 10)}.csv`;
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  // Read-only: no index builds either.
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.name;
  if (!expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (expectDb !== db) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${db}".`);

  const { rows, unnamed } = await collectDuplicateReport();
  const groups = new Set(rows.map((r) => r.group)).size;
  console.log(`db ${db} · likely duplicate groups: ${groups} · records in them: ${rows.length}\n`);
  let last = 0;
  for (const r of rows) {
    if (r.group !== last) {
      last = r.group;
      console.log(`── Group ${r.group}  (${r.reasons})`);
    }
    const c = r.counts;
    console.log([
      `  ${r.main ? "MAIN" : "    "}`,
      r.name.padEnd(42).slice(0, 42),
      `GSTIN ${r.gstin || "-"}`,
      `PAN ${r.pan || "-"}`,
      `created ${r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : "?"}`,
      `ws ${r.workspaceId || "—"} (${r.workspaceStatus})`,
      `wallet ${r.walletOn ? "ON" : "off"} ${r.creditLimit}/${r.used}`,
      `margin override ${r.marginOverride ? "Y" : "N"}`,
      `users ${c.users} · requests ${c.approvalRequests} · SBT ${c.sbtBookings} · manual ${c.manualBookings} · invoices ${c.invoices} · credit notes ${c.creditNotes} · wallet entries ${c.walletEntries}`,
    ].join(" · "));
  }
  fs.writeFileSync(out, reportCsv(rows));
  console.log(`\nCSV: ${out}`);
  if (unnamed.length) {
    console.log(`\nWorkspaces with no name anywhere (${unnamed.length}) — shown as "Unnamed company":`);
    for (const u of unnamed) console.log(`  ws ${u.workspaceId} · customer ${u.customerId || "-"} · slug ${u.slug || "-"}`);
  } else {
    console.log("\nEvery workspace has a name.");
  }
}

main()
  .catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
