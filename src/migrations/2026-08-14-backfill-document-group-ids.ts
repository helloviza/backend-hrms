// apps/backend/src/migrations/2026-08-14-backfill-document-group-ids.ts
//
// Assigns a stable `groupId` to every VisaRule.documentGroups entry that
// doesn't have one.
//
// ── WHY ──────────────────────────────────────────────────────────────────
//
// Per-group editing of documentGroups (routes/admin.visa.rules.
// documentGroups.ts) addresses one requirement at a time. It needs an
// identifier that survives an edit. `key` cannot be it: key is derived from
// the label via slugifyChecklistLabel, so renaming "Bank Statement" to
// "Bank Statement (6 months)" changes the key, and an edit keyed on it
// would orphan the original row and append a second one. Array index is
// worse — it moves whenever anything is added or removed.
//
// So groupId is a real assigned id (a fresh ObjectId, rendered as a string)
// with no relationship to the group's contents. Nothing derives it, so
// nothing can invalidate it.
//
// ── WHY IT MUST BE A MIGRATION AND NOT A SCHEMA DEFAULT ─────────────────
//
// A `default:` on the subdocument path would mint a NEW id every time a
// stored group lacking one is hydrated. Two GETs of the same rule would
// return different ids for the same requirement, and a PATCH would target
// whichever id the client happened to have received — the exact class of
// bug the stable id exists to prevent. Ids must be written down once. That
// means a migration.
//
// ── SAFETY ───────────────────────────────────────────────────────────────
//
// Dry-run by default; --apply writes. Local-only by default via
// assertLocalDatabase; production requires --i-know-this-is-production,
// which additionally demands an interactive TTY and the database name typed
// back before any write — the same pattern as 2026-08-12-backfill-visa-
// application-travel-denorm.ts, whose implementations are reused verbatim
// rather than re-derived. Ledgered through lib/migrationRunner, so a second
// --apply is refused without --force.
//
// Idempotent: only groups with a falsy groupId are touched, so a re-run
// after a partial failure completes the remainder and leaves existing ids
// exactly as they were.
//
// Usage:
//   node --env-file=.env.development --import tsx src/migrations/2026-08-14-backfill-document-group-ids.ts
//   node --env-file=.env.development --import tsx src/migrations/2026-08-14-backfill-document-group-ids.ts --apply
//   (production, interactive only)
//   node --env-file=.env --import tsx src/migrations/2026-08-14-backfill-document-group-ids.ts --i-know-this-is-production
import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import VisaRule from "../models/VisaRule.js";
import { runMigration } from "./lib/migrationRunner.js";
import {
  assertLocalDatabase,
  assertProductionAcknowledged,
} from "./2026-08-12-backfill-visa-application-travel-denorm.js";

const MIGRATION_NAME = "2026-08-14-backfill-document-group-ids";

export interface GroupIdBackfillSummary {
  rulesScanned: number; // rules holding at least one group with no id
  rulesUpdated: number; // rules actually written (same as scanned in apply mode)
  groupsBackfilled: number; // individual requirement groups given an id
  rulesAlreadyComplete: number; // every group already had one — untouched
  groupsTotal: number; // every group across every rule, for context
}

export async function backfillDocumentGroupIds(
  dryRun: boolean,
  onRule?: (r: { ruleId: string; destinationName: string; status: string; assigned: number; total: number }) => void,
): Promise<GroupIdBackfillSummary> {
  const summary: GroupIdBackfillSummary = {
    rulesScanned: 0,
    rulesUpdated: 0,
    groupsBackfilled: 0,
    rulesAlreadyComplete: 0,
    groupsTotal: 0,
  };

  // Every rule, not just those with gaps — the totals are what a reviewer
  // uses to decide the numbers look right before authorising a write.
  const rules = await VisaRule.find({}).sort({ destinationIso2: 1, purpose: 1 });

  for (const rule of rules) {
    const groups: any[] = (rule as any).documentGroups || [];
    summary.groupsTotal += groups.length;
    if (groups.length === 0) continue;

    const missing = groups.filter((g) => !g.groupId);
    if (missing.length === 0) {
      summary.rulesAlreadyComplete += 1;
      continue;
    }

    summary.rulesScanned += 1;
    for (const g of missing) {
      g.groupId = new mongoose.Types.ObjectId().toString();
      summary.groupsBackfilled += 1;
    }

    onRule?.({
      ruleId: String(rule._id),
      destinationName: (rule as any).destinationName,
      status: (rule as any).status,
      assigned: missing.length,
      total: groups.length,
    });

    if (!dryRun) {
      // markModified because the mutation happened on plain subdocument
      // properties inside an array — Mongoose does not always see those.
      rule.markModified("documentGroups");
      await rule.save();
      summary.rulesUpdated += 1;
    }
  }

  return summary;
}

async function main() {
  const dryRun = !process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  const productionAcknowledged = process.argv.includes("--i-know-this-is-production");

  console.log("=== Backfill stable groupId on VisaRule.documentGroups ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}${productionAcknowledged ? " (PRODUCTION path)" : ""}`);

  // Before connect, in BOTH modes — a dry run against production is still a
  // connection to production.
  if (productionAcknowledged) {
    await assertProductionAcknowledged(env.MONGO_URI, !dryRun);
  } else {
    assertLocalDatabase(env.MONGO_URI);
  }

  await mongoose.connect(env.MONGO_URI);
  if (mongoose.connection.readyState !== 1) {
    console.error(`Refusing to run: mongoose readyState is ${mongoose.connection.readyState}, expected 1.`);
    process.exit(1);
  }
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");

  try {
    await runMigration({
      migrationName: MIGRATION_NAME,
      mode: dryRun ? "DRY_RUN" : "APPLY",
      force,
      run: async () => {
        console.log("rule id                   status     dest                  ids assigned / groups");
        const summary = await backfillDocumentGroupIds(dryRun, (r) => {
          console.log(
            `${r.ruleId}  ${r.status.padEnd(9)}  ${String(r.destinationName ?? "-").padEnd(20)}  ` +
              `${String(r.assigned).padStart(3)} / ${r.total}`,
          );
        });
        console.log("");
        const summaryLine =
          `rulesScanned=${summary.rulesScanned} rulesUpdated=${summary.rulesUpdated} ` +
          `groupsBackfilled=${summary.groupsBackfilled} rulesAlreadyComplete=${summary.rulesAlreadyComplete} ` +
          `groupsTotal=${summary.groupsTotal}`;
        console.log(summaryLine);

        if (dryRun) {
          console.log("");
          console.log("DRY RUN — nothing was written. Re-run with --apply to assign these ids.");
        }
        return { outcome: "SUCCESS", summary: summaryLine };
      },
    });
  } finally {
    await mongoose.connection.close();
  }
}

// Auto-run ONLY as the process entry point — same guard, and same reason,
// as 2026-08-12-backfill-visa-application-travel-denorm.ts: this file
// exports backfillDocumentGroupIds, and a bare top-level `await main()`
// would turn any future import of that export into an accidental run
// against whatever MONGO_URI happened to be loaded.
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
