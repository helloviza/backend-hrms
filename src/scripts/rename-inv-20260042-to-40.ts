/**
 * One-time rename: INV-20260042 (Molnlycke, freshly regenerated with corrected
 * calculation) → INV-20260040 (deleted slot from previous cleanup), and reset
 * Counter invoice:FY2026 to 41 so the next generated invoice = INV-20260042.
 *
 * PROTECTED: INV-20260041 (Loom Solar) — already sent to customer, MUST NOT
 * BE TOUCHED.
 *
 * Usage:
 *   pnpm -C apps/backend tsx src/scripts/rename-inv-20260042-to-40.ts
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "../../.env") });

import Invoice from "../models/Invoice.js";
import Counter from "../models/Counter.js";

const SOURCE_INVOICE_NO = "INV-20260042";
const TARGET_INVOICE_NO = "INV-20260040";
const PROTECTED_INVOICE_NO = "INV-20260041";
const COUNTER_TARGET_SEQ = 41;

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");

  await mongoose.connect(uri);
  console.log("Connected to MongoDB\n");

  // ============================================
  // PRE-FLIGHT
  // ============================================

  // Check 1: Source must exist
  const source = await Invoice.findOne({ invoiceNo: SOURCE_INVOICE_NO });
  if (!source) {
    throw new Error(`✗ ABORT: Source ${SOURCE_INVOICE_NO} not found`);
  }
  console.log(`✓ Source: ${SOURCE_INVOICE_NO}`);
  console.log(`  Customer: ${source.clientDetails?.companyName || "Unknown"}`);
  console.log(`  Bookings: ${(source.bookingIds || []).length}`);
  console.log(`  Grand Total: ₹${source.grandTotal}`);
  console.log(`  Status: ${source.status}`);

  // Check 2: Target must NOT exist (collision check)
  const targetExists = await Invoice.findOne({ invoiceNo: TARGET_INVOICE_NO });
  if (targetExists) {
    throw new Error(`✗ ABORT: ${TARGET_INVOICE_NO} already exists — would create duplicate`);
  }
  console.log(`✓ Target slot ${TARGET_INVOICE_NO} is empty`);

  // Check 3: Protected must exist and be untouched
  const protectedInv = await Invoice.findOne({ invoiceNo: PROTECTED_INVOICE_NO });
  if (!protectedInv) {
    throw new Error(`✗ ABORT: Protected ${PROTECTED_INVOICE_NO} not found`);
  }
  console.log(`✓ Protected: ${PROTECTED_INVOICE_NO} confirmed safe`);

  // Check 4: Source customer must NOT be Loom Solar
  const customerName = (source.clientDetails?.companyName || "").toLowerCase();
  if (customerName.includes("loom")) {
    throw new Error(`✗ ABORT: Source customer name contains "loom" — sanity check failed`);
  }

  // Check 5: Source must have bookings
  if (!source.bookingIds || source.bookingIds.length === 0) {
    throw new Error(`✗ ABORT: Source has no bookings`);
  }

  // ============================================
  // EXECUTE
  // ============================================

  console.log("\n=== EXECUTING ===\n");

  // Step 1: Rename source to target
  const renameResult = await Invoice.updateOne(
    { invoiceNo: SOURCE_INVOICE_NO },
    { $set: { invoiceNo: TARGET_INVOICE_NO } },
  );
  console.log(
    `✓ Renamed ${SOURCE_INVOICE_NO} → ${TARGET_INVOICE_NO} (matched=${renameResult.matchedCount}, modified=${renameResult.modifiedCount})`,
  );

  if (renameResult.modifiedCount !== 1) {
    throw new Error(`✗ ABORT: Rename did not modify exactly 1 doc`);
  }

  // Step 2: Reset Counter to 41
  const counterResult = await Counter.updateOne(
    { _id: "invoice:FY2026" },
    { $set: { seq: COUNTER_TARGET_SEQ } },
    { upsert: true },
  );
  console.log(
    `✓ Counter reset to ${COUNTER_TARGET_SEQ} (matched=${counterResult.matchedCount}, modified=${counterResult.modifiedCount})`,
  );

  // ============================================
  // VERIFY
  // ============================================

  console.log("\n=== FINAL STATE ===\n");

  const remaining = await Invoice.find(
    { invoiceNo: { $regex: /^INV-2026/ } },
    { invoiceNo: 1, status: 1, "clientDetails.companyName": 1, grandTotal: 1, bookingIds: 1 },
  ).sort({ invoiceNo: 1 });

  console.log(`Remaining invoices: ${remaining.length}`);
  for (const inv of remaining) {
    const bookingCount = (inv.bookingIds || []).length;
    console.log(
      `  ${inv.invoiceNo}: ${inv.clientDetails?.companyName || "Unknown"} | ${bookingCount} bookings | ₹${inv.grandTotal} | ${inv.status}`,
    );
  }

  const counter = await Counter.findOne({ _id: "invoice:FY2026" });
  console.log(`\nCounter: seq=${counter?.seq}`);
  console.log(
    `Next generated invoice will be: INV-2026${String((counter?.seq || 0) + 1).padStart(4, "0")}`,
  );

  // Sanity: should be INV-20260040 (Molnlycke) + INV-20260041 (Loom Solar)
  const has40 = remaining.some((inv) => inv.invoiceNo === "INV-20260040");
  const has41 = remaining.some((inv) => inv.invoiceNo === "INV-20260041");
  const has42 = remaining.some((inv) => inv.invoiceNo === "INV-20260042");

  if (
    has40 &&
    has41 &&
    !has42 &&
    remaining.length === 2 &&
    counter?.seq === COUNTER_TARGET_SEQ
  ) {
    console.log(
      "\n✓ SUCCESS: INV-20260040 (Molnlycke) + INV-20260041 (Loom Solar) active. Counter at 41.",
    );
    console.log("  INV-20260040 is ready to send to Molnlycke.");
  } else {
    console.log("\n⚠ WARNING: Unexpected final state — review above");
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("\n[Rename] Fatal error:", err);
  process.exit(1);
});
