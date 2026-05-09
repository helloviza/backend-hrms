// apps/backend/src/scripts/diag-house-users.ts
// READ-ONLY: list every User in the Plumtrips HOUSE workspace and
// evaluate isStaffPrivileged() against each one.
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import User from "../models/User.js";

const HOUSE_WORKSPACE_ID = "69679a7628330a58d29f2254";

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

function isStaffPrivileged(u: any): boolean {
  const r = collectRoles(u);
  if (
    r.includes("TENANT_ADMIN") ||
    r.includes("TENANTADMIN") ||
    r.includes("CLIENT_ADMIN") ||
    r.includes("CLIENTADMIN")
  ) return false;
  if (u?.staff === true) return true;
  if (u?.isStaff === true) return true;
  return (
    r.includes("STAFF") ||
    r.includes("INTERNAL") ||
    r.includes("DEV") ||
    r.includes("SYSTEM") ||
    r.includes("ADMIN") ||
    r.includes("SUPERADMIN") ||
    r.includes("SUPER_ADMIN") ||
    r.includes("HR") ||
    r.includes("HR_ADMIN")
  );
}

async function main() {
  console.log("Connecting to MongoDB...");
  await mongoose.connect(env.MONGO_URI);
  console.log("Connected.\n");

  const users: any[] = await User.find(
    { workspaceId: new mongoose.Types.ObjectId(HOUSE_WORKSPACE_ID) },
    {
      email: 1,
      name: 1,
      displayName: 1,
      roles: 1,
      role: 1,
      accountType: 1,
      userType: 1,
      hrmsAccessRole: 1,
      hrmsAccessLevel: 1,
      isStaff: 1,
      staff: 1,
      sbtRole: 1,
      sbtEnabled: 1,
      customerId: 1,
      department: 1,
      designation: 1,
      title: 1,
    },
  )
    .sort({ email: 1 })
    .lean();

  console.log(`Found ${users.length} users in HOUSE workspace ${HOUSE_WORKSPACE_ID}\n`);

  const rows = users.map((u: any) => ({
    email: u.email || "(no email)",
    name: u.name || u.displayName || "",
    department: u.department || u.designation || u.title || "",
    roles: Array.isArray(u.roles) ? u.roles.join(",") : (u.roles || ""),
    hrmsAccessRole: u.hrmsAccessRole || "",
    hrmsAccessLevel: u.hrmsAccessLevel || "",
    accountType: u.accountType || "",
    isStaff: u.isStaff === true ? "true" : (u.isStaff === false ? "false" : ""),
    staff: u.staff === true ? "true" : (u.staff === false ? "false" : ""),
    sbtRole: u.sbtRole || "",
    customerId: u.customerId ? String(u.customerId) : "",
    gate: isStaffPrivileged(u) ? "PASS" : "FAIL",
  }));

  console.table(rows);

  const passes = rows.filter((r) => r.gate === "PASS").length;
  const fails = rows.filter((r) => r.gate === "FAIL").length;
  console.log(`\nTotal: ${rows.length}   PASS isStaffPrivileged: ${passes}   FAIL: ${fails}`);

  await mongoose.connection.close();
  console.log("Connection closed.");
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
