import { describe, it, expect } from "vitest";
import {
  deriveStateFromBookResponse,
  deriveStateFromVoucherResponse,
} from "./tboBookingStateMapper.js";

describe("deriveStateFromBookResponse", () => {
  it("voucher request + Status=1 + VoucherStatus=true → CONFIRMED + vouchered", () => {
    const result = deriveStateFromBookResponse(
      { Status: 1, VoucherStatus: true },
      { isVoucherBookingRequest: true }
    );
    expect(result).toEqual({
      status: "CONFIRMED",
      isHeld: false,
      isVouchered: true,
      voucherStatus: "GENERATED",
    });
  });

  it("voucher request + Status=1 + VoucherStatus=false → PENDING (spec 1987)", () => {
    const result = deriveStateFromBookResponse(
      { Status: 1, VoucherStatus: false },
      { isVoucherBookingRequest: true }
    );
    expect(result).toEqual({
      status: "PENDING",
      isHeld: false,
      isVouchered: false,
      voucherStatus: "PENDING",
    });
  });

  it("hold request + Status=1 + VoucherStatus=false → HELD with isHeld=true", () => {
    const result = deriveStateFromBookResponse(
      { Status: 1, VoucherStatus: false },
      { isVoucherBookingRequest: false }
    );
    expect(result).toEqual({
      status: "HELD",
      isHeld: true,
      isVouchered: false,
      voucherStatus: null,
    });
  });

  it("Status=0 (BookFailed) overrides everything → FAILED", () => {
    const result = deriveStateFromBookResponse(
      { Status: 0, VoucherStatus: true },
      { isVoucherBookingRequest: true }
    );
    expect(result).toEqual({
      status: "FAILED",
      isHeld: false,
      isVouchered: false,
      voucherStatus: "FAILED",
    });
  });

  it("Status=6 (Cancelled) → CANCELLED", () => {
    const result = deriveStateFromBookResponse(
      { Status: 6 },
      { isVoucherBookingRequest: true }
    );
    expect(result.status).toBe("CANCELLED");
    expect(result.isVouchered).toBe(false);
  });

  it("Status=3 (VerifyPrice) → FAILED (frontend re-prebooks)", () => {
    const result = deriveStateFromBookResponse(
      { Status: 3 },
      { isVoucherBookingRequest: true }
    );
    expect(result.status).toBe("FAILED");
  });

  it("unknown Status → FAILED (defensive)", () => {
    const result = deriveStateFromBookResponse(
      { Status: 99 },
      { isVoucherBookingRequest: true }
    );
    expect(result.status).toBe("FAILED");
  });

  // Regression cases for the actual production bookings.
  it("REGRESSION 2122199: hold flow must produce isHeld=true (not the buggy isHeld=false)", () => {
    const result = deriveStateFromBookResponse(
      { Status: 1, VoucherStatus: false, BookingId: 2122199 },
      { isVoucherBookingRequest: false }
    );
    expect(result.status).toBe("HELD");
    expect(result.isHeld).toBe(true); // ← the bug we're fixing
  });
});

describe("deriveStateFromVoucherResponse", () => {
  it("ResponseStatus=1 → success + CONFIRMED+vouchered state", () => {
    const result = deriveStateFromVoucherResponse({
      ResponseStatus: 1,
      Error: { ErrorCode: 0, ErrorMessage: "" },
    });
    expect(result.success).toBe(true);
    expect(result.derivedOnSuccess).toEqual({
      status: "CONFIRMED",
      isHeld: false,
      isVouchered: true,
      voucherStatus: "GENERATED",
    });
  });

  it("ErrorCode=2 with 'balance insufficient' → isBalanceError=true", () => {
    const result = deriveStateFromVoucherResponse({
      ResponseStatus: 2,
      Error: { ErrorCode: 2, ErrorMessage: "Agency balance insufficient" },
    });
    expect(result.success).toBe(false);
    expect(result.isBalanceError).toBe(true);
    expect(result.isAlreadyGenerated).toBe(false);
  });

  it("ErrorCode=2 with 'already generated' → isAlreadyGenerated=true (NOT balance error)", () => {
    const result = deriveStateFromVoucherResponse({
      ResponseStatus: 2,
      Error: {
        ErrorCode: 2,
        ErrorMessage:
          "HotelVoucher already generated (InvoiceNumber: 2125574). Please call GetBookingDetail method to know get the status.",
      },
    });
    expect(result.success).toBe(false);
    expect(result.isAlreadyGenerated).toBe(true);
    expect(result.isBalanceError).toBe(false);
  });

  it("REGRESSION 2122164: 'already generated' must NOT be classified as balance error or generic failure", () => {
    const result = deriveStateFromVoucherResponse({
      ResponseStatus: 2,
      Error: {
        ErrorCode: 2,
        ErrorMessage:
          "HotelVoucher already generated (InvoiceNumber: 2125574). Please call GetBookingDetail method to know get the status.",
      },
    });
    // The current production code treats this as a generic failure and writes voucherStatus='FAILED'.
    // Sprint 2 will use this classification to call GetBookingDetail instead.
    expect(result.isAlreadyGenerated).toBe(true);
  });

  it("Generic ResponseStatus=2 with no specific ErrorCode → plain failure", () => {
    const result = deriveStateFromVoucherResponse({
      ResponseStatus: 2,
      Error: { ErrorCode: 99, ErrorMessage: "Some other error" },
    });
    expect(result.success).toBe(false);
    expect(result.isAlreadyGenerated).toBe(false);
    expect(result.isBalanceError).toBe(false);
  });
});
