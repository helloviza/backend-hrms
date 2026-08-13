// apps/backend/src/scripts/delete-india-destination-visa-rules.ts
//
// Deletes ONLY the VisaRule rows whose destination is India itself.
//
// These are mis-scraped: this catalogue is nationality "IN" throughout (an
// Indian passport holder), and an Indian passport holder needs no visa TO
// India. The rows are inbound/foreigner visas (e-Medical, 1-year tourist,
// 1-year business) that the source workbook carried and the seed faithfully
// imported. Faithful, and wrong for this catalogue.
//
// ── WHAT THIS TOUCHES ─────────────────────────────────────────────────
// VisaRule (collection `visarules`), and within it ONLY documents matching
// { destinationIso2: "IN" }. The filter is a module constant, the delete
// re-uses the exact ids the preview listed (never a re-run of the filter),
// and assertOnlyDeletesVisaRule() re-reads this file's own source to prove
// no other model is deleted from. Same guard shape as scripts/
// delete-all-visa-rules.ts, which this is a narrowed copy of.
//
// Run (dry run, safe, read-only):
//   pnpm -C apps/backend exec tsx src/scripts/delete-india-destination-visa-rules.ts
// Run (the real delete — prompts for the database name):
//   pnpm -C apps/backend exec tsx src/scripts/delete-india-destination-visa-rules.ts --confirm
import * as readline from "node:readline/promises";
import { stdin as rlInput, stdout as rlOutput } from "node:process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import { env } from "../config/env.js";
import VisaRule from "../models/VisaRule.js";

const ALLOWED_MODELS = ["VisaRule"];

// The ONLY filter this script deletes by. India as a DESTINATION — never
// India as the nationality, which is every row in the catalogue.
const DESTINATION_FILTER = { destinationIso2: "IN" } as const;

const DELETE_CALL_PATTERN = new RegExp("(\\w+)\\s*\\.\\s*" + "delete" + "(?:One|Many)\\s*\\(", "g");
const FORBIDDEN_APIS = ["drop" + "Database", "drop" + "Collection", "collection" + ".drop", "find" + "OneAndDelete"];

function assertOnlyDeletesVisaRule(): void {
  const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const receivers = [...source.matchAll(DELETE_CALL_PATTERN)].map((m) => m[1]);
  const foreign = receivers.filter((name) => name !== "VisaRule");
  if (foreign.length > 0) {
    console.error(`Refusing to run: this script deletes from ${[...new Set(foreign)].join(", ")}, not just VisaRule.`);
    process.exit(1);
  }
  if (receivers.length === 0) {
    console.error("Refusing to run: no VisaRule delete call found in this script's own source — the self-check is broken.");
    process.exit(1);
  }
  const found = FORBIDDEN_APIS.filter((api) => source.includes(api));
  if (found.length > 0) {
    console.error(`Refusing to run: forbidden destructive API in this script's source: ${found.join(", ")}.`);
    process.exit(1);
  }
}

function assertModelScope(): void {
  const unexpected = mongoose.modelNames().filter((name) => !ALLOWED_MODELS.includes(name));
  if (unexpected.length > 0) {
    console.error(`Refusing to run: unexpected model(s) registered: ${unexpected.join(", ")}.`);
    process.exit(1);
  }
}

function targetInfo(): { host: string; db: string } {
  const url = new URL(env.MONGO_URI);
  return { host: url.hostname, db: url.pathname.replace(/^\//, "") || "(default)" };
}

function writeBackup(db: string, docs: unknown[]): string {
  const backupDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = resolve(backupDir, `visa-rules-india-backup-${db}-${stamp}.json`);
  writeFileSync(path, JSON.stringify(docs, null, 2), "utf8");
  return path;
}

async function confirmDatabaseName(expectedDb: string): Promise<void> {
  if (!rlInput.isTTY) {
    console.error("Refusing to run: --confirm requires an interactive terminal. Run this yourself in a shell.");
    process.exit(1);
  }
  const rl = readline.createInterface({ input: rlInput, output: rlOutput });
  try {
    const answer = await rl.question(`Type the database name ("${expectedDb}") to delete these rules: `);
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
  const matched = await VisaRule.find(DESTINATION_FILTER).lean();

  console.log("──────────────────────────────────────────────────────");
  console.log(`Target host:       ${target.host}`);
  console.log(`Target database:   ${target.db}`);
  console.log(`Collection:        ${VisaRule.collection.name}  (the ONLY collection this script can touch)`);
  console.log(`Filter:            destinationIso2 = "IN"  (India as DESTINATION, not as nationality)`);
  console.log(`Rules in collection: ${countBefore}`);
  console.log(`Rules matching:      ${matched.length}`);
  console.log("──────────────────────────────────────────────────────");
  for (const r of matched as any[]) {
    console.log(`  ${r._id}  ${r.destinationIso2} ${r.purpose}/${r.entryType}/${r.serviceTier} [${r.variantKey}]`);
    console.log(`      ${r.destinationName} · ${r.status} · ${(r.documentGroups || []).length} requirement group(s) · seedSource ${r.seedSource ?? "(none)"}`);
  }
  console.log("──────────────────────────────────────────────────────");

  if (matched.length === 0) {
    console.log("Nothing to do: no rule has India as its destination.");
    process.exit(0);
  }

  if (!confirmed) {
    console.log("DRY RUN — nothing was deleted and nothing was written.");
    console.log("Re-run with --confirm (and type the database name at the prompt) to delete these rules.");
    process.exit(0);
  }

  const backupPath = writeBackup(target.db, matched);
  console.log(`Backup written: ${backupPath} (${matched.length} documents)`);

  await confirmDatabaseName(target.db);

  // Deletes the EXACT ids listed above — not a re-run of the filter, so
  // nothing that appeared between the preview and the confirmation can be
  // caught by it.
  const ids = (matched as any[]).map((r) => r._id);
  const result = await VisaRule.deleteMany({ _id: { $in: ids } });
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
  console.error("delete-india-destination-visa-rules failed:", err);
  process.exit(1);
});
