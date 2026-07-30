// apps/backend/src/migrations/2026-07-30-migrate-visa-concierge-assignment.ts
//
// Phase 9a — case assignment moves from VisaRequest (one concierge shared by
// every traveller on a request, via the now-removed
// VisaRequest.assignedConciergeUserId) to VisaApplication (independent
// assignedConciergeUserId / assignedScreeningOfficerId per traveller — see
// models/VisaApplication.ts). This migration copies each VisaRequest's
// assignedConciergeUserId down onto every one of its child VisaApplications
// that doesn't already carry its own, then clears the field off the request.
//
// Nothing populates assignedScreeningOfficerId here — that role is new in
// this phase with no prior data anywhere to migrate.
//
// Idempotent:
//   - An application that ALREADY has its own assignedConciergeUserId (set
//     via the new PATCH /admin/visa/applications/:id/assignment route, or by
//     a prior run of this exact migration) is never overwritten — re-running
//     finds it already set and skips it.
//   - A request whose assignedConciergeUserId has already been cleared (by a
//     prior run) is simply not matched by the initial query, so a second run
//     over the same data is a clean no-op end to end.
//
// assignedConciergeAssignedAt/assignedConciergeAssignedByUserId have no
// historical source — VisaRequest never tracked who assigned it or when.
// assignedAt is backfilled from the request's own updatedAt as a documented
// approximation ("assigned no later than this"); assignedByUserId is left
// null (unknown provenance) rather than guessed.
//
// Usage:
//   pnpm -C apps/backend tsx src/migrations/2026-07-30-migrate-visa-concierge-assignment.ts              # dry-run
//   pnpm -C apps/backend tsx src/migrations/2026-07-30-migrate-visa-concierge-assignment.ts --apply       # write
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import VisaRequest from "../models/VisaRequest.js";
import VisaApplication from "../models/VisaApplication.js";

export interface MigrationSummary {
  requestsScanned: number;
  applicationsAssigned: number;
  applicationsAlreadyAssignedSkipped: number;
  requestsCleared: number;
}

/**
 * Core, testable migration logic. Assumes the caller already has a live
 * Mongoose connection (or, in tests, a mocked model) — this function itself
 * never connects/disconnects. dryRun=true computes and returns the same
 * summary a real run would produce, without writing anything.
 */
export async function migrateVisaConciergeAssignments(dryRun: boolean): Promise<MigrationSummary> {
  const summary: MigrationSummary = {
    requestsScanned: 0,
    applicationsAssigned: 0,
    applicationsAlreadyAssignedSkipped: 0,
    requestsCleared: 0,
  };

  // $ne: null also excludes documents where the field is literally null —
  // relevant only if this migration (or a prior partial run) already wrote
  // one; $exists alone would still match those and re-select them below,
  // where the request-level id would then be undefined.
  const requests = await VisaRequest.find({
    assignedConciergeUserId: { $exists: true, $ne: null },
  })
    .select("_id assignedConciergeUserId updatedAt")
    .lean();

  for (const r of requests as any[]) {
    summary.requestsScanned += 1;

    const applications = await VisaApplication.find({ requestId: r._id })
      .select("_id assignedConciergeUserId")
      .lean();

    for (const a of applications as any[]) {
      if (a.assignedConciergeUserId) {
        summary.applicationsAlreadyAssignedSkipped += 1;
        continue;
      }
      summary.applicationsAssigned += 1;
      if (!dryRun) {
        // Re-checked at write time, not just at the read above — a
        // concurrent assignment landing in between must win, never be
        // silently clobbered by this migration.
        await VisaApplication.updateOne(
          { _id: a._id, assignedConciergeUserId: { $exists: false } },
          {
            $set: {
              assignedConciergeUserId: r.assignedConciergeUserId,
              assignedConciergeAssignedAt: r.updatedAt || new Date(),
            },
          },
        );
      }
    }

    summary.requestsCleared += 1;
    if (!dryRun) {
      await VisaRequest.updateOne({ _id: r._id }, { $unset: { assignedConciergeUserId: "" } });
    }
  }

  return summary;
}

async function main() {
  const dryRun = !process.argv.includes("--apply");
  console.log("=== Migrate VisaRequest.assignedConciergeUserId -> VisaApplication ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}`);
  console.log("");

  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");

  try {
    const summary = await migrateVisaConciergeAssignments(dryRun);
    console.log(
      `requestsScanned=${summary.requestsScanned} applicationsAssigned=${summary.applicationsAssigned} ` +
        `applicationsAlreadyAssignedSkipped=${summary.applicationsAlreadyAssignedSkipped} ` +
        `requestsCleared=${summary.requestsCleared}`,
    );
    if (dryRun) {
      console.log("");
      console.log("Re-run with --apply to write these changes.");
    }
  } finally {
    await mongoose.connection.close();
  }
}

// Never auto-run under the test runner — importing this module (for
// migrateVisaConciergeAssignments's own test) must not open a real Mongo
// connection. Same guard server.ts already uses for its own startup code.
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
