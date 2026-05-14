// TBO cert Item 31 — defer GetBookingDetail by ≥120s after Book.
// TBO recommends waiting 120s before calling GetBookingDetail because the
// immediate-call response can return a transient intermediate state.
// This module is invoked from two places:
//   1. In-process setTimeout scheduled by /sbt/hotels/book after a successful
//      Book TBO call ("happy path").
//   2. Cron sweep in orphan-pending-cleanup.ts every 1 minute, which acts as
//      a durability backstop for bookings whose in-process timer was lost
//      (e.g., container restart, process crash).
// Idempotency is enforced by atomically claiming the booking via
// statusCheckDone: false → true on findOneAndUpdate.

import SBTHotelBooking from "../models/SBTHotelBooking.js";
import SBTRequest from "../models/SBTRequest.js";
import User from "../models/User.js";
import { getBookingDetail } from "../services/tbo.hotel.service.js";
import { parseTBODate } from "../lib/tbo-date.js";
import logger from "../utils/logger.js";
import { sendMail } from "../utils/mailer.js";

const MAX_ATTEMPTS = 5;

export async function runDeferredStatusCheck(bookingDocId: string): Promise<void> {
  // Atomic claim — first caller (timer or cron) wins; the loser exits.
  const claimed = await SBTHotelBooking.findOneAndUpdate(
    { _id: bookingDocId, statusCheckDone: false },
    {
      $set: { lastStatusCheckAt: new Date() },
      $inc: { statusCheckAttempts: 1 },
    },
    { new: true },
  );

  if (!claimed) {
    return;
  }

  const numericBookingId = claimed.bookingId ? Number(claimed.bookingId) : 0;
  const currentAttempts = claimed.statusCheckAttempts ?? 0;

  // No TBO BookingId — nothing to reconcile against. Mark done so cron
  // doesn't keep picking it up. Orphan-pending cron will handle stale PENDING.
  if (!numericBookingId) {
    await SBTHotelBooking.findByIdAndUpdate(bookingDocId, {
      $set: {
        statusCheckDone: true,
        pendingStatusCheckAt: null,
      },
    });
    logger.info("[DeferredStatusCheck] No TBO BookingId on booking; skipping", {
      bookingDocId, clientReferenceId: claimed.clientReferenceId,
    });
    return;
  }

  try {
    const detail = await getBookingDetail([
      { mode: "bookingId", bookingId: numericBookingId },
    ]);

    if (!detail) {
      throw new Error("GetBookingDetail returned empty");
    }

    const tboStatusStr = String(
      detail?.HotelBookingStatus || detail?.BookingStatus || "",
    ).toLowerCase();
    const tboStatusNum = Number(detail?.Status ?? -1);
    const tboVoucherStatus = detail?.VoucherStatus === true;

    // Derive the doc status TBO is reporting.
    let derivedStatus: string | null = null;
    let derivedIsHeld: boolean | null = null;
    let derivedIsVouchered: boolean | null = null;
    let derivedVoucherStatus: string | null = null;

    if (tboStatusStr === "confirmed" || tboVoucherStatus) {
      derivedStatus = "CONFIRMED";
      derivedIsHeld = false;
      derivedIsVouchered = tboVoucherStatus;
      derivedVoucherStatus = tboVoucherStatus ? "GENERATED" : null;
    } else if (tboStatusStr === "vouchered") {
      derivedStatus = "CONFIRMED";
      derivedIsHeld = false;
      derivedIsVouchered = true;
      derivedVoucherStatus = "GENERATED";
    } else if (tboStatusStr === "held" || tboStatusNum === 3) {
      derivedStatus = "HELD";
      derivedIsHeld = true;
      derivedIsVouchered = false;
      derivedVoucherStatus = null;
    } else if (tboStatusStr === "cancelled" || tboStatusNum === 2) {
      derivedStatus = "CANCELLED";
    } else if (tboStatusStr === "bookfailed" || tboStatusStr === "failed" || tboStatusNum === 0) {
      derivedStatus = "FAILED";
    }

    // Always opportunistically backfill metadata that the old setImmediate
    // block used to populate. PaxIds are required for PAN-at-voucher-time
    // on HELD bookings (POST-001).
    const allPassengers: any[] = (
      detail?.HotelRoomsDetails ?? detail?.Rooms ?? []
    ).flatMap((room: any) => room?.HotelPassenger ?? []);
    const paxDetails = allPassengers
      .filter((p: any) => p?.PaxId)
      .map((p: any) => ({
        paxId: String(p.PaxId),
        firstName: p.FirstName || "",
        lastName: p.LastName || "",
        paxType: Number(p.PaxType) || 1,
      }));
    const roomDescription =
      (detail?.HotelRoomsDetails ?? detail?.Rooms ?? [])[0]?.RoomDescription ||
      (detail?.HotelRoomsDetails ?? detail?.Rooms ?? [])[0]?.RoomTypeName ||
      null;

    const update: Record<string, unknown> = {
      statusCheckDone: true,
      pendingStatusCheckAt: null,
      bookingDetailFetched: true,
      bookingDetailFetchedAt: new Date(),
      bookingDetailRaw: detail,
      ...(detail?.TBOReferenceNo && !claimed.tboReferenceNo
        ? { tboReferenceNo: String(detail.TBOReferenceNo) }
        : {}),
      ...(detail?.TraceId && !claimed.traceId ? { traceId: String(detail.TraceId) } : {}),
      ...(detail?.InvoiceNo && !claimed.invoiceNumber
        ? { invoiceNumber: String(detail.InvoiceNo) }
        : {}),
      ...(detail?.ConfirmationNo && !claimed.confirmationNo
        ? { confirmationNo: String(detail.ConfirmationNo) }
        : {}),
      ...(roomDescription && !claimed.roomDescription
        ? { roomDescription }
        : {}),
      ...(paxDetails.length > 0 && (!claimed.paxDetails || claimed.paxDetails.length === 0)
        ? { paxDetails }
        : {}),
      ...(detail?.LastVoucherDate
        ? { lastVoucherDate: parseTBODate(detail.LastVoucherDate) }
        : {}),
      ...(detail?.LastCancellationDate
        ? { lastCancellationDate: parseTBODate(detail.LastCancellationDate) }
        : {}),
    };

    // Status reconciliation: only override if TBO disagrees with our state.
    if (derivedStatus && derivedStatus !== claimed.status) {
      update.status = derivedStatus;
      if (derivedIsHeld !== null) update.isHeld = derivedIsHeld;
      if (derivedIsVouchered !== null) update.isVouchered = derivedIsVouchered;
      if (derivedVoucherStatus !== null) update.voucherStatus = derivedVoucherStatus;
      if (derivedStatus === "CANCELLED" && !claimed.cancelledAt) {
        update.cancelledAt = new Date();
      }
      logger.warn("[DeferredStatusCheck] Status discrepancy reconciled", {
        bookingDocId,
        bookingId: numericBookingId,
        had: claimed.status,
        tbo: derivedStatus,
        tboRawStatus: tboStatusStr,
      });
    } else {
      logger.info("[DeferredStatusCheck] Status confirmed", {
        bookingDocId,
        bookingId: numericBookingId,
        status: claimed.status,
      });
    }

    await SBTHotelBooking.findByIdAndUpdate(bookingDocId, { $set: update });

    // Confirmation email — moved here from the /save handler in sbt.hotels.ts.
    // Only fires when (a) the booking fulfils an SBT request, (b) reconciliation
    // ended in CONFIRMED state (we won't email about a booking TBO later cancels),
    // (c) no prior email send was recorded. Failure to send is logged but does
    // not unwind the reconciliation — operator can resend manually.
    const finalStatus = update.status ?? claimed.status;
    if (
      finalStatus === "CONFIRMED" &&
      claimed.sbtRequestId &&
      !(claimed as any).confirmationEmailSentAt
    ) {
      try {
        await sendSbtRequestConfirmationEmail(claimed);
      } catch (emailErr: any) {
        logger.warn("[DeferredStatusCheck] Confirmation email send failed", {
          bookingDocId,
          sbtRequestId: String(claimed.sbtRequestId),
          err: emailErr?.message || String(emailErr),
        });
      }
    }
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    if (currentAttempts >= MAX_ATTEMPTS) {
      // Give up — log hard failure, mark done so cron stops, leave for manual.
      await SBTHotelBooking.findByIdAndUpdate(bookingDocId, {
        $set: { statusCheckDone: true, pendingStatusCheckAt: null },
      });
      logger.error("[DeferredStatusCheck] HARD FAILURE — giving up after max attempts", {
        bookingDocId,
        bookingId: numericBookingId,
        attempts: currentAttempts,
        err: errMsg,
      });
    } else {
      // Unclaim so cron retries on next tick. pendingStatusCheckAt stays.
      await SBTHotelBooking.findByIdAndUpdate(bookingDocId, {
        $set: { statusCheckDone: false },
      });
      logger.warn("[DeferredStatusCheck] TBO call failed — will retry via cron", {
        bookingDocId,
        bookingId: numericBookingId,
        attempts: currentAttempts,
        err: errMsg,
      });
    }
  }
}

async function sendSbtRequestConfirmationEmail(booking: any): Promise<void> {
  const sbtReq = await SBTRequest.findById(booking.sbtRequestId).select("requesterId").lean() as any;
  if (!sbtReq?.requesterId) return;

  const requester = await User.findById(sbtReq.requesterId).select("email").lean() as any;
  if (!requester?.email) return;

  const frontendUrl = process.env.FRONTEND_ORIGIN || "http://localhost:5173";
  await sendMail({
    to: requester.email,
    subject: `Your hotel has been booked — ${booking.hotelName || "Hotel"}`,
    kind: "CONFIRMATIONS",
    html: `
      <h3>Hotel Booking Confirmed</h3>
      <p>Your hotel request has been booked successfully.</p>
      <p><strong>Hotel:</strong> ${booking.hotelName || ""}</p>
      <p><strong>Check-in:</strong> ${booking.checkIn || ""}</p>
      <p><strong>Check-out:</strong> ${booking.checkOut || ""}</p>
      ${booking.confirmationNo ? `<p><strong>Confirmation:</strong> ${booking.confirmationNo}</p>` : ""}
      <p><a href="${frontendUrl}/sbt/my-requests">View My Requests</a></p>
    `,
  });

  // Idempotency stamp written only after a successful send. The conditional
  // filter (confirmationEmailSentAt: null) is a belt-and-braces guard against
  // any future race where two reconciliation workers might claim the same
  // booking — extremely unlikely given the statusCheckDone atomic claim above,
  // but cheap to enforce.
  await SBTHotelBooking.findOneAndUpdate(
    { _id: booking._id, confirmationEmailSentAt: null },
    { $set: { confirmationEmailSentAt: new Date() } },
  );
}

export async function runDeferredStatusCheckSweep(): Promise<void> {
  const now = new Date();
  const due = await SBTHotelBooking.find({
    pendingStatusCheckAt: { $ne: null, $lte: now },
    statusCheckDone: false,
  })
    .limit(50)
    .select({ _id: 1 })
    .lean();

  if (due.length === 0) return;

  logger.info(`[DeferredStatusCheck] Sweep — ${due.length} due`);

  for (const doc of due) {
    try {
      await runDeferredStatusCheck(String(doc._id));
    } catch (err: any) {
      logger.error("[DeferredStatusCheck] Sweep iteration failed", {
        bookingDocId: String(doc._id),
        err: err?.message || String(err),
      });
    }
  }
}
