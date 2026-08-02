// apps/backend/src/migrations/lib/migrationRunner.ts
//
// The shared runner every migration goes through, so the ledger
// (models/MigrationRun.ts) is a byproduct of running a migration, not a
// separate step someone has to remember. Assumes the caller already has a
// live Mongoose connection — this module never connects/disconnects itself,
// same convention every migration in this directory already follows.
//
// Two jobs:
//   1. Refuse to re-run an already-successfully-applied migration unless
//      the caller explicitly passes --force. A dry run is NEVER refused —
//      it's read-only by construction, and re-checking is exactly the
//      point of a dry run.
//   2. Record the run — always. Success, failure, or dry-run: exactly one
//      MigrationRun.create() call per invocation, including when the
//      migration's own logic throws (recorded as FAILED, then re-thrown so
//      the caller's own top-level catch/exit-code behavior is unaffected).
//
// APPEND-ONLY: this file only ever calls MigrationRun.create(). Never
// update, never delete — see that model's own file header for why.
import MigrationRun, { type MigrationRunMode, type MigrationRunOutcome } from "../../models/MigrationRun.js";

export interface MigrationRunResult {
  // FAILED is never returned here — a thrown error is how a migration
  // reports failure; the runner classifies that itself. A migration that
  // completes without throwing reports SUCCESS or, if it has a genuine
  // partial-completion concept, PARTIAL.
  outcome: Extract<MigrationRunOutcome, "SUCCESS" | "PARTIAL">;
  summary: string;
}

export interface RunMigrationOptions {
  migrationName: string;
  mode: Extract<MigrationRunMode, "DRY_RUN" | "APPLY">;
  // --force, parsed by the caller from argv. Only ever consulted when
  // mode === "APPLY" — irrelevant, and never checked, for a dry run.
  force: boolean;
  run: () => Promise<MigrationRunResult>;
}

// No authenticated req.user here — these are CLI/ops scripts. The OS/env
// username is the closest honest answer to "who ran this". Exported so
// migrations/backfill-ledger-2026-08-02-audit.ts stamps backfilled rows
// with the same convention, not a separately-invented one.
export function currentRunBy(): string {
  return process.env.USERNAME || process.env.USER || "unknown";
}

/**
 * Returns the most recent successful APPLY run for this migration, or null
 * if it has never been successfully applied. Exported so migrations/
 * status.ts's classification logic reads the exact same definition of
 * "applied" this guard enforces — the two must never drift apart.
 */
export async function findLastSuccessfulApply(migrationName: string) {
  return MigrationRun.findOne({ migrationName, mode: "APPLY", outcome: "SUCCESS" })
    .sort({ startedAt: -1 })
    .lean();
}

export async function runMigration(opts: RunMigrationOptions): Promise<void> {
  const { migrationName, mode, force, run } = opts;

  if (mode === "APPLY" && !force) {
    const alreadyApplied = await findLastSuccessfulApply(migrationName);
    if (alreadyApplied) {
      console.error(
        `Refusing to run: "${migrationName}" already has a successful APPLY run recorded ` +
          `(completed ${(alreadyApplied as any).completedAt.toISOString()} by ${(alreadyApplied as any).runBy}). ` +
          `Pass --force to re-apply anyway.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const startedAt = new Date();
  const runBy = currentRunBy();

  try {
    const result = await run();
    await MigrationRun.create({
      migrationName,
      mode,
      outcome: result.outcome,
      startedAt,
      completedAt: new Date(),
      summary: result.summary,
      runBy,
    });
  } catch (err: any) {
    await MigrationRun.create({
      migrationName,
      mode,
      outcome: "FAILED",
      startedAt,
      completedAt: new Date(),
      summary: "Migration threw before completing — see error.",
      runBy,
      error: err?.message || String(err),
    });
    throw err;
  }
}
