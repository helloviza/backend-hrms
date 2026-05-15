/**
 * Backfill: undo the corruption introduced by the old deferred-status-check
 * mapper, which flipped HELD bookings to CONFIRMED at T+125s when TBO returned
 * HotelBookingStatus="Confirmed" with VoucherStatus=false.
 *
 * Identified during the audit of booking 2127729 (Citymax Bur Dubai) on
 * 2026-05-15. The mapper at apps/backend/src/jobs/deferred-status-check.ts:77
 * was fixed in the same change; this script repairs already-corrupted rows.
 *
 * Default: DRY RUN. Set BACKFILL_APPLY=true to actually write.
 *
 *   pnpm -C apps/backend tsx src/scripts/backfill-corrupted-held-bookings-2026-05-15.ts
 *   BACKFILL_APPLY=true pnpm -C apps/backend tsx src/scripts/backfill-corrupted-held-bookings-2026-05-15.ts
 *
 * Idempotent: after the apply pass, the candidate query stops matching (status
 * has flipped to HELD), so a second run finds zero rows.
 */
import "dotenv/config";
import mongoose from "mongoose";
import SBTHotelBooking from "../models/SBTHotelBooking.js";

const APPLY = process.env.BACKFILL_APPLY === "true";

await mongoose.connect(process.env.MONGO_URI!);

// Corruption fingerprint:
//   status=CONFIRMED      ← wrongly overwritten by old mapper
//   isVouchered=false     ← consistent with "voucher never generated"
//   voucherStatus=null    ← consistent with "voucher never generated"
//   bookingDetailRaw.VoucherStatus=false  ← TBO confirms no voucher
//   lastVoucherDate > now ← TBO hold window still open (safe to flip back to HELD)
//   statusCheckDone=true  ← deferred check has already run; this isn't an in-flight booking
const candidateQuery: Record<string, unknown> = {
  status: "CONFIRMED",
  isVouchered: false,
  voucherStatus: null,
  statusCheckDone: true,
  bookingDetailFetched: true,
  "bookingDetailRaw.VoucherStatus": false,
  lastVoucherDate: { $gt: new Date() },
};

const candidates = await SBTHotelBooking.find(candidateQuery)
  .select({
    _id: 1,
    bookingId: 1,
    hotelName: 1,
    cityName: 1,
    status: 1,
    isHeld: 1,
    isVouchered: 1,
    voucherStatus: 1,
    statusCheckDone: 1,
    createdAt: 1,
    updatedAt: 1,
    lastVoucherDate: 1,
    panMandatory: 1,
    "bookingDetailRaw.HotelBookingStatus": 1,
    "bookingDetailRaw.VoucherStatus": 1,
  })
  .lean();

console.log("=".repeat(72));
console.log(`Backfill: corrupted HELD bookings (mapper bug, deferred-status-check)`);
console.log(`Mode:     ${APPLY ? "APPLY (writes)" : "DRY RUN"}`);
console.log(`Found:    ${candidates.length} candidate(s)`);
console.log("=".repeat(72));

for (const b of candidates) {
  const raw = (b as any).bookingDetailRaw ?? {};
  console.log(
    [
      `  bookingId=${(b as any).bookingId}`,
      `_id=${String(b._id)}`,
      `hotel=${JSON.stringify((b as any).hotelName ?? "")}`,
      `city=${JSON.stringify((b as any).cityName ?? "")}`,
      `status=${(b as any).status}`,
      `isHeld=${(b as any).isHeld}`,
      `voucherStatus=${(b as any).voucherStatus ?? "null"}`,
      `tboBookingStatus=${raw.HotelBookingStatus ?? "?"}`,
      `tboVoucher=${raw.VoucherStatus}`,
      `createdAt=${(b as any).createdAt?.toISOString?.() ?? ""}`,
      `lastVoucherDate=${(b as any).lastVoucherDate?.toISOString?.() ?? ""}`,
    ].join("  "),
  );
}

if (candidates.length === 0) {
  console.log("\nNothing to do.");
  await mongoose.connection.close();
  process.exit(0);
}

if (!APPLY) {
  console.log("\nDRY RUN — no writes performed.");
  console.log("Re-run with BACKFILL_APPLY=true to apply.");
  await mongoose.connection.close();
  process.exit(0);
}

// APPLY pass. Re-scope the update to the same candidate query so a row that
// has been modified between the find() and the update() (e.g., legitimately
// vouchered in between) is excluded. updateMany with the candidate filter is
// the simplest atomic guard.
const result = await SBTHotelBooking.updateMany(candidateQuery, {
  $set: {
    status: "HELD",
    isHeld: true,
    isVouchered: false,
    voucherStatus: null,
  },
});

console.log("\nUpdate result:");
console.log(`  matched:  ${result.matchedCount}`);
console.log(`  modified: ${result.modifiedCount}`);

// Belt-and-braces verification: re-query and confirm the bookings now match HELD.
const verify = await SBTHotelBooking.find({
  _id: { $in: candidates.map((c) => c._id) },
}).select({ _id: 1, bookingId: 1, status: 1, isHeld: 1 }).lean();

console.log("\nVerification — post-update state:");
for (const b of verify) {
  console.log(`  bookingId=${(b as any).bookingId}  status=${(b as any).status}  isHeld=${(b as any).isHeld}`);
}

await mongoose.connection.close();
