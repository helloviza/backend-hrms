import "dotenv/config";
import mongoose from "mongoose";
import { connectDb } from "../config/db.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import { parseTBODate } from "../lib/tbo-date.js";
import { getBookingDetail } from "../services/tbo.hotel.service.js";

// Run: npx tsx -r dotenv/config src/scripts/reconcile-booking.ts <BookingId>
// POST-004: Also supports --confirmationNo <no> --name <guest> and --traceId <id> fallback modes.
// Backfills a partial SBTHotelBooking record from TBO GetBookingDetail.
// Safe to re-run: idempotent if the record is already fully populated.

const args = process.argv.slice(2);
const argMap: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith("--")) { argMap[args[i].slice(2)] = args[i + 1] ?? ""; i++; }
  else if (!argMap.bookingId) { argMap.bookingId = args[i]; }
}

const bookingIdArg = argMap.bookingId;
const confirmationNoArg = argMap.confirmationNo;
const nameArg = argMap.name;
const traceIdArg = argMap.traceId;

if (!bookingIdArg && !confirmationNoArg && !traceIdArg) {
  console.error("Usage: tsx src/scripts/reconcile-booking.ts <BookingId>");
  console.error("       tsx src/scripts/reconcile-booking.ts --bookingId <id>");
  console.error("       tsx src/scripts/reconcile-booking.ts --confirmationNo <no> --name <guest>");
  console.error("       tsx src/scripts/reconcile-booking.ts --traceId <id>");
  process.exit(1);
}

const tboBookingId = bookingIdArg ? Number(bookingIdArg) : NaN;

// Convert TBO DD-MM-YYYY (or ISO) to YYYY-MM-DD string for checkIn/checkOut storage.
function tboDateToYMD(raw: string | null | undefined): string {
  if (!raw) return "";
  const ddmm = raw.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (ddmm) {
    const [, dd, mm, yyyy] = ddmm;
    return `${yyyy}-${mm}-${dd}`;
  }
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  return raw;
}

async function main() {
  const displayKey = bookingIdArg
    ? `BookingId=${tboBookingId}`
    : confirmationNoArg
    ? `ConfirmationNo=${confirmationNoArg}`
    : `TraceId=${traceIdArg}`;
  console.log(`\n=== Reconcile TBO Hotel Booking [${displayKey}] ===\n`);

  await connectDb();
  console.log("[1/4] MongoDB connected");

  // Step 1: Locate the partial DB record
  let doc =
    !isNaN(tboBookingId) && tboBookingId > 0
      ? await SBTHotelBooking.findOne({ bookingId: String(tboBookingId) })
      : null;

  if (!doc && confirmationNoArg) {
    doc = await SBTHotelBooking.findOne({ confirmationNo: confirmationNoArg });
    if (doc) console.log(`  [INFO] Found by confirmationNo="${confirmationNoArg}"`);
  }
  if (!doc && traceIdArg) {
    doc = await SBTHotelBooking.findOne({ clientReferenceId: traceIdArg });
    if (doc) console.log(`  [INFO] Found by clientReferenceId/traceId="${traceIdArg}"`);
  }

  if (!doc) {
    console.error(
      `[FAIL] No SBTHotelBooking found for [${displayKey}]. ` +
        "Try querying by clientReferenceId if the bookingId was not persisted."
    );
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log("[2/4] Found DB record:");
  const emptyFields = Object.entries({
    hotelName: doc.hotelName,
    checkIn: doc.checkIn,
    checkOut: doc.checkOut,
    totalFare: doc.totalFare,
    netAmount: doc.netAmount,
    guests: doc.guests?.length ?? 0,
    cancelPolicies: doc.cancelPolicies?.length ?? 0,
    lastCancellationDate: doc.lastCancellationDate,
    lastVoucherDate: doc.lastVoucherDate,
  })
    .filter(
      ([, v]) => v === "" || v === 0 || v === null || v === undefined
    )
    .map(([k]) => k);

  console.log(`  _id:            ${doc._id}`);
  console.log(`  status:         ${doc.status}`);
  console.log(`  bookingId:      ${doc.bookingId}`);
  console.log(`  confirmationNo: ${doc.confirmationNo}`);
  console.log(`  hotelName:      "${doc.hotelName}"`);
  console.log(`  totalFare:      ${doc.totalFare}`);
  console.log(`  checkIn:        "${doc.checkIn}"`);
  console.log(`  checkOut:       "${doc.checkOut}"`);
  console.log(`  guests:         ${doc.guests?.length ?? 0} entries`);
  console.log(`  cancelPolicies: ${doc.cancelPolicies?.length ?? 0} entries`);
  console.log(`  lastCancellationDate: ${doc.lastCancellationDate ?? "null"}`);
  console.log(`  lastVoucherDate:      ${doc.lastVoucherDate ?? "null"}`);
  console.log(`  Empty/default fields: [${emptyFields.join(", ")}]`);

  // Idempotency guard: already fully populated
  if (doc.hotelName && doc.totalFare > 0 && (doc.guests?.length ?? 0) > 0) {
    console.log(
      "\n[OK] Record appears already fully populated — no changes made (idempotent exit)."
    );
    await mongoose.disconnect();
    process.exit(0);
  }

  // Step 2: Call TBO GetBookingDetail — POST-004: try all three lookup modes
  console.log("\n[3/4] Calling TBO GetBookingDetail (with fallback modes)...");

  const lookups: import("../services/tbo.hotel.service.js").BookingDetailLookup[] = [];

  // Primary: BookingId (from DB record or CLI arg)
  const numericId = !isNaN(tboBookingId) && tboBookingId > 0
    ? tboBookingId
    : Number(doc.bookingId);
  if (numericId > 0) lookups.push({ mode: "bookingId", bookingId: numericId });

  // Fallback 1: ConfirmationNo + lead guest name
  const confNo = confirmationNoArg || doc.confirmationNo;
  const leadGuest = doc.guests?.[0];
  const guestName = nameArg || (leadGuest ? `${leadGuest.FirstName} ${leadGuest.LastName}`.trim() : "");
  if (confNo && guestName) lookups.push({ mode: "confirmationNo", confirmationNo: confNo, guestName });

  // Fallback 2: TraceId (passed via --traceId or stored as clientReferenceId)
  const traceId = traceIdArg || (doc as any).clientReferenceId;
  if (traceId) lookups.push({ mode: "traceId", traceId });

  if (lookups.length === 0) {
    console.error("[FAIL] No valid lookup parameters available (no bookingId, confirmationNo, or traceId).");
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`  Lookup chain: ${lookups.map((l) => l.mode).join(" → ")}`);

  let result: any;
  try {
    result = await getBookingDetail(lookups);
  } catch (e: any) {
    console.error(`[FAIL] ${e?.message || String(e)}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log("  TBO response: OK");
  console.log(`  HotelName:            ${result.HotelName}`);
  console.log(`  BookingStatus:        ${result.HotelBookingStatus || result.BookingStatus}`);
  console.log(`  TotalFare:            ${result.TotalFare}`);
  console.log(`  NetAmount:            ${result.NetAmount}`);
  console.log(`  CheckInDate:          ${result.CheckInDate}`);
  console.log(`  CheckOutDate:         ${result.CheckOutDate}`);
  console.log(`  LastCancellationDate: ${result.LastCancellationDate}`);
  console.log(`  LastVoucherDate:      ${result.LastVoucherDate}`);

  // Step 3: Map TBO response → SBTHotelBooking fields
  const allPassengers: any[] = (result.Rooms ?? []).flatMap(
    (room: any) => room?.HotelPassenger ?? []
  );

  const guests = allPassengers.map((p: any) => ({
    Title: p.Title || "Mr",
    FirstName: p.FirstName || "",
    LastName: p.LastName || "",
    PaxType: Number(p.PaxType) || 1,
    LeadPassenger: p.LeadPassenger === true || p.LeadPassenger === "true",
  }));

  const paxDetails = allPassengers
    .filter((p: any) => p?.PaxId)
    .map((p: any) => ({
      paxId: String(p.PaxId),
      firstName: p.FirstName || "",
      lastName: p.LastName || "",
      paxType: Number(p.PaxType) || 1,
    }));

  const roomInfo = result.Rooms?.[0];

  const tboStatus = (
    result.HotelBookingStatus ||
    result.BookingStatus ||
    ""
  ).toLowerCase();
  let newStatus = doc.status;
  if (tboStatus === "confirmed") newStatus = "CONFIRMED";
  else if (tboStatus === "cancelled") newStatus = "CANCELLED";
  else if (tboStatus === "failed") newStatus = "FAILED";

  const updates: Record<string, any> = {
    hotelName: result.HotelName || doc.hotelName,
    hotelCode: result.HotelCode || doc.hotelCode,
    checkIn: tboDateToYMD(result.CheckInDate) || doc.checkIn,
    checkOut: tboDateToYMD(result.CheckOutDate) || doc.checkOut,
    guests: guests.length > 0 ? guests : doc.guests,
    paxDetails: paxDetails.length > 0 ? paxDetails : doc.paxDetails,
    roomName: roomInfo?.RoomTypeName || roomInfo?.RoomName || doc.roomName,
    mealType: roomInfo?.MealType || doc.mealType,
    totalFare: result.TotalFare ?? doc.totalFare,
    netAmount: result.NetAmount ?? doc.netAmount,
    isRefundable: result.IsRefundable ?? doc.isRefundable,
    currency: result.CurrencyCode || doc.currency || "INR",
    cancelPolicies: Array.isArray(result.CancelPolicies)
      ? result.CancelPolicies
      : doc.cancelPolicies,
    status: newStatus,
    confirmationNo: result.ConfirmationNo || doc.confirmationNo,
    bookingRefNo: result.BookingRefNo || doc.bookingRefNo,
    invoiceNumber: result.InvoiceNumber || doc.invoiceNumber,
    // parseTBODate handles DD-MM-YYYY HH:mm:ss → Date (Phase 3.3 fix)
    lastCancellationDate: parseTBODate(result.LastCancellationDate),
    lastVoucherDate: parseTBODate(result.LastVoucherDate) ?? undefined,
  };

  // Only set voucherStatus if TBO returned a recognisable value
  if (result.VoucherStatus !== undefined && result.VoucherStatus !== null) {
    const vs = String(result.VoucherStatus).toUpperCase();
    const valid = [
      "PENDING", "CONFIRMED", "FAILED", "GENERATED",
      "PAYMENT_COLLECTED", "HELD", "CANCELLED", "CANCEL_PENDING",
    ];
    if (valid.includes(vs)) updates.voucherStatus = vs;
  }

  // Step 4: Save
  doc.set(updates);
  await doc.save();

  console.log("\n[4/4] Document updated:");
  console.log(`  hotelName:            ${doc.hotelName}`);
  console.log(`  checkIn:              ${doc.checkIn}`);
  console.log(`  checkOut:             ${doc.checkOut}`);
  console.log(`  totalFare:            ${doc.totalFare}`);
  console.log(`  netAmount:            ${doc.netAmount}`);
  console.log(`  guests:               ${doc.guests?.length ?? 0} entries`);
  console.log(`  paxDetails:           ${doc.paxDetails?.length ?? 0} entries`);
  console.log(`  lastCancellationDate: ${
    doc.lastCancellationDate instanceof Date
      ? doc.lastCancellationDate.toISOString()
      : doc.lastCancellationDate ?? "null"
  }`);
  console.log(`  lastVoucherDate:      ${
    doc.lastVoucherDate instanceof Date
      ? doc.lastVoucherDate.toISOString()
      : doc.lastVoucherDate ?? "null"
  }`);
  console.log(`  status:               ${doc.status}`);
  console.log(`  cancelPolicies:       ${doc.cancelPolicies?.length ?? 0} entries`);

  console.log(`\n[OK] Booking ${tboBookingId} reconciled successfully.\n`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error("[ERROR]", e instanceof Error ? e.message : String(e));
  mongoose.disconnect().catch(() => {});
  process.exit(1);
});
