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

/**
 * Derive internal booking state from a TBO GetBookingDetail response.
 *
 * Spec — UNIVERSAL_Hotel_API_Technical_Guide.md:
 *   - Line 2030: TBO Status enum is { 0: BookFailed, 1: Confirmed, 3: VerifyPrice, 6: Cancelled }.
 *     There is NO "Held" enum value. TBO returns "Confirmed" (Status=1) for BOTH held
 *     and vouchered bookings; VoucherStatus (boolean) is the only discriminator.
 *   - Line 1987: A booking made with IsVoucherBooking=true that returns Status=1 +
 *     VoucherStatus=false is the "Pending" edge case — TBO has confirmed the booking
 *     at the supplier but has not finished voucher generation. We keep it PENDING
 *     so the voucher-poll path can finish.
 *
 * Because GetBookingDetail doesn't carry the original IsVoucherBooking flag, we use
 * the booking's claimed (currently-persisted) status — set by deriveStateFromBookResponse
 * at Book time — to disambiguate the "Confirmed + VoucherStatus=false" ambiguity.
 *
 * Exported for unit testing.
 */
export type ClaimedStatus =
  | "CONFIRMED"
  | "HELD"
  | "PENDING"
  | "FAILED"
  | "CANCELLED"
  | "CANCEL_PENDING"
  | "EXPIRED"
  | "CLOSED"
  | "ORPHAN_CLEANED"
  | string;

export interface DerivedDetailState {
  derivedStatus: string | null;
  derivedIsHeld: boolean | null;
  derivedIsVouchered: boolean | null;
  derivedVoucherStatus: string | null;
}

export function deriveStateFromBookingDetail(
  detail: any,
  claimedStatus: ClaimedStatus,
): DerivedDetailState {
  const tboStatusStr = String(
    detail?.HotelBookingStatus || detail?.BookingStatus || "",
  ).toLowerCase();
  const tboStatusNum = Number(detail?.Status ?? -1);
  const tboVoucherStatus = detail?.VoucherStatus === true;

  // VoucherStatus=true (or the rare "Vouchered" string) is the only true signal of
  // a vouchered booking. Promote to CONFIRMED regardless of claimed state.
  if (tboVoucherStatus || tboStatusStr === "vouchered") {
    return {
      derivedStatus: "CONFIRMED",
      derivedIsHeld: false,
      derivedIsVouchered: true,
      derivedVoucherStatus: "GENERATED",
    };
  }

  // TBO Status=1 / "Confirmed" without VoucherStatus → ambiguous:
  //   - Hold flow (IsVoucherBooking=false at Book) → internal HELD.
  //   - Voucher flow waiting for voucher (spec line 1987) → keep PENDING.
  // The claimed status (written by deriveStateFromBookResponse at Book time) is
  // our memory of the original IsVoucherBooking intent — trust it.
  if (tboStatusStr === "confirmed" || tboStatusNum === 1) {
    if (claimedStatus === "HELD") {
      return {
        derivedStatus: "HELD",
        derivedIsHeld: true,
        derivedIsVouchered: false,
        derivedVoucherStatus: null,
      };
    }
    if (claimedStatus === "PENDING") {
      return {
        derivedStatus: "PENDING",
        derivedIsHeld: false,
        derivedIsVouchered: false,
        derivedVoucherStatus: "PENDING",
      };
    }
    // Unknown claimed state — defensively mark HELD. The booking exists at TBO,
    // is not vouchered, and (caller verifies) the hold window is still open.
    return {
      derivedStatus: "HELD",
      derivedIsHeld: true,
      derivedIsVouchered: false,
      derivedVoucherStatus: null,
    };
  }

  if (tboStatusStr === "cancelled" || tboStatusNum === 6) {
    return {
      derivedStatus: "CANCELLED",
      derivedIsHeld: null,
      derivedIsVouchered: null,
      derivedVoucherStatus: null,
    };
  }

  if (tboStatusStr === "bookfailed" || tboStatusStr === "failed" || tboStatusNum === 0) {
    return {
      derivedStatus: "FAILED",
      derivedIsHeld: null,
      derivedIsVouchered: null,
      derivedVoucherStatus: null,
    };
  }

  // Status=3 is VerifyPrice (price changed). Treat as FAILED so the frontend
  // re-prebooks — aligns with deriveStateFromBookResponse() in tboBookingStateMapper.ts.
  if (tboStatusNum === 3) {
    return {
      derivedStatus: "FAILED",
      derivedIsHeld: null,
      derivedIsVouchered: null,
      derivedVoucherStatus: null,
    };
  }

  return {
    derivedStatus: null,
    derivedIsHeld: null,
    derivedIsVouchered: null,
    derivedVoucherStatus: null,
  };
}

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

    const { derivedStatus, derivedIsHeld, derivedIsVouchered, derivedVoucherStatus } =
      deriveStateFromBookingDetail(detail, claimed.status);

    // Kept for the warn-log payload below. tboStatusStr mirrors the original raw value;
    // the actual decision lives in deriveStateFromBookingDetail.
    const tboStatusStr = String(
      detail?.HotelBookingStatus || detail?.BookingStatus || "",
    ).toLowerCase();

    // Always opportunistically backfill metadata that the old setImmediate
    // block used to populate. PaxIds are required for PAN-at-voucher-time
    // on HELD bookings (POST-001).
    const allPassengers: any[] = (
      detail?.HotelRoomsDetails ?? detail?.Rooms ?? []
    ).flatMap((room: any) => room?.HotelPassenger ?? []);
    // TBO never echoes the submitted PAN back via GetBookingDetail (always
    // null), so pan is sourced from heldLeadPAN captured at HOLD time.
    // Adults (PaxType 1) carry the lead PAN; children (PaxType 2) get null.
    const heldLeadPAN = String((claimed as any).heldLeadPAN || "").trim();
    const paxDetails = allPassengers
      .filter((p: any) => p?.PaxId)
      .map((p: any) => {
        const paxType = Number(p.PaxType) || 1;
        return {
          paxId: String(p.PaxId),
          firstName: p.FirstName || "",
          lastName: p.LastName || "",
          paxType,
          pan: paxType === 1 ? (heldLeadPAN || null) : null,
        };
      });
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
      // Write paxDetails when missing, OR re-write to backfill pan when an
      // existing record has adults still lacking a non-empty pan. The source
      // (this GetBookingDetail call) is authoritative for paxId/name/type.
      ...(paxDetails.length > 0 &&
      (!claimed.paxDetails ||
        claimed.paxDetails.length === 0 ||
        (claimed.paxDetails as any[]).some(
          (p: any) => Number(p?.paxType) === 1 && !String(p?.pan ?? "").trim(),
        ))
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
