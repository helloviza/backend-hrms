// apps/backend/src/scripts/seedDepartments.ts
//
// Seeds the 10 standard Plumtrips departments into every workspace.
// Safe to run multiple times — uses upsert, so existing departments
// are never modified or duplicated.
//
// Usage:
//   pnpm -C apps/backend tsx src/scripts/seedDepartments.ts
//
// To target a single workspace, pass its _id as an argument:
//   pnpm -C apps/backend tsx src/scripts/seedDepartments.ts <workspaceId>

import { connectDb } from "../config/db.js";
import Department from "../models/Department.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import mongoose from "mongoose";

const DEPARTMENTS = [
  "People & Culture",
  "Sales Development",
  "Growth & Marketing",
  "Tech & Product",
  "Ops & Service Delivery",
  "Accounts & Finance",
  "Legal & Compliance",
  "Customer Experience",
  "Partnerships & Alliances",
  "Strategy & Business Growth",
];

async function main() {
  await connectDb();
  console.log("✅ Connected to MongoDB");

  // Determine which workspaces to seed
  let workspaceIds: mongoose.Types.ObjectId[];

  const arg = process.argv[2];
  if (arg) {
    if (!mongoose.Types.ObjectId.isValid(arg)) {
      console.error(`❌ Invalid workspaceId: ${arg}`);
      process.exit(1);
    }
    workspaceIds = [new mongoose.Types.ObjectId(arg)];
    console.log(`🎯 Targeting single workspace: ${arg}`);
  } else {
    const workspaces = await CustomerWorkspace.find({}).select("_id").lean();
    workspaceIds = workspaces.map((w: any) => w._id);
    console.log(`🏢 Found ${workspaceIds.length} workspace(s)`);
  }

  let totalInserted = 0;
  let totalSkipped = 0;

  for (const wsId of workspaceIds) {
    console.log(`\n📂 Workspace: ${wsId}`);

    for (const name of DEPARTMENTS) {
      const result = await Department.updateOne(
        { workspaceId: wsId, name },
        {
          $setOnInsert: {
            workspaceId: wsId,
            name,
            isActive: true,
          },
        },
        { upsert: true },
      );

      if (result.upsertedCount > 0) {
        console.log(`  ✅ Inserted: ${name}`);
        totalInserted++;
      } else {
        console.log(`  ⏭️  Exists:   ${name}`);
        totalSkipped++;
      }
    }
  }

  console.log(`\n📊 Done — inserted: ${totalInserted}, skipped (already existed): ${totalSkipped}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
