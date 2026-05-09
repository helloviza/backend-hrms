/**
 * One-time cleanup: delete test invoices INV-20260040 and INV-20260042..71,
 * unlink their bookings (status → CONFIRMED, invoiceId removed), reset
 * Counter invoice:FY2026 to 41 so next generated invoice is INV-20260042.
 *
 * PROTECTED: INV-20260041 (Loom Solar) — already sent to customer.
 * Bookings are NOT deleted — they're real data and need to be re-invoiceable.
 *
 * Usage:
 *   pnpm -C apps/backend tsx src/scripts/cleanup-test-invoices.ts
 *
 * Safe to re-run — pre-flight checks abort if Loom Solar invoice is missing
 * or if it would be in the delete list.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import Invoice from "../models/Invoice.js";
import ManualBooking from "../models/ManualBooking.js";
import Counter from "../models/Counter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../../.env") });

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
  console.error("MONGO_URI not set in .env");
  process.exit(1);
}

const PROTECTED_INVOICE_NO = "INV-20260041"; // Loom Solar — DO NOT TOUCH
const COUNTER_ID = "invoice:FY2026";
const TARGET_SEQ = 41; // next invoice claim: $inc → 42 → INV-20260042

// Build delete list: 40, then 42..71 (skip 41)
const DELETE_LIST: string[] = ["INV-20260040"];
for (let i = 42; i <= 71; i++) {
  DELETE_LIST.push(`INV-2026${String(i).padStart(4, "0")}`);
}

async function main() {
  console.log("Connecting to MongoDB...");
  await mongoose.connect(MONGO_URI!);
  console.log("Connected.\n");

  // ── PRE-FLIGHT CHECKS ───────────────────────────────────────────────

  // Check 1: code-level guard — DELETE_LIST must not contain protected invoice
  if (DELETE_LIST.includes(PROTECTED_INVOICE_NO)) {
    throw new Error(`✗ ABORT: DELETE_LIST contains protected invoice ${PROTECTED_INVOICE_NO} — code error`);
  }

  // Check 2: protected invoice must exist
  const protectedInv = await Invoice.findOne({ invoiceNo: PROTECTED_INVOICE_NO });
  if (!protectedInv) {
    throw new Error(`✗ ABORT: Protected invoice ${PROTECTED_INVOICE_NO} (Loom Solar) not found`);
  }
  console.log(`✓ Protected: ${PROTECTED_INVOICE_NO} (${protectedInv.clientDetails?.companyName ?? "?"}) confirmed safe`);

  // Check 3: enumerate what would be deleted
  const invoicesToDelete = await Invoice.find(
    { invoiceNo: { $in: DELETE_LIST } },
    { invoiceNo: 1, "clientDetails.companyName": 1, grandTotal: 1, bookingIds: 1, status: 1 },
  ).sort({ invoiceNo: 1 });

  console.log(`\nFound ${invoicesToDelete.length} invoices to delete:`);

  const customerSummary: Record<string, number> = {};
  let totalBookingsToUnlink = 0;
  const allBookingIds: mongoose.Types.ObjectId[] = [];

  for (const inv of invoicesToDelete) {
    const customer = inv.clientDetails?.companyName || "Unknown";
    customerSummary[customer] = (customerSummary[customer] || 0) + 1;
    const bookings = (inv.bookingIds || []) as unknown as mongoose.Types.ObjectId[];
    totalBookingsToUnlink += bookings.length;
    allBookingIds.push(...bookings);
    console.log(`  ${inv.invoiceNo}: ${customer} | ${bookings.length} bookings | ₹${inv.grandTotal} | ${inv.status}`);
  }

  console.log(`\nCustomer breakdown:`);
  for (const [customer, count] of Object.entries(customerSummary)) {
    console.log(`  ${customer}: ${count} invoices`);
  }
  console.log(`\nTotal bookings to unlink: ${totalBookingsToUnlink}`);

  // Check 4: defense in depth — Loom Solar must NOT be in the materialized delete set
  const loomSolarInList = invoicesToDelete.find(
    (inv) => inv.clientDetails?.companyName?.toLowerCase().includes("loom"),
  );
  if (loomSolarInList) {
    throw new Error(`✗ ABORT: Loom Solar invoice found in delete list: ${loomSolarInList.invoiceNo}`);
  }

  // ── EXECUTE ─────────────────────────────────────────────────────────

  console.log("\n=== EXECUTING CLEANUP ===\n");

  // Step 1: Unlink bookings — status → CONFIRMED, drop invoiceId field
  if (allBookingIds.length > 0) {
    const unlinkResult = await ManualBooking.updateMany(
      { _id: { $in: allBookingIds } },
      { $set: { status: "CONFIRMED" }, $unset: { invoiceId: "" } },
    );
    console.log(`✓ Unlinked ${unlinkResult.modifiedCount} bookings (status → CONFIRMED, invoiceId unset)`);
  } else {
    console.log(`(No bookings to unlink)`);
  }

  // Step 2: Hard-delete invoices
  const deleteResult = await Invoice.deleteMany({ invoiceNo: { $in: DELETE_LIST } });
  console.log(`✓ Deleted ${deleteResult.deletedCount} invoices`);

  // Step 3: Reset counter to 41 → next claim = 42 → INV-20260042
  const counterResult = await Counter.updateOne(
    { _id: COUNTER_ID },
    { $set: { seq: TARGET_SEQ } },
    { upsert: true },
  );
  console.log(`✓ Counter ${COUNTER_ID} set to seq=${TARGET_SEQ} (matched=${counterResult.matchedCount}, modified=${counterResult.modifiedCount}, upserted=${counterResult.upsertedCount})`);

  // ── FINAL VERIFICATION ──────────────────────────────────────────────

  console.log("\n=== FINAL STATE ===\n");

  const remaining = await Invoice.find(
    { invoiceNo: { $regex: /^INV-2026/ } },
    { invoiceNo: 1, status: 1, "clientDetails.companyName": 1, grandTotal: 1 },
  ).sort({ invoiceNo: 1 });

  console.log(`Remaining FY2026 invoices: ${remaining.length}`);
  for (const inv of remaining) {
    console.log(`  ${inv.invoiceNo}: ${inv.clientDetails?.companyName || "Unknown"} | ₹${inv.grandTotal} | ${inv.status}`);
  }

  const counter = await Counter.findOne({ _id: COUNTER_ID });
  const nextSeq = (counter?.seq ?? 0) + 1;
  console.log(`\nCounter ${COUNTER_ID}: seq=${counter?.seq}`);
  console.log(`Next generated invoice will be: INV-2026${String(nextSeq).padStart(4, "0")}`);

  if (remaining.length === 1 && remaining[0].invoiceNo === PROTECTED_INVOICE_NO && counter?.seq === TARGET_SEQ) {
    console.log("\n✓ SUCCESS: Only Loom Solar invoice remains. Counter at 41.");
    console.log("  Ready for Molnlycke regeneration via UI (next invoice = INV-20260042).");
  } else {
    console.log("\n⚠ WARNING: Unexpected final state — review above");
  }

  await mongoose.disconnect();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("\n[cleanup-test-invoices] Fatal error:", err);
  process.exit(1);
});
