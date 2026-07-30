// apps/backend/src/scripts/purge-visa-seed.ts
//
// Deletes ONLY documents written by scripts/seed-visa-rules.ts — identified
// by the `seedSource` marker that script stamps on every row it writes (see
// models/VisaRule.ts / VisaDestinationContent.ts) — from VisaRule and
// VisaDestinationContent, and nothing else. Real rows created through the
// (future) fee-management UI never carry seedSource and can never match.
//
// Same guard shape as the seed script:
//   1. assertModelScope()   — only VisaRule/VisaDestinationContent may be
//      registered with mongoose when this runs.
//   2. assertAllMatchedHaveSeedSource() — re-checks every matched document
//      actually carries a non-empty seedSource before deleting anything. If
//      the filter is ever wrong (e.g. a future edit loosens it), this is
//      the last line of defense before a real row gets caught in it.
//   3. Refuses to run if nothing matches in EITHER collection — a zero-match
//      run is either already-clean state or a sign the filter/marker
//      drifted; neither should proceed silently.
//   4. Prints target host/database, collections, and exact counts before
//      deleting anything, then requires the database name typed to proceed
//      (or --yes for non-interactive runs).
//
// Run: pnpm -C apps/backend tsx src/scripts/purge-visa-seed.ts [--yes]
import * as readline from "node:readline/promises";
import { stdin as rlInput, stdout as rlOutput } from "node:process";
import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import { env } from "../config/env.js";
import VisaRule from "../models/VisaRule.js";
import VisaDestinationContent from "../models/VisaDestinationContent.js";

// Matches any row with a real (present, non-empty) seedSource — never a
// broader filter than that.
const SEED_MARKER_FILTER = { seedSource: { $exists: true, $ne: null } } as const;

const ALLOWED_MODELS = ["VisaRule", "VisaDestinationContent"];

function assertModelScope(): void {
  const registered = mongoose.modelNames();
  const unexpected = registered.filter((name) => !ALLOWED_MODELS.includes(name));
  if (unexpected.length > 0) {
    console.error(
      `Refusing to run: this script may only delete from ${ALLOWED_MODELS.join(" and ")}, but ` +
        `additional model(s) are registered: ${unexpected.join(", ")}.`,
    );
    process.exit(1);
  }
}

function targetInfo(): { host: string; db: string } {
  const url = new URL(env.MONGO_URI);
  const host = url.hostname;
  const db = url.pathname.replace(/^\//, "") || "(default)";
  return { host, db };
}

/**
 * Re-fetches every document the delete filter matches and asserts each one
 * actually carries a non-empty seedSource. Redundant with the filter itself
 * by construction — that's the point: if a future edit ever loosens
 * SEED_MARKER_FILTER, this independent check still catches it before any
 * delete runs, rather than trusting the filter that's about to be used for
 * the delete to also be the thing that proves the delete is safe.
 */
async function assertAllMatchedHaveSeedSource(): Promise<{
  ruleIds: string[];
  contentIds: string[];
  ruleSeedSources: Set<string>;
  contentSeedSources: Set<string>;
}> {
  const rules = await VisaRule.find(SEED_MARKER_FILTER).select("_id seedSource").lean();
  const content = await VisaDestinationContent.find(SEED_MARKER_FILTER).select("_id seedSource").lean();

  const badRule = rules.find((r) => !r.seedSource);
  const badContent = content.find((c) => !c.seedSource);
  if (badRule || badContent) {
    console.error(
      "Refusing to run: the delete filter matched at least one document with no seedSource set — " +
        "the filter is wrong. Aborting before deleting anything.",
    );
    process.exit(1);
  }

  return {
    ruleIds: rules.map((r) => String(r._id)),
    contentIds: content.map((c) => String(c._id)),
    ruleSeedSources: new Set(rules.map((r) => r.seedSource as string)),
    contentSeedSources: new Set(content.map((c) => c.seedSource as string)),
  };
}

function printPlan(
  target: { host: string; db: string },
  matched: Awaited<ReturnType<typeof assertAllMatchedHaveSeedSource>>,
): void {
  console.log("──────────────────────────────────────────────────────");
  console.log(`Target host:       ${target.host}`);
  console.log(`Target database:   ${target.db}`);
  console.log(`Collections deleted from: ${VisaRule.collection.name}, ${VisaDestinationContent.collection.name}`);
  console.log(`  ${VisaRule.collection.name}: ${matched.ruleIds.length} to delete`);
  console.log(`    seedSource values: ${[...matched.ruleSeedSources].join(", ") || "(none)"}`);
  console.log(`  ${VisaDestinationContent.collection.name}: ${matched.contentIds.length} to delete`);
  console.log(`    seedSource values: ${[...matched.contentSeedSources].join(", ") || "(none)"}`);
  console.log("──────────────────────────────────────────────────────");
}

async function confirmDatabaseName(expectedDb: string): Promise<void> {
  if (process.argv.includes("--yes")) {
    console.log("--yes passed — skipping interactive confirmation.");
    return;
  }
  const rl = readline.createInterface({ input: rlInput, output: rlOutput });
  try {
    const answer = await rl.question(`Type the database name ("${expectedDb}") to proceed: `);
    if (answer.trim() !== expectedDb) {
      console.error("Aborted: input did not match the database name.");
      process.exit(1);
    }
  } finally {
    rl.close();
  }
}

async function run() {
  await connectDb();
  assertModelScope();

  const target = targetInfo();
  const matched = await assertAllMatchedHaveSeedSource();

  const totalMatched = matched.ruleIds.length + matched.contentIds.length;
  if (totalMatched === 0) {
    console.log("Nothing to do: no VisaRule or VisaDestinationContent documents carry a seedSource marker.");
    process.exit(0);
  }

  printPlan(target, matched);
  await confirmDatabaseName(target.db);

  const ruleResult = matched.ruleIds.length
    ? await VisaRule.deleteMany({ _id: { $in: matched.ruleIds } })
    : { deletedCount: 0 };
  const contentResult = matched.contentIds.length
    ? await VisaDestinationContent.deleteMany({ _id: { $in: matched.contentIds } })
    : { deletedCount: 0 };

  console.log(
    `Purged: ${ruleResult.deletedCount ?? 0} VisaRule row(s), ` +
      `${contentResult.deletedCount ?? 0} VisaDestinationContent row(s).`,
  );
  process.exit(0);
}

run().catch((err) => {
  console.error("purge-visa-seed failed:", err);
  process.exit(1);
});
