// apps/backend/src/models/MigrationRun.ts
//
// The migration ledger (Phase 10d follow-up) — the thing that didn't exist
// when migrations/2026-08-02-visa-checklist-model-v2.ts turned out to have
// never been run on production, and was only discovered because an unrelated
// import failed on a stale index. Every invocation of a retrofitted
// migration (migrations/lib/migrationRunner.ts) writes exactly ONE row here,
// whether it succeeds, fails, or was only a dry run — this collection is the
// only place "did X run" can be answered without re-deriving it from data
// forensics.
//
// APPEND-ONLY: a row is never updated or deleted once written. A dry-run
// records mode:"DRY_RUN" and NEVER counts as having applied the migration —
// only mode:"APPLY" + outcome:"SUCCESS" does (see migrationRunner.ts's
// re-apply guard and migrations/status.ts's classification). This is
// deliberately NOT enforced at the MongoDB level (no capped collection, no
// server-side ACL) — the same posture scripts/seed-visa-rules.ts and
// scripts/import-visa-checklist-rules.ts already take with their own
// structural self-guards: migrationRunner.ts's own source only ever calls
// MigrationRun.create(), never update/delete, and nothing else in this
// codebase should either.
import mongoose, { Schema, type Document, type Model } from "mongoose";

// AUDIT is not a real execution — it's a retroactive ledger entry written
// once, by hand, to record what a point-in-time data audit concluded about a
// migration that predates this ledger (e.g. "ran, but undecidable from data
// alone"). Nothing but the one-off backfill script should ever write mode:
// "AUDIT" — migrationRunner.ts itself only ever passes DRY_RUN or APPLY.
export const MIGRATION_RUN_MODES = ["DRY_RUN", "APPLY", "AUDIT"] as const;
export type MigrationRunMode = (typeof MIGRATION_RUN_MODES)[number];

// UNKNOWN is not a fourth kind of real outcome — it exists for exactly the
// same AUDIT-only case as above: a migration whose execution history could
// not be determined from data alone. An honest "unknown" beats a guess
// (task brief) — never record SUCCESS/FAILED/PARTIAL for something that
// wasn't actually observed running.
export const MIGRATION_RUN_OUTCOMES = ["SUCCESS", "FAILED", "PARTIAL", "UNKNOWN"] as const;
export type MigrationRunOutcome = (typeof MIGRATION_RUN_OUTCOMES)[number];

export interface MigrationRunDocument extends Document {
  // The migration's own filename, without the .ts extension, e.g.
  // "2026-08-02-visa-checklist-model-v2" — stable, matches migrations/
  // status.ts's directory scan, never a human-chosen label that could drift
  // from the actual file.
  migrationName: string;
  mode: MigrationRunMode;
  outcome: MigrationRunOutcome;
  startedAt: Date;
  completedAt: Date;
  // Whatever the migration's own summary line(s) said — free text, not a
  // structured re-encoding of every migration's different summary shape.
  summary: string;
  // OS/env username the process ran as (migrationRunner.ts captures this
  // automatically — never a value the migration script itself chooses).
  // For a backfilled AUDIT row, this is whoever ran the backfill script,
  // not a guess at who ran the original, undated execution.
  runBy: string;
  // Present only when outcome === "FAILED".
  error?: string;
  createdAt?: Date;
}

const MigrationRunSchema = new Schema<MigrationRunDocument>(
  {
    migrationName: { type: String, required: true, trim: true },
    mode: { type: String, enum: MIGRATION_RUN_MODES, required: true },
    outcome: { type: String, enum: MIGRATION_RUN_OUTCOMES, required: true },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date, required: true },
    summary: { type: String, required: true, trim: true },
    runBy: { type: String, required: true, trim: true },
    error: { type: String, trim: true },
  },
  // createdAt only — these rows are never updated, so updatedAt would only
  // ever equal createdAt and add nothing.
  { timestamps: { createdAt: true, updatedAt: false } },
);

// migrations/status.ts's primary lookup: every run for one migration, most
// recent first.
MigrationRunSchema.index({ migrationName: 1, startedAt: -1 });
// migrationRunner.ts's re-apply guard: "does an APPLY+SUCCESS row exist for
// this migration at all" — a narrower, more selective index than the one
// above for that specific, frequent check.
MigrationRunSchema.index({ migrationName: 1, mode: 1, outcome: 1 });

const MigrationRun: Model<MigrationRunDocument> =
  mongoose.models.MigrationRun || mongoose.model<MigrationRunDocument>("MigrationRun", MigrationRunSchema);

export default MigrationRun;
