/**
 * diag-whatsapp-expenses.ts  (READ-ONLY — no writes)
 *
 * Reproduces the exact /api/expenses default-list query for the viewer to find
 * why their own WhatsApp expenses don't render. Prints viewer identity, the
 * requireWorkspace resolution, and the list query result.
 *
 *   pnpm -C apps/backend exec tsx src/scripts/diag-whatsapp-expenses.ts
 *
 * find()/findOne()/countDocuments() only — ZERO writes.
 */
import "dotenv/config";
import mongoose from "mongoose";

const VIEWER_EMAIL = "imranalikhan.immi@gmail.com";

function oid(v: any) {
  try {
    return new mongoose.Types.ObjectId(String(v));
  } catch {
    return null;
  }
}

const CUSTOMER_ROLES = new Set(["CUSTOMER", "WORKSPACE_LEADER", "REQUESTER", "APPROVER", "BUSINESS"]);
const STAFF_OVERRIDE = new Set([
  "TENANT_ADMIN", "ADMIN", "SUPERADMIN", "HR", "HR_ADMIN", "MANAGER", "EMPLOYEE", "LEAD", "TEAM_LEAD", "OWNER",
]);
function isCustomerUser(user: any): boolean {
  const roles: string[] = Array.isArray(user?.roles) ? user.roles.map((r: string) => String(r).toUpperCase()) : [];
  if (roles.some((r) => STAFF_OVERRIDE.has(r))) return false;
  return roles.some((r) => CUSTOMER_ROLES.has(r));
}

async function main() {
  const uri = process.env.MONGO_URI!;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { readPreference: "secondary" });
  const db = mongoose.connection.db!;
  const users = db.collection("users");
  const expenses = db.collection("expenses");
  const workspaces = db.collection("customerworkspaces");

  const viewer: any = await users.findOne({ email: { $regex: `^${VIEWER_EMAIL}$`, $options: "i" } });
  if (!viewer) {
    console.log("Viewer not found");
    await mongoose.disconnect();
    return;
  }

  console.log("── Viewer ──");
  console.log({
    _id: String(viewer._id),
    email: viewer.email,
    roles: viewer.roles,
    role: viewer.role,
    workspaceId: viewer.workspaceId ? String(viewer.workspaceId) : null,
    customerId: viewer.customerId ? String(viewer.customerId) : null,
    businessId: viewer.businessId ? String(viewer.businessId) : null,
  });

  // Reproduce requireWorkspace resolution.
  const customer = isCustomerUser(viewer);
  let resolvedWs: any = null;
  if (customer) {
    const raw = viewer.customerId ?? viewer.businessId ?? null;
    resolvedWs = raw ? await workspaces.findOne({ customerId: String(raw) }) : null;
    console.log(`\nrequireWorkspace path: CUSTOMER → findOne({customerId:${raw}})`);
  } else {
    const raw = viewer.workspaceId ?? viewer.customerId ?? viewer.businessId ?? null;
    resolvedWs = raw ? await workspaces.findOne({ _id: oid(raw) }) : null;
    if (!resolvedWs && raw) resolvedWs = await workspaces.findOne({ customerId: String(raw) });
    console.log(`\nrequireWorkspace path: STAFF → findById(${raw})`);
  }

  const resolvedWsId = resolvedWs?._id ? String(resolvedWs._id) : null;
  console.log({
    resolvedWorkspaceId: resolvedWsId,
    resolvedWorkspaceStatus: resolvedWs?.status ?? null,
  });

  // The workspaceId stamped on the viewer's expenses.
  const sample: any = await expenses.findOne({ sourceChannel: "whatsapp", employeeId: viewer._id });
  console.log("\n── Expense workspace vs resolved workspace ──");
  console.log({
    expenseWorkspaceId: sample?.workspaceId ? String(sample.workspaceId) : null,
    resolvedWorkspaceId: resolvedWsId,
    MATCH: sample && resolvedWsId ? String(sample.workspaceId) === resolvedWsId : "n/a",
  });

  // Reproduce the EXACT default list query for this viewer.
  if (resolvedWsId) {
    const wsOid = oid(resolvedWsId)!;
    const qOwnString = { workspaceId: wsOid, employeeId: String(viewer._id) };
    const qOwnOid = { workspaceId: wsOid, employeeId: viewer._id };
    console.log("\n── Default list query results (workspace = resolved) ──");
    console.log({
      employeeIdAsString_count: await expenses.countDocuments(qOwnString as any),
      employeeIdAsObjectId_count: await expenses.countDocuments(qOwnOid as any),
    });
  }

  // Cross-check: same employee, NO workspace filter.
  console.log("\n── Same employee, ignoring workspace ──");
  console.log({
    total_for_employee: await expenses.countDocuments({ employeeId: viewer._id }),
    whatsapp_for_employee: await expenses.countDocuments({ sourceChannel: "whatsapp", employeeId: viewer._id }),
  });

  // Distinct workspaceIds present on this employee's expenses.
  const wsOnExpenses = await expenses.distinct("workspaceId", { employeeId: viewer._id });
  console.log("workspaceIds on this employee's expenses:", wsOnExpenses.map((w: any) => String(w)));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
