// apps/backend/src/scripts/report-wallet-credit-lines.ts
//
// READ-ONLY. Every company's Business Wallet credit line after the migration:
// wallet on/off, old monthly limit, credit limit, used, available, % used, and
// `used` re-derived from the ledger (Σ DEBIT − Σ CREDIT, test rows excluded) —
// "OK" when they agree, "DIFF" when they don't. Nothing is written.
//
//   npx tsx src/scripts/report-wallet-credit-lines.ts --expect-db=<db>
import "dotenv/config";
import mongoose from "mongoose";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { ledgerUsed, walletState } from "../services/sbtWallet.js";

async function main() {
  const expectDb = process.argv.slice(2).find((a) => a.startsWith("--expect-db="))?.split("=")[1];
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri);
  const db = mongoose.connection.name;
  if (!expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (expectDb !== db) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${db}".`);

  const all = (await CustomerWorkspace.find({ sbtOfficialBooking: { $exists: true } })
    .select("companyName customerId sbtOfficialBooking").lean()) as any[];
  let migrated = 0, diffs = 0, unlimitedOn = 0;
  console.log(`db ${db} · companies with a wallet config: ${all.length}\n`);
  console.log(["Company".padEnd(32), "On ", "Monthly(old)".padStart(12), "Limit".padStart(11), "Used".padStart(11),
    "Available".padStart(11), "%".padStart(6), "Ledger used".padStart(12), "Check", "Migrated"].join("  "));
  for (const w of all) {
    const ob = w.sbtOfficialBooking || {};
    const s = walletState(w);
    const l = await ledgerUsed(w._id);
    const ok = Math.abs(l.used - s.used) < 0.01;
    if (ob.creditLineMigratedAt) migrated++;
    if (!ok) diffs++;
    if (ob.enabled && !(s.creditLimit > 0)) unlimitedOn++;
    console.log([
      String(w.companyName || w.customerId || w._id).padEnd(32).slice(0, 32),
      ob.enabled ? "ON " : "off",
      String(ob.monthlyLimit ?? "-").padStart(12),
      String(s.creditLimit).padStart(11),
      String(s.used).padStart(11),
      String(s.available).padStart(11),
      String(s.usagePct).padStart(6),
      String(l.used).padStart(12),
      ok ? "OK   " : "DIFF ",
      ob.creditLineMigratedAt ? new Date(ob.creditLineMigratedAt).toISOString().slice(0, 16) : "NOT MIGRATED",
    ].join("  "));
  }
  console.log(`\nmigrated ${migrated}/${all.length} · used ≠ ledger: ${diffs} · wallet ON with no credit limit: ${unlimitedOn}`);
}

main()
  .catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
