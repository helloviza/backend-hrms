/**
 * One-time script: reset invoice:FY2026 counter from 43 → 41.
 * Context: INV-20260042 and INV-20260043 were cancelled+deleted during the
 * Molnlycke reissue. Only INV-20260040 and INV-20260041 exist. Next real
 * invoice should be INV-20260042, so counter must sit at 41 (next $inc = 42).
 *
 * Usage:
 *   pnpm -C apps/backend tsx src/scripts/reset-counter-fy2026.ts
 *
 * Run ONCE. Safe to re-run — it aborts if preconditions aren't met.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../../.env") });

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("MONGO_URI not set in .env");
  process.exit(1);
}

async function run() {
  await mongoose.connect(MONGO_URI!);
  console.log("Connected to MongoDB\n");

  const db = mongoose.connection.db!;
  const invoices = db.collection("invoices");
  const counters = db.collection("counters");

  // ── STEP 1: Show current state ──────────────────────────────────────
  console.log("=== CURRENT STATE ===");
  const allInvs = await invoices
    .find({ invoiceNo: /^INV-2026/ }, { projection: { invoiceNo: 1, status: 1, customerName: 1 } })
    .sort({ invoiceNo: 1 })
    .toArray();
  const counter = await counters.findOne({ _id: "invoice:FY2026" } as any);

  console.log("Invoices in FY2026:");
  for (const inv of allInvs) {
    console.log(`  ${inv.invoiceNo} | status=${inv.status} | customer=${inv.customerName}`);
  }
  console.log("Counter invoice:FY2026:", counter ? `seq=${counter.seq}` : "NOT FOUND");
  console.log();

  // ── SAFETY CHECKS ────────────────────────────────────────────────────
  if (!counter) {
    console.error("Counter invoice:FY2026 not found. Aborting.");
    await mongoose.disconnect();
    process.exit(1);
  }

  if (counter.seq === 41) {
    console.log("Counter already at 41 — nothing to do.");
    await mongoose.disconnect();
    return;
  }

  if (counter.seq !== 43) {
    console.error(`Counter is at ${counter.seq}, expected 43. Investigate before resetting. Aborting.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  // Ensure no live invoice exists with number >= 42 (would mean we'd produce a duplicate)
  const above41 = allInvs.filter((inv) => {
    const m = inv.invoiceNo?.match(/^INV-2026(\d{4})$/);
    return m && parseInt(m[1]) >= 42 && inv.status !== "CANCELLED";
  });
  if (above41.length > 0) {
    console.error(
      "Found live invoices numbered >= 42 — resetting would produce duplicates. Aborting.\n",
      above41.map((i) => `${i.invoiceNo} (${i.status})`).join(", "),
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  // ── STEP 2: Reset counter to 41 ─────────────────────────────────────
  console.log("=== STEP 2: Resetting counter invoice:FY2026 to seq=41 ===");
  const result = await counters.updateOne(
    { _id: "invoice:FY2026" } as any,
    { $set: { seq: 41 } },
  );
  console.log(`updateOne: acknowledged=${result.acknowledged} modifiedCount=${result.modifiedCount}`);
  console.log();

  // ── STEP 3: Verify ──────────────────────────────────────────────────
  console.log("=== FINAL STATE VERIFICATION ===");
  const finalCounter = await counters.findOne({ _id: "invoice:FY2026" } as any);
  console.log("Counter invoice:FY2026:", finalCounter ? `seq=${finalCounter.seq}` : "NOT FOUND");

  if (finalCounter?.seq !== 41) {
    console.error(`⚠ Counter is ${finalCounter?.seq}, expected 41. Something went wrong.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log("✓ Counter at 41 — next generated invoice will be INV-20260042.");
  await mongoose.disconnect();
  console.log("\nDone.");
}

run().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
