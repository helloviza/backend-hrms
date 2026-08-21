// apps/backend/src/scripts/backfill-sanitize-ticket-bodies.ts
//
// ══════════════════════════════════════════════════════════════════════
// BACKFILL — sanitize every stored TicketMessage.bodyHtml.
//
// Write-path sanitizing (ticketIngestion, the reply endpoint, the quote
// builder) only protects rows written AFTER it shipped. Every row already
// in the collection was stored under the old rules, and those are exactly
// the rows an ops user opens today. Render-side sanitizing covers them at
// display time, but a dirty row is still a dirty row: it is one forgotten
// render path, one export, one email away from executing. This closes it
// at rest.
//
// PROFILE SELECTION is not a judgement call made here — it is
// sanitizeTicketBody() in @plumtrips/shared, the same function the admin
// renderer uses. Mail-channel rows keep their tables under the EMAIL
// profile; everything agent-authored goes through STRICT. If the two ever
// disagreed, a row would be cleaned one way and rendered another.
//
// IDEMPOTENT. Sanitizing an already-sanitized body is a no-op, so a second
// run reports 0 changed. That is asserted by the test beside this script,
// not merely intended.
//
// USAGE
//   Dry run (default — reports, writes nothing):
//     pnpm -C apps/backend tsx src/scripts/backfill-sanitize-ticket-bodies.ts
//   Apply:
//     pnpm -C apps/backend tsx src/scripts/backfill-sanitize-ticket-bodies.ts --apply
//
// LOCAL ONLY. The script refuses to connect to anything that is not a
// loopback MongoDB. Running it against production is a deliberate,
// separate act behind the pre-prod gate — see ALLOW_REMOTE below — and is
// NOT what this file is for today.
// ══════════════════════════════════════════════════════════════════════

import "dotenv/config";
import mongoose from "mongoose";
import { sanitizeTicketBody } from "@plumtrips/shared/security/htmlSanitize";

const APPLY = process.argv.includes("--apply");

/**
 * The guard. A backfill rewrites every row in a collection; pointing one at
 * the wrong database is not an error you get to undo. Local dev here has a
 * standing habit of aiming MONGO_URI at live Atlas, so "which database is
 * this?" is answered by inspecting the URI rather than by trusting the
 * operator to have checked.
 *
 * Loopback host AND no `mongodb+srv://` scheme — Atlas is always SRV, so
 * rejecting the scheme outright removes the one way a hostname could look
 * local and resolve remote.
 */
function assertLocalUri(uri: string): void {
  if (process.env.BACKFILL_ALLOW_REMOTE === "I-HAVE-A-BACKUP-AND-A-CHANGE-WINDOW") {
    console.warn("⚠️  REMOTE BACKFILL EXPLICITLY ENABLED — this is not a local run.");
    return;
  }

  if (/^mongodb\+srv:\/\//i.test(uri)) {
    throw new Error(
      "REFUSING: MONGO_URI uses mongodb+srv:// (Atlas). This script is local-only.",
    );
  }

  let host: string;
  try {
    // mongodb:// parses as a URL well enough to read the host off it.
    host = new URL(uri).hostname;
  } catch {
    throw new Error(`REFUSING: could not parse MONGO_URI to verify it is local.`);
  }

  const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `REFUSING: MONGO_URI host "${host}" is not loopback. This script is local-only.`,
    );
  }
}

export interface BackfillCounts {
  scanned: number;
  changed: number;
  unchanged: number;
  /**
   * Subset of `changed` where nothing dangerous was present — the body came
   * back differing only in spelling, e.g. `&#39;` re-emitted as `'`, which
   * renders identically.
   *
   * This is a LABEL, not a skip. Rewriting those rows is harmless, and
   * deciding NOT to rewrite a row on the strength of a marker regex would be
   * trusting exactly the kind of pattern-matching this whole fix exists to
   * replace. The count is here so that a future production run can be read
   * as "N rows actually had markup removed, M were re-spelled" instead of
   * one undifferentiated number.
   */
  normalizedOnly: number;
}

/** Coarse "did this row contain anything with teeth" check — labelling only. */
const DANGEROUS_MARKERS =
  /(<\s*(script|iframe|svg|base|form|object|embed|link|meta|input)\b|\son[a-z]+\s*=|javascript\s*:|vbscript\s*:|data\s*:\s*text\/html)/i;

/**
 * The work itself, separated from connecting and exiting so the test can
 * drive it against its own in-memory database.
 */
export async function backfillTicketBodies(
  db: mongoose.mongo.Db,
  apply: boolean,
): Promise<BackfillCounts> {
  const col = db.collection("ticketmessages");
  const counts: BackfillCounts = { scanned: 0, changed: 0, unchanged: 0, normalizedOnly: 0 };

  const cursor = col.find({}, { projection: { bodyHtml: 1, channel: 1 } });

  for await (const doc of cursor) {
    counts.scanned += 1;

    const before = String((doc as any).bodyHtml ?? "");
    const after = sanitizeTicketBody(before, (doc as any).channel);

    if (after === before) {
      counts.unchanged += 1;
      continue;
    }

    counts.changed += 1;
    const label = DANGEROUS_MARKERS.test(before) ? "CLEANED" : "normalized";
    if (label === "normalized") counts.normalizedOnly += 1;

    console.log(
      `  [${apply ? "REWRITE" : "WOULD REWRITE"} · ${label}] ${String(doc._id)} (${(doc as any).channel})`,
    );
    console.log(`      before: ${before.slice(0, 160)}`);
    console.log(`      after : ${after.slice(0, 160)}`);

    if (apply) {
      await col.updateOne({ _id: doc._id }, { $set: { bodyHtml: after } });
    }
  }

  return counts;
}

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set.");

  assertLocalUri(uri);

  console.log(`Mode: ${APPLY ? "APPLY (will write)" : "DRY RUN (no writes)"}`);
  console.log(`Connecting to ${uri.replace(/\/\/[^@]*@/, "//***@")} …\n`);
  await mongoose.connect(uri);

  const counts = await backfillTicketBodies(mongoose.connection.db!, APPLY);

  console.log("\n─────────────────────────────");
  console.log(`  scanned  : ${counts.scanned}`);
  console.log(`  changed  : ${counts.changed}${APPLY ? "" : " (dry run — nothing written)"}`);
  console.log(`    ├ markup removed : ${counts.changed - counts.normalizedOnly}`);
  console.log(`    └ re-spelled only: ${counts.normalizedOnly}`);
  console.log(`  unchanged: ${counts.unchanged}`);
  console.log("─────────────────────────────");

  await mongoose.connection.close();
}

// Only run when invoked directly — importing this file from a test must not
// connect to anything.
const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith(
  "backfill-sanitize-ticket-bodies.ts",
);

if (invokedDirectly) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`\n${err.message}\n`);
      process.exit(1);
    });
}
