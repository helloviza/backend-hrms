// apps/backend/src/migrations/2026-10-17-traveller-id-partial-index.ts
//
// CSTEP Traveller ID = Employee ID — the index half. Run at DEPLOY, with
// the backend that carries it.
//
// TravellerProfile.travelerId stopped being required: a CSTEP traveller
// auto-captured from a booking now sits with a blank id until an admin
// assigns their employee id. The old index — unique {workspaceId,
// travelerId} on EVERY value — would let only one such blank traveller
// exist per workspace. This replaces it with the same index, unique only
// where travelerId is a non-empty string (partialFilterExpression
// { travelerId: { $gt: "" } }, the shape CustomerMember already uses).
//
// Safe on existing data by construction: the old index already enforced
// uniqueness on every value, so the narrower one cannot be violated.
// Idempotent: an index that is already partial is reported and left alone.
// Drop-then-create under the same name Mongoose derives from the schema, so
// the brief gap between the two is milliseconds and autoIndex at boot sees
// a matching index afterwards (not a conflicting one).
//
// Until it runs, a SECOND blank-id CSTEP traveller in one workspace fails
// the old index (E11000 at auto-capture, which is logged and skipped —
// never surfaced to the booking). Non-CSTEP workspaces are unaffected
// either way: they always mint a non-empty id.
//
// --expect-db=<name> is required in EVERY mode, dry run included: the
// migration runner records a MigrationRun row even on a dry run, so no mode
// is read-only. The connected database must be exactly that name, or nothing
// runs. autoIndex and autoCreate are off on the connection, so importing
// models never builds indexes or creates empty collections on the target as a
// side effect — the only index work is the drop/create below.
//
// Usage:
//   pnpm -C apps/backend tsx src/migrations/2026-10-17-traveller-id-partial-index.ts --expect-db=<db>           # dry-run
//   pnpm -C apps/backend tsx src/migrations/2026-10-17-traveller-id-partial-index.ts --expect-db=<db> --apply   # write
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { runMigration } from "./lib/migrationRunner.js";
import { migrateTravelerIdIndex } from "../services/cstepTravellerIds.js";

export const MIGRATION_NAME = "2026-10-17-traveller-id-partial-index";

async function main() {
  const dryRun = !process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  const expectDb = process.argv.find((a) => a.startsWith("--expect-db="))?.split("=")[1] || "";
  console.log("=== TravellerProfile {workspaceId, travelerId} → partial unique index ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}`);
  console.log("");

  await mongoose.connect(env.MONGO_URI, { autoIndex: false, autoCreate: false });
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");
  const db = mongoose.connection.db?.databaseName;
  if (!expectDb || db !== expectDb) {
    throw new Error(`connected database is "${db}", --expect-db is "${expectDb}" — refusing to run`);
  }

  try {
    await runMigration({
      migrationName: MIGRATION_NAME,
      mode: dryRun ? "DRY_RUN" : "APPLY",
      force,
      run: async () => {
        const r = await migrateTravelerIdIndex(dryRun);
        console.log("Index before:", JSON.stringify(r.before));
        console.log("Index after: ", JSON.stringify(r.after));
        console.log(`Travellers with a blank travelerId today: ${r.blankIds}`);
        const summary = `state=${r.state} blankIds=${r.blankIds}`;
        console.log(summary);
        if (dryRun && r.state === "would-migrate") {
          console.log("");
          console.log("Re-run with --apply to replace the index.");
        }
        return { outcome: "SUCCESS", summary };
      },
    });
  } finally {
    await mongoose.connection.close();
  }
}

// Auto-run only as the process entry point — see
// 2026-08-01-backfill-visa-request-customer-id.ts for why.
const isDirectRun = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(async (err) => {
    console.error("Migration failed:", err);
    try {
      await mongoose.connection.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}
