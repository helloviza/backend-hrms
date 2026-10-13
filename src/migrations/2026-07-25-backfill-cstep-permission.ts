// apps/backend/src/migrations/2026-07-25-backfill-cstep-permission.ts
//
// Backfills the new `cstep` module key onto existing UserPermission records.
//
// Context: `cstep` was just added to ModulesTemplate (config/levelTemplates.ts)
// and to the UserPermission.modules schema (models/UserPermission.ts). Mongoose
// applies the schema's per-path default ({ access: 'NONE', scope: 'NONE' }) to
// any UserPermission doc that doesn't already have `modules.cstep` set — which
// is every doc that existed before this migration. For most levels that default
// IS the correct value, but L6 (Admin) and L8 (Super Admin) are entitled to
// { access: 'FULL', scope: 'WORKSPACE' } per their level template. Without this
// backfill, existing L6/L8 users would silently read as NONE for `cstep` until
// someone re-grants them through the Access Console.
//
// This does NOT enable the CSTEP module for anyone — `cstepEnabled` stays false
// on every CustomerWorkspace (see models/CustomerWorkspace.ts). This migration
// only makes the PERMISSION template consistent, so the moment a workspace's
// feature flag is turned on, existing L6/L8 users don't need a manual re-grant.
//
// *** MUST BE RUN MANUALLY BEFORE THE CSTEP MODULE LAUNCHES — this is NOT part
// *** of any automated deploy step. Safe to run multiple times (idempotent —
// *** it only ever sets modules.cstep to the value implied by the user's
// *** stored level template; re-running on an already-migrated doc is a no-op).
//
// Usage:
//   pnpm -C apps/backend tsx src/migrations/2026-07-25-backfill-cstep-permission.ts            # dry-run
//   pnpm -C apps/backend tsx src/migrations/2026-07-25-backfill-cstep-permission.ts --apply    # write
//
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { UserPermission } from "../models/UserPermission.js";
import { LEVEL_TEMPLATES } from "../config/levelTemplates.js";

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--apply");

async function main() {
  console.log("=== Backfill cstep permission migration ===");
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "APPLY"}`);
  console.log("");

  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");

  try {
    const docs = await UserPermission.find({})
      .select("_id userId email level modules.cstep")
      .lean();

    console.log(`Found ${docs.length} UserPermission records.`);
    console.log("");

    let alreadyCorrect = 0;
    let unknownLevel = 0;
    const updates: Array<{
      _id: any;
      email: string;
      levelCode: string;
      cstep: { access: string; scope: string };
    }> = [];

    for (const doc of docs as any[]) {
      const levelCode = doc.level?.code || "";
      const template = (LEVEL_TEMPLATES as any)[levelCode];

      if (!template) {
        console.warn(
          `  [SKIP] userId=${doc.userId} email=${doc.email}: unknown level code "${levelCode}"`,
        );
        unknownLevel++;
        continue;
      }

      const target = template.cstep as { access: string; scope: string };
      const current = doc.modules?.cstep;

      if (current && current.access === target.access && current.scope === target.scope) {
        alreadyCorrect++;
        continue;
      }

      updates.push({ _id: doc._id, email: doc.email, levelCode, cstep: target });
    }

    console.log(`  Already correct: ${alreadyCorrect}`);
    console.log(`  Unknown level (skipped): ${unknownLevel}`);
    console.log(`  Needs update: ${updates.length}`);
    console.log("");

    if (updates.length > 0) {
      console.log("Records that WILL BE updated:");
      console.log("-".repeat(80));
      for (const u of updates) {
        console.log(`  [${u.levelCode}] ${u.email} -> cstep: ${u.cstep.access}/${u.cstep.scope}`);
      }
      console.log("-".repeat(80));
      console.log("");
    }

    if (DRY_RUN) {
      console.log(`DRY RUN — would update ${updates.length} records. Re-run with --apply to commit.`);
      return;
    }

    let modifiedCount = 0;
    for (const u of updates) {
      const result = await UserPermission.updateOne(
        { _id: u._id },
        {
          $set: {
            "modules.cstep": u.cstep,
            updatedBy: "system-migration-cstep-backfill",
            updatedAt: new Date(),
          },
        },
      );
      modifiedCount += result.modifiedCount ?? 0;
    }

    console.log(`APPLY complete. modifiedCount=${modifiedCount}`);
  } finally {
    await mongoose.connection.close();
  }
}

main().catch(async (err) => {
  console.error("Migration failed:", err);
  try {
    await mongoose.connection.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
