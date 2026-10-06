// apps/backend/src/scripts/report-invoice-tenant-exposure.ts
//
// READ-ONLY report for the invoice by-id tenant-scope fix. Writes nothing.
//
//   A. Non-Plumtrips users holding the `invoices` grant (access ≠ NONE) —
//      before the fix these could open / edit / cancel / change the status of
//      ANY tenant's invoice by id (the lists were already scoped); after it,
//      only their own workspace's.
//   B. Invoices per workspace, and which non-Plumtrips holders can act on them
//      now (their own only).
//
// "Plumtrips" = the HOUSE workspace (69679a7628330a58d29f2254), judged on the
// UserPermission's workspaceId OR the user's own workspaceId.
// An invoice's workspaceId is CustomerWorkspace._id or (legacy) Customer._id;
// both are resolved.
//
//   npx tsx src/scripts/report-invoice-tenant-exposure.ts --expect-db=<db>
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

  const workspaces = await col("customerworkspaces")
    .find({}, { projection: { companyName: 1, customerId: 1, tenantType: 1 } }).toArray();
  const wsById = new Map(workspaces.map((w: any) => [s(w._id), w]));
  const wsByCustomer = new Map(workspaces.filter((w: any) => w.customerId).map((w: any) => [s(w.customerId), w]));
  const customers = await col("customers").find({}, { projection: { name: 1, legalName: 1 } }).toArray();
  const custById = new Map(customers.map((c: any) => [s(c._id), c]));
  const canonical = (id: string) => wsById.get(id) || wsByCustomer.get(id) || null;
  const label = (id: string) => {
    if (id === HOUSE) return "Plumtrips (House)";
    const w: any = canonical(id);
    const c: any = custById.get(id) || (w?.customerId ? custById.get(s(w.customerId)) : null);
    return w?.companyName || c?.legalName || c?.name || "(unknown)";
  };
  const canonicalId = (id: string) => s((canonical(id) as any)?._id) || id;

  /* ── A. invoices grant holders outside Plumtrips ──────────────────── */
  const perms = await col("userpermissions")
    .find({ "modules.invoices.access": { $exists: true, $ne: "NONE" } },
      { projection: { userId: 1, email: 1, workspaceId: 1, level: 1, "modules.invoices": 1, "modules.creditnotes": 1 } })
    .toArray();
  const userIds = perms.map((p: any) => s(p.userId)).filter((id) => mongoose.Types.ObjectId.isValid(id));
  const users = await col("users")
    .find({ _id: { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) } },
      { projection: { email: 1, roles: 1, workspaceId: 1, status: 1 } })
    .toArray();
  const userById = new Map(users.map((u: any) => [s(u._id), u]));

  const house: any[] = [];
  const outside: any[] = [];
  for (const p of perms as any[]) {
    const u: any = userById.get(s(p.userId));
    const isHouse = s(p.workspaceId) === HOUSE || s(u?.workspaceId) === HOUSE;
    (isHouse ? house : outside).push({ p, u });
  }
  console.log(`A. invoices grant holders (access ≠ NONE): ${perms.length} — Plumtrips ${house.length}, OUTSIDE Plumtrips ${outside.length}`);
  for (const { p, u } of outside) {
    const ws = s(u?.workspaceId || p.workspaceId);
    console.log(
      `   ${s(p.email || u?.email).padEnd(36)} invoices ${s(p.modules?.invoices?.access)}/${s(p.modules?.invoices?.scope)}` +
      `  creditnotes ${s(p.modules?.creditnotes?.access || "NONE")}  level ${s(p.level?.code)}  roles [${(u?.roles || []).join(",")}]` +
      `  status ${s(u?.status || "-")}  ws ${ws} (${label(ws)})`,
    );
  }

  /* ── B. invoices per workspace ──────────────────────────────────────── */
  const st = (v: string) => ({ $sum: { $cond: [{ $eq: ["$status", v] }, 1, 0] } });
  const byWs = await col("invoices").aggregate([
    { $group: { _id: "$workspaceId", total: { $sum: 1 },
      draft: st("DRAFT"), sent: st("SENT"), declared: st("PAYMENT_DECLARED"), paid: st("PAID"), cancelled: st("CANCELLED"),
      demo: { $sum: { $cond: [{ $eq: ["$isDemo", true] }, 1, 0] } } } },
    { $sort: { total: -1 } },
  ]).toArray();

  const outsideByWs = new Map<string, string[]>();
  for (const { p, u } of outside) {
    const key = canonicalId(s(u?.workspaceId || p.workspaceId));
    outsideByWs.set(key, [...(outsideByWs.get(key) || []), s(p.email || u?.email)]);
  }

  const total = byWs.reduce((n: number, r: any) => n + r.total, 0);
  console.log(`\nB. invoices: ${total} across ${byWs.length} workspace id(s)`);
  for (const r of byWs as any[]) {
    const id = s(r._id);
    const w: any = canonical(id);
    const space = wsById.has(id) ? "CWS" : wsByCustomer.has(id) ? "Customer(legacy)" : "unresolved";
    const viewers = outsideByWs.get(canonicalId(id)) || [];
    console.log(
      `   ${id} [${space}] ${label(id).padEnd(32)} total ${r.total} (draft ${r.draft}, sent ${r.sent}, declared ${r.declared}, ` +
      `paid ${r.paid}, cancelled ${r.cancelled}, demo ${r.demo})  tenantType ${s(w?.tenantType || "-")}` +
      `  outside holders after fix: ${viewers.length ? viewers.join(", ") : "none"}`,
    );
  }

  const tenantOwned = (byWs as any[]).filter((r) => (outsideByWs.get(canonicalId(s(r._id))) || []).length > 0);
  console.log(
    `\nSummary: ${outside.length} non-Plumtrips invoices holder(s); ` +
    `${tenantOwned.length} workspace(s) with invoices a non-Plumtrips holder can still act on (their own).` +
    `\nBefore the fix every one of the ${outside.length} could open or act on any of the ${total} invoices by id. Read-only — nothing written.`,
  );
}

main()
  .catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
