/** READ-ONLY post-write verification for INV-20260152. No writes. */
import mongoose from "mongoose";
import { connectDb } from "../src/config/db.js";
import Invoice from "../src/models/Invoice.js";

async function run() {
  await connectDb();
  const inv: any = await Invoice.collection.findOne({ invoiceNo: "INV-20260152" });

  const negLines = (inv.lineItems ?? []).filter((li: any) => (li.amount ?? 0) < 0 || (li.igst ?? 0) < 0);
  const surge = (inv.lineItems ?? []).filter((li: any) => li.bookingRef === "MB-2605-0314");

  console.log("invoiceNo        :", inv.invoiceNo);
  console.log("status           :", inv.status);
  console.log("supplyType       :", inv.supplyType);
  console.log("invoiceDate      :", inv.invoiceDate);
  console.log("generatedAt      :", inv.generatedAt);
  console.log("bookingIds       :", (inv.bookingIds ?? []).map((x: any) => String(x)).join(", "));
  console.log("bookingIds count :", (inv.bookingIds ?? []).length);
  console.log("pdfUrl (key)     :", String(inv.pdfUrl ?? "—").split("?")[0]);
  console.log("subtotal/totalGST/cgst/sgst/grand:",
    inv.subtotal, "/", inv.totalGST, "/", inv.cgstAmount, "/", inv.sgstAmount, "/", inv.grandTotal);
  console.log("subtotal+totalGST:", parseFloat((inv.subtotal + inv.totalGST).toFixed(2)));
  console.log("negative lines remaining:", negLines.length);
  console.log("MB-2605-0314 lines:", JSON.stringify(surge.map((l: any) => ({ rowType: l.rowType, rate: l.rate, igst: l.igst, amount: l.amount }))));
  console.log("editHistory count:", (inv.editHistory ?? []).length);
  console.log("editHistory last :", JSON.stringify((inv.editHistory ?? []).slice(-1)[0]?.note ?? (inv.editHistory ?? []).slice(-1)[0] ?? null));

  await mongoose.disconnect();
  process.exit(0);
}
run().catch(async (e) => { console.error(e); try { await mongoose.disconnect(); } catch {} process.exit(1); });
