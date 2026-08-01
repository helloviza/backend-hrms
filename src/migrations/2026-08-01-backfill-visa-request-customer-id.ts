// apps/backend/src/migrations/2026-08-01-backfill-visa-request-customer-id.ts
//
// VisaRequest (and VisaApplication) gained a stored, indexed customerId
// (models/VisaRequest.ts, models/VisaApplication.ts) — set going forward at
// creation time from the raising user's OWN customerId/businessId
// (routes/visa.ts's POST /requests), never re-derived afterward. This
// migration is the one-time catch-up for every row created BEFORE that
// field existed: it derives customerId from the raiser's CURRENT
// customerId/businessId (the best available source of truth for old data —
// there is no stored point-in-time value to recover instead) and copies the
// same value onto every one of that request's child VisaApplications.
//
// Deliberately does NOT touch a request whose raiser has no customerId at
// all (a genuinely staff-raised request, e.g. HOUSE's existing test data) —
// that's not a backfill gap, it's the same "leave it null rather than
// guess" rule POST /requests itself follows, applied retroactively. Counted
// separately as "unresolved" so the two cases (fixable vs. genuinely
// customerId-less) are never conflated in the report.
//
// Idempotent:
//   - Only ever selects requests with customerId: null (or the field
//     missing entirely, for rows written before the schema even declared
//     it) — a request already backfilled (by this migration or by POST
//     /requests going forward) is simply not matched by the read query, so
//     re-running finds nothing left to do for it.
//   - The write itself re-checks customerId: null at write time, not just
//     at the read above — a concurrent write landing in between must win,
//     never be silently clobbered by this migration.
//
// Usage:
//   pnpm -C apps/backend tsx src/migrations/2026-08-01-backfill-visa-request-customer-id.ts              # dry-run
//   pnpm -C apps/backend tsx src/migrations/2026-08-01-backfill-visa-request-customer-id.ts --apply       # write
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import VisaRequest from "../models/VisaRequest.js";
import VisaApplication from "../models/VisaApplication.js";
import User from "../models/User.js";

export interface MigrationSummary {
  requestsScanned: number;
  requestsResolved: number; // raiser has a customerId/businessId today — would be/was set
  requestsUnresolved: number; // raiser has neither (staff-raised, or raiser no longer exists)
  applicationsUpdated: number; // child VisaApplications whose customerId was copied down to match
}

/**
 * Core, testable migration logic. Assumes the caller already has a live
 * Mongoose connection (or, in tests, a mocked model) — this function itself
 * never connects/disconnects. dryRun=true computes and returns the same
 * summary a real run would produce, without writing anything.
 */
export async function backfillVisaRequestCustomerId(dryRun: boolean): Promise<MigrationSummary> {
  const summary: MigrationSummary = {
    requestsScanned: 0,
    requestsResolved: 0,
    requestsUnresolved: 0,
    applicationsUpdated: 0,
  };

  const requests = await VisaRequest.find({
    $or: [{ customerId: null }, { customerId: { $exists: false } }],
  })
    .select("_id raisedByUserId")
    .lean();

  for (const r of requests as any[]) {
    summary.requestsScanned += 1;

    const raiser = r.raisedByUserId
      ? await User.findById(r.raisedByUserId).select("customerId businessId").lean()
      : null;
    const customerId = (raiser as any)?.customerId || (raiser as any)?.businessId || null;

    if (!customerId) {
      summary.requestsUnresolved += 1;
      continue;
    }

    summary.requestsResolved += 1;
    if (!dryRun) {
      await VisaRequest.updateOne(
        { _id: r._id, customerId: null },
        { $set: { customerId } },
      );
      const result = await VisaApplication.updateMany(
        { requestId: r._id, customerId: null },
        { $set: { customerId } },
      );
      summary.applicationsUpdated += result.modifiedCount ?? 0;
    } else {
      // Dry run still reports the applications a real run WOULD touch, so
      // the printed summary means the same thing in both modes.
      summary.applicationsUpdated += await VisaApplication.countDocuments({
        requestId: r._id,
        $or: [{ customerId: null }, { customerId: { $exists: false } }],
      });
    }
  }

  return summary;
}

async function main() {
  const dryRun = !process.argv.includes("--apply");
  console.log("=== Backfill VisaRequest/VisaApplication.customerId ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}`);
  console.log("");

  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");

  try {
    const summary = await backfillVisaRequestCustomerId(dryRun);
    console.log(
      `requestsScanned=${summary.requestsScanned} requestsResolved=${summary.requestsResolved} ` +
        `requestsUnresolved=${summary.requestsUnresolved} applicationsUpdated=${summary.applicationsUpdated}`,
    );
    if (summary.requestsUnresolved > 0) {
      console.log("");
      console.log(
        `${summary.requestsUnresolved} request(s) left with customerId: null — the raiser has no customerId/businessId today (staff-raised, or the account no longer carries one). Not guessed from workspaceId; this is expected for those rows, not a failure.`,
      );
    }
    if (dryRun) {
      console.log("");
      console.log("Re-run with --apply to write these changes.");
    }
  } finally {
    await mongoose.connection.close();
  }
}

// Never auto-run under the test runner — importing this module (for
// backfillVisaRequestCustomerId's own test) must not open a real Mongo
// connection. Same guard used by every other migration in this directory.
if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
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
