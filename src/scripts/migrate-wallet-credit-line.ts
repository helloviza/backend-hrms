// apps/backend/src/scripts/migrate-wallet-credit-line.ts
//
// Business Wallet: monthly limit → CREDIT LINE (services/sbtWallet.ts).
// For every company with a wallet config:
//   creditLimit = old monthlyLimit   (0 stays 0: the old "0 = unlimited" ends —
//                                     such companies can't book by wallet until a
//                                     limit is set on the Business Wallets page)
//   used        = Σ DEBIT − Σ CREDIT of its non-test SBTWalletLedger rows
//   usageAlertSent = already ≥80% used (no email for the migration itself)
// and stamps creditLineMigratedAt. Run right after the backend deploy: until a
// company is migrated it has no credit limit, so its wallet bookings are
// refused (fail-safe), and any refund in between is folded in by the recompute.
//
// Dry run by default. Idempotent: migrated companies are skipped unless
// --recompute-used (re-derives `used` from the ledger; the limit is kept).
//   --expect-db=<name>   must equal the connected database
//   --apply              write
//
//   npx tsx src/scripts/migrate-wallet-credit-line.ts --expect-db=<db>
//   npx tsx src/scripts/migrate-wallet-credit-line.ts --expect-db=<db> --apply
import "dotenv/config";
import mongoose from "mongoose";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { creditLineFromLegacy, ledgerUsed } from "../services/sbtWallet.js";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const recompute = args.includes("--recompute-used");
  const expectDb = args.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri);
  const db = mongoose.connection.name;
  if (!expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (expectDb !== db) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${db}".`);

  const all = (await CustomerWorkspace.find({ sbtOfficialBooking: { $exists: true } })
    .select("companyName customerId sbtOfficialBooking").lean()) as any[];
  console.log(`${apply ? "APPLY" : "DRY RUN"} · db ${db} · companies with a wallet config: ${all.length}`);
  let written = 0, skipped = 0;
  const blocked: string[] = [];
  for (const w of all) {
    const ob = w.sbtOfficialBooking || {};
    const name = String(w.companyName || w.customerId || w._id);
    if (ob.creditLineMigratedAt && !recompute) { skipped++; continue; }
    const sums = await ledgerUsed(w._id);
    const next = creditLineFromLegacy(ob, sums.used);
    const limit = ob.creditLineMigratedAt ? Number(ob.creditLimit) || 0 : next.creditLimit;
    const line = [
      name.padEnd(32).slice(0, 32),
      `wallet ${ob.enabled ? "ON " : "off"}`,
      `monthly ${String(ob.monthlyLimit ?? "-").padStart(9)}`,
      `→ limit ${String(limit).padStart(9)}`,
      `used ${String(next.used).padStart(9)} (debits ${sums.debits}, credits ${sums.credits}, test rows excluded ${sums.testRows})`,
      `available ${limit - next.used}`,
      next.wasUnlimited && !ob.creditLineMigratedAt ? "  ⚠ WAS UNLIMITED (0) — set a limit" : "",
      next.usageAlertSent ? "  ≥80%" : "",
    ].join(" · ");
    console.log(line);
    if (next.wasUnlimited && !ob.creditLineMigratedAt) blocked.push(name);
    if (!apply) continue;
    const set: Record<string, unknown> = {
      "sbtOfficialBooking.used": next.used,
      "sbtOfficialBooking.usageAlertSent": limit > 0 && next.used >= limit * 0.8,
      "sbtOfficialBooking.creditLineMigratedAt": ob.creditLineMigratedAt || new Date(),
    };
    if (!ob.creditLineMigratedAt) set["sbtOfficialBooking.creditLimit"] = next.creditLimit;
    await CustomerWorkspace.updateOne({ _id: w._id }, { $set: set }, { runValidators: false });
    written++;
  }
  console.log(`\n${apply ? "Written" : "Would write"}: ${apply ? written : all.length - skipped} · already migrated (skipped): ${skipped}`);
  if (blocked.length) console.log(`Wallet ON with no limit (were unlimited): ${blocked.join(", ")}`);
  if (!apply) console.log("Dry run — re-run with --apply to write.");
}

main()
  .catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
