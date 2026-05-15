import { describe, it, expect } from "vitest";
import { deriveStateFromBookingDetail } from "./deferred-status-check.js";

// TBO GetBookingDetail response stub for a CityMax-shaped hotel booking.
// Only the fields the mapper reads are populated; the rest is intentionally absent.
function makeDetail(over: Partial<{
  HotelBookingStatus: string;
  Status: number;
  VoucherStatus: boolean;
}>) {
  return {
    HotelBookingStatus: over.HotelBookingStatus ?? "Confirmed",
    Status: over.Status ?? 1,
    VoucherStatus: over.VoucherStatus ?? false,
  };
}

describe("deriveStateFromBookingDetail", () => {
  // (a) TBO confirmed + voucher=true → CONFIRMED in our system.
  it("VoucherStatus=true → CONFIRMED + vouchered, regardless of claimed status", () => {
    const out = deriveStateFromBookingDetail(
      makeDetail({ HotelBookingStatus: "Confirmed", Status: 1, VoucherStatus: true }),
      "HELD",
    );
    expect(out).toEqual({
      derivedStatus: "CONFIRMED",
      derivedIsHeld: false,
      derivedIsVouchered: true,
      derivedVoucherStatus: "GENERATED",
    });
  });

  // (b) TBO confirmed + voucher=false + claimed HELD → preserve HELD.
  it("Status=Confirmed + VoucherStatus=false + claimed HELD → preserve HELD", () => {
    const out = deriveStateFromBookingDetail(
      makeDetail({ HotelBookingStatus: "Confirmed", Status: 1, VoucherStatus: false }),
      "HELD",
    );
    expect(out).toEqual({
      derivedStatus: "HELD",
      derivedIsHeld: true,
      derivedIsVouchered: false,
      derivedVoucherStatus: null,
    });
  });

  // (c) TBO confirmed + voucher=false + claimed PENDING → preserve PENDING (spec 1987).
  it("Status=Confirmed + VoucherStatus=false + claimed PENDING → preserve PENDING", () => {
    const out = deriveStateFromBookingDetail(
      makeDetail({ HotelBookingStatus: "Confirmed", Status: 1, VoucherStatus: false }),
      "PENDING",
    );
    expect(out).toEqual({
      derivedStatus: "PENDING",
      derivedIsHeld: false,
      derivedIsVouchered: false,
      derivedVoucherStatus: "PENDING",
    });
  });

  // (d.1) BookFailed.
  it("Status=0 / BookFailed → FAILED", () => {
    const out = deriveStateFromBookingDetail(
      makeDetail({ HotelBookingStatus: "BookFailed", Status: 0, VoucherStatus: false }),
      "PENDING",
    );
    expect(out.derivedStatus).toBe("FAILED");
  });

  // (d.2) Cancelled — spec line 2030 says enum=6.
  it("Status=6 / Cancelled → CANCELLED", () => {
    const out = deriveStateFromBookingDetail(
      makeDetail({ HotelBookingStatus: "Cancelled", Status: 6, VoucherStatus: false }),
      "CONFIRMED",
    );
    expect(out.derivedStatus).toBe("CANCELLED");
  });

  // Defensive: Confirmed + VoucherStatus=false + claimed CONFIRMED (e.g., already corrupted)
  // → re-mark HELD so the Generate Voucher flow works again.
  it("Status=Confirmed + VoucherStatus=false + claimed CONFIRMED (corrupted) → defensively HELD", () => {
    const out = deriveStateFromBookingDetail(
      makeDetail({ HotelBookingStatus: "Confirmed", Status: 1, VoucherStatus: false }),
      "CONFIRMED",
    );
    expect(out).toEqual({
      derivedStatus: "HELD",
      derivedIsHeld: true,
      derivedIsVouchered: false,
      derivedVoucherStatus: null,
    });
  });

  // VerifyPrice — TBO Status=3 means price changed. Treated as FAILED so the FE re-prebooks.
  it("Status=3 / VerifyPrice → FAILED (frontend re-prebooks)", () => {
    const out = deriveStateFromBookingDetail(
      makeDetail({ HotelBookingStatus: "", Status: 3, VoucherStatus: false }),
      "PENDING",
    );
    expect(out.derivedStatus).toBe("FAILED");
  });

  // Defensive: "Vouchered" string variant (rare).
  it('HotelBookingStatus="Vouchered" → CONFIRMED + vouchered', () => {
    const out = deriveStateFromBookingDetail(
      { HotelBookingStatus: "Vouchered", Status: 1, VoucherStatus: false },
      "HELD",
    );
    expect(out).toEqual({
      derivedStatus: "CONFIRMED",
      derivedIsHeld: false,
      derivedIsVouchered: true,
      derivedVoucherStatus: "GENERATED",
    });
  });

  // Unknown / empty response — return all nulls so the caller no-ops the status write.
  it("unrecognized response → all nulls (no status change)", () => {
    const out = deriveStateFromBookingDetail(
      { HotelBookingStatus: "Mystery", Status: 99, VoucherStatus: false },
      "HELD",
    );
    expect(out).toEqual({
      derivedStatus: null,
      derivedIsHeld: null,
      derivedIsVouchered: null,
      derivedVoucherStatus: null,
    });
  });
});
