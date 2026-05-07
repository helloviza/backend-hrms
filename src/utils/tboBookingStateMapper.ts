/**
 * TBO Hotel Booking State Mapper
 *
 * Single source of truth for translating TBO response state into Plumtrips internal state.
 * Replaces ad-hoc $set blocks across sbt.hotels.ts that were producing inconsistent flag combinations.
 *
 * Spec references (UNIVERSAL_Hotel_API_Technical_Guide.md):
 * - Line 2030: TBO Status enum is 0=BookFailed, 1=Confirmed, 3=VerifyPrice, 6=Cancelled. No HELD.
 * - Line 2029: VoucherStatus is the boolean truth (true=vouchered, false=not).
 * - Line 1977: IsVoucherBooking=false at Book → hold flow → GenerateVoucher later.
 * - Line 1979: IsVoucherBooking=true at Book → book + voucher in one go.
 * - Line 1987: IsVoucherBooking=true but Status=1 + VoucherStatus=false → "Pending" edge case → poll GetBookingDetail.
 *
 * USAGE — Sprint 2 will replace inline $set blocks with:
 *   const stateUpdate = deriveStateFromBookResponse(bookResult, { isVoucherBookingRequest: !isHeld });
 *   await SBTHotelBooking.findOneAndUpdate({ clientReferenceId }, { $set: { ...stateUpdate, ...otherFields } });
 */

export type InternalBookingStatus =
  | "CONFIRMED"
  | "HELD"
  | "PENDING"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED"
  | "CLOSED"
  | "ORPHAN_CLEANED"
  | "CANCEL_PENDING";

export type InternalVoucherStatus =
  | "PENDING"
  | "GENERATED"
  | "FAILED"
  | "CONFIRMED"
  | "PAYMENT_COLLECTED"
  | "HELD"
  | "CANCELLED"
  | "CANCEL_PENDING"
  | null;

/**
 * Derived state shape — every Book/GenerateVoucher response write should produce ALL of these together,
 * never a subset. Sprint 2 will enforce this by replacing the partial $set writes.
 */
export interface DerivedBookingState {
  status: InternalBookingStatus;
  isHeld: boolean;
  isVouchered: boolean;
  voucherStatus: InternalVoucherStatus;
}

/**
 * Derive internal state from a TBO Book response.
 *
 * @param bookResult - TBO BookResult (the contents of `data.BookResult` from /rest/book/)
 * @param ctx.isVoucherBookingRequest - The IsVoucherBooking flag we sent in the request (true=voucher, false=hold)
 *
 * Decision matrix per spec:
 *   request    | TBO Status | VoucherStatus | → internal state
 *   ---------- | ---------- | ------------- | -----------------
 *   voucher(t) | 1          | true          | CONFIRMED, isHeld=false, isVouchered=true,  voucherStatus=GENERATED
 *   voucher(t) | 1          | false         | PENDING,   isHeld=false, isVouchered=false, voucherStatus=PENDING   ← needs GetBookingDetail poll (spec 1987)
 *   hold(f)    | 1          | false         | HELD,      isHeld=true,  isVouchered=false, voucherStatus=null
 *   any        | 0          | any           | FAILED,    isHeld=false, isVouchered=false, voucherStatus=FAILED
 *   any        | 6          | any           | CANCELLED, isHeld=false, isVouchered=false, voucherStatus=CANCELLED
 *   any        | 3          | any           | FAILED,    isHeld=false, isVouchered=false, voucherStatus=FAILED   ← VerifyPrice = need re-prebook
 */
export function deriveStateFromBookResponse(
  bookResult: any,
  ctx: { isVoucherBookingRequest: boolean }
): DerivedBookingState {
  const tboStatus: number = Number(bookResult?.Status ?? -1);
  const voucherStatus: boolean = bookResult?.VoucherStatus === true;

  // BookFailed (Status=0) — overrides everything else.
  if (tboStatus === 0) {
    return {
      status: "FAILED",
      isHeld: false,
      isVouchered: false,
      voucherStatus: "FAILED",
    };
  }

  // Cancelled (Status=6) — TBO marked it cancelled.
  if (tboStatus === 6) {
    return {
      status: "CANCELLED",
      isHeld: false,
      isVouchered: false,
      voucherStatus: "CANCELLED",
    };
  }

  // VerifyPrice (Status=3) — price changed, treat as failed for our flow (frontend re-prebooks).
  if (tboStatus === 3) {
    return {
      status: "FAILED",
      isHeld: false,
      isVouchered: false,
      voucherStatus: "FAILED",
    };
  }

  // Confirmed (Status=1) — three sub-cases.
  if (tboStatus === 1) {
    if (voucherStatus === true) {
      // Book+voucher succeeded in one shot.
      return {
        status: "CONFIRMED",
        isHeld: false,
        isVouchered: true,
        voucherStatus: "GENERATED",
      };
    }

    // Confirmed but not yet vouchered.
    if (ctx.isVoucherBookingRequest === false) {
      // We asked for hold → this is a held booking awaiting later GenerateVoucher.
      return {
        status: "HELD",
        isHeld: true,
        isVouchered: false,
        voucherStatus: null,
      };
    }

    // We asked for voucher but TBO gave us VoucherStatus=false → spec line 1987 "Pending" case.
    // Caller is responsible for scheduling a GetBookingDetail poll after 120s.
    return {
      status: "PENDING",
      isHeld: false,
      isVouchered: false,
      voucherStatus: "PENDING",
    };
  }

  // Unknown TBO Status — treat as failed (defensive).
  return {
    status: "FAILED",
    isHeld: false,
    isVouchered: false,
    voucherStatus: "FAILED",
  };
}

/**
 * Derive internal state from a TBO GenerateVoucher response.
 *
 * Spec note: ErrorCode 2 with "already generated" message is NOT a real failure — it means the
 * voucher exists at TBO and we should reconcile via GetBookingDetail. Sprint 2 will wire the
 * reconciliation path; for now this helper just classifies the response.
 *
 * @param gvr - TBO GenerateVoucherResult (the contents of `data.GenerateVoucherResult`)
 */
export interface DerivedVoucherState {
  /** Was the voucher operation considered successful? */
  success: boolean;
  /** Is this the "already generated" idempotency case that needs GetBookingDetail reconciliation? */
  isAlreadyGenerated: boolean;
  /** Is this the agency-balance-insufficient case (existing handler keeps current 402 behaviour)? */
  isBalanceError: boolean;
  /** Derived booking state IF success === true. Caller should ignore if success===false. */
  derivedOnSuccess: DerivedBookingState | null;
  /** Raw TBO error message, for logging/error responses. */
  tboErrorMessage: string;
  /** Raw TBO error code. */
  tboErrorCode: number | null;
}

export function deriveStateFromVoucherResponse(gvr: any): DerivedVoucherState {
  const tboErrorCode: number | null =
    typeof gvr?.Error?.ErrorCode === "number" ? gvr.Error.ErrorCode : null;
  const tboErrorMessage: string = String(gvr?.Error?.ErrorMessage ?? "");
  const responseStatus: number = Number(gvr?.ResponseStatus ?? -1);

  // ErrorCode 2 has TWO meanings — disambiguate by message content.
  // Subcase A: agency wallet balance insufficient. Existing handler returns 402.
  // Subcase B: voucher already generated (idempotency). Caller should reconcile via GetBookingDetail.
  const lowerMsg = tboErrorMessage.toLowerCase();
  const isBalanceError =
    tboErrorCode === 2 &&
    (lowerMsg.includes("balance") ||
      lowerMsg.includes("insufficient") ||
      lowerMsg.includes("credit"));
  const isAlreadyGenerated =
    tboErrorCode === 2 &&
    !isBalanceError &&
    (lowerMsg.includes("already generated") ||
      lowerMsg.includes("already vouchered"));

  // Successful voucher — TBO confirmed.
  const success = responseStatus === 1;

  if (success) {
    return {
      success: true,
      isAlreadyGenerated: false,
      isBalanceError: false,
      tboErrorCode,
      tboErrorMessage,
      derivedOnSuccess: {
        status: "CONFIRMED",
        isHeld: false,
        isVouchered: true,
        voucherStatus: "GENERATED",
      },
    };
  }

  return {
    success: false,
    isAlreadyGenerated,
    isBalanceError,
    tboErrorCode,
    tboErrorMessage,
    derivedOnSuccess: null,
  };
}
