/**
 * Backfill-correct ONE invoice in place: INV-20260152.
 * DRY-RUN by default. Pass --write to mutate the SAME _id.
 *   Dry-run: pnpm -C apps/backend exec tsx tmp/backfill-inv-20260152.mts
 *   Write:   pnpm -C apps/backend exec tsx tmp/backfill-inv-20260152.mts --write
 * Reads only ManualBooking; writes only this single Invoice doc on --write.
 */
import mongoose from "mongoose";
import { connectDb } from "../src/config/db.js";
import Invoice from "../src/models/Invoice.js";
import ManualBooking from "../src/models/ManualBooking.js";
import {
  buildLineItemsForBooking,
  buildCombinedLineItems,
} from "../src/utils/invoiceLineItems.js";
import { calculateGSTAmounts, type GSTType } from "../src/utils/gstDetection.js";

const TARGET = "INV-20260152";
const STORED_GRAND_EXPECTED = 31409;
const WRITE = process.argv.includes("--write");

const r2 = (n: number) => parseFloat(n.toFixed(2));
function abort(reason: string): never {
  console.error(`\n*** ABORT — ${reason}\n*** Nothing written.\n`);
  process.exit(1);
}
function printLines(label: string, lines: any[]) {
  console.log(`  ${label} (${lines.length} rows):`);
  for (const li of lines) {
    console.log(
      `    [${li.rowType}] ${li.description} | ref=${li.bookingRef} | qty=${li.qty} rate=${r2(li.rate ?? 0)} igst=${r2(li.igst ?? 0)} amount=${r2(li.amount ?? 0)}`,
    );
  }
}

async function run() {
  await connectDb();

  // ── Precondition: target + DRAFT ───────────────────────────────────────
  const invoice: any = await Invoice.findOne({ invoiceNo: TARGET }).lean();
  if (!invoice) abort(`invoice ${TARGET} not found`);
  if (invoice.invoiceNo !== TARGET) abort(`loaded ${invoice.invoiceNo}, expected ${TARGET}`);
  if (invoice.status !== "DRAFT")
    abort(`status is "${invoice.status}", not DRAFT — issued invoices need a formal correction path`);

  // ── 1. Current stored state ────────────────────────────────────────────
  console.log(`\n========== CURRENT STORED STATE (${TARGET}) ==========`);
  console.log(`  _id=${invoice._id}  invoiceNo=${invoice.invoiceNo}  status=${invoice.status}`);
  console.log(`  invoiceDate=${invoice.invoiceDate}  generatedAt=${invoice.generatedAt}`);
  console.log(`  supplyType=${invoice.supplyType}`);
  console.log(`  subtotal=${r2(invoice.subtotal)} totalGST=${r2(invoice.totalGST)} cgst=${r2(invoice.cgstAmount)} sgst=${r2(invoice.sgstAmount)} utgst=${r2(invoice.utgstAmount)} igstAmt=${r2(invoice.igstAmount)} grandTotal=${r2(invoice.grandTotal)}`);
  console.log(`  pdfUrl=${invoice.pdfUrl ?? "—"}`);
  console.log(`  bookingIds=${(invoice.bookingIds ?? []).map((x: any) => String(x)).join(", ")}`);
  printLines("stored lineItems", invoice.lineItems ?? []);

  // ── 2. Re-run the SAME builder the generate route uses ─────────────────
  const bookingIds = (invoice.bookingIds ?? []).map((x: any) => new mongoose.Types.ObjectId(String(x)));
  const bookings: any[] = await ManualBooking.find({ _id: { $in: bookingIds } }).lean();
  if (bookings.length !== bookingIds.length)
    abort(`linked bookings ${bookings.length} != bookingIds ${bookingIds.length}`);

  // Detect the format the invoice was generated in: a COMBINED line carries a
  // multi-ref (comma) bookingRef; SEPARATE lines are single-ref.
  const wasCombined = (invoice.lineItems ?? []).some(
    (li: any) => typeof li.bookingRef === "string" && li.bookingRef.includes(","),
  );
  console.log(`\n  detected format: ${wasCombined ? "COMBINED" : "SEPARATE"}`);

  const freshLines: any[] = wasCombined
    ? buildCombinedLineItems(bookings)
    : bookings.flatMap((b) => buildLineItemsForBooking(b));

  // ── 3. Recompute totals exactly as invoices.ts ~585-610 ────────────────
  const totalAmount = freshLines.reduce((s, li) => s + (li.amount ?? 0), 0);
  const totalGST = freshLines.reduce((s, li) => s + (li.igst ?? 0), 0);
  const subtotal = r2(totalAmount - totalGST);
  const rawTotalGST = r2(totalGST);

  // grandTotal — same per-booking derivation the route uses (lines 588-597)
  let grandTotal = 0;
  for (const b of bookings) {
    const gstMode = b.pricing?.gstMode || "ON_MARKUP";
    if (gstMode === "ON_MARKUP") grandTotal += b.pricing?.quotedPrice ?? 0;
    else grandTotal += b.pricing?.grandTotal ?? ((b.pricing?.quotedPrice ?? 0) + (b.pricing?.gstAmount ?? 0));
  }
  grandTotal = r2(grandTotal);

  const reconciledFromAmounts = r2(totalAmount);
  const gstAmounts = calculateGSTAmounts(rawTotalGST, invoice.supplyType as GSTType);

  // grandTotal must NOT change
  if (Math.abs(grandTotal - r2(invoice.grandTotal)) > 0.01)
    abort(`recomputed grandTotal ${grandTotal} != stored ${r2(invoice.grandTotal)} — grandTotal must not change`);
  if (Math.abs(grandTotal - STORED_GRAND_EXPECTED) > 0.01)
    abort(`recomputed grandTotal ${grandTotal} != expected ${STORED_GRAND_EXPECTED}`);
  if (Math.abs(reconciledFromAmounts - grandTotal) > 1)
    abort(`Σ amount ${reconciledFromAmounts} drifts from grandTotal ${grandTotal} > ₹1`);

  // ── 4. Before/after ────────────────────────────────────────────────────
  console.log(`\n========== PROPOSED AFTER ==========`);
  printLines("fresh lineItems", freshLines);
  console.log(`\n  TOTALS  before -> after`);
  console.log(`    subtotal:   ${r2(invoice.subtotal)}  ->  ${subtotal}`);
  console.log(`    totalGST:   ${r2(invoice.totalGST)}  ->  ${rawTotalGST}`);
  console.log(`    cgstAmount: ${r2(invoice.cgstAmount)}  ->  ${gstAmounts.cgst}`);
  console.log(`    sgstAmount: ${r2(invoice.sgstAmount)}  ->  ${gstAmounts.sgst}`);
  console.log(`    grandTotal: ${r2(invoice.grandTotal)}  ->  ${grandTotal}  (UNCHANGED)`);
  console.log(`    Σ amount reconciles to grandTotal: ${reconciledFromAmounts} == ${grandTotal}`);

  if (invoice.pdfUrl) {
    console.log(`\n  ⚠ STALE PDF: pdfUrl is set (${invoice.pdfUrl}). The cached PDF still shows the OLD negative line and must be re-rendered. This script does NOT regenerate the PDF.`);
  }

  if (!WRITE) {
    console.log(`\n=== DRY-RUN ONLY — no write performed. Re-run with --write to apply. ===\n`);
    await mongoose.disconnect();
    process.exit(0);
  }

  // ── 5. WRITE (only with --write) ───────────────────────────────────────
  const historyEntry = {
    editedAt: new Date(),
    editedBy: null,
    fieldsChanged: ["lineItems", "subtotal", "totalGST", "cgstAmount", "sgstAmount"],
    oldValues: {
      lineItems: (invoice.lineItems ?? []).map((li: any) => ({
        rowType: li.rowType, description: li.description, rate: li.rate, igst: li.igst, amount: li.amount, bookingRef: li.bookingRef,
      })),
      subtotal: r2(invoice.subtotal), totalGST: r2(invoice.totalGST),
      cgstAmount: r2(invoice.cgstAmount), sgstAmount: r2(invoice.sgstAmount),
    },
    newValues: {
      lineItems: freshLines.map((li: any) => ({
        rowType: li.rowType, description: li.description, rate: li.rate, igst: li.igst, amount: li.amount, bookingRef: li.bookingRef,
      })),
      subtotal, totalGST: rawTotalGST, cgstAmount: gstAmounts.cgst, sgstAmount: gstAmounts.sgst,
    },
    note: "negative-markup line correction (backfill)",
  };

  const writeRes = await Invoice.collection.updateOne(
    { _id: invoice._id, invoiceNo: TARGET, status: "DRAFT" },
    {
      $set: {
        lineItems: freshLines,
        subtotal,
        totalGST: rawTotalGST,
        cgstAmount: gstAmounts.cgst,
        sgstAmount: gstAmounts.sgst,
        grandTotal, // unchanged value, written for completeness
        editedAt: new Date(),
      },
      $push: { editHistory: historyEntry },
    },
  );
  console.log(`\n=== WRITE result: matched=${writeRes.matchedCount} modified=${writeRes.modifiedCount} ===`);

  // Re-read and confirm
  const after: any = await Invoice.collection.findOne({ _id: invoice._id });
  console.log(`\n========== FINAL STATE AFTER WRITE ==========`);
  console.log(`  invoiceNo=${after.invoiceNo} (unchanged)  status=${after.status} (unchanged)`);
  console.log(`  invoiceDate=${after.invoiceDate} (unchanged)  generatedAt=${after.generatedAt} (unchanged)`);
  console.log(`  subtotal=${r2(after.subtotal)} totalGST=${r2(after.totalGST)} cgst=${r2(after.cgstAmount)} sgst=${r2(after.sgstAmount)} grandTotal=${r2(after.grandTotal)}`);
  printLines("final lineItems", after.lineItems ?? []);
  console.log(`  editHistory entries: ${(after.editHistory ?? []).length}`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
