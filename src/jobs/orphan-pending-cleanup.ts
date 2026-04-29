// BUCKET-C-3: Hourly cron that marks orphaned PENDING hotel bookings.
// A PENDING booking with no bookingId that is older than 1 hour has no
// way to succeed — the TBO session is long gone. If a bookingId exists,
// we attempt GetBookingDetail to reconcile before marking ORPHAN_CLEANED.
import cron from "node-cron";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import { getTBOToken } from "../services/tbo.auth.service.js";
import { withTBOSessionRetry } from "../services/tbo.session.helper.js";
import logger from "../utils/logger.js";

async function verifyWithTBO(bookingId: number): Promise<string | null> {
  try {
    const rawData = await withTBOSessionRetry(
      async (tokenId) => {
        const res = await fetch(
          "https://hotelbe.tektravels.com/hotelservice.svc/rest/GetBookingDetail/",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${tokenId}`,
            },
            body: JSON.stringify({
              EndUserIp: process.env.TBO_EndUserIp || "1.1.1.1",
              TokenId: tokenId,
              BookingId: bookingId,
            }),
            signal: AbortSignal.timeout(15_000),
          },
        );
        return (await res.json()) as any;
      },
      (r: any) => {
        const inner = r?.GetBookingDetailResult || r?.BookResult || r;
        return inner?.ResponseStatus === 4 || inner?.Error?.ErrorCode === 6;
      },
    );
    const detail = rawData?.GetBookingDetailResult || rawData?.BookResult || rawData;
    const status = (detail?.HotelBookingStatus || detail?.BookingStatus || "").toLowerCase();
    return status || null;
  } catch {
    return null;
  }
}

export async function runOrphanPendingCleanup(): Promise<void> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

  const candidates = await SBTHotelBooking.find({
    status: "PENDING",
    createdAt: { $lt: cutoff },
  }).lean();

  if (candidates.length === 0) {
    logger.info("[OrphanCleanup] No stale PENDING bookings found");
    return;
  }

  logger.info(`[OrphanCleanup] Found ${candidates.length} stale PENDING bookings`);

  let reconciled = 0;
  let cleaned = 0;
  let skipped = 0;

  for (const booking of candidates) {
    const id = String(booking._id);
    const numericBookingId = booking.bookingId ? Number(booking.bookingId) : 0;

    if (numericBookingId > 0) {
      // Has a BookingId — try GetBookingDetail to reconcile
      const tboStatus = await verifyWithTBO(numericBookingId);
      if (tboStatus === "confirmed" || tboStatus === "vouchered") {
        await SBTHotelBooking.findByIdAndUpdate(id, {
          $set: { status: "CONFIRMED" },
        });
        reconciled++;
        logger.info("[OrphanCleanup] Reconciled booking", { id, bookingId: numericBookingId, tboStatus });
        continue;
      }
      if (tboStatus === "held") {
        await SBTHotelBooking.findByIdAndUpdate(id, {
          $set: { status: "HELD" },
        });
        reconciled++;
        logger.info("[OrphanCleanup] Reconciled held booking", { id, bookingId: numericBookingId });
        continue;
      }
      if (tboStatus === null) {
        // Could not reach TBO — skip; will retry next hour
        skipped++;
        logger.warn("[OrphanCleanup] TBO unreachable for booking — skipping", { id });
        continue;
      }
      // TBO returned failed/cancelled/unknown — mark cleaned
    }

    // No bookingId, or TBO returned no usable status → ORPHAN_CLEANED
    await SBTHotelBooking.findByIdAndUpdate(id, {
      $set: {
        status: "ORPHAN_CLEANED",
        failureReason: "Orphaned PENDING — no TBO confirmation after 1h",
      },
    });
    cleaned++;
    logger.info("[OrphanCleanup] Marked ORPHAN_CLEANED", {
      id,
      clientReferenceId: booking.clientReferenceId,
      createdAt: booking.createdAt,
    });
  }

  logger.info(
    `[OrphanCleanup] Done — reconciled=${reconciled} cleaned=${cleaned} skipped=${skipped}`,
  );
}

export function startOrphanPendingCleanupCron(): void {
  // Run every hour at :30 (offset from hold-booking-reminder's :00)
  cron.schedule("30 * * * *", async () => {
    logger.info("[OrphanCleanup] Cron triggered");
    try {
      await runOrphanPendingCleanup();
    } catch (err: any) {
      logger.error("[OrphanCleanup] Cron run failed", { error: err?.message });
    }
  });
  logger.info("[OrphanCleanup] Cron scheduled — hourly at :30");
}
