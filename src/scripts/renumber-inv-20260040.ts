/**
 * One-time script: hard-delete cancelled INV-20260040 (Molnlycke, wrong ON_MARKUP cab rendering)
 * and cancelled INV-20260042 (incomplete, 25/49 bookings), rename INV-20260043 → INV-20260040.
 * Counter stays at 43 — next generated invoice will be INV-20260044.
 *
 * Pre-conditions (must be true before running):
 *   1. INV-20260040 is CANCELLED (done in UI)
 *   2. INV-20260042 is CANCELLED (incomplete invoice, cancelled in UI)
 *   3. INV-20260043 is DRAFT/GENERATED (reissued from all 49 Molnlycke April bookings)
 *   4. INV-20260041 (Loom Solar) is untouched
 *
 * Post-conditions:
 *   - INV-20260040 = reissued Molnlycke invoice with correct ON_FULL cab line items (49 bookings)
 *   - INV-20260041 = Loom Solar (unchanged)
 *   - INV-20260042 = NOT FOUND (deleted)
 *   - INV-20260043 = NOT FOUND (renamed to INV-20260040)
 *   - Counter invoice:FY2026 seq=43 → next generated invoice will be INV-20260044
 *
 * Usage:
 *   pnpm -C apps/backend tsx src/scripts/renumber-inv-20260040.ts
 *
 * Run ONCE. Safe to re-run — checks state before acting.
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
  const inv40 = await invoices.findOne({ invoiceNo: "INV-20260040" });
  const inv41 = await invoices.findOne({ invoiceNo: "INV-20260041" });
  const inv42 = await invoices.findOne({ invoiceNo: "INV-20260042" });
  const inv43 = await invoices.findOne({ invoiceNo: "INV-20260043" });
  const counter = await counters.findOne({ _id: "invoice:FY2026" } as any);

  console.log("INV-20260040:", inv40
    ? `status=${inv40.status} | customerName=${inv40.customerName} | grandTotal=${inv40.grandTotal} | bookingIds=${(inv40.bookingIds ?? []).length} bookings`
    : "NOT FOUND");
  console.log("INV-20260041:", inv41
    ? `status=${inv41.status} | customerName=${inv41.customerName} | grandTotal=${inv41.grandTotal}`
    : "NOT FOUND");
  console.log("INV-20260042:", inv42
    ? `status=${inv42.status} | customerName=${inv42.customerName} | bookingIds=${(inv42.bookingIds ?? []).length} bookings`
    : "NOT FOUND");
  console.log("INV-20260043:", inv43
    ? `status=${inv43.status} | customerName=${inv43.customerName} | grandTotal=${inv43.grandTotal} | bookingIds=${(inv43.bookingIds ?? []).length} bookings`
    : "NOT FOUND");
  console.log("Counter invoice:FY2026:", counter ? `seq=${counter.seq}` : "NOT FOUND");
  console.log();

  // ── SAFETY CHECKS ────────────────────────────────────────────────────
  if (!inv40 && !inv43) {
    console.log("INV-20260040 not found and INV-20260043 not found — nothing to do (already completed?).");
    await mongoose.disconnect();
    return;
  }

  if (inv40 && inv40.status !== "CANCELLED") {
    console.error(`INV-20260040 exists but status is "${inv40.status}" — expected CANCELLED. Cancel it in the UI first. Aborting.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  if (inv42 && inv42.status !== "CANCELLED") {
    console.error(`INV-20260042 exists but status is "${inv42.status}" — expected CANCELLED. Cancel it in the UI first. Aborting.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!inv43) {
    if (!inv40) {
      console.log("INV-20260040 already deleted and INV-20260043 not found — rename may have already run.");
      await mongoose.disconnect();
      return;
    }
    console.error("INV-20260043 not found — reissue the full 49-booking invoice in the UI first. Aborting.");
    await mongoose.disconnect();
    process.exit(1);
  }

  if (inv43.status === "CANCELLED") {
    console.error(`INV-20260043 status is CANCELLED — expected DRAFT or a live invoice. Aborting.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const bookingCount = (inv43.bookingIds ?? []).length;
  if (bookingCount < 49) {
    console.error(`INV-20260043 only has ${bookingCount} bookings — expected 49. Regenerate with all bookings. Aborting.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  // ── STEP 2: Hard-delete cancelled INV-20260040 ───────────────────────
  console.log("=== STEP 2: Deleting cancelled INV-20260040 ===");
  if (inv40) {
    const deleteResult = await invoices.deleteOne({ invoiceNo: "INV-20260040", status: "CANCELLED" });
    console.log(`deleteOne result: acknowledged=${deleteResult.acknowledged} deletedCount=${deleteResult.deletedCount}`);
    if (deleteResult.deletedCount !== 1) {
      console.error("Delete did not remove exactly 1 document. Aborting.");
      await mongoose.disconnect();
      process.exit(1);
    }
  } else {
    console.log("INV-20260040 not found — skipping delete (already done).");
  }
  console.log();

  // ── STEP 3: Hard-delete cancelled INV-20260042 (incomplete, never sent) ─
  console.log("=== STEP 3: Deleting cancelled INV-20260042 (incomplete) ===");
  if (inv42) {
    const deleteResult = await invoices.deleteOne({ invoiceNo: "INV-20260042", status: "CANCELLED" });
    console.log(`deleteOne result: acknowledged=${deleteResult.acknowledged} deletedCount=${deleteResult.deletedCount}`);
    if (deleteResult.deletedCount !== 1) {
      console.error("Delete did not remove exactly 1 document. Aborting.");
      await mongoose.disconnect();
      process.exit(1);
    }
  } else {
    console.log("INV-20260042 not found — skipping delete (already done or never existed).");
  }
  console.log();

  // ── STEP 4: Rename INV-20260043 → INV-20260040 ───────────────────────
  console.log("=== STEP 4: Renaming INV-20260043 → INV-20260040 ===");
  const renameResult = await invoices.updateOne(
    { invoiceNo: "INV-20260043" },
    { $set: { invoiceNo: "INV-20260040" } },
  );
  console.log(`updateOne result: acknowledged=${renameResult.acknowledged} modifiedCount=${renameResult.modifiedCount}`);
  if (renameResult.modifiedCount !== 1) {
    console.error("Rename did not modify exactly 1 document. Aborting.");
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log();

  // ── STEP 5: Verify final state ────────────────────────────────────────
  console.log("=== FINAL STATE VERIFICATION ===");
  const final40 = await invoices.findOne({ invoiceNo: "INV-20260040" });
  const final41 = await invoices.findOne({ invoiceNo: "INV-20260041" });
  const final42 = await invoices.findOne({ invoiceNo: "INV-20260042" });
  const final43 = await invoices.findOne({ invoiceNo: "INV-20260043" });
  const finalCounter = await counters.findOne({ _id: "invoice:FY2026" } as any);

  console.log("INV-20260040:", final40
    ? `status=${final40.status} | customerName=${final40.customerName} | gstType=${final40.gstType} | grandTotal=${final40.grandTotal} | bookingIds=${(final40.bookingIds ?? []).length} bookings`
    : "NOT FOUND (unexpected!)");
  console.log("INV-20260041:", final41
    ? `status=${final41.status} | customerName=${final41.customerName} | grandTotal=${final41.grandTotal} ✓ (unchanged)`
    : "NOT FOUND (unexpected!)");
  console.log("INV-20260042:", final42 ? `EXISTS (unexpected! — delete may have failed)` : "NOT FOUND ✓");
  console.log("INV-20260043:", final43 ? `EXISTS (unexpected! — rename may have failed)` : "NOT FOUND ✓");
  console.log("Counter invoice:FY2026:", finalCounter ? `seq=${finalCounter.seq} (next invoice will be INV-20260044)` : "NOT FOUND");
  console.log();

  const ok40 = final40 && final40.status !== "CANCELLED" && (final40.bookingIds ?? []).length >= 49;
  const ok41 = !!final41;
  const ok42 = !final42;
  const ok43 = !final43;

  if (ok40) console.log(`✓ INV-20260040 is the reissued Molnlycke invoice (${(final40!.bookingIds ?? []).length} bookings).`);
  if (ok41) console.log("✓ INV-20260041 (Loom Solar) untouched.");
  if (ok42) console.log("✓ INV-20260042 deleted.");
  if (ok43) console.log("✓ INV-20260043 no longer exists.");

  if (!ok40 || !ok41 || !ok42 || !ok43) {
    console.error("\n⚠ One or more checks failed — review the output above.");
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log("\nAll checks passed. INV-20260040 is ready to send to Molnlycke.");
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
