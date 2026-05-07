// One-time dedup: SBTHotelBooking has duplicate documents per real bookingId
// (every /save call after /book historically created a fresh doc). This collapses
// each duplicate group to a single best doc, merging non-empty scalar fields from
// the stale docs into the kept doc, then deleting the stale ones.
//
// Skips bookingId values of "0", null, "", or missing — those are TBO-failed
// bookings where TBO never returned an ID, and they are not duplicates of each
// other in the business sense.
//
// Run AFTER deploying the schema unique partial index + /save upsert fix, and
// BEFORE the index actually gets created (Mongoose autoIndex on app start will
// fail until duplicates are gone — that's expected, restart App Runner once this
// script finishes).
import "dotenv/config";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";

// Higher-priority statuses are kept over lower-priority ones. VOUCHERED is
// listed even though it's not in the current schema enum — older docs may
// carry it and we want to preserve them.
const STATUS_PRIORITY: Record<string, number> = {
  CONFIRMED: 1,
  VOUCHERED: 2,
  HELD: 3,
  PENDING: 4,
  CANCEL_PENDING: 5,
  CANCELLED: 6,
  FAILED: 7,
  ORPHAN_CLEANED: 8,
};

function statusRank(s: any): number {
  const key = String(s || "").toUpperCase();
  return STATUS_PRIORITY[key] ?? 99;
}

function pickBest(docs: any[]): any {
  return [...docs].sort((a, b) => {
    const ra = statusRank(a.status);
    const rb = statusRank(b.status);
    if (ra !== rb) return ra - rb;
    const ua = a.updatedAt?.getTime?.() ?? 0;
    const ub = b.updatedAt?.getTime?.() ?? 0;
    return ub - ua; // newer updatedAt wins ties
  })[0];
}

function isEmpty(v: any): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

// Only merge plain scalars (string, number, boolean) and Dates. Skip arrays
// and nested objects (raw, tboVoucherData, bookingDetailRaw, guests, etc.) —
// merging those is too risky.
function isMergeableScalar(v: any): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return false;
  if (v instanceof Date) return true;
  if (typeof v === "object") return false;
  return true;
}

const SKIP_FIELDS = new Set(["_id", "__v", "createdAt", "updatedAt"]);

async function main() {
  await mongoose.connect(env.MONGO_URI);
  console.log("[DEDUP] Connected to MongoDB");

  const groups = await SBTHotelBooking.aggregate([
    {
      $match: {
        bookingId: { $exists: true, $nin: [null, "", "0"] },
      },
    },
    {
      $group: {
        _id: "$bookingId",
        count: { $sum: 1 },
        docIds: { $push: "$_id" },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);

  console.log(`[DEDUP] Found ${groups.length} bookingId(s) with duplicates`);

  let totalDeleted = 0;
  const touched: string[] = [];

  for (const g of groups) {
    const bookingId: string = g._id;
    const docs = await SBTHotelBooking.find({ _id: { $in: g.docIds } });
    if (docs.length < 2) continue;

    const best = pickBest(docs);
    const stale = docs.filter((d: any) => String(d._id) !== String(best._id));

    // Merge: for each field where best is empty and a stale doc has a real
    // scalar value, copy it into the kept doc.
    const mergedFields: string[] = [];
    const update: Record<string, any> = {};
    const bestObj = best.toObject();

    for (const stl of stale) {
      const stlObj = stl.toObject();
      for (const key of Object.keys(stlObj)) {
        if (SKIP_FIELDS.has(key)) continue;
        if (key in update) continue;
        const bestVal = (bestObj as any)[key];
        const stlVal = (stlObj as any)[key];
        if (!isEmpty(bestVal)) continue;
        if (!isMergeableScalar(stlVal)) continue;
        if (isEmpty(stlVal)) continue;
        update[key] = stlVal;
        mergedFields.push(key);
      }
    }

    if (Object.keys(update).length > 0) {
      await SBTHotelBooking.updateOne({ _id: best._id }, { $set: update });
    }

    const staleIds = stale.map((d: any) => d._id);
    await SBTHotelBooking.deleteMany({ _id: { $in: staleIds } });

    totalDeleted += staleIds.length;
    touched.push(bookingId);

    console.log(
      `[DEDUP] bookingId=${bookingId} kept=${best._id} deleted=${staleIds
        .map(String)
        .join(",")} mergedFields=${mergedFields.join(",") || "(none)"}`,
    );
  }

  console.log("");
  console.log("[DEDUP] Summary:");
  console.log(`  Groups processed: ${groups.length}`);
  console.log(`  Docs deleted:     ${totalDeleted}`);
  console.log(`  bookingIds:       ${touched.join(", ") || "(none)"}`);

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("[DEDUP] Failed:", e);
  process.exit(1);
});
