/**
 * Loyalty Points — reconcile / backfill (services/loyalty.ts).
 *
 * Creates the missing loyalty account for every customer that has a counted
 * invoice (SENT / PAYMENT_DECLARED / PAID, not demo, not HOUSE/D2C), then
 * reconciles every account: each invoice's target points per bucket are
 * compared with its ledger and only the difference is appended. Safe to run
 * any number of times — a second run writes nothing.
 *
 * USAGE
 *   node --env-file=.env.development --import tsx scripts/loyalty-reconcile.ts --dry-run
 *   node --env-file=.env.development --import tsx scripts/loyalty-reconcile.ts
 *   node --env-file=.env.development --import tsx scripts/loyalty-reconcile.ts --account=<accountId> [--dry-run]
 *
 *   --dry-run         print each account's differences; write NOTHING
 *                     (missing accounts are planned as "(new)", not created)
 *   --account=<id>    only this account (no missing-account creation)
 */
import mongoose from "mongoose";
import { connectDb } from "../src/config/db.js";
import LoyaltyAccount from "../src/models/LoyaltyAccount.js";
import Customer from "../src/models/Customer.js";
import {
  getLoyaltySettings, planAccount, reconcileAccount, customersMissingAccounts, ensureAccountForCustomer,
  type AccountPlan,
} from "../src/services/loyalty.js";

const DRY = process.argv.includes("--dry-run");
const ONLY = process.argv.find((a) => a.startsWith("--account="))?.slice("--account=".length) || "";
const ACTOR = "script:loyalty-reconcile";

const inr = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;

function printPlan(label: string, plan: AccountPlan, threshold: number): void {
  const earning = plan.invoices.filter((i) => i.earns).length;
  const counted = plan.invoices.filter((i) => i.counted).length;
  const elig = plan.eligibleAt ? `eligible${plan.becameEligible ? " (NOW)" : ""}` : `not eligible (needs ${inr(threshold)})`;
  console.log(`\n■ ${label}`);
  console.log(`  invoices ${plan.invoices.length} · counted ${counted} · earning ${earning} · cumulative ${inr(plan.cumulativeInr)} · ${elig}`);
  const why = new Map<string, number>();
  for (const i of plan.invoices) if (i.counted && !i.earns && i.why) why.set(i.why, (why.get(i.why) ?? 0) + 1);
  for (const [w, n] of why) console.log(`  not earning: ${n} × ${w}`);
  if (!plan.deltas.length) { console.log("  no differences"); return; }
  for (const d of plan.deltas) {
    console.log(`  ${d.points > 0 ? "+" : ""}${d.points} ${d.bucket.padEnd(10)} ${d.reason.padEnd(18)} ${d.invoiceNo ?? d.invoiceId ?? "manual points"}${d.snapshot ? ` (${d.snapshot.status}, base ${inr(d.snapshot.earnBase)})` : ""}`);
  }
}

async function main() {
  // A dry run writes NOTHING — not even the indexes Mongoose would build for
  // the new loyalty collections on connect.
  if (DRY) { mongoose.set("autoIndex", false); mongoose.set("autoCreate", false); }
  await connectDb();
  const db = mongoose.connection.db!;
  console.log(`[loyalty-reconcile] db=${db.databaseName} mode=${DRY ? "DRY-RUN (no writes)" : "APPLY"}${ONLY ? ` account=${ONLY}` : ""}`);
  const settings = await getLoyaltySettings({ create: !DRY });
  console.log(`  settings: programmeEnabled=${settings.programmeEnabled} launchDate=${new Date(settings.launchDate).toISOString()} rates=${settings.rateHistory.map((r) => `${r.pointsPer100}/₹100 from ${new Date(r.effectiveFrom).toISOString()}`).join("; ")} threshold=${inr(settings.thresholdInr)} enrolBusinessesOnly=${settings.enrolBusinessesOnly}`);
  if (!settings.programmeEnabled && !DRY) {
    console.log("  programme is disabled (kill switch) — nothing written.");
    return;
  }

  const totals = { accounts: 0, created: 0, rows: 0, points: 0, skipped: 0 };

  if (!ONLY) {
    const missing = await customersMissingAccounts();
    console.log(`  customers with counted invoices but no account: ${missing.length}`);
    for (const c of missing) {
      if (DRY) {
        const cust: any = mongoose.Types.ObjectId.isValid(c)
          ? await Customer.collection.findOne({ _id: new mongoose.Types.ObjectId(c) }, { projection: { legalName: 1, companyName: 1, name: 1 } })
          : null;
        const plan = await planAccount({ _id: new mongoose.Types.ObjectId(), memberCustomerIds: [c] }, settings);
        printPlan(`(new) ${cust?.legalName || cust?.companyName || cust?.name || c} [customer ${c}]`, plan, settings.thresholdInr);
        totals.accounts += 1; totals.created += 1; totals.rows += plan.deltas.length;
        totals.points += plan.deltas.reduce((s, d) => s + d.points, 0);
      } else if (await ensureAccountForCustomer(c, ACTOR)) {
        totals.created += 1;
      }
    }
  }

  const accounts: any[] = ONLY
    ? await LoyaltyAccount.find({ _id: ONLY }).lean()
    : await LoyaltyAccount.find({}).sort({ name: 1 }).lean();
  if (ONLY && !accounts.length) throw new Error(`No loyalty account ${ONLY}`);

  for (const a of accounts) {
    totals.accounts += 1;
    if (DRY) {
      const plan = await planAccount(a, settings);
      printPlan(`${a.name} [account ${a._id}] members=${a.memberCustomerIds.length}`, plan, settings.thresholdInr);
      totals.rows += plan.deltas.length;
      totals.points += plan.deltas.reduce((s, d) => s + d.points, 0);
    } else {
      const r = await reconcileAccount(a._id, { actor: ACTOR, settings });
      if (r.skipped) { totals.skipped += 1; console.log(`  ${a.name}: skipped (${r.skipped})`); continue; }
      totals.rows += r.rowsWritten;
      console.log(`  ${a.name}: ${r.rowsWritten} row(s), cumulative ${inr(r.cumulativeInr)}, balances on-the-way ${r.balances.onTheWay} / locked ${r.balances.locked} / ready ${r.balances.ready}${r.conflicts ? `, ${r.conflicts} conflict(s)` : ""}`);
    }
  }

  console.log(
    `\n[loyalty-reconcile] ${DRY ? "WOULD write" : "wrote"} ${totals.rows} ledger row(s)` +
      (DRY ? ` (net ${totals.points} points)` : "") +
      ` across ${totals.accounts} account(s); ${DRY ? "would create" : "created"} ${totals.created} account(s)` +
      (totals.skipped ? `; ${totals.skipped} skipped` : ""),
  );
}

main()
  .then(() => mongoose.disconnect())
  .catch(async (err) => {
    console.error("[loyalty-reconcile] FAILED:", err?.message || err);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
