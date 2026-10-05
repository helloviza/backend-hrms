// apps/backend/src/scripts/migrate-customer-gst-status.ts
//
// One-time: give every company a GST status (Customer.gstStatus).
//   GSTIN on the Customer record → REGISTERED
//   no GSTIN                     → NOT_SET  (staff mark UNREGISTERED themselves —
//                                            see report-customer-gst-status.ts)
// Only companies with NO status yet are touched, so it is safe to re-run and
// never overrides a status staff have already set. Nothing else is changed.
//
// DRY RUN by default (prints what it would do). Pass --apply to write.
//
//   npx tsx src/scripts/migrate-customer-gst-status.ts --expect-db=<db> [--apply]
import "dotenv/config";
import mongoose from "mongoose";
import { migrationGstStatus } from "../utils/customerGst.js";

const NO_STATUS = { $or: [{ gstStatus: { $exists: false } }, { gstStatus: null }, { gstStatus: "" }] };

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const expectDb = args.find((a) => a.startsWith("--expect-db="))?.split("=")[1];
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.name;
  if (!expectDb) throw new Error(`REFUSING: --expect-db=<name> is required (connected db: "${db}").`);
  if (expectDb !== db) throw new Error(`REFUSING: --expect-db="${expectDb}" but connected db is "${db}".`);

  const customers = mongoose.connection.collection("customers");
  const total = await customers.countDocuments({});
  const already = await customers.countDocuments({ $nor: [NO_STATUS] });
  const todo = await customers
    .find(NO_STATUS, { projection: { name: 1, legalName: 1, gstNumber: 1, gstin: 1 } })
    .toArray();

  const plan = todo.map((c: any) => ({ _id: c._id, name: c.legalName || c.name || "(no name)", status: migrationGstStatus(c) }));
  const registered = plan.filter((p) => p.status === "REGISTERED");
  const notSet = plan.filter((p) => p.status === "NOT_SET");

  console.log(`db ${db} · ${apply ? "APPLY" : "DRY RUN"}`);
  console.log(`companies: ${total} · already have a status: ${already} · to set: ${plan.length}`);
  console.log(`  → REGISTERED (has a GSTIN): ${registered.length}`);
  console.log(`  → NOT_SET    (no GSTIN):    ${notSet.length}`);
  for (const p of plan) console.log(`    ${p.status.padEnd(10)} ${String(p._id)}  ${p.name}`);

  if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --apply to write.");
    return;
  }

  let written = 0;
  for (const status of ["REGISTERED", "NOT_SET"] as const) {
    const ids = plan.filter((p) => p.status === status).map((p) => p._id);
    if (!ids.length) continue;
    // The NO_STATUS guard is repeated in the write so a status set between the
    // read and this write (by staff) is never overridden.
    const r = await customers.updateMany({ _id: { $in: ids }, ...NO_STATUS }, { $set: { gstStatus: status } });
    written += r.modifiedCount;
  }
  console.log(`\nWritten: ${written} of ${plan.length}.`);
}

main()
  .catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
