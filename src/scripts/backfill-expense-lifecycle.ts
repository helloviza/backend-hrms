/**
 * backfill-expense-lifecycle.ts
 *
 * Migrates the expense status taxonomy to:
 *   pending_to_submit → awaiting_approval → (approved · declined ·
 *   clarification_required) → reimbursed
 *
 * Renames existing values in place (idempotent):
 *   Expense.lifecycleStatus:
 *     (missing)   → pending_to_submit   (legacy / WhatsApp rows predate the field)
 *     unreported  → pending_to_submit
 *     in_report   → pending_to_submit   (told apart from loose by reportId)
 *     rejected    → declined
 *   Report.status:
 *     rejected    → declined
 * (awaiting_approval / approved / reimbursed / draft / submitted unchanged.)
 *
 *   DRY RUN (default):  pnpm -C apps/backend tsx src/scripts/backfill-expense-lifecycle.ts
 *   COMMIT  (writes):   ... backfill-expense-lifecycle.ts --commit
 *
 * Idempotent: re-running after a commit is a no-op (no rows match the old values).
 */
import "dotenv/config";
import mongoose from "mongoose";

const COMMIT = process.argv.includes("--commit");

// from → to. Order doesn't matter; each is a disjoint $set on the matched set.
const EXPENSE_RENAMES: { from: any; to: string }[] = [
  { from: { lifecycleStatus: { $exists: false } }, to: "pending_to_submit" },
  { from: { lifecycleStatus: null }, to: "pending_to_submit" },
  { from: { lifecycleStatus: "unreported" }, to: "pending_to_submit" },
  { from: { lifecycleStatus: "in_report" }, to: "pending_to_submit" },
  { from: { lifecycleStatus: "rejected" }, to: "declined" },
];

const REPORT_RENAMES: { from: any; to: string }[] = [
  { from: { status: "rejected" }, to: "declined" },
];

async function main() {
  const uri = process.env.MONGO_URI!;
  if (!uri) throw new Error("MONGO_URI is not set");

  await mongoose.connect(uri, { readPreference: COMMIT ? "primary" : "secondary" });
  const db = mongoose.connection.db!;
  const expenses = db.collection("expenses");
  const reports = db.collection("reports");

  console.log(COMMIT ? "── COMMIT (writing) ──" : "── DRY RUN (no writes) ──");

  console.log("\nExpense.lifecycleStatus:");
  for (const { from, to } of EXPENSE_RENAMES) {
    const n = await expenses.countDocuments(from);
    const label = JSON.stringify(from.lifecycleStatus ?? "(missing)");
    if (!COMMIT) {
      console.log(`  ${label} → "${to}":  ${n} doc(s)`);
    } else {
      const res = await expenses.updateMany(from, { $set: { lifecycleStatus: to } });
      console.log(`  ${label} → "${to}":  matched ${n}, modified ${res.modifiedCount ?? 0}`);
    }
  }

  console.log("\nReport.status:");
  for (const { from, to } of REPORT_RENAMES) {
    const n = await reports.countDocuments(from);
    const label = JSON.stringify(from.status);
    if (!COMMIT) {
      console.log(`  ${label} → "${to}":  ${n} doc(s)`);
    } else {
      const res = await reports.updateMany(from, { $set: { status: to } });
      console.log(`  ${label} → "${to}":  matched ${n}, modified ${res.modifiedCount ?? 0}`);
    }
  }

  if (!COMMIT) console.log("\nRe-run with --commit to apply.");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
