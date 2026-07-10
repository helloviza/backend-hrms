import { describe, it, expect } from "vitest";
import {
  canCustomerAccessBookingAttachments,
  type CustomerBookingAccessContext,
  type CustomerBookingAccessRecord,
} from "./bookingCustomerAccess.js";

// Customer._id space — deliberately unrelated-looking strings for A vs B, and
// deliberately a DIFFERENT-looking string still for "the CustomerWorkspace._id
// that must NOT be mistaken for a Customer._id" (F1 regression guard).
const COMPANY_A_CUSTOMER_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const COMPANY_A_WORKSPACE_OBJECT_ID = "bbbbbbbbbbbbbbbbbbbbbbbb"; // CustomerWorkspace._id space
const COMPANY_B_CUSTOMER_ID = "cccccccccccccccccccccccc";

const LEADER_EMAIL = "leader@company-a.com";
const REQUESTER_EMAIL = "traveller@company-a.com";

function ctx(over: Partial<CustomerBookingAccessContext> = {}): CustomerBookingAccessContext {
  return {
    customerId: COMPANY_A_CUSTOMER_ID,
    isOrgScope: false,
    email: REQUESTER_EMAIL,
    ...over,
  };
}

function booking(over: Partial<CustomerBookingAccessRecord> = {}): CustomerBookingAccessRecord {
  return {
    workspaceId: COMPANY_A_CUSTOMER_ID,
    passengers: [{ email: REQUESTER_EMAIL }],
    ...over,
  };
}

describe("canCustomerAccessBookingAttachments — own company", () => {
  it("ORG scope (leader/approver) is allowed regardless of passenger emails", () => {
    const leaderCtx = ctx({ isOrgScope: true, email: LEADER_EMAIL });
    const b = booking({ passengers: [{ email: "someone-else@company-a.com" }] });
    expect(canCustomerAccessBookingAttachments(leaderCtx, b)).toBe(true);
  });

  it("ORG scope is allowed even with no passengers at all", () => {
    const leaderCtx = ctx({ isOrgScope: true });
    const b = booking({ passengers: [] });
    expect(canCustomerAccessBookingAttachments(leaderCtx, b)).toBe(true);
  });

  it("non-ORG caller is allowed when their login email matches a passenger email (case-insensitive)", () => {
    const b = booking({ passengers: [{ email: REQUESTER_EMAIL.toUpperCase() }] });
    expect(canCustomerAccessBookingAttachments(ctx({ email: REQUESTER_EMAIL }), b)).toBe(true);
  });

  it("non-ORG caller is denied when their email matches no passenger", () => {
    const b = booking({ passengers: [{ email: "nobody@company-a.com" }] });
    expect(canCustomerAccessBookingAttachments(ctx({ isOrgScope: false, email: REQUESTER_EMAIL }), b)).toBe(false);
  });

  it("non-ORG caller is denied when the booking has no passengers", () => {
    const b = booking({ passengers: [] });
    expect(canCustomerAccessBookingAttachments(ctx({ isOrgScope: false }), b)).toBe(false);
  });

  it("non-ORG caller with no login email on the context is denied (fail closed)", () => {
    const b = booking();
    expect(canCustomerAccessBookingAttachments(ctx({ isOrgScope: false, email: null }), b)).toBe(false);
  });
});

describe("canCustomerAccessBookingAttachments — cross-company denial (F10/F1 regression guard)", () => {
  it("a company-B booking is denied to a company-A ORG-scope caller", () => {
    const leaderCtx = ctx({ isOrgScope: true, customerId: COMPANY_A_CUSTOMER_ID });
    const otherCompanyBooking = booking({ workspaceId: COMPANY_B_CUSTOMER_ID });
    expect(canCustomerAccessBookingAttachments(leaderCtx, otherCompanyBooking)).toBe(false);
  });

  it("a company-B booking is denied even when the passenger email happens to match", () => {
    const otherCompanyBooking = booking({
      workspaceId: COMPANY_B_CUSTOMER_ID,
      passengers: [{ email: REQUESTER_EMAIL }],
    });
    expect(canCustomerAccessBookingAttachments(ctx({ email: REQUESTER_EMAIL }), otherCompanyBooking)).toBe(false);
  });

  it("F1 guard: comparing against workspaceObjectId (CustomerWorkspace._id) instead of customerId must NOT accidentally allow access", () => {
    // Simulates the exact miscoding risk flagged in the audit: if a caller's
    // context were (wrongly) built from workspaceObjectId instead of
    // req.workspace.customerId, the tenant gate must still fail rather than
    // silently matching in the wrong id space.
    const wronglyBuiltCtx = ctx({ customerId: COMPANY_A_WORKSPACE_OBJECT_ID, isOrgScope: true });
    const b = booking({ workspaceId: COMPANY_A_CUSTOMER_ID });
    expect(canCustomerAccessBookingAttachments(wronglyBuiltCtx, b)).toBe(false);
  });

  it("missing ctx.customerId denies access even for an ORG-scope caller (fail closed)", () => {
    const leaderCtx = ctx({ isOrgScope: true, customerId: null });
    expect(canCustomerAccessBookingAttachments(leaderCtx, booking())).toBe(false);
  });

  it("missing booking.workspaceId denies access (fail closed)", () => {
    const b = booking({ workspaceId: undefined });
    expect(canCustomerAccessBookingAttachments(ctx({ isOrgScope: true }), b)).toBe(false);
  });
});
