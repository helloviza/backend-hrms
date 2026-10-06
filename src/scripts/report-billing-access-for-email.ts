// apps/backend/src/scripts/report-billing-access-for-email.ts
//
// READ-ONLY. For ONE email: why does this person get (or not get) the staff
// Invoices / Credit Notes routers? Prints the User's roles, account type, level,
// HOUSE membership, every customer / vendor marker, the invoices + creditnotes
// grants, and walks requireBillingStaff the way the server would — BEFORE
// (travel roles counted as "external") and AFTER the fix. Writes nothing.
//
//   npx tsx src/scripts/report-billing-access-for-email.ts --expect-db=<db> --email=<email>
//
// The token is approximated from the DB the way routes/auth.ts builds it: a
// STAFF account's access token carries User.roles + workspaceId and never
// customerMemberRole; a non-staff account carries its member role instead.
import "dotenv/config";
import mongoose from "mongoose";

const HOUSE = "69679a7628330a58d29f2254";
const norm = (v: unknown) => String(v ?? "").trim().toUpperCase().replace(/[\s\-_]/g, "");
const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));

// routes/auth.ts isStaffActor (mirrored).
const STAFF_ROLES = ["SUPERADMIN", "ADMIN", "HR", "HRADMIN", "STAFF", "TENANTADMIN", "MANAGER", "EMPLOYEE", "LEAD", "TEAMLEAD", "OWNER"];
// middleware/rbac.ts requireAdmin (mirrored).
const ADMIN_ROLES = ["ADMIN", "SUPERADMIN", "HR", "HRADMIN", "OPS", "OPSADMIN", "TENANTADMIN", "WORKSPACEADMIN"];
// middleware/requireBillingStaff.ts EXTERNAL_MARKERS, before and after the fix.
const EXTERNAL_BEFORE = ["CUSTOMER", "BUSINESS", "CLIENT", "CORPORATE", "VENDOR", "SUPPLIER", "WORKSPACELEADER", "REQUESTER", "APPROVER", "TRAVELLER", "TRAVELER"];
const EXTERNAL_AFTER = ["CUSTOMER", "BUSINESS", "CLIENT", "CORPORATE", "VENDOR", "SUPPLIER"];

async function main() {
  const args = process.argv.slice(2);
  const expectDb = args.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
  const email = (args.find((a) => a.startsWith("--email="))?.split("=")[1] || "").trim().toLowerCase();
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  if (!email) throw new Error("--email=<address> is required");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.name;
  if (!expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (expectDb !== db) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${db}".`);
  const col = (n: string) => mongoose.connection.collection(n);
  console.log(`db ${db} · READ-ONLY · ${email}\n`);

  const rx = new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
  const users = await col("users").find({ $or: [{ email: rx }, { officialEmail: rx }] }).toArray();
  if (!users.length) { console.log("No User with that email."); return; }
  if (users.length > 1) console.log(`⚠ ${users.length} User docs match this email (login uses the OLDER one) — showing all.\n`);

  for (const u of users as any[]) {
    const id = s(u._id);
    const dbRoles: string[] = (Array.isArray(u.roles) ? u.roles : []).map(String);
    const n = dbRoles.map(norm);
    const staff = ["STAFF"].includes(norm(u.hrmsAccessLevel)) || ["STAFF"].includes(norm(u.accountType)) ||
      ["STAFF"].includes(norm(u.userType)) || n.some((r) => STAFF_ROLES.includes(r));
    const members = await col("customermembers").find({ email: rx }).project({ customerId: 1, role: 1, status: 1, workspaceId: 1 }).toArray();
    const perm: any = await col("userpermissions").findOne({ userId: id });

    console.log(`User ${id}  status ${s(u.status || "-")}  created ${s(u.createdAt?.toISOString?.() || "-")}`);
    console.log(`  roles            [${dbRoles.join(", ")}]`);
    console.log(`  accountType      ${s(u.accountType || "-")}   userType ${s(u.userType || "-")}`);
    console.log(`  hrmsAccessRole   ${s(u.hrmsAccessRole || "-")}   hrmsAccessLevel ${s(u.hrmsAccessLevel || "-")}`);
    console.log(`  workspaceId      ${s(u.workspaceId || "-")}  ${s(u.workspaceId) === HOUSE ? "(HOUSE — Plumtrips)" : "(NOT HOUSE)"}`);
    console.log(`  customer/vendor  customerId ${s(u.customerId || "-")}  vendorId ${s(u.vendorId || "-")}  businessId ${s(u.businessId || "-")}  customerMemberRole ${s(u.customerMemberRole || "-")}`);
    console.log(`  CustomerMember   ${members.length ? members.map((m: any) => `${s(m.role)}@${s(m.customerId || m.workspaceId)} (${s(m.status || "-")})`).join("; ") : "none"}`);
    console.log(`  auth classifies  ${staff ? "STAFF — token carries roles + workspaceId, no customerMemberRole" : "NOT STAFF — token carries member role; customer-side"}`);
    if (perm) {
      const g = (k: string) => `${s(perm.modules?.[k]?.access || "NONE")}/${s(perm.modules?.[k]?.scope || "NONE")}`;
      console.log(`  grant            level ${s(perm.level?.code)} ${s(perm.level?.name)}  roleType ${s(perm.roleType || "-")}  ws ${s(perm.workspaceId)}`);
      console.log(`                   invoices ${g("invoices")}   creditnotes ${g("creditnotes")}   companySettings ${g("companySettings")}`);
    } else {
      console.log("  grant            NO UserPermission doc (every requirePermission → 403 'Access not granted')");
    }

    // Walk requireBillingStaff as the server would (token roles ≈ DB roles for staff).
    const tokenRoles = staff ? n : [...n, "CUSTOMER"];
    const tokenWs = staff ? s(u.workspaceId) : "";
    const isSA = n.includes("SUPERADMIN") || u.isSuperAdmin === true;
    const hasMemberRole = !staff && members.length > 0;
    const verdict = (markers: string[]) => {
      if (isSA) return "PASS — Super Admin";
      const external = hasMemberRole || tokenRoles.some((r) => markers.includes(r));
      if (tokenWs === HOUSE && !external) return "PASS — HOUSE staff, not a customer/vendor account (grant decides)";
      if (tokenRoles.some((r) => ADMIN_ROLES.includes(r))) return "PASS — requireAdmin role (grant decides)";
      const why = tokenWs !== HOUSE ? "workspace is not HOUSE"
        : `counted as external: ${tokenRoles.filter((r) => markers.includes(r)).join(", ") || "customer membership"}`;
      return `REFUSED "Admin access required" — ${why}, and no ADMIN/HR/OPS-type role`;
    };
    console.log(`  requireBillingStaff BEFORE fix: ${verdict(EXTERNAL_BEFORE)}`);
    console.log(`  requireBillingStaff AFTER  fix: ${verdict(EXTERNAL_AFTER)}\n`);
  }
}

main()
  .catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
