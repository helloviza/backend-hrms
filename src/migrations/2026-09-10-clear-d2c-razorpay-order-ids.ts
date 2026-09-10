// apps/backend/src/migrations/2026-09-10-clear-d2c-razorpay-order-ids.ts
//
// ══════════════════════════════════════════════════════════════════════
// THE MID CUTOVER'S ONE DATA HAZARD: ORDERS STRANDED ON THE OLD ACCOUNT.
// ══════════════════════════════════════════════════════════════════════
// D2C visa fees move to their own Razorpay MID. A Razorpay order belongs to
// the account that minted it, and a checkout opened with account B's key id
// against an order minted by account A is rejected outright.
//
// routes/consumer.applications.ts REUSES a stored order rather than minting
// a second one for the same application:
//
//     if (application.razorpayOrderId) { ...return it, reused: true... }
//
// That branch is correct — it is what stops one application accumulating a
// trail of half-open orders — and at the cutover it becomes a trap. Every
// unpaid application still holding an OLD-MID order id will, from the
// moment the new keys are live, hand the browser the NEW key id together
// with the OLD order id. Razorpay rejects the pair. The consumer gets a Pay
// button that fails every time, forever, because the reuse branch never
// re-mints and nothing in the flow expires the stored id.
//
// So the stored id is cleared for exactly those applications. At the next
// click the endpoint takes its "no order yet" path and mints a fresh order
// on the new MID. Nothing else about the application changes.
//
// ── WHAT IS DELIBERATELY NOT TOUCHED ─────────────────────────────────
// PAID applications keep their order id. It is the reference tying a case
// to a settlement on the old account, it appears on the invoice trail, and
// the case will never open checkout again. Clearing it would destroy
// reconciliation evidence to fix a problem paid cases do not have.
//
// B2B/SBT rows are not in scope at all — they live in different collections
// and their MID is unchanged.
//
// ── null, NOT $unset ─────────────────────────────────────────────────
// models/VisaApplication.ts declares `razorpayOrderId: { type: String,
// default: null }`, so null is the state a never-ordered application is
// already in, and it is what the reuse check reads as "no order". $unset
// would leave the path ABSENT — a third document shape the schema never
// produces, differing from every other unpaid row in the collection for no
// gain. Both are falsy to the reuse branch; only one of them is the state
// the model already defines. See the ORDER OF OPERATIONS note below: this
// migration must run in the window where a re-mint is what we want.
//
// ── ORDER OF OPERATIONS AT CUTOVER ───────────────────────────────────
// Run this AFTER the new keys are live in App Runner, not before. Cleared
// early, an application re-mints on the OLD MID and lands right back in the
// state this exists to clear. Cleared after, the very next click mints on
// the new one.
//
// A consumer who pays in the minutes before this runs is fine either way:
// their payment.captured arrives at the OLD webhook endpoint, which
// deliberately keeps its VisaApplication lookup for exactly this drain
// window (routes/razorpay.webhook.ts). This migration never touches a case
// that is already PAID, so a payment landing mid-run cannot be un-linked.
//
// Idempotent: the selector only ever matches rows that still hold an order
// id, so a second run finds fewer (eventually zero) and writes nothing new.
//
// ⚠ DATABASE SAFETY — identical to every migration in this directory,
// because the hazard is identical: `.env` (which "dotenv/config" loads by
// default) points at the PRODUCTION cluster and `.env.test` is remote too.
// assertLocalDatabase() is host-based, default-deny, additionally pins the
// database NAME to plumbox_dev, and runs BEFORE mongoose.connect. Dry run
// is the default.
//
// Ledger — every run (dry-run, apply, or a thrown failure) is recorded in
// MigrationRun via lib/migrationRunner.ts. Once a successful --apply run is
// recorded, --apply is refused again unless --force is also passed.
//
// Usage (local — pass the dev env file explicitly, do NOT rely on .env):
//   node --env-file=.env.development --import tsx src/migrations/2026-09-10-clear-d2c-razorpay-order-ids.ts           # dry-run
//   node --env-file=.env.development --import tsx src/migrations/2026-09-10-clear-d2c-razorpay-order-ids.ts --apply   # write
//
// Production (deliberate, interactive, never scriptable).
//
// ⚠ NOTE THE ENV FILE. It is NOT .env.development, and it is NOT the bare
// `.env` that "dotenv/config" loads by default — pass the PRODUCTION env
// file by path, explicitly, on the command line:
//
//   node --env-file=<path to the prod .env> --import tsx src/migrations/2026-09-10-clear-d2c-razorpay-order-ids.ts --i-know-this-is-production            # dry run against prod
//   node --env-file=<path to the prod .env> --import tsx src/migrations/2026-09-10-clear-d2c-razorpay-order-ids.ts --i-know-this-is-production --apply    # writes; prompts for the db name
//
// NOT YET RUN. It runs once, at the MID cutover, after the new keys are live.
import "dotenv/config";
import path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as rlInput, stdout as rlOutput } from "node:process";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import VisaApplication from "../models/VisaApplication.js";
import { runMigration } from "./lib/migrationRunner.js";

/* ─────────────────────────────────────────────────────────────────────
 * THE GUARD. Lifted verbatim from the sibling migrations — a migration
 * that can be pointed at production is a production incident waiting for a
 * tired evening, and here the DEFAULT env file IS production.
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
  /** D2C applications holding a stored order id, paid or not. Context only. */
  d2cWithOrderId: number;
  /** PAID ones among them — deliberately left alone. */
  paidLeftIntact: number;
  /** UNPAID ones holding an old-MID order id — the population to clear. */
  strandedUnpaid: number;
  /** Actually cleared (0 on a dry run). */
  cleared: number;
}

/**
 * THE SELECTOR, in one place so the count and the write cannot drift.
 *
 * `$nin: [null, ""]` rather than `$ne: null`, because "has an order" has two
 * falsy spellings here: the schema default (null) and an empty string, which
 * an early hand-edit or a partial write could leave behind. Neither is an
 * order, and neither should be counted as one.
 */
const STRANDED_SELECTOR = {
  source: "D2C",
  razorpayOrderId: { $nin: [null, ""] },
  d2cPaymentStatus: { $ne: "PAID" },
} as const;

/**
 * Core, testable migration logic. Assumes the caller already has a live
 * Mongoose connection (or, in tests, an in-memory server) — never connects
 * or disconnects itself. dryRun=true computes and returns exactly the
 * summary a real run would produce, without writing anything.
 *
 * One updateMany, not a per-row loop: every matched row takes the SAME
 * value (null), so there is nothing per-row to compute and a single
 * statement is both faster and atomic per document.
 */
export async function clearD2CRazorpayOrderIds(dryRun: boolean): Promise<MigrationSummary> {
  const withOrderSelector = { source: "D2C", razorpayOrderId: { $nin: [null, ""] } };

  const d2cWithOrderId = await VisaApplication.countDocuments(withOrderSelector);
  const strandedUnpaid = await VisaApplication.countDocuments(STRANDED_SELECTOR);
  const paidLeftIntact = d2cWithOrderId - strandedUnpaid;

  if (dryRun) {
    return { d2cWithOrderId, paidLeftIntact, strandedUnpaid, cleared: 0 };
  }

  // The selector is re-evaluated at WRITE time, not reused from the count
  // above: a consumer who paid in between must NOT be cleared, and
  // re-matching is what guarantees that rather than assuming it.
  const result = await VisaApplication.updateMany(STRANDED_SELECTOR, {
    $set: { razorpayOrderId: null },
  });

  return {
    d2cWithOrderId,
    paidLeftIntact,
    strandedUnpaid,
    cleared: result.modifiedCount ?? 0,
  };
}

async function main() {
  const dryRun = !process.argv.includes("--apply");
  const force = process.argv.includes("--force");
  const productionAcknowledged = process.argv.includes("--i-know-this-is-production");

  console.log("=== Clear stranded D2C Razorpay order ids (helloviza MID cutover) ===");
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
      migrationName: "2026-09-10-clear-d2c-razorpay-order-ids",
      mode: dryRun ? "DRY_RUN" : "APPLY",
      force,
      run: async () => {
        const summary = await clearD2CRazorpayOrderIds(dryRun);
        const summaryLine =
          `d2cWithOrderId=${summary.d2cWithOrderId} paidLeftIntact=${summary.paidLeftIntact} ` +
          `strandedUnpaid=${summary.strandedUnpaid} cleared=${summary.cleared}`;

        console.log("An unpaid application holding an order id minted on the OLD Razorpay MID");
        console.log("would hand the browser the NEW key id with the OLD order id — a Pay button");
        console.log("that fails every time, because the reuse branch never re-mints. Clearing the");
        console.log("stored id makes the next click mint a fresh order on the new MID.");
        console.log("");
        console.log(summaryLine);
        console.log("");
        console.log(
          `${summary.paidLeftIntact} PAID application(s) keep their order id on purpose — it ties\n` +
            "the case to a settlement on the old account and appears on the invoice trail.\n" +
            "They will never open checkout again.",
        );
        if (dryRun) {
          console.log("");
          console.log("⚠ Run this AFTER the new keys are live in App Runner. Cleared before, an");
          console.log("  application simply re-mints on the OLD MID and is stranded again.");
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
