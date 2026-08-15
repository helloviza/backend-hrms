// apps/backend/src/migrations/2026-08-16-backfill-visa-case-source.ts
//
// VisaRequest and VisaApplication gained `source: "B2B" | "D2C"` (Phase 1b,
// models/visaCaseSource.ts) — the channel a case came in through. It is
// written going forward at creation, and defaults to "B2B". This migration
// is the one-time catch-up for every row created BEFORE the field existed.
//
// A UNIFORM SAFE SET. Every case in the database today is B2B: the D2C
// surface does not exist yet (Phase 1a shipped the identity wall only, with
// no case-creating route). So unlike the processingDeadlineAt backfill this
// is modelled on, there is no per-row judgement to get wrong — no dateless
// bucket, no orphan bucket, no derivation. Every matched row gets the same
// literal value, which is why the summary is two counts rather than four.
//
// VisaActivityLog is DELIBERATELY NOT BACKFILLED. models/VisaActivityLog.ts's
// own header records the standing decision that the collection never
// synthesises history for what came before it shipped. Its `source` default
// of "B2B" already makes every historical row read correctly, since every
// case that predates D2C is B2B — writing the value onto old rows would
// assert a fact this migration recorded rather than one the event carried.
//
// Idempotent, two layers (inherited from the deadline backfill's posture):
//   - Only ever selects { source: { $exists: false } }. Mongoose defaults
//     apply on WRITE, never to already-stored documents, so $exists is a
//     true "predates this change" marker. A row already carrying a source —
//     backfilled here, or written by a creation path going forward — is
//     simply not matched, including one that is legitimately "D2C".
//   - The write re-checks $exists at write time, not just at the read, so a
//     concurrent write landing in between wins rather than being clobbered.
//
// ⚠ DATABASE SAFETY — identical to 2026-08-12-backfill-visa-application-
// travel-denorm.ts, because the hazard is identical: `.env` (which
// "dotenv/config" loads by default) points at the PRODUCTION cluster, and
// `.env.test` points at a remote Atlas cluster too. assertLocalDatabase()
// below is host-based and default-deny, additionally pins the database NAME
// to plumbox_dev so a local mongod holding a prod restore is still refused,
// and runs BEFORE mongoose.connect. The script also defaults to DRY RUN.
//
// Ledger — every run (dry-run, apply, or a thrown failure) is recorded in
// MigrationRun via lib/migrationRunner.ts. Once a successful --apply run is
// recorded, --apply is refused again unless --force is also passed.
//
// Usage (local — pass the dev env file explicitly, do NOT rely on .env):
//   node --env-file=.env.development --import tsx src/migrations/2026-08-16-backfill-visa-case-source.ts            # dry-run
//   node --env-file=.env.development --import tsx src/migrations/2026-08-16-backfill-visa-case-source.ts --apply     # write
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
import VisaRequest from "../models/VisaRequest.js";
import VisaApplication from "../models/VisaApplication.js";
import { DEFAULT_VISA_CASE_SOURCE } from "../models/visaCaseSource.js";
import { runMigration } from "./lib/migrationRunner.js";

/* ─────────────────────────────────────────────────────────────────────
 * THE GUARD. Lifted verbatim from the deadline backfill — a migration that
 * can be pointed at production is a production incident waiting for a tired
 * evening, and here the DEFAULT env file IS production. Host-based, so a
 * remote provider nobody has thought of is rejected without being listed.
 * ───────────────────────────────────────────────────────────────────── */

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "[::1]"]);
const REQUIRED_DB_NAME = "plumbox_dev";

export function assertLocalDatabase(uri: string): void {
  if (!uri) {
    throw new Error(
      "REFUSING TO RUN: MONGO_URI is empty. Pass --env-file=.env.development — see docs/dev-setup.md.",
    );
  }

  // mongodb+srv is Atlas-shaped by definition — never local. Rejected before
  // parsing, because the SRV form has no port and parses oddly.
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

  // Belt and braces: a local mongod can perfectly well be holding a restore
  // of production. The host check alone would happily let that through.
  if (dbName !== REQUIRED_DB_NAME) {
    throw new Error(
      `REFUSING TO RUN: MONGO_URI database is '${dbName || "(none)"}', expected '${REQUIRED_DB_NAME}'.\n` +
        "A local host is not on its own proof the data is local test data.",
    );
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * THE PRODUCTION PATH. Same three conditions the deadline backfill
 * established: an interactive TTY (so no CI job, cron or piped heredoc can
 * reach the write), the target printed FIRST and the database name typed
 * back exactly, and dry-run still the default so the acknowledgement flag
 * alone writes nothing. The ledger still refuses a second --apply without
 * --force.
 * ───────────────────────────────────────────────────────────────────── */
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

  // The TTY + typed-name challenge guards the WRITE only. A dry run touches
  // nothing, and making it unrunnable without a human at a keyboard would
  // block the very review step that has to happen BEFORE anyone --applies.
  // The explicit flag is still required for either, so a production read is
  // never accidental.
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
  requestsScanned: number;
  requestsBackfilled: number;
  applicationsScanned: number;
  applicationsBackfilled: number;
}

/**
 * Core, testable migration logic. Assumes the caller already has a live
 * Mongoose connection (or, in tests, an in-memory server) — never connects
 * or disconnects itself. dryRun=true computes and returns exactly the
 * summary a real run would produce, without writing anything.
 *
 * updateMany rather than a per-row loop: every matched row gets the SAME
 * literal value, so there is nothing to compute per row and nothing a
 * reviewer would want printed per row (unlike the deadline backfill, where
 * each row got its own derived date and the per-row report was the point).
 *
 * ── WHY THE WRITE GOES THROUGH THE RAW DRIVER ─────────────────────────
 * `source` is IMMUTABLE, enforced by a query-middleware guard on the models
 * (models/visaCaseSource.ts) that THROWS on any update touching the field.
 * That guard is doing its job — and it cannot make an exception for this
 * script, because a query-level hook sees the filter, not the rows, so it
 * has no way to tell "setting it for the first time on a legacy row" from
 * "re-channelling a live case".
 *
 * So the backfill writes through mongoose.connection.collection(...),
 * deliberately below the model layer. This is the ONLY sanctioned bypass and
 * it is safe precisely here: the value written is a hardcoded constant (no
 * casting to get wrong), and the $exists:false filter means it can only ever
 * land on a row that has no channel at all. Nothing in application code
 * should ever do this — if a future caller needs it, the answer is that they
 * are trying to change a case's channel, which is the thing the guard exists
 * to stop.
 */
export async function backfillVisaCaseSource(dryRun: boolean): Promise<MigrationSummary> {
  const selector = { source: { $exists: false } };

  // Reads go through the models (no guard involved) so the collection names
  // come from the schema registry rather than being restated as literals.
  const requestsScanned = await VisaRequest.countDocuments(selector);
  const applicationsScanned = await VisaApplication.countDocuments(selector);

  if (dryRun) {
    return {
      requestsScanned,
      requestsBackfilled: 0,
      applicationsScanned,
      applicationsBackfilled: 0,
    };
  }

  const requestCollection = VisaRequest.collection;
  const applicationCollection = VisaApplication.collection;

  // The selector is re-applied at write time, not just at the count above,
  // so a row that gained a source between the two (a concurrent creation)
  // is not clobbered back to the default.
  const requestResult = await requestCollection.updateMany(selector, {
    $set: { source: DEFAULT_VISA_CASE_SOURCE },
  });
  const applicationResult = await applicationCollection.updateMany(selector, {
    $set: { source: DEFAULT_VISA_CASE_SOURCE },
  });

  return {
    requestsScanned,
    requestsBackfilled: requestResult.modifiedCount ?? 0,
    applicationsScanned,
    applicationsBackfilled: applicationResult.modifiedCount ?? 0,
  };
}

async function main() {
  const dryRun = !process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  const productionAcknowledged = process.argv.includes("--i-know-this-is-production");

  console.log("=== Backfill VisaRequest/VisaApplication channel source ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}${productionAcknowledged ? " (PRODUCTION path)" : ""}`);

  // BEFORE connect, always — in both modes. A dry run against production is
  // still a connection to production, which is why the production path
  // prompts before this point too, not just before the write.
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
      migrationName: "2026-08-16-backfill-visa-case-source",
      mode: dryRun ? "DRY_RUN" : "APPLY",
      force,
      run: async () => {
        const summary = await backfillVisaCaseSource(dryRun);
        const summaryLine =
          `requestsScanned=${summary.requestsScanned} requestsBackfilled=${summary.requestsBackfilled} ` +
          `applicationsScanned=${summary.applicationsScanned} applicationsBackfilled=${summary.applicationsBackfilled}`;
        console.log(`Every matched row is set to "${DEFAULT_VISA_CASE_SOURCE}" — the D2C channel has`);
        console.log("created no cases yet, so this is a uniform set with no per-row judgement.");
        console.log("");
        console.log(summaryLine);
        console.log("");
        console.log(
          "VisaActivityLog is NOT backfilled by design — that collection never synthesises\n" +
            'history (see its own file header), and its "B2B" default already reads correctly.',
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
// trigger main() as an import side effect (that exact shape once caused an
// accidental dry-run against production — see
// migrations/2026-08-02-visa-checklist-model-v2.ts's history).
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
