/**
 * provision-demo-customer-seeds.ts  — ONE-OFF, REVIEW BEFORE RUNNING
 * ---------------------------------------------------------------------------
 * Provisions demo1/demo2/demo3@plumtrips.com as CUSTOMER-universe Demo
 * Platform seed users inside the "Demo Company" CustomerWorkspace
 * (_id 6a4b6727ab711bba0d56e1ae), and grants imran.ali@plumtrips.com
 * impersonation access to all three (in addition to their existing
 * Inteletek AI mappedSeedUsers).
 *
 * Background (2026-07-06 audit):
 *  - demo1@plumtrips.com already exists but User.workspaceId is wrongly
 *    HOUSE (69679a7628330a58d29f2254) — a workspaceId-gap bug from
 *    onboarding. Its correct CustomerWorkspace already exists. Its
 *    UserPermission doc has the SAME workspaceId gap. Both are repaired
 *    in place — not deleted/recreated.
 *  - demo2@plumtrips.com exists as a stray HR EMPLOYEE record
 *    (employeeCode PTS001094) homed in HOUSE. Verified via a read-only scan
 *    (payroll/attendance/leave/department/manager/FK references) to have
 *    zero real HR usage — only a system-auto-generated LeaveBalance row from
 *    account creation. Cleared to delete-and-recreate cleanly as a customer
 *    seed rather than converting the employee doc in place.
 *  - demo3@plumtrips.com does not exist. Created fresh.
 *
 * SAFETY: DRY-RUN by default (writes nothing, prints the intended change set).
 *   Dry-run:  pnpm -C apps/backend tsx src/scripts/provision-demo-customer-seeds.ts
 *   Apply:    pnpm -C apps/backend tsx src/scripts/provision-demo-customer-seeds.ts --apply
 * Uses the MONGO_URI in apps/backend/.env.
 */
import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

import User from "../models/User.js";
import { UserPermission } from "../models/UserPermission.js";
import Customer from "../models/Customer.js";
import CustomerWorkspace from "../models/CustomerWorkspace.js";

const APPLY = process.argv.includes("--apply");

const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";
const DEMO_WORKSPACE_ID = "6a4b6727ab711bba0d56e1ae"; // "Demo Company" CustomerWorkspace
const DEMO_CUSTOMER_ID = "6a4b66dbcb21a699d66db59b"; // Customer doc for "Demo Company"

const DEMO1_EMAIL = "demo1@plumtrips.com";
const DEMO2_EMAIL = "demo2@plumtrips.com";
const DEMO3_EMAIL = "demo3@plumtrips.com";
const GRANTER_EMAIL = "imran.ali@plumtrips.com";

function log(...a: any[]) {
  console.log("[provision-demo-customer-seeds]", ...a);
}

// Non-admin CUSTOMER UserPermission modules — mirrors seed-demo-inteletek.ts's
// non-admin branch (stagePermissions), scoped OWN not WORKSPACE.
const REQUESTER_MODULES = {
  profile: { access: "WRITE", scope: "OWN" },
  myBookings: { access: "READ", scope: "OWN" },
  myInvoices: { access: "READ", scope: "OWN" },
  sbtSearch: { access: "WRITE", scope: "OWN" },
  sbtRequest: { access: "WRITE", scope: "OWN" },
  travelSpend: { access: "READ", scope: "OWN" },
};
const REQUESTER_GRANTED_MODULES = [
  "profile",
  "myBookings",
  "myInvoices",
  "sbtSearch",
  "sbtRequest",
  "travelSpend",
];

async function main() {
  const MONGO = process.env.MONGO_URI;
  if (!MONGO) throw new Error("MONGO_URI not set in apps/backend/.env");
  await mongoose.connect(MONGO);
  log(APPLY ? "MODE: APPLY (will write)" : "MODE: DRY-RUN (no writes) — pass --apply to commit");

  // ── Preconditions ──────────────────────────────────────────────────────
  const demoWorkspace: any = await CustomerWorkspace.findById(DEMO_WORKSPACE_ID).lean();
  if (!demoWorkspace) throw new Error(`Demo Company CustomerWorkspace ${DEMO_WORKSPACE_ID} not found — aborting.`);
  if (String(demoWorkspace.customerId) !== DEMO_CUSTOMER_ID) {
    throw new Error(
      `Safety check failed: CustomerWorkspace ${DEMO_WORKSPACE_ID}.customerId=${demoWorkspace.customerId} !== expected ${DEMO_CUSTOMER_ID}`,
    );
  }
  const demoCustomer: any = await Customer.findById(DEMO_CUSTOMER_ID).lean();
  if (!demoCustomer) throw new Error(`Demo Company Customer ${DEMO_CUSTOMER_ID} not found — aborting.`);
  log(`Preconditions OK: CustomerWorkspace ${DEMO_WORKSPACE_ID} <-> Customer ${DEMO_CUSTOMER_ID} ("${demoCustomer.legalName}")`);

  const demoWorkspaceOid = new mongoose.Types.ObjectId(DEMO_WORKSPACE_ID);

  // ────────────────────────────────────────────────────────────────────────
  // demo1 — REPAIR in place (workspaceId gap fix), not delete/recreate
  // ────────────────────────────────────────────────────────────────────────
  const demo1: any = await User.findOne({ email: DEMO1_EMAIL }).lean();
  if (!demo1) throw new Error(`${DEMO1_EMAIL} not found — expected to already exist per audit.`);
  if (String(demo1.workspaceId) === HOUSE_WORKSPACE_ID) {
    log(`✓ Confirmed ${DEMO1_EMAIL} currently has workspaceId=HOUSE (the bug this script fixes).`);
  } else {
    log(`⚠ ${DEMO1_EMAIL}.workspaceId is NOT HOUSE (already ${demo1.workspaceId}) — re-verify before applying.`);
  }
  const demo1Roles: string[] = Array.isArray(demo1.roles) ? demo1.roles.slice() : [];
  const demo1NextRoles = Array.from(new Set([...demo1Roles, "CUSTOMER"]));
  const demo1UserDiff = {
    workspaceId: { from: demo1.workspaceId, to: DEMO_WORKSPACE_ID },
    accountType: { from: demo1.accountType, to: "CUSTOMER" },
    userType: { from: demo1.userType, to: "CUSTOMER" },
    customerId: { from: demo1.customerId, to: DEMO_CUSTOMER_ID },
    businessId: { from: demo1.businessId, to: DEMO_CUSTOMER_ID },
    roles: { from: demo1Roles, to: demo1NextRoles },
    isDemoUser: { from: demo1.isDemoUser, to: true },
  };
  log(`--- demo1 (${demo1._id}) User diff ---\n` + JSON.stringify(demo1UserDiff, null, 2));

  const demo1Perm: any = await UserPermission.findOne({ email: DEMO1_EMAIL }).lean();
  let demo1PermDiff: any = null;
  if (demo1Perm) {
    demo1PermDiff = { workspaceId: { from: demo1Perm.workspaceId, to: DEMO_WORKSPACE_ID } };
    log(
      `--- demo1 UserPermission (${demo1Perm._id}) diff — workspaceId gap fix ONLY. ` +
        `NOT rewriting its modules/level/tier (currently level=${demo1Perm.level?.code}, tier=${demo1Perm.tier}, ` +
        `modules mostly NONE — pre-existing default onboarding shape, out of scope for this script). ---\n` +
        JSON.stringify(demo1PermDiff, null, 2),
    );
  } else {
    log(`⚠ No existing UserPermission doc found for ${DEMO1_EMAIL} — none will be created (out of scope; flagging only).`);
  }

  // ────────────────────────────────────────────────────────────────────────
  // demo2 — DELETE stray employee record, RECREATE as CUSTOMER seed
  // Resumable: if demo2 already exists as the recreated CUSTOMER seed (e.g. a
  // prior run got this far before failing later), skip delete+recreate and
  // just ensure its UserPermission doc exists.
  // ────────────────────────────────────────────────────────────────────────
  const demo2: any = await User.findOne({ email: DEMO2_EMAIL }).lean();
  if (!demo2) throw new Error(`${DEMO2_EMAIL} not found — expected to already exist per audit.`);
  const demo2AlreadyRecreated = demo2.accountType === "CUSTOMER" && demo2.isDemoUser === true;
  if (!demo2AlreadyRecreated && demo2.employeeCode !== "PTS001094") {
    throw new Error(
      `Safety check failed: ${DEMO2_EMAIL} employeeCode=${demo2.employeeCode} !== expected PTS001094 — refusing to delete.`,
    );
  }
  if (demo2AlreadyRecreated) {
    log(`⏭️  ${DEMO2_EMAIL} (${demo2._id}) already recreated as a CUSTOMER seed — skipping delete+recreate, will only ensure UserPermission.`);
  }
  const demo2OldId = String(demo2._id);
  const demo2OldPerm: any = await UserPermission.findOne({ email: DEMO2_EMAIL }).lean();
  // userId on leavebalances is stored as an ObjectId, not a string — query
  // both forms so this actually matches (a string-only query silently misses it).
  const demo2LeaveBalances: any[] = await mongoose.connection.db!
    .collection("leavebalances")
    .find({ userId: { $in: [demo2OldId, demo2._id] } })
    .toArray();

  log(
    `--- demo2 DELETE plan ---\n` +
      `User ${demo2OldId} (email=${demo2.email}, employeeCode=${demo2.employeeCode}, workspaceId=${demo2.workspaceId})\n` +
      (demo2OldPerm ? `UserPermission ${demo2OldPerm._id} (universe=${demo2OldPerm.universe}, workspaceId=${demo2OldPerm.workspaceId})\n` : `UserPermission: none found\n`) +
      `LeaveBalance docs: ${demo2LeaveBalances.length} (${demo2LeaveBalances.map((d) => d._id).join(", ") || "none"})`,
  );

  const demo2Password = await bcrypt.hash("DemoUser@2026", 12);
  const demo2NewDoc = {
    email: DEMO2_EMAIL,
    officialEmail: DEMO2_EMAIL,
    personalEmail: DEMO2_EMAIL,
    firstName: "Priya",
    lastName: "Singh",
    name: "Priya Singh",
    roles: ["CUSTOMER", "REQUESTER"],
    passwordHash: demo2Password,
    customerId: DEMO_CUSTOMER_ID,
    businessId: DEMO_CUSTOMER_ID,
    workspaceId: demoWorkspaceOid,
    accountType: "CUSTOMER",
    userType: "CUSTOMER",
    status: "ACTIVE",
    sbtEnabled: false,
    canRaiseRequest: true,
    isDemoUser: true,
  };
  log(`--- demo2 RECREATE plan (new User doc) ---\n` + JSON.stringify({ ...demo2NewDoc, passwordHash: "<hashed>" }, null, 2));

  const demo2NewPermDoc = {
    email: DEMO2_EMAIL.toLowerCase(),
    workspaceId: DEMO_WORKSPACE_ID,
    universe: "CUSTOMER" as const,
    level: { code: "CUSTOMER_APPROVAL", name: "Business Client", designation: "Requestor" },
    status: "active",
    tier: 1,
    roleType: "CLIENT",
    grantedModules: REQUESTER_GRANTED_MODULES,
    modules: REQUESTER_MODULES,
    source: "system", // UserPermission.ts:210-213 enum is ['onboarding','manual','migration','system'] — 'demo-seed' is NOT valid
    grantedBy: "system",
    grantedAt: new Date(),
  };
  log(`--- demo2 UserPermission CREATE plan ---\n` + JSON.stringify(demo2NewPermDoc, null, 2));

  // ────────────────────────────────────────────────────────────────────────
  // demo3 — CREATE fresh. Resumable: if it already exists as a CUSTOMER demo
  // seed (a prior run got this far), skip creation and just ensure its
  // UserPermission doc exists.
  // ────────────────────────────────────────────────────────────────────────
  const demo3Existing: any = await User.findOne({ email: DEMO3_EMAIL }).lean();
  const demo3AlreadyCreated = !!demo3Existing && demo3Existing.accountType === "CUSTOMER" && demo3Existing.isDemoUser === true;
  if (demo3Existing && !demo3AlreadyCreated) {
    throw new Error(`${DEMO3_EMAIL} exists (${demo3Existing._id}) but not in the expected CUSTOMER-demo-seed shape — re-verify before proceeding.`);
  }
  if (demo3AlreadyCreated) {
    log(`⏭️  ${DEMO3_EMAIL} (${demo3Existing._id}) already created as a CUSTOMER seed — skipping creation, will only ensure UserPermission.`);
  }
  const demo3Password = await bcrypt.hash("DemoUser@2026", 12);
  const demo3NewDoc = {
    email: DEMO3_EMAIL,
    officialEmail: DEMO3_EMAIL,
    personalEmail: DEMO3_EMAIL,
    firstName: "Arjun",
    lastName: "Verma",
    name: "Arjun Verma",
    roles: ["CUSTOMER", "REQUESTER"],
    passwordHash: demo3Password,
    customerId: DEMO_CUSTOMER_ID,
    businessId: DEMO_CUSTOMER_ID,
    workspaceId: demoWorkspaceOid,
    accountType: "CUSTOMER",
    userType: "CUSTOMER",
    status: "ACTIVE",
    sbtEnabled: false,
    canRaiseRequest: true,
    isDemoUser: true,
  };
  log(`--- demo3 CREATE plan (new User doc) ---\n` + JSON.stringify({ ...demo3NewDoc, passwordHash: "<hashed>" }, null, 2));

  const demo3NewPermDoc = {
    email: DEMO3_EMAIL.toLowerCase(),
    workspaceId: DEMO_WORKSPACE_ID,
    universe: "CUSTOMER" as const,
    level: { code: "CUSTOMER_APPROVAL", name: "Business Client", designation: "Requestor" },
    status: "active",
    tier: 1,
    roleType: "CLIENT",
    grantedModules: REQUESTER_GRANTED_MODULES,
    modules: REQUESTER_MODULES,
    source: "system", // UserPermission.ts:210-213 enum is ['onboarding','manual','migration','system'] — 'demo-seed' is NOT valid
    grantedBy: "system",
    grantedAt: new Date(),
  };
  log(`--- demo3 UserPermission CREATE plan ---\n` + JSON.stringify(demo3NewPermDoc, null, 2));

  // ────────────────────────────────────────────────────────────────────────
  // Granter — imran.ali@plumtrips.com demoAccess.mappedSeedUsers
  // ────────────────────────────────────────────────────────────────────────
  const granter: any = await User.findOne({ email: GRANTER_EMAIL }).lean();
  if (!granter) throw new Error(`${GRANTER_EMAIL} not found — cannot wire granter access.`);
  const existingMapped: string[] = (granter.demoAccess?.mappedSeedUsers || []).map((id: any) => String(id));
  log(`--- Granter ${GRANTER_EMAIL} (${granter._id}) current demoAccess ---\n` + JSON.stringify(granter.demoAccess, null, 2));
  log(`Existing mappedSeedUsers count: ${existingMapped.length} (kept unchanged; new 3 seed ids appended once demo2/demo3 are created)`);

  log("\nDRY-RUN COMPLETE. Review every diff above. Re-run with --apply to commit demo1/demo2 changes.");
  log("NOTE: demo3 creation and the granter wire-up (Step 3) both depend on demo2's NEW _id, which does not");
  log("exist until this script (or a follow-up) actually applies. This script performs demo1 repair, demo2");
  log("delete+recreate, and demo3 create in one --apply pass, and prints the final _ids for Step 3 wiring.");

  if (!APPLY) {
    await mongoose.disconnect();
    return;
  }

  // ══════════════════════════════════════════════════════════════════════
  // APPLY
  // ══════════════════════════════════════════════════════════════════════

  // demo1 repair
  await User.updateOne(
    { _id: demo1._id },
    {
      $set: {
        workspaceId: demoWorkspaceOid,
        accountType: "CUSTOMER",
        userType: "CUSTOMER",
        customerId: DEMO_CUSTOMER_ID,
        businessId: DEMO_CUSTOMER_ID,
        roles: demo1NextRoles,
        isDemoUser: true,
      },
    },
  );
  log(`✅ demo1 User repaired.`);
  if (demo1Perm) {
    await UserPermission.updateOne({ _id: demo1Perm._id }, { $set: { workspaceId: DEMO_WORKSPACE_ID } });
    log(`✅ demo1 UserPermission workspaceId repaired.`);
  }

  // demo2 delete + recreate (skipped if a prior run already got this far)
  let demo2Created: any;
  if (demo2AlreadyRecreated) {
    demo2Created = demo2;
  } else {
    await User.deleteOne({ _id: demo2._id });
    if (demo2OldPerm) await UserPermission.deleteOne({ _id: demo2OldPerm._id });
    if (demo2LeaveBalances.length) {
      await mongoose.connection.db!.collection("leavebalances").deleteMany({ userId: { $in: [demo2OldId, demo2._id] } });
    }
    log(`✅ demo2 stray employee record + permission + leave balance deleted (old _id: ${demo2OldId}).`);
    demo2Created = await User.create(demo2NewDoc);
    log(`✅ demo2 recreated as CUSTOMER seed. New _id: ${demo2Created._id}`);
  }
  // Idempotent: upsert so re-running after a partial failure doesn't duplicate.
  await UserPermission.findOneAndUpdate(
    { email: DEMO2_EMAIL.toLowerCase() },
    { $setOnInsert: { ...demo2NewPermDoc, userId: String(demo2Created._id) } },
    { upsert: true, new: true, runValidators: true },
  );
  log(`✅ demo2 UserPermission ensured.`);

  // demo3 create (skipped if a prior run already got this far)
  let demo3Created: any;
  if (demo3AlreadyCreated) {
    demo3Created = demo3Existing;
  } else {
    demo3Created = await User.create(demo3NewDoc);
    log(`✅ demo3 created as CUSTOMER seed. New _id: ${demo3Created._id}`);
  }
  await UserPermission.findOneAndUpdate(
    { email: DEMO3_EMAIL.toLowerCase() },
    { $setOnInsert: { ...demo3NewPermDoc, userId: String(demo3Created._id) } },
    { upsert: true, new: true, runValidators: true },
  );
  log(`✅ demo3 UserPermission ensured.`);

  // Post-write assertions
  const demo1After: any = await User.findById(demo1._id).lean();
  const demo2After: any = await User.findById(demo2Created._id).lean();
  const demo3After: any = await User.findById(demo3Created._id).lean();
  for (const [label, doc] of [
    ["demo1", demo1After],
    ["demo2", demo2After],
    ["demo3", demo3After],
  ] as const) {
    const wsOk = doc.workspaceId instanceof mongoose.Types.ObjectId && String(doc.workspaceId) !== HOUSE_WORKSPACE_ID;
    const typeOk = doc.accountType === "CUSTOMER";
    if (!wsOk || !typeOk) {
      throw new Error(`POST-WRITE ASSERTION FAILED for ${label}: workspaceIdOk=${wsOk} accountTypeOk=${typeOk}`);
    }
    log(`✅ Assertion passed for ${label}: workspaceId=${doc.workspaceId} (!=HOUSE), accountType=${doc.accountType}`);
  }

  // Wire granter access (Step 3) — appends the 3 new/repaired ids, keeps existing ones.
  const newMappedIds = [String(demo1._id), String(demo2Created._id), String(demo3Created._id)];
  const nextMapped = Array.from(new Set([...existingMapped, ...newMappedIds]));
  await User.updateOne(
    { _id: granter._id },
    { $set: { "demoAccess.enabled": true, "demoAccess.mappedSeedUsers": nextMapped.map((id) => new mongoose.Types.ObjectId(id)) } },
  );
  log(`✅ Granter ${GRANTER_EMAIL} demoAccess.mappedSeedUsers updated. Total mapped: ${nextMapped.length} (was ${existingMapped.length}).`);
  log(`   New ids added: ${newMappedIds.join(", ")}`);

  log("\n✅ APPLY COMPLETE.");
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error("[provision-demo-customer-seeds] FAILED:", e?.message || e);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
