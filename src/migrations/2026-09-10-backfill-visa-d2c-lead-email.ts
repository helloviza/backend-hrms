// apps/backend/src/migrations/2026-09-10-backfill-visa-d2c-lead-email.ts
//
// VisaD2CLead gained a denormalised `email` (models/VisaD2CLead.ts) so the
// unified Master Sheet can key a lead row to the same PERSON as their score
// checks — email being the only identifier all three of the sheet's arms can
// carry. It is written going forward in both $setOnInsert sites
// (routes/consumer.applications.ts). This is the one-time catch-up for every
// row created BEFORE the field existed.
//
// ── WHY THE ROWS ARE NOT SIMPLY LEFT ALONE ───────────────────────────
// The sheet's union EXCLUDES lead rows with no email, because a row that
// cannot be keyed to a person would otherwise group every such row together
// under one null and invent a person who "started" a dozen unrelated
// corridors. Excluding them is correct and it is also lossy: until this
// runs, every pre-existing application is missing from the sheet. The
// endpoint reports the outstanding count as `legacyUnkeyedLeads` precisely
// so that gap is visible rather than looking like an empty funnel.
//
// ── PER-ROW, NOT updateMany ──────────────────────────────────────────
// Unlike 2026-08-16-backfill-visa-case-source.ts (which this is modelled on
// and which writes ONE literal to every matched row), each row here gets a
// DIFFERENT value — the email of the Consumer its consumerId points at. So
// this resolves in batches and reports four counts, not two: some rows will
// have a consumerId that no longer resolves (an erased consumer, a hand-
// edited row), and those are left untouched and COUNTED rather than written
// as null. A null would be indistinguishable from "not yet backfilled" and
// would make a re-run unable to find them.
//
// Idempotent, two layers (the same posture the case-source backfill sets):
//   - Only ever selects { email: { $exists: false } }. The field has NO
//     schema default, deliberately (see the model), so $exists is a true
//     "predates this change" marker rather than something Mongoose fills in.
//   - The write re-checks $exists at write time, not just at the read, so a
//     row that gained an email in between (a concurrent /start by that very
//     person) wins rather than being clobbered by a stale value.
//
// ⚠ DATABASE SAFETY — identical to the case-source backfill, because the
// hazard is identical: `.env` (which "dotenv/config" loads by default)
// points at the PRODUCTION cluster and `.env.test` is remote too.
// assertLocalDatabase() is host-based, default-deny, additionally pins the
// database NAME to plumbox_dev so a local mongod holding a prod restore is
// still refused, and runs BEFORE mongoose.connect. Dry run is the default.
//
// ⚠ THIS WRITES A PII COPY. That is the whole point of the field, and it is
// why B3 shipped WITH B1: scripts/lib/consumerErasureCascade.ts sweeps
// VisaD2CLead by consumerId OR email before this migration can put an
// address anywhere erasure could not reach it. Do not run this against a
// database whose cascade predates that change.
//
// Ledger — every run (dry-run, apply, or a thrown failure) is recorded in
// MigrationRun via lib/migrationRunner.ts. Once a successful --apply run is
// recorded, --apply is refused again unless --force is also passed.
//
// Usage (local — pass the dev env file explicitly, do NOT rely on .env):
//   node --env-file=.env.development --import tsx src/migrations/2026-09-10-backfill-visa-d2c-lead-email.ts           # dry-run
//   node --env-file=.env.development --import tsx src/migrations/2026-09-10-backfill-visa-d2c-lead-email.ts --apply   # write
//
// Production (deliberate, interactive, never scriptable):
//   ... --i-know-this-is-production            # dry run against prod
//   ... --i-know-this-is-production --apply    # prompts for the db name
import "dotenv/config";
import path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as rlInput, stdout as rlOutput } from "node:process";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import Consumer from "../models/Consumer.js";
import VisaD2CLead from "../models/VisaD2CLead.js";
import { runMigration } from "./lib/migrationRunner.js";

/* ─────────────────────────────────────────────────────────────────────
 * THE GUARD. Lifted from the case-source backfill — a migration that can be
 * pointed at production is a production incident waiting for a tired
 * evening, and here the DEFAULT env file IS production.
 * ───────────────────────────────────────────────────────────────────── */

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "[::1]"]);
const REQUIRED_DB_NAME = "plumbox_dev";

export function assertLocalDatabase(uri: string): void {
  if (!uri) {
    throw new Error(
      "REFUSING TO RUN: MONGO_URI is empty. Pass --env-file=.env.development — see docs/dev-setup.md.",
    );
  }

  if (uri.startsWith("mongodb+srv://")) {
    throw new Error(
      "REFUSING TO RUN: MONGO_URI is a mongodb+srv:// (Atlas) connection string.\n" +
        "This migration only ever runs against the local development database.\n" +
        "Note that BOTH .env (production) and .env.test are remote — pass\n" +
        "--env-file=.env.development explicitly.",
    );
  }

  let hosts: string[];
  let dbName: string;
  try {
    const afterScheme = uri.replace(/^mongodb:\/\//, "");
    const afterCreds = afterScheme.includes("@") ? afterScheme.slice(afterScheme.indexOf("@") + 1) : afterScheme;
    const [hostPart, ...rest] = afterCreds.split("/");
    hosts = hostPart.split(",").map((h) => h.split(":")[0].trim().toLowerCase());
    dbName = (rest.join("/") || "").split("?")[0].trim();
  } catch {
    throw new Error("REFUSING TO RUN: could not parse MONGO_URI to verify it is local.");
  }

  const remote = hosts.filter((h) => !LOCAL_HOSTS.has(h));
  if (remote.length) {
    throw new Error(
      `REFUSING TO RUN: MONGO_URI points at non-local host(s): ${remote.join(", ")}.\n` +
        "This migration only ever runs against the local development database.",
    );
  }

  if (dbName !== REQUIRED_DB_NAME) {
    throw new Error(
      `REFUSING TO RUN: MONGO_URI database is '${dbName || "(none)"}', expected '${REQUIRED_DB_NAME}'.\n` +
        "A local host is not on its own proof the data is local test data.",
    );
  }
}

export function describeTarget(uri: string): { host: string; db: string } {
  try {
    const afterScheme = uri.replace(/^mongodb(\+srv)?:\/\//, "");
    const afterCreds = afterScheme.includes("@") ? afterScheme.slice(afterScheme.indexOf("@") + 1) : afterScheme;
    const [hostPart, ...rest] = afterCreds.split("/");
    return {
      host: hostPart.split(",")[0].split(":")[0].trim(),
      db: (rest.join("/") || "").split("?")[0].trim() || "(default)",
    };
  } catch {
    return { host: "(unparseable)", db: "(unparseable)" };
  }
}

async function assertProductionAcknowledged(uri: string, willWrite: boolean): Promise<void> {
  if (!uri) throw new Error("REFUSING TO RUN: MONGO_URI is empty.");

  const { host, db } = describeTarget(uri);

  console.log("──────────────────────────────────────────────────────");
  console.log("  PRODUCTION TARGET");
  console.log(`  host:     ${host}`);
  console.log(`  database: ${db}`);
  console.log(`  action:   ${willWrite ? "WRITE (--apply)" : "read-only dry run"}`);
  console.log("──────────────────────────────────────────────────────");

  // The TTY + typed-name challenge guards the WRITE only — a dry run touches
  // nothing, and making it unrunnable without a human at a keyboard would
  // block the very review step that has to happen BEFORE anyone --applies.
  if (!willWrite) return;

  if (!rlInput.isTTY) {
    throw new Error(
      "REFUSING TO RUN: --apply against production requires typing the database name at an " +
        "interactive terminal, and stdin is not a TTY. Run this yourself in a shell.",
    );
  }

  const rl = readline.createInterface({ input: rlInput, output: rlOutput });
  try {
    const answer = await rl.question(`Type the database name ("${db}") to WRITE: `);
    if (answer.trim() !== db) {
      throw new Error("Aborted: input did not match the database name. Nothing was written.");
    }
  } finally {
    rl.close();
  }
}

export interface MigrationSummary {
  /** Rows with no email at all — the backfill's whole population. */
  scanned: number;
  /** Rows whose consumerId resolved to a Consumer carrying an address. */
  resolved: number;
  /** Rows actually written (0 on a dry run). */
  backfilled: number;
  /** Resolved to nothing — consumer erased, or an address-less Consumer.
   *  Left untouched ON PURPOSE, so a later run can still find them. */
  unresolved: number;
}

const BATCH_SIZE = 500;

/**
 * Core, testable migration logic. Assumes the caller already has a live
 * Mongoose connection (or, in tests, an in-memory server) — never connects
 * or disconnects itself. dryRun=true computes and returns exactly the
 * summary a real run would produce, without writing anything.
 *
 * Batched rather than one big $lookup-and-merge: the batch bound is what
 * keeps memory flat regardless of how large the collection has grown, and a
 * per-row updateOne is what lets each row carry its own value while still
 * re-checking $exists at write time.
 */
export async function backfillVisaD2CLeadEmail(dryRun: boolean): Promise<MigrationSummary> {
  const selector = { email: { $exists: false } };

  const scanned = await VisaD2CLead.countDocuments(selector);
  let resolved = 0;
  let backfilled = 0;
  let unresolved = 0;

  // Sorted by _id so batching is stable: without a total order, skipping
  // forward can revisit or miss rows as the collection changes underneath.
  let lastId: mongoose.Types.ObjectId | null = null;

  for (;;) {
    const query: Record<string, unknown> = { ...selector };
    if (lastId) query._id = { $gt: lastId };

    const batch = await VisaD2CLead.find(query)
      .select("_id consumerId")
      .sort({ _id: 1 })
      .limit(BATCH_SIZE)
      .lean();

    if (!batch.length) break;
    lastId = (batch[batch.length - 1] as any)._id;

    const consumerIds = [...new Set(batch.map((r: any) => String(r.consumerId)).filter(Boolean))];
    const consumers = await Consumer.find({ _id: { $in: consumerIds } })
      .select("_id email")
      .lean();
    const emailById = new Map(
      (consumers as any[])
        .filter((c) => c?.email)
        .map((c) => [String(c._id), String(c.email).toLowerCase()]),
    );

    for (const row of batch as any[]) {
      const email = emailById.get(String(row.consumerId));
      if (!email) {
        // No address to write. NOT written as null — see MigrationSummary.
        unresolved += 1;
        continue;
      }
      resolved += 1;
      if (dryRun) continue;

      // $exists re-checked at WRITE time, not just at the read above: the
      // person may have hit /start between the two, and their live address
      // must win over the one this batch resolved.
      const result = await VisaD2CLead.updateOne(
        { _id: row._id, email: { $exists: false } },
        { $set: { email } },
      );
      backfilled += result.modifiedCount ?? 0;
    }
  }

  return { scanned, resolved, backfilled, unresolved };
}

async function main() {
  const dryRun = !process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  const productionAcknowledged = process.argv.includes("--i-know-this-is-production");

  console.log("=== Backfill VisaD2CLead.email (Master Sheet union key) ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}${productionAcknowledged ? " (PRODUCTION path)" : ""}`);

  // BEFORE connect, always — in both modes. A dry run against production is
  // still a connection to production.
  if (productionAcknowledged) {
    await assertProductionAcknowledged(env.MONGO_URI, !dryRun);
  } else {
    assertLocalDatabase(env.MONGO_URI);
  }

  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");

  try {
    await runMigration({
      migrationName: "2026-09-10-backfill-visa-d2c-lead-email",
      mode: dryRun ? "DRY_RUN" : "APPLY",
      force,
      run: async () => {
        const summary = await backfillVisaD2CLeadEmail(dryRun);
        const summaryLine =
          `scanned=${summary.scanned} resolved=${summary.resolved} ` +
          `backfilled=${summary.backfilled} unresolved=${summary.unresolved}`;
        console.log("Each row takes the email of the Consumer its consumerId points at, so unlike");
        console.log("the case-source backfill this is a per-row value and reports four counts.");
        console.log("");
        console.log(summaryLine);
        console.log("");
        if (summary.unresolved > 0) {
          console.log(
            `${summary.unresolved} row(s) could not be resolved — the consumer was erased, or\n` +
              "carries no address. They are LEFT UNTOUCHED on purpose: writing null would be\n" +
              "indistinguishable from 'not yet backfilled' and a later run could not find them.\n" +
              "They stay excluded from the Master Sheet union and counted as legacyUnkeyedLeads.",
          );
          console.log("");
        }
        console.log(
          "⚠ This writes a PII copy. It is only safe on a database whose erasure cascade\n" +
            "already sweeps VisaD2CLead by consumerId OR email (B3, shipped with the field).",
        );
        if (dryRun) {
          console.log("");
          console.log("Re-run with --apply to write these changes.");
        }
        return { outcome: "SUCCESS", summary: summaryLine };
      },
    });
  } finally {
    await mongoose.connection.close();
  }
}

// Auto-run ONLY when this file is the actual process entry point — an
// env-var guard alone protects against the test runner but NOT against
// another module importing this file for its exports, which would silently
// trigger main() as an import side effect.
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
