/**
 * diag-admin-allscope.ts  (READ-ONLY — no writes)
 *
 * Diagnoses why admin@plumtrips.com cannot see the WhatsApp-captured expenses
 * even on the new Mine/All "All" view.
 *
 *   1) Prints the resolved workspaceId of admin@plumtrips.com and
 *      imranalikhan.immi@gmail.com, and the workspaceId stamped on the 3
 *      sourceChannel:"whatsapp" expenses. Compares all to 69679a76…2254.
 *   2) Executes the EXACT ALL-scope admin query (buildExpenseFilter with NO
 *      employeeId, the admin's resolved workspaceId, no status) and reports the
 *      row count + whether the WhatsApp refs appear.
 *
 *   pnpm -C apps/backend exec tsx src/scripts/diag-admin-allscope.ts
 *
 * find()/findOne()/countDocuments()/distinct() only — ZERO writes.
 */
import "dotenv/config";
import mongoose from "mongoose";

const ADMIN_EMAIL = "admin@plumtrips.com";
const VIEWER_EMAIL = "imranalikhan.immi@gmail.com";
const HOUSE_WS = "69679a7628330a58d29f2254"; // the "69679a76…2254" referenced in the task

function oid(v: any) {
  try {
    return new mongoose.Types.ObjectId(String(v));
  } catch {
    return null;
  }
}

// Mirrors requireWorkspace.isCustomerUser + isSuperAdmin.
const CUSTOMER_ROLES = new Set(["CUSTOMER", "WORKSPACE_LEADER", "REQUESTER", "APPROVER", "BUSINESS"]);
const STAFF_OVERRIDE = new Set([
  "TENANT_ADMIN", "ADMIN", "SUPERADMIN", "HR", "HR_ADMIN", "MANAGER", "EMPLOYEE", "LEAD", "TEAM_LEAD", "OWNER",
]);
function rolesOf(user: any): string[] {
  return Array.isArray(user?.roles) ? user.roles.map((r: string) => String(r).toUpperCase()) : [];
}
function isCustomerUser(user: any): boolean {
  const roles = rolesOf(user);
  if (roles.some((r) => STAFF_OVERRIDE.has(r))) return false;
  return roles.some((r) => CUSTOMER_ROLES.has(r));
}
function isSuperAdmin(user: any): boolean {
  return rolesOf(user).includes("SUPERADMIN") || String(user?.role).toUpperCase() === "SUPERADMIN" || user?.isSuperAdmin === true;
}

async function resolveWorkspace(db: any, user: any): Promise<{ id: string | null; status: any; path: string }> {
  const workspaces = db.collection("customerworkspaces");

  // ── SUPERADMIN bypass: NO DB lookup. Effective ws = explicit (none from a
  //    plain GET) → JWT workspaceId | customerId | businessId. We proxy the JWT
  //    with the User doc fields (the JWT is minted from them at login).
  if (isSuperAdmin(user)) {
    const explicit = user.workspaceId ?? user.customerId ?? user.businessId ?? null;
    return {
      id: explicit ? String(explicit) : null,
      status: "(SUPERADMIN bypass — workspace NOT validated/looked up)",
      path: `SUPERADMIN bypass → ws from JWT(${explicit ? String(explicit) : "none"})`,
    };
  }

  // ── TBO cert bypass ──
  if (String(user.email || "").toLowerCase() === "tbocertification@plumtrips.com") {
    return { id: HOUSE_WS, status: "(cert bypass)", path: "TBO cert bypass" };
  }

  if (isCustomerUser(user)) {
    const raw = user.customerId ?? user.businessId ?? null;
    const ws = raw ? await workspaces.findOne({ customerId: String(raw) }) : null;
    return { id: ws?._id ? String(ws._id) : null, status: ws?.status ?? null, path: `CUSTOMER → findOne({customerId:${raw}})` };
  }

  // Staff path: workspaceId > customerId > businessId, findById then customerId fallback.
  let raw = user.workspaceId ?? user.customerId ?? user.businessId ?? null;
  if (!raw && user.email) {
    const domain = String(user.email).split("@")[1]?.toLowerCase();
    if (domain && new Set(["plumtrips.com", "helloviza.com"]).has(domain)) raw = HOUSE_WS;
  }
  let ws = raw ? await workspaces.findOne({ _id: oid(raw) }) : null;
  if (!ws && raw) ws = await workspaces.findOne({ customerId: String(raw) });
  return { id: ws?._id ? String(ws._id) : null, status: ws?.status ?? null, path: `STAFF → findById(${raw})` };
}

async function main() {
  const uri = process.env.MONGO_URI!;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { readPreference: "secondary" });
  const db = mongoose.connection.db!;
  const users = db.collection("users");
  const expenses = db.collection("expenses");

  const admin: any = await users.findOne({ email: { $regex: `^${ADMIN_EMAIL}$`, $options: "i" } });
  const viewer: any = await users.findOne({ email: { $regex: `^${VIEWER_EMAIL}$`, $options: "i" } });

  console.log("════════════════════════════════════════════════════════════");
  console.log(" Q1 — Identities & workspace resolution");
  console.log("════════════════════════════════════════════════════════════");

  if (!admin) console.log(`!! admin user ${ADMIN_EMAIL} NOT FOUND`);
  if (!viewer) console.log(`!! viewer user ${VIEWER_EMAIL} NOT FOUND`);

  let adminWs: any = null;
  if (admin) {
    adminWs = await resolveWorkspace(db, admin);
    console.log("\n── admin@plumtrips.com ──");
    console.log({
      _id: String(admin._id),
      roles: admin.roles,
      role: admin.role,
      isSuperAdmin: isSuperAdmin(admin),
      jwt_workspaceId: admin.workspaceId ? String(admin.workspaceId) : null,
      jwt_customerId: admin.customerId ? String(admin.customerId) : null,
      jwt_businessId: admin.businessId ? String(admin.businessId) : null,
      resolvePath: adminWs.path,
      RESOLVED_workspaceId: adminWs.id,
      resolvedStatus: adminWs.status,
      equals_69679a76_2254: adminWs.id === HOUSE_WS,
    });
  }

  let viewerWs: any = null;
  if (viewer) {
    viewerWs = await resolveWorkspace(db, viewer);
    console.log("\n── imranalikhan.immi@gmail.com ──");
    console.log({
      _id: String(viewer._id),
      roles: viewer.roles,
      role: viewer.role,
      jwt_workspaceId: viewer.workspaceId ? String(viewer.workspaceId) : null,
      jwt_customerId: viewer.customerId ? String(viewer.customerId) : null,
      jwt_businessId: viewer.businessId ? String(viewer.businessId) : null,
      resolvePath: viewerWs.path,
      RESOLVED_workspaceId: viewerWs.id,
      resolvedStatus: viewerWs.status,
      equals_69679a76_2254: viewerWs.id === HOUSE_WS,
    });
  }

  // ── The 3 WhatsApp expenses ──
  const waDocs = await expenses
    .find({ sourceChannel: "whatsapp" })
    .project({ ref: 1, workspaceId: 1, employeeId: 1, amount: 1, merchant: 1, lifecycleStatus: 1 })
    .toArray();

  console.log("\n── sourceChannel:\"whatsapp\" expenses ──");
  console.log(`count = ${waDocs.length}`);
  for (const d of waDocs) {
    console.log({
      ref: d.ref,
      workspaceId: d.workspaceId ? String(d.workspaceId) : null,
      employeeId: d.employeeId ? String(d.employeeId) : null,
      equals_69679a76_2254: String(d.workspaceId) === HOUSE_WS,
      merchant: d.merchant ?? null,
      amount: d.amount ?? null,
      lifecycleStatus: d.lifecycleStatus ?? "(missing)",
    });
  }
  const waWsIds = Array.from(new Set(waDocs.map((d: any) => String(d.workspaceId))));
  const waRefs = waDocs.map((d: any) => d.ref);

  console.log("\n── Q1 verdict ──");
  console.log({
    admin_ws: adminWs?.id ?? null,
    viewer_ws: viewerWs?.id ?? null,
    whatsapp_ws: waWsIds,
    target: HOUSE_WS,
    all_three_equal_target:
      adminWs?.id === HOUSE_WS && viewerWs?.id === HOUSE_WS && waWsIds.length === 1 && waWsIds[0] === HOUSE_WS,
    admin_ws_equals_whatsapp_ws: !!adminWs?.id && waWsIds.length === 1 && adminWs.id === waWsIds[0],
  });

  console.log("\n════════════════════════════════════════════════════════════");
  console.log(" Q2 — Exact ALL-scope admin query (no employeeId, no status)");
  console.log("════════════════════════════════════════════════════════════");

  // buildExpenseFilter for a seesAll admin with NO ?employeeId and NO ?status:
  //   { workspaceId: req.workspaceObjectId }   ← the ONLY clause.
  if (!adminWs?.id) {
    console.log("Admin workspace did not resolve → buildExpenseFilter would stamp workspaceId=undefined.");
    console.log("countDocuments({ workspaceId: undefined }) =", await expenses.countDocuments({ workspaceId: undefined } as any));
  } else {
    const wsOid = oid(adminWs.id)!;
    const filter = { workspaceId: wsOid };
    const total = await expenses.countDocuments(filter as any);
    const found = await expenses
      .find({ ...filter, sourceChannel: "whatsapp" } as any)
      .project({ ref: 1 })
      .toArray();
    const foundRefs = found.map((d: any) => d.ref);
    console.log("\nALL-scope filter =", JSON.stringify({ workspaceId: adminWs.id }));
    console.log({
      total_rows_returned: total,
      whatsapp_refs_expected: waRefs,
      whatsapp_refs_in_result: foundRefs,
      whatsapp_visible: waRefs.every((r: any) => foundRefs.includes(r)) && waRefs.length > 0,
    });
  }

  // Cross-check: where DO the whatsapp expenses live vs the admin workspace?
  console.log("\n── Cross-check ──");
  console.log({
    whatsapp_count_in_ADMIN_ws: adminWs?.id ? await expenses.countDocuments({ workspaceId: oid(adminWs.id), sourceChannel: "whatsapp" } as any) : "n/a",
    whatsapp_count_in_VIEWER_ws: viewerWs?.id ? await expenses.countDocuments({ workspaceId: oid(viewerWs.id), sourceChannel: "whatsapp" } as any) : "n/a",
    total_expenses_in_ADMIN_ws: adminWs?.id ? await expenses.countDocuments({ workspaceId: oid(adminWs.id) } as any) : "n/a",
  });

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
