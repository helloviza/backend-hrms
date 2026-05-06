// apps/backend/src/migrations/2026-05-06-fix-saas-hrms-tenant-admin-roles.ts
//
// Backfills hrmsAccessRole/hrmsAccessLevel/accountType on existing SaaS HRMS
// tenant admin users. These were created via /api/saas/signup before the bug
// fix, and got the schema default ("EMPLOYEE") + accountType "CUSTOMER",
// which prevented them from accessing admin HRMS features.
//
// Targets ONLY users where:
//   - workspaceId belongs to a CustomerWorkspace with tenantType === "SAAS_HRMS"
//   - AND roles[] includes "TENANT_ADMIN"
//
// Plumtrips workspace and Travel CRM customer workspaces are NEVER touched
// (they have a different tenantType, or none at all).
//
// Usage:
//   pnpm -C apps/backend tsx src/migrations/2026-05-06-fix-saas-hrms-tenant-admin-roles.ts            # dry-run
//   pnpm -C apps/backend tsx src/migrations/2026-05-06-fix-saas-hrms-tenant-admin-roles.ts --apply    # write
//   pnpm -C apps/backend tsx src/migrations/2026-05-06-fix-saas-hrms-tenant-admin-roles.ts --rollback # undo
//
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import User from "../models/User.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

const MAX_AFFECTED = 10;

const TARGET_VALUES = {
  hrmsAccessRole: "L0",
  hrmsAccessLevel: "L0",
  accountType: "STAFF",
} as const;

const ROLLBACK_VALUES = {
  hrmsAccessRole: "EMPLOYEE",
  hrmsAccessLevel: "EMPLOYEE",
  accountType: "CUSTOMER",
} as const;

const args = process.argv.slice(2);
const DRY_RUN = !args.includes("--apply") && !args.includes("--rollback");
const ROLLBACK = args.includes("--rollback");

async function main() {
  console.log("=== SaaS HRMS tenant-admin role-fix migration ===");
  console.log(`Mode: ${ROLLBACK ? "ROLLBACK" : DRY_RUN ? "DRY RUN" : "APPLY"}`);
  console.log("");

  await mongoose.connect(env.MONGO_URI);
  console.log("Connected to:", env.MONGO_URI?.split("@").pop()?.split("?")[0]);
  console.log("");

  // Step 1: find all SaaS HRMS workspaces
  const saasWorkspaces = await CustomerWorkspace.find({ tenantType: "SAAS_HRMS" })
    .select("_id companyName customerId")
    .lean();

  if (saasWorkspaces.length === 0) {
    console.log("No CustomerWorkspace docs found with tenantType: 'SAAS_HRMS'. Nothing to do.");
    await mongoose.connection.close();
    return;
  }

  console.log(`Found ${saasWorkspaces.length} SaaS HRMS workspace(s):`);
  for (const ws of saasWorkspaces) {
    console.log(`  - ${ws.companyName} [customerId=${ws.customerId}, _id=${ws._id}]`);
  }
  console.log("");

  const workspaceIds = saasWorkspaces.map((ws) => ws._id);

  // Step 2: find tenant-admin users in those workspaces
  const affectedUsers = await User.find({
    workspaceId: { $in: workspaceIds },
    roles: "TENANT_ADMIN",
  })
    .select("_id email workspaceId roles hrmsAccessRole hrmsAccessLevel accountType")
    .lean();

  console.log(`Found ${affectedUsers.length} candidate user(s) (workspaceId ∈ SaaS HRMS AND roles ∋ TENANT_ADMIN):`);
  console.log("");

  // SAFETY GUARD: abort if more than MAX_AFFECTED users would be touched
  if (affectedUsers.length > MAX_AFFECTED) {
    console.error(
      `ERROR: ${affectedUsers.length} users would be affected, exceeding safety cap of ${MAX_AFFECTED}. Aborting.`,
    );
    await mongoose.connection.close();
    process.exit(1);
  }

  // Step 3: print current state of each affected user
  for (const u of affectedUsers) {
    console.log(`User: ${u.email}`);
    console.log(`  _id:             ${u._id}`);
    console.log(`  workspaceId:     ${u.workspaceId}`);
    console.log(`  roles:           ${JSON.stringify(u.roles)}`);
    console.log(`  hrmsAccessRole:  ${(u as any).hrmsAccessRole ?? "(absent)"}`);
    console.log(`  hrmsAccessLevel: ${(u as any).hrmsAccessLevel ?? "(absent)"}`);
    console.log(`  accountType:     ${(u as any).accountType ?? "(absent)"}`);
    console.log("");
  }

  if (affectedUsers.length === 0) {
    console.log("No users matched. Nothing to do.");
    await mongoose.connection.close();
    return;
  }

  if (DRY_RUN) {
    console.log("DRY RUN — no writes performed.");
    console.log("Re-run with --apply to commit or --rollback to revert.");
    await mongoose.connection.close();
    return;
  }

  // Step 4: apply or rollback
  const desired = ROLLBACK ? ROLLBACK_VALUES : TARGET_VALUES;
  let totalModified = 0;
  let skipped = 0;

  for (const u of affectedUsers) {
    const current = {
      hrmsAccessRole: (u as any).hrmsAccessRole ?? "",
      hrmsAccessLevel: (u as any).hrmsAccessLevel ?? "",
      accountType: (u as any).accountType ?? "",
    };

    const alreadyCorrect =
      current.hrmsAccessRole === desired.hrmsAccessRole &&
      current.hrmsAccessLevel === desired.hrmsAccessLevel &&
      current.accountType === desired.accountType;

    if (alreadyCorrect) {
      console.log(`Skipped: ${u.email} (already ${ROLLBACK ? "rolled back" : "correct"})`);
      skipped += 1;
      continue;
    }

    const result = await User.updateOne(
      { _id: u._id },
      { $set: { ...desired } },
    );

    console.log(`Updated: ${u.email}`);
    console.log(`  hrmsAccessRole:  ${current.hrmsAccessRole || "(absent)"} → ${desired.hrmsAccessRole}`);
    console.log(`  hrmsAccessLevel: ${current.hrmsAccessLevel || "(absent)"} → ${desired.hrmsAccessLevel}`);
    console.log(`  accountType:     ${current.accountType || "(absent)"} → ${desired.accountType}`);
    console.log(`  matchedCount=${result.matchedCount} modifiedCount=${result.modifiedCount}`);
    console.log("");
    totalModified += result.modifiedCount;
  }

  console.log(`Total documents modified: ${totalModified} (skipped already-correct: ${skipped})`);
  console.log("");

  // Step 5: verification — re-query and confirm final state
  console.log("=== Verification ===");
  const verifyUsers = await User.find({
    workspaceId: { $in: workspaceIds },
    roles: "TENANT_ADMIN",
  })
    .select("email hrmsAccessRole hrmsAccessLevel accountType")
    .lean();

  let allCorrect = true;
  for (const u of verifyUsers) {
    const ok =
      (u as any).hrmsAccessRole === desired.hrmsAccessRole &&
      (u as any).hrmsAccessLevel === desired.hrmsAccessLevel &&
      (u as any).accountType === desired.accountType;
    if (!ok) allCorrect = false;
    console.log(
      `  ${ok ? "✓" : "✗"} ${u.email}: hrmsAccessRole=${(u as any).hrmsAccessRole} hrmsAccessLevel=${(u as any).hrmsAccessLevel} accountType=${(u as any).accountType}`,
    );
  }

  console.log("");
  if (allCorrect) {
    console.log(`Migration completed successfully. All ${verifyUsers.length} SaaS HRMS tenant admin(s) verified.`);
  } else {
    console.warn("WARNING: Verification found users that are NOT in the desired state. Inspect the output above.");
  }

  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error("Migration failed:", err);
  try {
    await mongoose.connection.close();
  } catch {
    // ignore
  }
  process.exit(1);
});
