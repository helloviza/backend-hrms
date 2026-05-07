// One-time backfill: copy bookingDetailRaw.TBOReferenceNo to top-level tboReferenceNo
// for SBTHotelBooking docs that already have the value buried in the raw payload.
// Safe to re-run: matches only docs where the top-level field is null/undefined.
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";

async function main() {
  await mongoose.connect(env.MONGO_URI);
  console.log("[BACKFILL] Connected to MongoDB");

  const candidates = await SBTHotelBooking.find(
    {
      $and: [
        { $or: [{ tboReferenceNo: { $exists: false } }, { tboReferenceNo: null }, { tboReferenceNo: "" }] },
        { "bookingDetailRaw.TBOReferenceNo": { $exists: true, $ne: null } },
      ],
    },
    { _id: 1, bookingId: 1, tboReferenceNo: 1, bookingDetailRaw: 1 },
  ).lean();

  console.log(`[BACKFILL] Found ${candidates.length} candidate booking(s)`);

  let updated = 0;
  for (const doc of candidates) {
    const value = (doc as any)?.bookingDetailRaw?.TBOReferenceNo;
    if (value === undefined || value === null || String(value).trim() === "") continue;
    const refNo = String(value);
    await SBTHotelBooking.updateOne(
      { _id: doc._id },
      { $set: { tboReferenceNo: refNo } },
    );
    console.log(`[BACKFILL] booking ${doc.bookingId} tboReferenceNo=${refNo}`);
    updated++;
  }

  console.log(`[BACKFILL] Updated ${updated} bookings`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("[BACKFILL] Failed:", e);
  process.exit(1);
});
