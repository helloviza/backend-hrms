// apps/backend/src/scripts/erase-consumer.ts
//
// CONSUMER ERASURE, from the command line. The D2C sibling of
// scripts/erase-visa-request.ts and scripts/erase-traveller-profile.ts, and
// it follows their guard model exactly:
//
//   1. Dry run by default — prints the plan, writes nothing, exits 0.
//   2. --apply is required to write anything at all.
//   3. --confirm-erasure is required IN ADDITION to --apply. Two flags, not
//      one, mirroring the two-boolean gate in executeConsumerErasure(): the
//      B2B scripts use --apply plus an interactive database-name prompt, and
//      this adds an explicit second flag so a non-interactive run (--yes)
//      still has to say the destructive thing out loud twice.
//   4. confirmDatabaseName() — the operator types the exact database name
//      (or passes --yes) before anything is deleted.
//   5. assertModelScope() — only the models this erasure may touch are
//      registered with mongoose when this runs.
//
// SUPERADMIN ONLY, verified against a real User row (--actor-email), never
// trusted from the flag itself. Same as the B2B scripts: there is no
// req.user out here to trust instead.
//
// ── HOW THIS RELATES TO THE CONSOLE ──────────────────────────────────
// routes/admin.consumerErasure.ts drives the SAME cascade through the same
// two functions. This script exists for the case the console cannot serve:
// a request that has to run without a browser, or a re-run against a
// consumer whose row is already gone (the console lists live consumers).
// If a --request-id is supplied, the ConsumerErasureRequest is advanced to
// `executed` and stamped with the manifest, exactly as the console would —
// so a CLI run is not an off-books erasure with no audit record.
//
// Run (dry run):
//   pnpm exec tsx src/scripts/erase-consumer.ts --consumer-id <id> --actor-email <email> --reason "<text>"
// Run (apply):
//   pnpm exec tsx src/scripts/erase-consumer.ts --consumer-id <id> --actor-email <email> --reason "<text>" --apply --confirm-erasure [--yes] [--request-id <id>]
import "dotenv/config";
import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import {
  assertModelScope,
  targetInfo,
  confirmDatabaseName,
  resolveSuperAdminActor,
  planConsumerErasure,
  planToManifest,
  executeConsumerErasure,
  renderManifest,
} from "./lib/consumerErasureCascade.js";
import ConsumerErasureRequest, { markExecuted } from "../models/ConsumerErasureRequest.js";
import { shouldRedactInvoiceName, ERASURE_REDACT_INVOICE_NAME_ENV } from "../config/erasurePolicy.js";

function getArgValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

async function run() {
  const consumerId = getArgValue("--consumer-id");
  const actorEmail = getArgValue("--actor-email");
  const reason = getArgValue("--reason");
  const requestId = getArgValue("--request-id");
  const apply = process.argv.includes("--apply");
  const confirmed = process.argv.includes("--confirm-erasure");

  if (!consumerId || !mongoose.isValidObjectId(consumerId)) {
    console.error("Usage: --consumer-id <Consumer ObjectId> is required.");
    process.exit(1);
  }
  if (!actorEmail) {
    console.error("Usage: --actor-email <email> is required (must resolve to a SUPERADMIN user).");
    process.exit(1);
  }
  if (!reason || !reason.trim()) {
    console.error('Usage: --reason "<text>" is required — recorded on the erasure manifest.');
    process.exit(1);
  }
  if (requestId && !mongoose.isValidObjectId(requestId)) {
    console.error("Usage: --request-id must be a ConsumerErasureRequest ObjectId.");
    process.exit(1);
  }

  await connectDb();
  assertModelScope();

  const actor = await resolveSuperAdminActor(actorEmail);
  const target = targetInfo();

  const plan = await planConsumerErasure(consumerId);

  console.log("──────────────────────────────────────────────────────");
  console.log(`Target host:       ${target.host}`);
  console.log(`Target database:   ${target.db}`);
  console.log(`Consumer:          ${consumerId}`);
  console.log(`Actor:             ${actor.email} (SUPERADMIN, verified)`);
  console.log(
    `D1 flag:           ${ERASURE_REDACT_INVOICE_NAME_ENV}=${shouldRedactInvoiceName() ? "true" : "false (default — invoice recipient name is KEPT)"}`,
  );

  // The plan's manifest is the dry-run report — the SAME shape the real run
  // returns, so what is printed here and what is stored later are
  // comparable line for line.
  console.log(renderManifest(planToManifest(plan, { actorEmail: actor.email, reason })));

  if (!apply) {
    console.log("Dry run — nothing written. Re-run with --apply --confirm-erasure to execute.");
    process.exit(0);
  }
  if (!confirmed) {
    console.error(
      "--apply was passed WITHOUT --confirm-erasure. This erasure deletes a person's account and " +
        "crypto-shreds their data key; both flags are required. Nothing was written.",
    );
    process.exit(1);
  }

  // A request id, when supplied, must be in a state that can be executed —
  // checked BEFORE the cascade runs, so an erasure never happens against a
  // request that could not then record it.
  if (requestId) {
    const req = await ConsumerErasureRequest.findById(requestId).select("state consumerId").lean();
    if (!req) {
      console.error(`No ConsumerErasureRequest found with id ${requestId}.`);
      process.exit(1);
    }
    if ((req as any).state !== "approved") {
      console.error(
        `ConsumerErasureRequest ${requestId} is "${(req as any).state}", not "approved". ` +
          `Only an approved request may be executed.`,
      );
      process.exit(1);
    }
    if (String((req as any).consumerId) !== String(consumerId)) {
      console.error(
        `ConsumerErasureRequest ${requestId} is for consumer ${String((req as any).consumerId)}, ` +
          `not ${consumerId}. Refusing to execute a request against a different subject.`,
      );
      process.exit(1);
    }
  }

  await confirmDatabaseName(target.db);

  const manifest = await executeConsumerErasure(plan, {
    apply: true,
    confirmed: true,
    actorEmail: actor.email,
    actorUserId: actor._id,
    reason,
  });

  if (requestId) {
    await markExecuted(requestId, { userId: actor._id, email: actor.email }, manifest as any);
    console.log(`ConsumerErasureRequest ${requestId} -> executed, manifest recorded.`);
  } else {
    console.log(
      "No --request-id supplied — the cascade ran but no ConsumerErasureRequest was advanced. " +
        "The manifest above is the only record of this run; keep it.",
    );
  }

  console.log(renderManifest(manifest));
  process.exit(0);
}

run().catch((err) => {
  console.error("erase-consumer failed:", err?.message || err);
  process.exit(1);
});
