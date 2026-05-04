// apps/backend/src/migrations/2026-05-04-init-tenant-setup-progress.ts
//
// Creates TenantSetupProgress docs for all existing SAAS_HRMS workspaces
// that were provisioned before the saas.signup.ts wiring added auto-creation.
//
// Usage:
//   pnpm -C apps/backend tsx src/migrations/2026-05-04-init-tenant-setup-progress.ts           # dry-run
//   pnpm -C apps/backend tsx src/migrations/2026-05-04-init-tenant-setup-progress.ts --apply   # write
//   pnpm -C apps/backend tsx src/migrations/2026-05-04-init-tenant-setup-progress.ts --rollback # undo
//
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import TenantSetupProgress from "../models/TenantSetupProgress.js";

const SAAS_WORKSPACE_SAFETY_LIMIT = 5;

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--apply") && !args.includes("--rollback");
const ROLLBACK = args.includes("--rollback");

async function main() {
  console.log("=== TenantSetupProgress backfill migration ===");
  console.log(`Mode: ${ROLLBACK ? "ROLLBACK" : DRY_RUN ? "DRY RUN" : "APPLY"}`);
  console.log("");

  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");

  // Step 1: find all SAAS_HRMS workspaces
  const workspaces = await CustomerWorkspace.find({ tenantType: "SAAS_HRMS" }).lean();
  console.log(`Found ${workspaces.length} SAAS_HRMS workspace(s).`);
  console.log("");

  // Safety guard: abort if unexpectedly many workspaces
  if (workspaces.length > SAAS_WORKSPACE_SAFETY_LIMIT) {
    console.error(
      `ERROR: Found ${workspaces.length} SAAS_HRMS workspaces — exceeds safety limit of ${SAAS_WORKSPACE_SAFETY_LIMIT}. Aborting.`,
    );
    await mongoose.connection.close();
    process.exit(1);
  }

  // Step 2: inspect current state of each workspace
  for (const ws of workspaces) {
    const existing = await TenantSetupProgress.findOne({ workspaceId: ws._id }).lean();
    console.log(`Workspace: ${ws.companyName} [customerId=${ws.customerId}]`);
    console.log(`  _id:                     ${ws._id}`);
    console.log(`  Has TenantSetupProgress: ${existing ? "yes" : "no"}`);
    console.log("");
  }

  if (DRY_RUN) {
    console.log("DRY RUN — no writes performed.");
    console.log("Re-run with --apply to create missing docs or --rollback to delete all.");
    await mongoose.connection.close();
    return;
  }

  if (ROLLBACK) {
    // Delete all TenantSetupProgress docs for these workspaces
    const wsIds = workspaces.map((ws) => ws._id);
    const result = await TenantSetupProgress.deleteMany({ workspaceId: { $in: wsIds } });
    console.log(`ROLLBACK: deleted ${result.deletedCount} TenantSetupProgress document(s).`);
    await mongoose.connection.close();
    return;
  }

  // Apply: create missing docs, skip existing
  let createdCount = 0;
  let skippedCount = 0;

  for (const ws of workspaces) {
    const existing = await TenantSetupProgress.findOne({ workspaceId: ws._id }).lean();
    if (existing) {
      console.log(`SKIP: ${ws.companyName} — TenantSetupProgress already exists.`);
      skippedCount++;
      continue;
    }

    await TenantSetupProgress.create({
      workspaceId: ws._id,
      tenantType: "SAAS_HRMS",
      currentStage: "WELCOME",
      lastActivityAt: new Date(),
    });
    console.log(`CREATED: ${ws.companyName} [${ws.customerId}]`);
    createdCount++;
  }

  console.log("");
  console.log(`Done. created=${createdCount}  skipped=${skippedCount}`);
  if (createdCount + skippedCount !== workspaces.length) {
    console.warn("WARNING: count mismatch — review output above.");
  }

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
