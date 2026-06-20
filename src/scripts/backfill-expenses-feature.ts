/**
 * backfill-expenses-feature.ts
 *
 * Sets config.features.expensesEnabled = true on EVERY existing CustomerWorkspace.
 *
 * The expenses module was always-on (no feature flag) until this change. The new
 * `expensesEnabled` flag has SCHEMA DEFAULT false, so without this backfill every
 * pre-existing workspace would lose expenses the moment the route gate ships. Run
 * this (dry-run → commit) on prod BEFORE deploying the requireFeature gate.
 *
 *   DRY RUN (default):  pnpm -C apps/backend tsx src/scripts/backfill-expenses-feature.ts
 *   COMMIT (writes):    ... backfill-expenses-feature.ts --commit
 *
 * DRY RUN performs ZERO writes — it counts what WOULD change and prints a report.
 * Writing requires the explicit --commit flag.
 *
 * Idempotent: only flips workspaces where config.features.expensesEnabled is not
 * already true; re-running after a commit is a no-op. Touches nothing but that one
 * field. Includes ACTIVE / INACTIVE / DELETED workspaces (collection-wide) so a
 * later reactivation doesn't silently lose the module.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

const COMMIT = process.argv.includes("--commit");

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT (writes)" : "DRY RUN (no writes)"}\n`);
  console.log("Connecting to MongoDB...");
  await mongoose.connect(env.MONGO_URI);
  console.log("Connected.\n");

  const total = await CustomerWorkspace.countDocuments({});
  const alreadyOn = await CustomerWorkspace.countDocuments({
    "config.features.expensesEnabled": true,
  });
  // Everything not already explicitly true (false, missing, or null) is a target.
  const toUpdate = await CustomerWorkspace.countDocuments({
    "config.features.expensesEnabled": { $ne: true },
  });

  console.log(`Total workspaces        : ${total}`);
  console.log(`Already expensesEnabled : ${alreadyOn}`);
  console.log(`Would enable            : ${toUpdate}\n`);

  if (!COMMIT) {
    console.log("DRY RUN — no writes performed. Re-run with --commit to apply.");
    await mongoose.connection.close();
    process.exit(0);
  }

  const res = await CustomerWorkspace.updateMany(
    { "config.features.expensesEnabled": { $ne: true } },
    { $set: { "config.features.expensesEnabled": true } },
  );

  console.log("Backfill complete:");
  console.log(`  Matched  : ${res.matchedCount}`);
  console.log(`  Modified : ${res.modifiedCount}`);

  const finalOn = await CustomerWorkspace.countDocuments({
    "config.features.expensesEnabled": true,
  });
  console.log(`\nWorkspaces now expensesEnabled: ${finalOn} / ${total}`);

  await mongoose.connection.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
