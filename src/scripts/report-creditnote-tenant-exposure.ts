// apps/backend/src/scripts/report-creditnote-tenant-exposure.ts
//
// READ-ONLY report for the credit-note tenant-scope fix. Writes nothing.
//
//   A. Non-Plumtrips users holding the `creditnotes` grant (access ≠ NONE) —
//      before the fix these could read every tenant's credit notes; after it,
//      only their own workspace's.
//   B. Credit notes per workspace — whether any tenant has credit notes of its
//      own, and whether anyone outside Plumtrips can now see them.
//
// "Plumtrips" = the HOUSE workspace (69679a7628330a58d29f2254), judged on the
// UserPermission's workspaceId OR the user's own workspaceId.
// A credit note's workspaceId is its invoice's — CustomerWorkspace._id or
// (legacy) Customer._id; both are resolved.
//
//   npx tsx src/scripts/report-creditnote-tenant-exposure.ts --expect-db=<db>
import "dotenv/config";
import mongoose from "mongoose";

const HOUSE = "69679a7628330a58d29f2254";
const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));

async function main() {
  const args = process.argv.slice(2);
  const expectDb = args.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.name;
  if (!expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (expectDb !== db) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${db}".`);
  const col = (n: string) => mongoose.connection.collection(n);
  console.log(`db ${db} · READ-ONLY report · ${new Date().toISOString()}\n`);

  // Workspace + customer names, keyed by id (both id-spaces).
  const workspaces = await col("customerworkspaces")
    .find({}, { projection: { companyName: 1, customerId: 1, tenantType: 1, "config.features.invoicesEnabled": 1 } }).toArray();
  const wsById = new Map(workspaces.map((w: any) => [s(w._id), w]));
  const wsByCustomer = new Map(workspaces.filter((w: any) => w.customerId).map((w: any) => [s(w.customerId), w]));
  const customers = await col("customers").find({}, { projection: { name: 1, legalName: 1 } }).toArray();
  const custById = new Map(customers.map((c: any) => [s(c._id), c]));
  // Canonical workspace for any id (CWS._id, or Customer._id → its CWS).
  const canonical = (id: string) => wsById.get(id) || wsByCustomer.get(id) || null;
  const label = (id: string) => {
    if (id === HOUSE) return "Plumtrips (House)";
    const w: any = canonical(id);
    const c: any = custById.get(id) || (w?.customerId ? custById.get(s(w.customerId)) : null);
    return w?.companyName || c?.legalName || c?.name || "(unknown)";
  };
  const canonicalId = (id: string) => s((canonical(id) as any)?._id) || id;

  /* ── A. creditnotes grant holders outside Plumtrips ───────────────── */
  const perms = await col("userpermissions")
    .find({ "modules.creditnotes.access": { $exists: true, $ne: "NONE" } },
      { projection: { userId: 1, email: 1, workspaceId: 1, universe: 1, level: 1, roleType: 1, "modules.creditnotes": 1, "modules.invoices": 1 } })
    .toArray();
  const userIds = perms.map((p: any) => p.userId).filter((id: any) => mongoose.Types.ObjectId.isValid(s(id)));
  const users = await col("users")
    .find({ _id: { $in: userIds.map((id: any) => new mongoose.Types.ObjectId(s(id))) } },
      { projection: { email: 1, roles: 1, workspaceId: 1, status: 1, accountType: 1 } })
    .toArray();
  const userById = new Map(users.map((u: any) => [s(u._id), u]));

  const house: any[] = [];
  const outside: any[] = [];
  for (const p of perms as any[]) {
    const u: any = userById.get(s(p.userId));
    const isHouse = s(p.workspaceId) === HOUSE || s(u?.workspaceId) === HOUSE;
    (isHouse ? house : outside).push({ p, u });
  }
  console.log(`A. creditnotes grant holders (access ≠ NONE): ${perms.length} — Plumtrips ${house.length}, OUTSIDE Plumtrips ${outside.length}`);
  for (const { p, u } of outside) {
    const ws = s(u?.workspaceId || p.workspaceId);
    console.log(
      `   ${s(p.email || u?.email).padEnd(36)} creditnotes ${s(p.modules?.creditnotes?.access)}/${s(p.modules?.creditnotes?.scope)}` +
      `  invoices ${s(p.modules?.invoices?.access || "NONE")}  level ${s(p.level?.code)}  roles [${(u?.roles || []).join(",")}]` +
      `  status ${s(u?.status || "-")}  ws ${ws} (${label(ws)})`,
    );
  }

  /* ── B. credit notes per workspace ─────────────────────────────────── */
  const byWs = await col("creditnotes").aggregate([
    { $group: { _id: "$workspaceId", total: { $sum: 1 },
      issued: { $sum: { $cond: [{ $eq: ["$status", "ISSUED"] }, 1, 0] } },
      draft: { $sum: { $cond: [{ $eq: ["$status", "DRAFT"] }, 1, 0] } },
      cancelled: { $sum: { $cond: [{ $eq: ["$status", "CANCELLED"] }, 1, 0] } },
      demo: { $sum: { $cond: [{ $eq: ["$isDemo", true] }, 1, 0] } } } },
    { $sort: { total: -1 } },
  ]).toArray();

  // Who outside Plumtrips will see each workspace's credit notes after the fix.
  const outsideByWs = new Map<string, string[]>();
  for (const { p, u } of outside) {
    const key = canonicalId(s(u?.workspaceId || p.workspaceId));
    outsideByWs.set(key, [...(outsideByWs.get(key) || []), s(p.email || u?.email)]);
  }

  const total = byWs.reduce((n: number, r: any) => n + r.total, 0);
  console.log(`\nB. credit notes: ${total} across ${byWs.length} workspace id(s)`);
  for (const r of byWs as any[]) {
    const id = s(r._id);
    const w: any = canonical(id);
    const space = wsById.has(id) ? "CWS" : wsByCustomer.has(id) ? "Customer(legacy)" : "unresolved";
    const viewers = outsideByWs.get(canonicalId(id)) || [];
    console.log(
      `   ${id} [${space}] ${label(id).padEnd(32)} total ${r.total} (issued ${r.issued}, draft ${r.draft}, cancelled ${r.cancelled}, demo ${r.demo})` +
      `  tenantType ${s(w?.tenantType || "-")}  outside viewers after fix: ${viewers.length ? viewers.join(", ") : "none"}`,
    );
  }

  const tenantOwned = (byWs as any[]).filter((r) => (outsideByWs.get(canonicalId(s(r._id))) || []).length > 0);
  console.log(
    `\nSummary: ${outside.length} non-Plumtrips creditnotes holder(s); ` +
    `${tenantOwned.length} workspace(s) with credit notes that a non-Plumtrips holder will still see (their own).` +
    `\nBefore the fix every one of the ${outside.length} could list all ${total}. Read-only — nothing written.`,
  );
}

main()
  .catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
