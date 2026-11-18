// apps/backend/src/jobs/stale-hotel-hold-mirror.ts
//
// Travel Spend FU-1 (decision 2026-11-18): a HELD SBT hotel hold whose
// check-in date (IST) has passed shows as FAILED in the TravelBooking mirror,
// not "Pending" for ever. The SOURCE booking is never touched — it stays HELD.
//
// mapHotelMirrorStatus (models/SBTHotelBooking.ts) already applies the rule
// whenever the mirror is written, but nothing writes a hold when its date
// simply passes. This daily sweep re-syncs exactly those rows: HELD sources
// with checkIn < today (IST) whose mirror is not yet FAILED.
import cron from "node-cron";
import SBTHotelBooking, { istDateKey, resyncSBTHotelBookingMirrors } from "../models/SBTHotelBooking.js";
import TravelBooking from "../models/TravelBooking.js";
import logger from "../utils/logger.js";

export async function runStaleHotelHoldMirrorSweep(now: Date = new Date()): Promise<{ candidates: number; synced: number; failed: number }> {
  const today = istDateKey(now);
  // checkIn is a "YYYY-MM-DD…" string, so a string compare is a date compare.
  const held = (await SBTHotelBooking.find({ status: "HELD", checkIn: { $gt: "", $lt: today } })
    .select("_id")
    .lean()) as any[];
  if (!held.length) return { candidates: 0, synced: 0, failed: 0 };
  const ids = held.map((h) => h._id);
  const stale = (await TravelBooking.find({ reference: { $in: ids }, status: { $ne: "FAILED" } })
    .select("reference")
    .lean()) as any[];
  const missing = ids.length - (await TravelBooking.countDocuments({ reference: { $in: ids } }));
  const targets = [...stale.map((m) => m.reference), ...(missing > 0 ? ids : [])];
  const unique = [...new Map(targets.map((t) => [String(t), t])).values()];
  if (!unique.length) return { candidates: 0, synced: 0, failed: 0 };
  const res = await resyncSBTHotelBookingMirrors(unique);
  return { candidates: unique.length, synced: res.synced, failed: res.failed };
}

export function startStaleHotelHoldMirrorCron(): void {
  // 00:20 IST — just after the IST day turns over.
  cron.schedule(
    "20 0 * * *",
    async () => {
      try {
        const r = await runStaleHotelHoldMirrorSweep();
        logger.info("[StaleHoldMirror] Done", r);
      } catch (err: any) {
        logger.error("[StaleHoldMirror] Sweep failed", { error: err?.message });
      }
    },
    { timezone: "Asia/Kolkata" },
  );
  logger.info("[StaleHoldMirror] Cron scheduled — daily 00:20 IST");
}
