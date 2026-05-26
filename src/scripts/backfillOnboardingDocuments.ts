// apps/backend/src/scripts/backfillOnboardingDocuments.ts
//
// ONE-SHOT BACKFILL — copy historical employee onboarding documents into the
// Document collection so they appear in /profile/team → Documents (DocumentVault).
//
// Background: migrateOnboardingDocuments() now runs on employee promotion
// (POST /master-data/:id/promote-employee). Employees promoted BEFORE that fix
// still have their files only in Onboarding.documents[] — their vault is empty.
// This script backfills every already-promoted employee by REUSING the exact
// same migrateOnboardingDocuments() logic (no duplication). It is idempotent
// (dedup by workspaceId + userId + key via upsert), so it is safe to re-run.
//
// This script is invoked MANUALLY only — it is never imported or run on boot.
//
// Run (dry-run — logs what it WOULD do, writes nothing):
//   pnpm -C apps/backend tsx src/scripts/backfillOnboardingDocuments.ts --dry-run
//
// Run for real (writes the Document records):
//   pnpm -C apps/backend tsx src/scripts/backfillOnboardingDocuments.ts
//
// (Equivalent from repo root: pnpm tsx apps/backend/src/scripts/backfillOnboardingDocuments.ts [--dry-run])

import "dotenv/config";
import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import Onboarding from "../models/Onboarding.js";
import User from "../models/User.js";
import { migrateOnboardingDocuments } from "../routes/masterData.js";

const DRY_RUN = process.argv.includes("--dry-run");

async function run() {
  console.log(
    `\n📦 Onboarding → Document Vault backfill ${DRY_RUN ? "(DRY RUN — no writes)" : "(LIVE)"}\n`,
  );

  await connectDb();

  // Only employee-type onboarding records can carry vault documents, and only
  // ones that actually have attachments are worth examining.
  const onboardings: any[] = await (Onboarding as any)
    .find({
      type: { $regex: /^employee$/i },
      documents: { $exists: true, $ne: [] },
    })
    .lean()
    .exec();

  console.log(
    `Found ${onboardings.length} employee onboarding record(s) with documents.\n`,
  );

  // Aggregate tallies.
  let scanned = 0; // onboarding records examined
  let employeesWithUser = 0; // resolved to a promoted user
  let migrated = 0; // documents newly written (or would-write in dry-run)
  let duplicates = 0; // documents already present (deduped)
  let errors = 0; // per-document failures
  let skippedNoUser = 0; // onboarding not yet promoted to a user
  let skippedNoWorkspace = 0; // promoted user has no resolvable workspaceId

  for (const onboardingDoc of onboardings) {
    scanned++;

    const label =
      onboardingDoc.name ||
      onboardingDoc.inviteeName ||
      onboardingDoc.email ||
      String(onboardingDoc._id);

    // Resolve the promoted user the same way promote-employee links them:
    // linkedUserId → User.onboardingId → email. If none, it was never promoted.
    let user: any = null;
    if (onboardingDoc.linkedUserId) {
      user = await User.findById(onboardingDoc.linkedUserId).exec();
    }
    if (!user) {
      user = await User.findOne({ onboardingId: onboardingDoc._id }).exec();
    }
    if (!user && onboardingDoc.email) {
      user = await User.findOne({
        email: String(onboardingDoc.email).trim().toLowerCase(),
      }).exec();
    }

    if (!user) {
      skippedNoUser++;
      console.log(`• ${label}: SKIP — no promoted user found (not promoted yet).`);
      continue;
    }

    employeesWithUser++;

    const res = await migrateOnboardingDocuments({
      user,
      onboardingDoc,
      dryRun: DRY_RUN,
      onLog: (msg) => console.log(msg),
    });

    if (res.skippedNoWorkspace) {
      skippedNoWorkspace++;
      console.log(
        `• ${label} (userId=${String(user._id)}): SKIP — no resolvable workspaceId; cannot match vault.`,
      );
      continue;
    }

    migrated += res.migrated;
    duplicates += res.duplicates;
    errors += res.errors;

    console.log(
      `• ${label} (userId=${String(user._id)}): ${res.total} doc(s) → ` +
        `${res.migrated} ${DRY_RUN ? "would migrate" : "migrated"}, ` +
        `${res.duplicates} already present, ${res.errors} error(s).`,
    );
  }

  console.log(`\n──────────── SUMMARY ${DRY_RUN ? "(DRY RUN)" : ""} ────────────`);
  console.log(`Employee onboarding records scanned : ${scanned}`);
  console.log(`  resolved to a promoted user       : ${employeesWithUser}`);
  console.log(`  skipped — not promoted (no user)  : ${skippedNoUser}`);
  console.log(`  skipped — no workspaceId          : ${skippedNoWorkspace}`);
  console.log(`Documents ${DRY_RUN ? "that would migrate" : "migrated"}      : ${migrated}`);
  console.log(`Documents already present (dedup)   : ${duplicates}`);
  console.log(`Per-document errors                 : ${errors}`);
  console.log(`────────────────────────────────────────────\n`);

  if (DRY_RUN) {
    console.log("ℹ️  Dry run — nothing was written. Re-run without --dry-run to apply.\n");
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
