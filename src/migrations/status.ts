// apps/backend/src/migrations/status.ts
//
// Answers "did this run" for every file in this directory by reading the
// ledger (models/MigrationRun.ts) instead of re-deriving it from data
// forensics each time — which is what the Phase 10d audit had to do by hand
// for the 9 migrations that predate this ledger, and got two of them (cstep
// traveller logins, concierge assignment) genuinely undecidable.
//
// Read-only — never writes anything, never takes --apply/--force.
//
// Usage:
//   pnpm -C apps/backend tsx src/migrations/status.ts
import "dotenv/config";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import MigrationRun from "../models/MigrationRun.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Files in this directory that are NOT a trackable migration: the runner
// library, this status command itself, unit tests, and ledger-maintenance
// utilities like the one-off audit backfill (it WRITES ledger entries about
// other migrations — it isn't itself a migration whose own execution needs
// tracking).
const NON_MIGRATION_FILES = new Set(["status.ts"]);
const NON_MIGRATION_PATTERNS = [/\.test\.ts$/, /^backfill-ledger-/];

export type MigrationStatus = "APPLIED" | "UNKNOWN" | "DRY_RUN_ONLY" | "NEVER_SEEN";

export interface MigrationRunLike {
  mode: string;
  outcome: string;
}

/**
 * Pure classification — given every MigrationRun row for one migration
 * (any order), decides which of the three statuses the task brief asked
 * for applies, plus the UNKNOWN bucket for a backfilled audit finding.
 * "APPLIED" checks ALL rows, not just the most recent — once a migration
 * has ever had a successful APPLY run, a later failed dry-run attempt (or
 * anything else) must never make it look un-applied again.
 */
export function classifyMigrationRuns(runs: MigrationRunLike[]): MigrationStatus {
  if (runs.some((r) => r.mode === "APPLY" && r.outcome === "SUCCESS")) return "APPLIED";
  if (runs.some((r) => r.mode === "AUDIT" && r.outcome === "UNKNOWN")) return "UNKNOWN";
  if (runs.length > 0) return "DRY_RUN_ONLY";
  return "NEVER_SEEN";
}

export function listMigrationFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !NON_MIGRATION_FILES.has(f))
    .filter((f) => !NON_MIGRATION_PATTERNS.some((p) => p.test(f)))
    .sort();
}

function formatStatus(status: MigrationStatus): string {
  switch (status) {
    case "APPLIED":
      return "APPLIED";
    case "UNKNOWN":
      return "UNKNOWN (audited — could not be determined from data)";
    case "DRY_RUN_ONLY":
      return "DRY-RUN ONLY (never successfully applied)";
    case "NEVER_SEEN":
      return "NEVER SEEN (no ledger entry at all)";
  }
}

async function main() {
  console.log("=== Migration ledger status ===");
  console.log("");

  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");

  try {
    const files = listMigrationFiles(__dirname);

    for (const file of files) {
      const migrationName = file.replace(/\.ts$/, "");
      const runs = await MigrationRun.find({ migrationName }).sort({ startedAt: -1 }).lean();
      const status = classifyMigrationRuns(runs);

      console.log(`${migrationName}`);
      console.log(`  ${formatStatus(status)}`);
      if (runs.length > 0) {
        const last = runs[0] as any;
        console.log(
          `  last run: ${last.mode} / ${last.outcome} at ${last.completedAt.toISOString()} by ${last.runBy}`,
        );
        if (last.outcome === "FAILED" && last.error) {
          console.log(`  last error: ${last.error}`);
        }
      }
      console.log("");
    }

    const counts = { APPLIED: 0, UNKNOWN: 0, DRY_RUN_ONLY: 0, NEVER_SEEN: 0 } as Record<MigrationStatus, number>;
    for (const file of files) {
      const migrationName = file.replace(/\.ts$/, "");
      const runs = await MigrationRun.find({ migrationName }).lean();
      counts[classifyMigrationRuns(runs)] += 1;
    }
    console.log(
      `Summary: ${counts.APPLIED} applied, ${counts.UNKNOWN} unknown, ${counts.DRY_RUN_ONLY} dry-run only, ${counts.NEVER_SEEN} never seen (${files.length} total).`,
    );
  } finally {
    await mongoose.connection.close();
  }
}

const isDirectRun = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch(async (err) => {
    console.error("Status check failed:", err);
    try {
      await mongoose.connection.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}
