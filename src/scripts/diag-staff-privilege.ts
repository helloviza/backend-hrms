// apps/backend/src/scripts/diag-staff-privilege.ts
// READ-ONLY diagnostic for isStaffPrivileged gate on Manual Booking client search.
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import User from "../models/User.js";

const TARGETS = [
  "chirag@plumtrips.com",
  "nowshiba.malik@plumtrips.com",
  "admin@plumtrips.com",
];

function collectRoles(u: any): string[] {
  const roles: string[] = [];
  if (Array.isArray(u?.roles)) roles.push(...u.roles);
  if (u?.role) roles.push(u.role);
  if (u?.accountType) roles.push(u.accountType);
  if (u?.userType) roles.push(u.userType);
  if (u?.hrmsAccessRole) roles.push(u.hrmsAccessRole);
  if (u?.hrmsAccessLevel) roles.push(u.hrmsAccessLevel);
  return roles.map((r) => String(r).trim().toUpperCase()).filter(Boolean);
}

function isStaffPrivileged(u: any) {
  const r = collectRoles(u);
  if (
    r.includes("TENANT_ADMIN") ||
    r.includes("TENANTADMIN") ||
    r.includes("CLIENT_ADMIN") ||
    r.includes("CLIENTADMIN")
  ) {
    return { pass: false, reason: "HARD_EXCLUDE_TENANT_OR_CLIENT_ADMIN" };
  }
  if (u?.staff === true) return { pass: true, reason: "staff===true" };
  if (u?.isStaff === true) return { pass: true, reason: "isStaff===true" };
  const admit = [
    "STAFF","INTERNAL","DEV","SYSTEM","ADMIN","SUPERADMIN","SUPER_ADMIN","HR","HR_ADMIN",
  ].find((k) => r.includes(k));
  return admit
    ? { pass: true, reason: `roles.includes(${admit})` }
    : { pass: false, reason: "no admit role + no staff flag" };
}

async function main() {
  console.log("🔌 Connecting to MongoDB...");
  await mongoose.connect(env.MONGO_URI);
  console.log("✅ Connected\n");

  for (const email of TARGETS) {
    const u: any = await User.findOne(
      { email: { $regex: new RegExp(`^${email}$`, "i") } },
      {
        email: 1,
        roles: 1,
        role: 1,
        hrmsAccessRole: 1,
        hrmsAccessLevel: 1,
        accountType: 1,
        userType: 1,
        isStaff: 1,
        staff: 1,
        customerId: 1,
        workspaceId: 1,
        sbtRole: 1,
        sbtEnabled: 1,
        approvalRole: 1,
      },
    ).lean();

    console.log(`──────── ${email} ────────`);
    if (!u) {
      console.log("  ❌ NOT FOUND\n");
      continue;
    }
    console.log("  _id:", u._id?.toString());
    console.log("  email:", u.email);
    console.log("  roles[]:", JSON.stringify(u.roles));
    console.log("  role:", u.role);
    console.log("  accountType:", u.accountType);
    console.log("  userType:", u.userType);
    console.log("  hrmsAccessRole:", u.hrmsAccessRole);
    console.log("  hrmsAccessLevel:", u.hrmsAccessLevel);
    console.log("  approvalRole:", u.approvalRole);
    console.log("  isStaff:", u.isStaff);
    console.log("  staff:", u.staff);
    console.log("  sbtRole:", u.sbtRole, "sbtEnabled:", u.sbtEnabled);
    console.log("  customerId:", u.customerId);
    console.log("  workspaceId:", u.workspaceId);
    console.log("  collectRoles() ->", JSON.stringify(collectRoles(u)));
    const verdict = isStaffPrivileged(u);
    console.log(`  isStaffPrivileged -> ${verdict.pass ? "✅ PASS" : "❌ FAIL"}  (${verdict.reason})\n`);
  }

  await mongoose.connection.close();
  console.log("🔒 Connection closed.");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
