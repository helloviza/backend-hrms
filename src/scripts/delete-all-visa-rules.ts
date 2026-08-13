// apps/backend/src/scripts/delete-all-visa-rules.ts
//
// Deletes EVERY document in the visarules collection — and nothing else.
// Written for one specific job (2026-08-13): clearing the test catalogue
// Imran built by hand so the real StampMyVisa catalogue can be imported in
// its place. This is deliberately a whole-collection delete, so it does NOT
// reuse scripts/purge-visa-seed.ts: that script is scoped by the
// `seedSource` marker and would leave behind every hand-made row (exactly
// the rows this one exists to remove), and it also deletes from
// VisaDestinationContent, which must NOT be touched here.
//
// ── WHAT THIS TOUCHES ─────────────────────────────────────────────────
// VisaRule (collection `visarules`). That is the complete list. It is the
// only model this file imports, and ALLOWED_MODELS below is a single-entry
// list, so VisaDestinationContent, VisaRequest, VisaApplication,
// VisaDocument, Counter and every other collection are out of reach by
// construction — not by discipline. assertModelScope() aborts the run if
// anything else is registered with mongoose by the time it executes, which
// is what would happen if a future edit imported another model (directly
// or transitively) into this file.
//
// ── GUARDS, IN THE ORDER THEY RUN ─────────────────────────────────────
//   1. assertOnlyDeletesVisaRule() — reads this file's own source and
//      refuses to start unless every delete-shaped call in it is on the
//      VisaRule model, and no collection-dropping API appears at all. Same
//      self-scanning convention as routes/admin.visa.rules.importExport.ts's
//      assertNeverSetsPublishedStatus() and scripts/
//      import-visa-checklist-rules.ts's assertNeverPublishesLiteral().
//   2. assertModelScope() — only VisaRule may be registered (above).
//   3. DRY RUN unless --confirm is passed. The default run counts, groups
//      and prints, and writes NOTHING — to the database or to disk.
//   4. --confirm additionally requires the target database NAME typed at
//      the prompt. There is no --yes escape hatch: this deletes a whole
//      collection on a production-wired connection, so it may only ever be
//      run by a human at a terminal who typed the database name.
//   5. Before deleting, the full documents are written to a local JSON
//      backup file (gitignored) so a mistake is recoverable by re-inserting
//      that file. The delete does not proceed if the backup can't be
//      written.
//
// Counts are printed before AND after the delete, from the database itself.
//
// Run (dry run, safe, read-only):
//   pnpm -C apps/backend exec tsx src/scripts/delete-all-visa-rules.ts
// Run (the real delete — prompts for the database name):
//   pnpm -C apps/backend exec tsx src/scripts/delete-all-visa-rules.ts --confirm
import * as readline from "node:readline/promises";
import { stdin as rlInput, stdout as rlOutput } from "node:process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import { env } from "../config/env.js";
import VisaRule from "../models/VisaRule.js";

// The one and only model this script may see. Not a preference — a
// precondition, enforced below against mongoose's own registry.
const ALLOWED_MODELS = ["VisaRule"];

/* ─────────────────────────────────────────────────────────────────────
 * Guard 1 — self-scan.
 *
 * The patterns are ASSEMBLED from fragments rather than written out as
 * literals, so this function can never match its own definition and
 * "pass" by finding itself. Every delete-shaped call site in this file
 * must be qualified by the VisaRule model, and the collection-level
 * destructive APIs must not appear at all.
 * ───────────────────────────────────────────────────────────────────── */
const DELETE_CALL_PATTERN = new RegExp("(\\w+)\\s*\\.\\s*" + "delete" + "(?:One|Many)\\s*\\(", "g");
const FORBIDDEN_APIS = ["drop" + "Database", "drop" + "Collection", "collection" + ".drop", "find" + "OneAndDelete"];

function assertOnlyDeletesVisaRule(): void {
  const selfPath = fileURLToPath(import.meta.url);
  const source = readFileSync(selfPath, "utf8");

  const receivers = [...source.matchAll(DELETE_CALL_PATTERN)].map((m) => m[1]);
  const foreign = receivers.filter((name) => name !== "VisaRule");
  if (foreign.length > 0) {
    console.error(
      `Refusing to run: this script may only delete from VisaRule, but its own source deletes from: ` +
        `${[...new Set(foreign)].join(", ")}.`,
    );
    process.exit(1);
  }
  if (receivers.length === 0) {
    console.error("Refusing to run: this script's own source contains no VisaRule delete call — the self-check is broken.");
    process.exit(1);
  }

  const found = FORBIDDEN_APIS.filter((api) => source.includes(api));
  if (found.length > 0) {
    console.error(`Refusing to run: this script's own source uses a forbidden destructive API: ${found.join(", ")}.`);
    process.exit(1);
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Guard 2 — model scope.
 * ───────────────────────────────────────────────────────────────────── */
function assertModelScope(): void {
  const registered = mongoose.modelNames();
  const unexpected = registered.filter((name) => !ALLOWED_MODELS.includes(name));
  if (unexpected.length > 0) {
    console.error(
      `Refusing to run: this script may only touch ${ALLOWED_MODELS.join(", ")}, but ` +
        `additional model(s) are registered: ${unexpected.join(", ")}.`,
    );
    process.exit(1);
  }
}

function targetInfo(): { host: string; db: string } {
  const url = new URL(env.MONGO_URI);
  return { host: url.hostname, db: url.pathname.replace(/^\//, "") || "(default)" };
}

interface Preview {
  total: number;
  byDestination: { iso2: string; name: string; count: number }[];
  byStatus: Record<string, number>;
  bySeedSource: Record<string, number>;
}

async function buildPreview(): Promise<Preview> {
  const rules = await VisaRule.find({})
    .select("_id destinationIso2 destinationName purpose status seedSource")
    .lean();

  const destinations = new Map<string, { iso2: string; name: string; count: number }>();
  const byStatus: Record<string, number> = {};
  const bySeedSource: Record<string, number> = {};

  for (const r of rules as any[]) {
    const iso2 = r.destinationIso2 || "(none)";
    const entry = destinations.get(iso2) || { iso2, name: r.destinationName || "(no name)", count: 0 };
    entry.count += 1;
    destinations.set(iso2, entry);

    const status = r.status || "(none)";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    const seed = r.seedSource || "(hand-made — no seedSource)";
    bySeedSource[seed] = (bySeedSource[seed] ?? 0) + 1;
  }

  return {
    total: rules.length,
    byDestination: [...destinations.values()].sort((a, b) => a.iso2.localeCompare(b.iso2)),
    byStatus,
    bySeedSource,
  };
}

function printPreview(target: { host: string; db: string }, preview: Preview): void {
  console.log("──────────────────────────────────────────────────────");
  console.log(`Target host:       ${target.host}`);
  console.log(`Target database:   ${target.db}`);
  console.log(`Collection:        ${VisaRule.collection.name}  (the ONLY collection this script can touch)`);
  console.log("──────────────────────────────────────────────────────");
  console.log(`Rules that WOULD be deleted: ${preview.total}`);
  console.log(`Destinations covered:        ${preview.byDestination.length}`);
  console.log("");
  console.log("By status:");
  for (const [status, count] of Object.entries(preview.byStatus).sort()) {
    console.log(`  ${status.padEnd(12)} ${count}`);
  }
  console.log("");
  console.log("By seedSource:");
  for (const [seed, count] of Object.entries(preview.bySeedSource).sort()) {
    console.log(`  ${String(count).padStart(4)}  ${seed}`);
  }
  console.log("");
  console.log("By destination:");
  for (const d of preview.byDestination) {
    console.log(`  ${d.iso2}  ${String(d.count).padStart(2)}  ${d.name}`);
  }
  console.log("──────────────────────────────────────────────────────");
}

/**
 * Full documents to disk before anything is deleted, so the delete is
 * reversible by re-inserting the file. The filename matches the repo's own
 * `*-backup-*.json` gitignore rule — this data must never be committed.
 * Returns the path written; throws (aborting the delete) if it can't be.
 */
function writeBackup(db: string, docs: unknown[]): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const backupDir = resolve(scriptDir, "../../backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = resolve(backupDir, `visa-rules-backup-${db}-${stamp}.json`);
  writeFileSync(path, JSON.stringify(docs, null, 2), "utf8");
  return path;
}

async function confirmDatabaseName(expectedDb: string): Promise<void> {
  if (!rlInput.isTTY) {
    console.error(
      "Refusing to run: --confirm requires typing the database name at an interactive terminal, " +
        "and stdin is not a TTY. Run this yourself in a shell.",
    );
    process.exit(1);
  }
  const rl = readline.createInterface({ input: rlInput, output: rlOutput });
  try {
    const answer = await rl.question(`Type the database name ("${expectedDb}") to DELETE every visa rule: `);
    if (answer.trim() !== expectedDb) {
      console.error("Aborted: input did not match the database name. Nothing was deleted.");
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

async function run() {
  assertOnlyDeletesVisaRule();

  const confirmed = process.argv.includes("--confirm");

  await connectDb();
  assertModelScope();

  const target = targetInfo();
  const countBefore = await VisaRule.countDocuments({});
  const preview = await buildPreview();
  printPreview(target, preview);

  if (countBefore === 0) {
    console.log("Nothing to do: the visarules collection is already empty.");
    process.exit(0);
  }

  if (!confirmed) {
    console.log("DRY RUN — nothing was deleted and nothing was written.");
    console.log("Re-run with --confirm (and type the database name at the prompt) to delete these rules.");
    process.exit(0);
  }

  console.log("");
  console.log(`!! This will permanently delete ALL ${countBefore} documents in ${target.db}.${VisaRule.collection.name}.`);
  console.log("!! No other collection is touched.");

  const fullDocs = await VisaRule.find({}).lean();
  const backupPath = writeBackup(target.db, fullDocs);
  console.log(`Backup written: ${backupPath} (${fullDocs.length} documents)`);

  await confirmDatabaseName(target.db);

  const result = await VisaRule.deleteMany({});
  const countAfter = await VisaRule.countDocuments({});

  console.log("──────────────────────────────────────────────────────");
  console.log(`Count before: ${countBefore}`);
  console.log(`Deleted:      ${result.deletedCount ?? 0}`);
  console.log(`Count after:  ${countAfter}`);
  console.log(`Backup:       ${backupPath}`);
  console.log("──────────────────────────────────────────────────────");
  process.exit(0);
}

run().catch((err) => {
  console.error("delete-all-visa-rules failed:", err);
  process.exit(1);
});
