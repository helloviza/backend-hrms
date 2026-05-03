/**
 * One-time script: hard-delete cancelled INV-20260041 (never sent externally),
 * rename INV-20260042 → INV-20260041, reset Counter so next invoice is INV-20260042.
 *
 * Usage:
 *   pnpm -C apps/backend tsx src/scripts/renumber-invoice-2026.ts
 *
 * Run ONCE. Safe to re-run — it checks state before acting.
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
  const inv41 = await invoices.findOne({ invoiceNo: "INV-20260041" });
  const inv42 = await invoices.findOne({ invoiceNo: "INV-20260042" });
  const counter = await counters.findOne({ _id: "invoice:FY2026" } as any);

  console.log("INV-20260041:", inv41
    ? `status=${inv41.status} | supplyType=${inv41.supplyType} | grandTotal=${inv41.grandTotal} | createdAt=${inv41.createdAt}`
    : "NOT FOUND");
  console.log("INV-20260042:", inv42
    ? `status=${inv42.status} | supplyType=${inv42.supplyType} | grandTotal=${inv42.grandTotal} | bookingIds=${(inv42.bookingIds ?? []).length} bookings`
    : "NOT FOUND");
  console.log("Counter invoice:FY2026:", counter ? `seq=${counter.seq}` : "NOT FOUND");
  console.log();

  // ── SAFETY CHECKS ────────────────────────────────────────────────────
  if (!inv41) {
    if (!inv42) {
      console.log("Neither invoice found — nothing to do.");
      await mongoose.disconnect();
      return;
    }
    // 41 already deleted or renamed previously — check if 42 still needs renaming
    const existing41after = await invoices.findOne({ invoiceNo: "INV-20260041" });
    if (existing41after?.supplyType === "CGST_SGST" || existing41after?.supplyType === "CGST_UTGST") {
      console.log("INV-20260041 already looks like the correct invoice — skipping.");
      await mongoose.disconnect();
      return;
    }
  }

  if (inv41 && inv41.status !== "CANCELLED") {
    console.error(`INV-20260041 exists but status is "${inv41.status}" — expected CANCELLED. Aborting.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!inv42) {
    console.error("INV-20260042 not found — cannot rename. Aborting.");
    await mongoose.disconnect();
    process.exit(1);
  }

  // ── STEP 2: Hard-delete the cancelled INV-20260041 ───────────────────
  console.log("=== STEP 2: Deleting cancelled INV-20260041 ===");
  if (inv41) {
    const deleteResult = await invoices.deleteOne({ invoiceNo: "INV-20260041", status: "CANCELLED" });
    console.log(`deleteOne result: acknowledged=${deleteResult.acknowledged} deletedCount=${deleteResult.deletedCount}`);
    if (deleteResult.deletedCount !== 1) {
      console.error("Delete did not remove exactly 1 document. Aborting.");
      await mongoose.disconnect();
      process.exit(1);
    }
  } else {
    console.log("INV-20260041 not found — skipping delete (already done).");
  }
  console.log();

  // ── STEP 3: Rename INV-20260042 → INV-20260041 ──────────────────────
  console.log("=== STEP 3: Renaming INV-20260042 → INV-20260041 ===");
  const renameResult = await invoices.updateOne(
    { invoiceNo: "INV-20260042" },
    { $set: { invoiceNo: "INV-20260041" } },
  );
  console.log(`updateOne result: acknowledged=${renameResult.acknowledged} modifiedCount=${renameResult.modifiedCount}`);
  if (renameResult.modifiedCount !== 1) {
    console.error("Rename did not modify exactly 1 document. Aborting.");
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log();

  // ── STEP 4: Reset Counter to 41 ─────────────────────────────────────
  // INV-20260041 now exists (renamed). Next invoice = INV-20260042. Counter must be at 41.
  console.log("=== STEP 4: Resetting counter invoice:FY2026 to seq=41 ===");
  const counterResult = await counters.updateOne(
    { _id: "invoice:FY2026" } as any,
    { $set: { seq: 41 } },
    { upsert: true },
  );
  console.log(`updateOne result: acknowledged=${counterResult.acknowledged} modifiedCount=${counterResult.modifiedCount}`);
  console.log();

  // ── STEP 5: Verify final state ───────────────────────────────────────
  console.log("=== FINAL STATE VERIFICATION ===");
  const final41 = await invoices.findOne({ invoiceNo: "INV-20260041" });
  const final42 = await invoices.findOne({ invoiceNo: "INV-20260042" });
  const finalCounter = await counters.findOne({ _id: "invoice:FY2026" } as any);

  console.log("INV-20260041:", final41
    ? `status=${final41.status} | supplyType=${final41.supplyType} | grandTotal=${final41.grandTotal} | bookingIds=${(final41.bookingIds ?? []).length} bookings`
    : "NOT FOUND ✓ (correctly deleted)");
  console.log("INV-20260042:", final42 ? `EXISTS (unexpected!)` : "NOT FOUND ✓");
  console.log("Counter invoice:FY2026:", finalCounter ? `seq=${finalCounter.seq} (next invoice will be INV-20260042)` : "NOT FOUND");

  if (final41 && final41.status !== "CANCELLED" && (final41.supplyType === "CGST_SGST" || final41.supplyType === "CGST_UTGST")) {
    console.log("\n✓ INV-20260041 is the correctly-typed invoice with split GST.");
  }
  if (!final42) {
    console.log("✓ INV-20260042 no longer exists.");
  }
  if (finalCounter?.seq === 41) {
    console.log("✓ Counter at 41 — next generated invoice will be INV-20260042.");
  }

  await mongoose.disconnect();
  console.log("\nDone.");
}

run().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
