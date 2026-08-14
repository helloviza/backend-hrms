// apps/backend/src/migrations/2026-08-12-backfill-visa-application-travel-denorm.ts
//
// VisaApplication gained three denormalised fields copied down from its
// parent VisaRequest (models/VisaApplication.ts): travelDateFrom,
// destinationIso2 and processingDeadlineAt. They are written going forward
// at creation time by routes/visa.ts's POST /requests, on the same line
// customerId already is. This migration is the one-time catch-up for every
// application created BEFORE those fields existed, so the ops queue's
// query-side filter/sort (routes/admin.visa.ts's GET /queue) sees a fully
// populated collection.
//
// processingDeadlineAt is derived per application from its OWN frozen
// ruleSnapshot (etaMaxDays/etaBasis) plus the parent's travelDateFrom, via
// the same utils/visaEta.ts helper the creation path uses — one definition,
// so a backfilled row and a newly-created row are computed identically.
//
// DATELESS ROWS ARE WRITTEN, NOT SKIPPED. A request with no travelDateFrom
// is genuinely unassessable, and null is the correct terminal value for it —
// not a gap. Skipping would leave the field ABSENT, so the row would be
// re-selected by every future run and the migration would never converge.
// Writing explicit null flips "$exists" to true and it converges. Counted
// separately as `dateless` so "genuinely has no travel date" is never
// conflated with "we failed to resolve one" — the same distinction the
// customerId backfill draws between resolved and unresolved.
//
// Idempotent, two layers (the customerId backfill's own posture):
//   - Only ever selects { processingDeadlineAt: { $exists: false } }.
//     Mongoose defaults apply on WRITE, never to already-stored documents,
//     so $exists is a true "predates this change" marker. A row already
//     backfilled — by this migration or by POST /requests going forward —
//     is simply not matched.
//   - The write re-checks $exists at write time, not just at the read, so a
//     concurrent write landing in between wins rather than being clobbered.
//
// ⚠ DATABASE SAFETY. `.env` (which "dotenv/config" loads by default) points
// at the PRODUCTION cluster, and `.env.test` points at a remote Atlas
// cluster too — so neither the default invocation nor "it's the test env"
// is safe here. assertLocalDatabase() below is the only thing between this
// script and production: it is host-based and default-deny (lifted from
// seed/seed-dev.ts), it additionally pins the database NAME to plumbox_dev
// so a local mongod holding a prod restore is still refused, and it runs
// BEFORE mongoose.connect. The script also defaults to DRY RUN.
//
// Ledger — every run (dry-run, apply, or a thrown failure) is recorded in
// MigrationRun via lib/migrationRunner.ts. Once a successful --apply run is
// recorded, --apply is refused again unless --force is also passed.
//
// Usage (local only — pass the dev env file explicitly, do NOT rely on .env):
//   node --env-file=.env.development --import tsx src/migrations/2026-08-12-backfill-visa-application-travel-denorm.ts            # dry-run
//   node --env-file=.env.development --import tsx src/migrations/2026-08-12-backfill-visa-application-travel-denorm.ts --apply     # write
import "dotenv/config";
import path from "node:path";
import * as readline from "node:readline/promises";
import { stdin as rlInput, stdout as rlOutput } from "node:process";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import VisaRequest from "../models/VisaRequest.js";
import VisaApplication from "../models/VisaApplication.js";
import { computeProcessingDeadline } from "../utils/visaEta.js";
import { runMigration } from "./lib/migrationRunner.js";

/* ─────────────────────────────────────────────────────────────────────
 * THE GUARD. A migration that can be pointed at production is a
 * production incident waiting for a tired evening — and here the DEFAULT
 * env file IS production, so this is not hypothetical. Refuses by default:
 * the check is on the host, so a remote provider nobody has thought of is
 * rejected without needing to be listed anywhere.
 * ───────────────────────────────────────────────────────────────────── */

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "[::1]"]);
const REQUIRED_DB_NAME = "plumbox_dev";

export function assertLocalDatabase(uri: string): void {
  if (!uri) {
    throw new Error(
      "REFUSING TO RUN: MONGO_URI is empty. Pass --env-file=.env.development — see docs/dev-setup.md.",
    );
  }

  // mongodb+srv is Atlas-shaped by definition — never local. Rejected
  // before parsing, because the SRV form has no port and parses oddly.
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
 * THE PRODUCTION PATH (2026-08-13). Added because the 21 pre-existing
 * production applications genuinely need this backfill — without it the
 * ops queue reads them as unassessable — and assertLocalDatabase above
 * cannot be satisfied by any production connection string by design.
 *
 * assertLocalDatabase REMAINS THE DEFAULT and is untouched. This path is
 * only reachable with --i-know-this-is-production, and even then every
 * one of these must hold:
 *   1. an interactive TTY (refused outright otherwise, so no CI job, no
 *      cron, no piped heredoc can ever reach the write);
 *   2. the target host and database printed FIRST, then the database name
 *      typed back exactly — the same challenge scripts/
 *      delete-all-visa-rules.ts uses before a destructive production
 *      write;
 *   3. dry run still the default — --apply is a separate, additional
 *      flag, so the acknowledgement flag alone writes nothing.
 * The ledger (runMigration) still refuses a second --apply without
 * --force, and the migration body is untouched: same $exists:false
 * selection, same write-time recheck, same computeProcessingDeadline.
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

// Exported so later migrations needing the same production path reuse this
// one rather than re-deriving it — a second, drifting copy of a guard this
// careful is a liability. Safe to import: the auto-run at the bottom of
// this file is behind an isDirectRun check for exactly that reason.
export async function assertProductionAcknowledged(uri: string, willWrite: boolean): Promise<void> {
  if (!uri) throw new Error("REFUSING TO RUN: MONGO_URI is empty.");

  const { host, db } = describeTarget(uri);

  console.log("──────────────────────────────────────────────────────");
  console.log("  PRODUCTION TARGET");
  console.log(`  host:     ${host}`);
  console.log(`  database: ${db}`);
  console.log(`  action:   ${willWrite ? "WRITE (--apply)" : "read-only dry run"}`);
  console.log("──────────────────────────────────────────────────────");

  // The TTY + typed-name challenge guards the WRITE. A dry run touches
  // nothing — it only reads and prints what a write would do — and making
  // that unrunnable without a human at a keyboard would block the very
  // review step that has to happen BEFORE anyone is allowed to --apply.
  // The explicit --i-know-this-is-production flag is still required for
  // either, so a production read is never accidental.
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
  applicationsScanned: number; // rows lacking the denormalised fields
  backfilled: number; // parent had a travel date — a real deadline was computed
  dateless: number; // parent genuinely has no travel date — written as null, not a gap
  orphaned: number; // parent request row missing entirely — left untouched, never guessed
}

/**
 * Core, testable migration logic. Assumes the caller already has a live
 * Mongoose connection (or, in tests, an in-memory server) — never connects
 * or disconnects itself. dryRun=true computes and returns exactly the
 * summary a real run would produce, without writing anything.
 */
export interface BackfillRowReport {
  applicationId: string;
  requestId: string;
  travelDateFrom: Date | null;
  destinationIso2: string | null;
  etaMaxDays: number | null;
  etaBasis: string | null;
  processingDeadlineAt: Date | null;
  kind: "backfilled" | "dateless" | "orphaned";
}

/**
 * onRow (2026-08-13) — optional, purely observational. Added so a
 * production dry run can show WHICH deadline each row would get rather
 * than only the four summary totals: a reviewer approving a production
 * write needs to see the values, not just the counts. Never affects what
 * is selected, computed or written; omitting it reproduces the previous
 * behaviour exactly.
 */
export async function backfillVisaApplicationTravelDenorm(
  dryRun: boolean,
  onRow?: (row: BackfillRowReport) => void,
): Promise<MigrationSummary> {
  const summary: MigrationSummary = {
    applicationsScanned: 0,
    backfilled: 0,
    dateless: 0,
    orphaned: 0,
  };

  const applications = await VisaApplication.find({
    processingDeadlineAt: { $exists: false },
  })
    .select("_id requestId ruleSnapshot.etaMaxDays ruleSnapshot.etaBasis")
    .lean();

  // One read per distinct parent rather than per application — a
  // multi-traveller request would otherwise be fetched once per child.
  const requestIds = [...new Set((applications as any[]).map((a) => String(a.requestId)))];
  const requests = await VisaRequest.find({ _id: { $in: requestIds } })
    .select("_id travelDateFrom destinationIso2")
    .lean();
  const requestById = new Map((requests as any[]).map((r) => [String(r._id), r]));

  for (const a of applications as any[]) {
    summary.applicationsScanned += 1;

    const request = requestById.get(String(a.requestId));
    if (!request) {
      // No parent to copy from. Left ALONE — not written as null, because
      // that would assert "this case has no travel date" when the truth is
      // "we could not find out". It stays $exists:false and is re-reported
      // by every future run, which is the correct loud behaviour for data
      // that shouldn't be possible.
      summary.orphaned += 1;
      onRow?.({
        applicationId: String(a._id),
        requestId: String(a.requestId),
        travelDateFrom: null,
        destinationIso2: null,
        etaMaxDays: a.ruleSnapshot?.etaMaxDays ?? null,
        etaBasis: a.ruleSnapshot?.etaBasis ?? null,
        processingDeadlineAt: null,
        kind: "orphaned",
      });
      continue;
    }

    const travelDateFrom = request.travelDateFrom ?? null;
    const processingDeadlineAt = computeProcessingDeadline(
      travelDateFrom,
      a.ruleSnapshot?.etaMaxDays,
      a.ruleSnapshot?.etaBasis,
    );

    if (travelDateFrom) summary.backfilled += 1;
    else summary.dateless += 1;

    onRow?.({
      applicationId: String(a._id),
      requestId: String(a.requestId),
      travelDateFrom,
      destinationIso2: request.destinationIso2 ?? null,
      etaMaxDays: a.ruleSnapshot?.etaMaxDays ?? null,
      etaBasis: a.ruleSnapshot?.etaBasis ?? null,
      processingDeadlineAt,
      kind: travelDateFrom ? "backfilled" : "dateless",
    });

    if (!dryRun) {
      await VisaApplication.updateOne(
        { _id: a._id, processingDeadlineAt: { $exists: false } },
        {
          $set: {
            travelDateFrom,
            destinationIso2: request.destinationIso2 ?? null,
            processingDeadlineAt,
          },
        },
      );
    }
  }

  return summary;
}

async function main() {
  const dryRun = !process.argv.includes("--apply");
  const force = process.argv.includes("--force");

  const productionAcknowledged = process.argv.includes("--i-know-this-is-production");

  console.log("=== Backfill VisaApplication travel/destination/deadline denormalisation ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}${productionAcknowledged ? " (PRODUCTION path)" : ""}`);

  // BEFORE connect, always — in both modes. A dry run against production is
  // still a connection to production, which is exactly why the production
  // path prompts before this point too, not just before the write.
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
      migrationName: "2026-08-12-backfill-visa-application-travel-denorm",
      mode: dryRun ? "DRY_RUN" : "APPLY",
      force,
      run: async () => {
        // Per-row lines first, then the totals — a reviewer approving a
        // production write reads the values, not just the counts.
        const fmt = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "null");
        console.log("app id                    dest  travelFrom  etaMax/basis   -> processingDeadlineAt");
        const summary = await backfillVisaApplicationTravelDenorm(dryRun, (r) => {
          console.log(
            `${r.applicationId}  ${(r.destinationIso2 ?? "--").padEnd(4)}  ${fmt(r.travelDateFrom).padEnd(10)}  ` +
              `${String(r.etaMaxDays ?? "-").padStart(3)}/${(r.etaBasis ?? "-").padEnd(8)}  -> ` +
              `${fmt(r.processingDeadlineAt).padEnd(10)} [${r.kind}]`,
          );
        });
        console.log("");
        const summaryLine =
          `applicationsScanned=${summary.applicationsScanned} backfilled=${summary.backfilled} ` +
          `dateless=${summary.dateless} orphaned=${summary.orphaned}`;
        console.log(summaryLine);
        if (summary.dateless > 0) {
          console.log("");
          console.log(
            `${summary.dateless} application(s) written with a null deadline — their request carries no travelDateFrom, so at-risk is genuinely unassessable for them. The queue gives these their own bucket (sorted last, flagged "no travel date"); they are never treated as low-risk.`,
          );
        }
        if (summary.orphaned > 0) {
          console.log("");
          console.log(
            `${summary.orphaned} application(s) LEFT UNTOUCHED — their parent VisaRequest could not be found, so there was nothing to copy. Not written as null (that would assert a fact we do not have). These will be reported again on the next run.`,
          );
        }
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
