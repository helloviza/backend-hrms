// apps/backend/src/migrations/backfill-ledger-2026-08-02-audit.ts
//
// One-time seed for models/MigrationRun.ts — NOT a migration itself (it
// changes no application data), and NOT run through lib/migrationRunner.ts
// (there's nothing to "run"; this hand-enters what a specific point-in-time
// data audit already concluded about migrations that predate the ledger).
// migrations/status.ts excludes this file from its own migration listing.
//
// Writes exactly three MigrationRun rows, from the Phase 10d ledger-audit
// conversation:
//   1. 2026-08-02-visa-checklist-model-v2 — mode:APPLY, outcome:SUCCESS.
//      This one genuinely ran (in that same conversation, before this
//      ledger existed) — VisaDocumentType/VisaQuestion were seeded, 12
//      VisaRule rows migrated, the unique index widened. The real summary
//      numbers observed at the time are recorded verbatim.
//   2. 2026-07-26-backfill-cstep-traveller-logins — mode:AUDIT,
//      outcome:UNKNOWN. Every currently-eligible traveller is already
//      claimed, but both were claimed seconds/minutes after their own
//      creation — consistent with the LIVE auto-claim flow, not a later
//      migration run. The migration's own named example (CSTEP-003) is now
//      inactive and outside its scope. Undecidable from data.
//   3. 2026-07-30-migrate-visa-concierge-assignment — mode:AUDIT,
//      outcome:UNKNOWN. Zero VisaRequest docs ever had the legacy field
//      set and zero VisaApplication docs have the new one populated —
//      vacuously consistent with "ran, nothing to migrate" or "never ran,
//      nothing existed to migrate". No historical data to test against
//      either way.
//
// Deliberately WRITES NOTHING for the four migrations the same audit
// confirmed never ran (2026-05-06-backfill-feature-flags,
// 2026-07-25-backfill-cstep-permission,
// 2026-08-01-backfill-visa-request-customer-id,
// 2026-08-01-migrate-visa-consent-array) — an absent ledger entry already
// means exactly "never seen" in migrations/status.ts's classification, and
// that IS the honest, correct backfill for them. Fabricating a "confirmed
// absent" row for those four would just be a different kind of guess.
//
// Idempotent: skips (does not insert) any migration that already has ANY
// MigrationRun row — this script inserts, never updates (see
// MigrationRun.ts's append-only header), so a second run must never
// duplicate a backfill it already did.
//
// Usage:
//   pnpm -C apps/backend tsx src/migrations/backfill-ledger-2026-08-02-audit.ts            # dry-run
//   pnpm -C apps/backend tsx src/migrations/backfill-ledger-2026-08-02-audit.ts --apply     # write
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import MigrationRun from "../models/MigrationRun.js";
import { currentRunBy } from "./lib/migrationRunner.js";

interface BackfillEntry {
  migrationName: string;
  mode: "APPLY" | "AUDIT";
  outcome: "SUCCESS" | "UNKNOWN";
  summary: string;
}

// startedAt/completedAt for all three: this audit (and, for entry 1, the
// real --apply run it describes) happened in the same Phase 10d
// conversation — there is no more precise historical timestamp to recover
// for entry 1 than "today", and entries 2/3 are dated exactly when the
// audit itself ran. All three get the same timestamp for that reason, not
// because the events were literally simultaneous.
const RECORDED_AT = new Date();

const BACKFILL_ENTRIES: BackfillEntry[] = [
  {
    migrationName: "2026-08-02-visa-checklist-model-v2",
    mode: "APPLY",
    outcome: "SUCCESS",
    summary:
      "[Backfilled retroactively — this migration was actually run via a direct tsx --apply invocation " +
      "before this ledger/runner existed; see the Phase 10d conversation.] " +
      "VisaDocumentType catalogue: 33 created, 0 updated, 0 unchanged. " +
      "VisaQuestion bank: 17 created, 0 updated, 0 unchanged. " +
      "VisaRule rows: 12 scanned, 12 updated (variantKey/documentGroups), 0 already migrated. " +
      "Rule-key unique index: created new 6-field unique index; dropped old 5-field index " +
      '("nationality_1_destinationIso2_1_purpose_1_entryType_1_serviceTier_1").',
  },
  {
    migrationName: "2026-07-26-backfill-cstep-traveller-logins",
    mode: "AUDIT",
    outcome: "UNKNOWN",
    summary:
      "Cannot determine from data whether this migration ever ran. Every currently-eligible " +
      "(active, has-email) traveller in the one cstepEnabled workspace is already claimed, but both " +
      "were claimed 12 seconds and ~33 minutes after their own creation respectively — consistent with " +
      "the LIVE auto-create-login flow (routes/workspace.travellers.ts's ensureCstepTravellerLogin), not " +
      "a later, separate backfill run. The migration's own named example of a target traveller " +
      "(CSTEP-003, 'Imran Ali') is now isActive:false and therefore outside this migration's scope today " +
      "— the one case it was written for no longer qualifies, so there is nothing left to test execution " +
      "against. Recorded as UNKNOWN rather than guessed either way.",
  },
  {
    migrationName: "2026-07-30-migrate-visa-concierge-assignment",
    mode: "AUDIT",
    outcome: "UNKNOWN",
    summary:
      "Cannot determine from data whether this migration ever ran. Zero VisaRequest documents have ever " +
      "had the legacy assignedConciergeUserId field set (not even present, let alone non-null), and zero " +
      "VisaApplication documents have the new per-application field populated. This is vacuously " +
      "consistent with either 'ran, and there was nothing to migrate' or 'never ran, and there was " +
      "nothing to migrate' — the concierge-assignment feature appears to have no historical usage in " +
      "this dataset at all, in either the old or new shape, so there is no data to test execution " +
      "against. Recorded as UNKNOWN rather than guessed either way.",
  },
];

async function main() {
  const dryRun = !process.argv.includes("--apply");
  console.log("=== Backfill migration ledger from Phase 10d audit ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}`);
  console.log("");

  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");

  try {
    const runBy = currentRunBy();
    let toInsert = 0;
    let alreadyHasEntries = 0;

    for (const entry of BACKFILL_ENTRIES) {
      const existing = await MigrationRun.findOne({ migrationName: entry.migrationName }).lean();
      if (existing) {
        console.log(`SKIP: ${entry.migrationName} — already has a ledger entry, not touching it.`);
        alreadyHasEntries += 1;
        continue;
      }

      console.log(`${dryRun ? "WOULD INSERT" : "INSERTING"}: ${entry.migrationName} [${entry.mode}/${entry.outcome}]`);
      toInsert += 1;

      if (!dryRun) {
        await MigrationRun.create({
          migrationName: entry.migrationName,
          mode: entry.mode,
          outcome: entry.outcome,
          startedAt: RECORDED_AT,
          completedAt: RECORDED_AT,
          summary: entry.summary,
          runBy,
        });
      }
    }

    console.log("");
    console.log(`${dryRun ? "Would insert" : "Inserted"} ${toInsert} row(s). ${alreadyHasEntries} already had entries and were left alone.`);
    console.log(
      "No entry is written for 2026-05-06-backfill-feature-flags, 2026-07-25-backfill-cstep-permission, " +
        "2026-08-01-backfill-visa-request-customer-id, or 2026-08-01-migrate-visa-consent-array — an absent " +
        "ledger entry already means \"never seen\", which is the confirmed, honest state for those four.",
    );
    if (dryRun) {
      console.log("");
      console.log("Re-run with --apply to write these rows.");
    }
  } finally {
    await mongoose.connection.close();
  }
}

const isDirectRun = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(async (err) => {
    console.error("Ledger backfill failed:", err);
    try {
      await mongoose.connection.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}
