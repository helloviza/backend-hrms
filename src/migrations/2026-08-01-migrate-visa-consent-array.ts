// apps/backend/src/migrations/2026-08-01-migrate-visa-consent-array.ts
//
// The v1 consent flow recorded ONE blanket acceptance —
// VisaRequest.consentAcceptedAt/consentAcceptedByUserId/consentVersion — for
// a single checkbox covering, in one paragraph, both representation and a
// promise that passport/identity data would be stored and shared. v2 splits
// that into three independently-recorded clauses (config/visaConsent.ts's
// VISA_CONSENT_CLAUSES) stored as VisaRequest.consents[] — see
// models/VisaRequest.ts.
//
// This migration backfills ONE consents[] entry per prior acceptance — not
// three — deliberately: the v1 text's leading, unambiguous legal act was
// authorising Helloviza to act as the applicant's representative ("By
// submitting, you authorise Helloviza to act as the applicant's
// representative..."). It never used DPDP-Act framing for the data-storage
// sentence that followed, and never mentioned Terms of Service or a Privacy
// Policy at all. Backfilling DATA_PROCESSING or TERMS entries against text
// that didn't actually say those things would overclaim what an applicant
// agreed to — the ONE honest entry this writes is clauseId: REPRESENTATION,
// stamped with whatever version was actually recorded at the time (falling
// back to "v1" if that field is somehow missing) and the real historical
// acceptedAt/acceptedByUserId. A historical request will therefore show only
// one of three clauses accepted — that under-claims rather than over-claims,
// which is the safer direction for a consent record to be wrong in.
//
// Requests with consentAcceptedAt set but NO consentAcceptedByUserId (should
// not exist, but never trust that) are skipped rather than migrated with a
// fabricated actor — VisaConsentRecord.acceptedByUserId is required, and an
// invented value would be worse than an unmigrated row a human can look at.
//
// Idempotent: the old three fields are $unset in the SAME update as the
// $push, so a request this migration already touched no longer matches the
// { consentAcceptedAt: { $exists: true, $ne: null } } filter on a re-run.
//
// Usage:
//   pnpm -C apps/backend tsx src/migrations/2026-08-01-migrate-visa-consent-array.ts              # dry-run
//   pnpm -C apps/backend tsx src/migrations/2026-08-01-migrate-visa-consent-array.ts --apply       # write
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import VisaRequest from "../models/VisaRequest.js";

export interface ConsentMigrationSummary {
  requestsScanned: number;
  requestsMigrated: number;
  requestsSkippedMissingActor: number;
}

/**
 * Core, testable migration logic. Assumes the caller already has a live
 * Mongoose connection (or, in tests, a mocked model) — this function itself
 * never connects/disconnects. dryRun=true computes and returns the same
 * summary a real run would produce, without writing anything.
 */
export async function migrateVisaConsentArray(dryRun: boolean): Promise<ConsentMigrationSummary> {
  const summary: ConsentMigrationSummary = {
    requestsScanned: 0,
    requestsMigrated: 0,
    requestsSkippedMissingActor: 0,
  };

  const requests = await VisaRequest.find({
    consentAcceptedAt: { $exists: true, $ne: null },
  })
    .select("_id consentAcceptedAt consentAcceptedByUserId consentVersion")
    .lean();

  for (const r of requests as any[]) {
    summary.requestsScanned += 1;

    if (!r.consentAcceptedByUserId) {
      summary.requestsSkippedMissingActor += 1;
      continue;
    }

    summary.requestsMigrated += 1;
    if (!dryRun) {
      // Re-filtered on "consents.0" not existing at write time too, not just
      // read time — a request this migration (or a concurrent run) already
      // touched must never gain a second REPRESENTATION entry.
      await VisaRequest.updateOne(
        { _id: r._id, "consents.0": { $exists: false } },
        {
          $push: {
            consents: {
              clauseId: "REPRESENTATION",
              version: r.consentVersion || "v1",
              acceptedAt: r.consentAcceptedAt,
              acceptedByUserId: r.consentAcceptedByUserId,
            },
          },
          $unset: { consentAcceptedAt: "", consentAcceptedByUserId: "", consentVersion: "" },
        },
      );
    }
  }

  return summary;
}

async function main() {
  const dryRun = !process.argv.includes("--apply");
  console.log("=== Migrate VisaRequest consent fields -> consents[] ===");
  console.log(`Mode: ${dryRun ? "DRY RUN" : "APPLY"}`);
  console.log("");

  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");

  try {
    const summary = await migrateVisaConsentArray(dryRun);
    console.log(
      `requestsScanned=${summary.requestsScanned} requestsMigrated=${summary.requestsMigrated} ` +
        `requestsSkippedMissingActor=${summary.requestsSkippedMissingActor}`,
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
// migrateVisaConsentArray's own test) must not open a real Mongo connection.
// Same guard server.ts already uses for its own startup code.
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
