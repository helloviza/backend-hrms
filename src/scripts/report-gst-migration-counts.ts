// apps/backend/src/scripts/report-gst-migration-counts.ts
//
// READ-ONLY. Per-company invoice / manual-booking / SBT-booking counts for the
// P2 dry run (migrate-gst-registrations.ts --counts=<this csv>), taken by
// aggregation so invoices and bookings never have to be dumped. Nothing is
// written to the database; no indexes are built.
//
//   MONGO_URI=... npx tsx src/scripts/report-gst-migration-counts.ts --expect-db=<db> [--out=<file.csv>]
//
// Invoice.workspaceId holds either the company's Customer._id or its
// CustomerWorkspace._id (MIX, audit §8.2); both are folded to the Customer.
import "dotenv/config";
import fs from "node:fs";
import mongoose from "mongoose";

async function groupCount(coll: string, field: string): Promise<Map<string, number>> {
  const rows = await mongoose.connection
    .collection(coll)
    .aggregate([{ $match: { [field]: { $ne: null } } }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }], { readPreference: "secondaryPreferred" } as any)
    .toArray();
  return new Map(rows.map((r: any) => [String(r._id), r.n as number]));
}

async function main() {
  const args = process.argv.slice(2);
  const expectDb = args.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
  const out = args.find((a) => a.startsWith("--out="))?.slice(6) || `gst-migration-counts-${new Date().toISOString().slice(0, 10)}.csv`;
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false, readPreference: "secondaryPreferred" });
  const db = mongoose.connection.name;
  if (!expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (expectDb !== db) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${db}".`);

  const c = mongoose.connection;
  const customers = await c.collection("customers").find({}, { projection: { _id: 1 } }).toArray();
  const workspaces = await c.collection("customerworkspaces").find({}, { projection: { customerId: 1 } }).toArray();
  const wsToCustomer = new Map(workspaces.map((w: any) => [String(w._id), String(w.customerId)]));

  const invoices = await groupCount("invoices", "workspaceId");
  const manual = await groupCount("manualbookings", "workspaceId");
  const sbt = await groupCount("sbtbookings", "customerId");

  const lines = ["customerId,invoices,manualBookings,sbtBookings"];
  const inv = new Map<string, number>();
  for (const [k, n] of invoices) {
    const cust = wsToCustomer.get(k) || k;
    inv.set(cust, (inv.get(cust) || 0) + n);
  }
  for (const cu of customers as any[]) {
    const id = String(cu._id);
    lines.push([id, inv.get(id) || 0, manual.get(id) || 0, sbt.get(id) || 0].join(","));
  }
  fs.writeFileSync(out, lines.join("\n"));
  console.log(`db ${db}: ${customers.length} companies · invoices ${[...invoices.values()].reduce((a, b) => a + b, 0)} · manual ${[...manual.values()].reduce((a, b) => a + b, 0)} · sbt ${[...sbt.values()].reduce((a, b) => a + b, 0)}\nCSV: ${out}`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
