/**
 * READ-ONLY audit. Finds invoices affected by the ON_MARKUP negative-markup bug.
 * No writes. Run from apps/backend:
 *   pnpm -C apps/backend exec tsx tmp/find-neg-markup-invoices.mts
 */
import mongoose from "mongoose";
import { connectDb } from "../src/config/db.js";
import Invoice from "../src/models/Invoice.js";
import ManualBooking from "../src/models/ManualBooking.js";

function money(n: any) {
  return typeof n === "number" ? n.toFixed(2) : String(n ?? "");
}
function dmy(d: any) {
  if (!d) return "";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? "" : dt.toLocaleDateString("en-IN");
}

async function run() {
  await connectDb();

  // ── Path A: invoices whose STORED lineItems contain a negative amount or igst
  const aDocs = await Invoice.find({
    lineItems: { $elemMatch: { $or: [{ amount: { $lt: 0 } }, { igst: { $lt: 0 } }] } },
  }).lean();

  // ── Path B: bookings ON_MARKUP with diff<0 (or quoted<actual), then invoices linking them
  const negBookings = await ManualBooking.find({
    "pricing.gstMode": "ON_MARKUP",
    $or: [
      { "pricing.diff": { $lt: 0 } },
      { $expr: { $lt: ["$pricing.quotedPrice", "$pricing.actualPrice"] } },
    ],
  })
    .select("_id bookingRef pricing.actualPrice pricing.quotedPrice pricing.diff status invoiceId")
    .lean();

  const negBookingById = new Map<string, any>();
  negBookings.forEach((b: any) => negBookingById.set(String(b._id), b));
  const negIds = negBookings.map((b: any) => b._id);

  const bDocs = negIds.length
    ? await Invoice.find({ bookingIds: { $in: negIds } }).lean()
    : [];

  // ── Union by _id
  const byId = new Map<string, any>();
  [...aDocs, ...bDocs].forEach((inv: any) => byId.set(String(inv._id), inv));
  const all = [...byId.values()];
  all.sort((x: any, y: any) => String(x.invoiceNo).localeCompare(String(y.invoiceNo)));

  console.log(`\n=== ON_MARKUP negative-markup bookings (any state) ===`);
  console.log(`count: ${negBookings.length}`);
  negBookings.forEach((b: any) => {
    console.log(
      `  ${b.bookingRef}  actual=${money(b.pricing?.actualPrice)} quoted=${money(b.pricing?.quotedPrice)} diff=${money(b.pricing?.diff)} status=${b.status} invoiceId=${b.invoiceId ?? "—"}`,
    );
  });

  console.log(`\n=== AFFECTED INVOICES ===`);
  console.log(`Path A (stored negative line amount/igst): ${aDocs.length}`);
  console.log(`Path B (links an ON_MARKUP diff<0 booking):  ${bDocs.length}`);
  console.log(`UNION (distinct invoices):                   ${all.length}\n`);

  for (const inv of all as any[]) {
    const negLines = (inv.lineItems ?? []).filter(
      (li: any) => (li.amount ?? 0) < 0 || (li.igst ?? 0) < 0,
    );
    const negLineStr =
      negLines
        .map((li: any) => `${li.rowType}:${li.description}=amt ${money(li.amount)}/igst ${money(li.igst)} [${li.bookingRef}]`)
        .join("  ;  ") || "(none stored)";

    const refsOnInvoice = (inv.bookingIds ?? [])
      .map((id: any) => negBookingById.get(String(id)))
      .filter(Boolean)
      .map((b: any) => `${b.bookingRef}(diff ${money(b.pricing?.diff)})`)
      .join(", ");

    const issued =
      inv.status === "SENT" || inv.status === "PAID" || !!inv.sentAt ? "ISSUED" : inv.status;

    console.log(
      `${inv.invoiceNo} | invDate=${dmy(inv.invoiceDate)} | gen=${dmy(inv.generatedAt)} | status=${inv.status} | ${issued} | grand=${money(inv.grandTotal)} | totalGST=${money(inv.totalGST)} | cgst=${money(inv.cgstAmount)} | sgst=${money(inv.sgstAmount)} | igst=${money(inv.igstAmount)}\n    negLines: ${negLineStr}\n    negMarkupRefs: ${refsOnInvoice || "—"}`,
    );
  }

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (e) => {
  console.error(e);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
