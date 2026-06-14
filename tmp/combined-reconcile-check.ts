import { buildLineItemsForBooking, buildCombinedLineItems } from "../src/utils/invoiceLineItems.js";

// Helpers to build realistic pricing blocks (as the model pre-save hook leaves them).
function onMarkup(actual: number, quoted: number) {
  const diff = quoted - actual;
  return {
    actualPrice: actual, supplierCost: actual,
    quotedPrice: quoted, sellingPrice: quoted,
    diff, markupAmount: diff,
    gstMode: "ON_MARKUP" as const, gstPercent: 18,
    grandTotal: quoted, totalWithGST: quoted,
  };
}
function onFull(actual: number, quoted: number) {
  const diff = quoted - actual;
  const gstAmount = parseFloat((quoted * 18 / 100).toFixed(2));
  return {
    actualPrice: actual, supplierCost: actual,
    quotedPrice: quoted, sellingPrice: quoted,
    diff, markupAmount: diff,
    gstMode: "ON_FULL" as const, gstPercent: 18,
    gstAmount, grandTotal: parseFloat((quoted + gstAmount).toFixed(2)),
    totalWithGST: parseFloat((quoted + gstAmount).toFixed(2)),
  };
}
const pax = (...names: string[]) => names.map((n) => ({ name: n, type: "ADULT" }));

// A deliberately mixed set: 2 flights (merge), 1 reschedule (own group),
// 2 hotels (merge, incl. a dummy), VISA, 2 OTHER, a TROPHY; mixed GST modes.
const bookings: any[] = [
  { bookingRef: "MB-1", type: "FLIGHT",            travelDate: "2026-05-01", passengers: pax("A"),      itinerary: { origin: "DEL", destination: "BOM", airline: "AI", flightNo: "302" }, pricing: onMarkup(10000, 12000) },
  { bookingRef: "MB-2", type: "FLIGHT",            travelDate: "2026-05-03", passengers: pax("B", "C"), itinerary: { origin: "BOM", destination: "GOI" }, pricing: onFull(8000, 9000) },
  { bookingRef: "MB-3", type: "FLIGHT_RESCHEDULE", travelDate: "2026-05-05", passengers: pax("A"),      itinerary: { origin: "DEL", destination: "BOM" }, pricing: onMarkup(1500, 2200) },
  { bookingRef: "MB-4", type: "HOTEL",             travelDate: "2026-05-02", returnDate: "2026-05-06", passengers: pax("D"), itinerary: { hotelName: "Oberoi", destination: "Mumbai", nights: 4, roomCount: 1 }, sector: "Mumbai", pricing: onMarkup(20000, 24000) },
  { bookingRef: "MB-5", type: "DUMMY_HOTEL",       travelDate: "2026-05-10", returnDate: "2026-05-13", passengers: pax("E"), itinerary: { hotelName: "Taj", destination: "Delhi", nights: 3, roomCount: 2 }, sector: "Delhi", pricing: onFull(15000, 17000) },
  { bookingRef: "MB-6", type: "VISA",              travelDate: "2026-05-04", passengers: pax("F", "G"), itinerary: {}, pricing: onMarkup(3000, 3800) },
  { bookingRef: "MB-7", type: "OTHER",             travelDate: "2026-05-07", passengers: pax("H"),      itinerary: { description: "Misc service" }, sector: "X", pricing: onMarkup(1000, 1400) },
  { bookingRef: "MB-8", type: "OTHER",             travelDate: "2026-05-08", passengers: pax("I"),      itinerary: { description: "Another" }, sector: "Y", pricing: onFull(500, 700) },
  { bookingRef: "MB-9", type: "TROPHY",            travelDate: "2026-05-09", passengers: pax("J"),      itinerary: { description: "Crystal trophy" }, sector: "Z", pricing: onMarkup(2000, 2600) },
];

// Replicate the route's totals math for a given lineItems array + bookings.
function totals(lineItems: any[], bks: any[]) {
  const totalAmount = lineItems.reduce((s, li) => s + (li.amount ?? 0), 0);
  const totalGST = lineItems.reduce((s, li) => s + (li.igst ?? 0), 0);
  const subtotal = parseFloat((totalAmount - totalGST).toFixed(2));
  let grandTotal = 0;
  for (const b of bks) {
    const gstMode = b.pricing?.gstMode || "ON_MARKUP";
    grandTotal += gstMode === "ON_MARKUP"
      ? (b.pricing?.quotedPrice ?? 0)
      : (b.pricing?.grandTotal ?? ((b.pricing?.quotedPrice ?? 0) + (b.pricing?.gstAmount ?? 0)));
  }
  return {
    totalAmount: parseFloat(totalAmount.toFixed(2)),
    totalGST: parseFloat(totalGST.toFixed(2)),
    subtotal,
    grandTotal: parseFloat(grandTotal.toFixed(2)),
  };
}

const sepLines = bookings.flatMap((b) => buildLineItemsForBooking(b));
const combLines = buildCombinedLineItems(bookings);

const sep = totals(sepLines, bookings);
const comb = totals(combLines, bookings);

console.log("SEPARATE lines:", sepLines.length, "| COMBINED lines:", combLines.length);
console.log("\nCombined line breakdown:");
for (const li of combLines) {
  console.log(`  [${li.rowType.padEnd(11)}] ${String(li.description).padEnd(20)} | ${li.subDescription} | amount=${li.amount} igst=${li.igst} qty=${li.qty} | refs=${li.bookingRef}`);
}

console.log("\nSEPARATE totals:", sep);
console.log("COMBINED totals:", comb);

const keys = ["totalAmount", "totalGST", "subtotal", "grandTotal"] as const;
let ok = true;
for (const k of keys) {
  const diff = Math.abs(sep[k] - comb[k]);
  if (diff > 0.01) { ok = false; console.log(`  MISMATCH ${k}: separate=${sep[k]} combined=${comb[k]} diff=${diff}`); }
}
console.log(ok ? "\n✅ RECONCILES: combined totals === separate totals (all 4 metrics within 0.01)"
              : "\n❌ DRIFT DETECTED");
process.exit(ok ? 0 : 1);
