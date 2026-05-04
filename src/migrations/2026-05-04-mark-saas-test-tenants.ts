// apps/backend/src/migrations/2026-05-04-mark-saas-test-tenants.ts
//
// Marks exactly two known test workspaces as tenantType: "SAAS_HRMS".
// These workspaces were created before the field existed and need to be
// retroactively tagged.
//
// Usage:
//   pnpm -C apps/backend tsx src/migrations/2026-05-04-mark-saas-test-tenants.ts           # dry-run
//   pnpm -C apps/backend tsx src/migrations/2026-05-04-mark-saas-test-tenants.ts --apply   # write
//   pnpm -C apps/backend tsx src/migrations/2026-05-04-mark-saas-test-tenants.ts --rollback # undo
//
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

const TARGET_EMAILS = [
  "imran.ali@mdaliimran.in",
  "hello@peachmintacademy.com",
] as const;

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--apply") && !args.includes("--rollback");
const ROLLBACK = args.includes("--rollback");

async function main() {
  console.log("=== SaaS HRMS test-tenant migration ===");
  console.log(`Mode: ${ROLLBACK ? "ROLLBACK" : DRY_RUN ? "DRY RUN" : "APPLY"}`);
  console.log("");

  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");

  // Step 1: resolve workspaceIds from the two admin emails
  const workspaceIds: mongoose.Types.ObjectId[] = [];
  for (const email of TARGET_EMAILS) {
    const user = await User.findOne({ email }).lean();
    if (!user) {
      console.error(`ERROR: No user found for email "${email}". Aborting.`);
      process.exit(1);
    }
    if (!user.workspaceId) {
      console.error(`ERROR: User "${email}" has no workspaceId. Aborting.`);
      process.exit(1);
    }
    workspaceIds.push(user.workspaceId as mongoose.Types.ObjectId);
    console.log(`Resolved: ${email} → workspaceId ${user.workspaceId}`);
  }

  if (workspaceIds.length !== 2) {
    console.error(`ERROR: Expected exactly 2 workspace IDs, got ${workspaceIds.length}. Aborting.`);
    process.exit(1);
  }

  // Guard: never touch more than 2 workspaces
  const uniqueIds = [...new Set(workspaceIds.map(String))];
  if (uniqueIds.length > 2) {
    console.error(`ERROR: More than 2 unique workspaces would be affected (${uniqueIds.length}). Aborting.`);
    process.exit(1);
  }

  console.log("");

  // Step 2: inspect current state of each workspace
  for (const wsId of workspaceIds) {
    const ws = await CustomerWorkspace.findById(wsId).lean();
    if (!ws) {
      console.error(`ERROR: CustomerWorkspace ${wsId} not found. Aborting.`);
      process.exit(1);
    }
    const current = (ws as any).tenantType ?? "(absent)";
    console.log(`Workspace: ${ws.companyName} [customerId=${ws.customerId}]`);
    console.log(`  _id:        ${ws._id}`);
    console.log(`  tenantType: ${current}`);
    console.log("");
  }

  if (DRY_RUN) {
    console.log("DRY RUN — no writes performed.");
    console.log("Re-run with --apply to commit or --rollback to remove the field.");
    await mongoose.connection.close();
    return;
  }

  // Step 3: apply or rollback
  let totalModified = 0;
  for (const wsId of workspaceIds) {
    const ws = await CustomerWorkspace.findById(wsId).lean();
    if (!ws) continue;

    const before = (ws as any).tenantType ?? "(absent)";
    const op = ROLLBACK
      ? { $unset: { tenantType: "" } }
      : { $set: { tenantType: "SAAS_HRMS" } };

    const result = await CustomerWorkspace.updateOne({ _id: wsId }, op);
    const after = ROLLBACK ? "(absent)" : "SAAS_HRMS";

    console.log(`Updated: ${ws.companyName} [${ws.customerId}]`);
    console.log(`  tenantType: ${before} → ${after}`);
    console.log(`  matchedCount=${result.matchedCount} modifiedCount=${result.modifiedCount}`);
    console.log("");
    totalModified += result.modifiedCount;
  }

  console.log(`Total documents modified: ${totalModified} (expected: 2)`);
  if (totalModified !== 2) {
    console.warn("WARNING: Expected 2 modifications but got", totalModified);
  } else {
    console.log("Migration completed successfully.");
  }

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
