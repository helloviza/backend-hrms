import { describe, it, expect } from "vitest";
import {
  canAccessBooking,
  isHouseCallerContext,
  HOUSE_CUSTOMER_ID,
  HOUSE_WORKSPACE_ID,
  type BookingAccessContext,
  type BookingAccessRecord,
} from "./bookingAccess.js";

// Non-HOUSE tenant ids used across tests — Customer._id / CustomerWorkspace._id
// space respectively, deliberately different from each other (mirrors real
// data: they're never numerically related).
const TENANT_A_CUSTOMER_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TENANT_A_WORKSPACE_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";
const TENANT_B_CUSTOMER_ID = "cccccccccccccccccccccccc";
const TENANT_B_WORKSPACE_ID = "dddddddddddddddddddddddd";

const CALLER_ID = "user000000000000000000001";
const OTHER_USER_ID = "user000000000000000000002";

function ctx(over: Partial<BookingAccessContext> = {}): BookingAccessContext {
  return {
    callerId: CALLER_ID,
    customerId: TENANT_A_CUSTOMER_ID,
    workspaceObjectId: TENANT_A_WORKSPACE_ID,
    permissionScope: "OWN",
    isSuperAdmin: false,
    ...over,
  };
}

function booking(over: Partial<BookingAccessRecord> = {}): BookingAccessRecord {
  return {
    workspaceId: TENANT_A_CUSTOMER_ID,
    createdBy: CALLER_ID,
    assignPerson: undefined,
    assignmentStatus: undefined,
    ...over,
  };
}

describe("isHouseCallerContext", () => {
  it("true when ctx.customerId is the HOUSE Customer._id", () => {
    expect(isHouseCallerContext(ctx({ customerId: HOUSE_CUSTOMER_ID, workspaceObjectId: "irrelevant" }))).toBe(true);
  });

  it("true when ctx.workspaceObjectId is the HOUSE CustomerWorkspace._id (customerId absent)", () => {
    expect(isHouseCallerContext(ctx({ customerId: null, workspaceObjectId: HOUSE_WORKSPACE_ID }))).toBe(true);
  });

  it("false for a non-HOUSE tenant", () => {
    expect(isHouseCallerContext(ctx({ customerId: TENANT_A_CUSTOMER_ID, workspaceObjectId: TENANT_A_WORKSPACE_ID }))).toBe(false);
  });
});

describe("canAccessBooking — SuperAdmin bypass", () => {
  it("SuperAdmin can access any booking regardless of tenant, READ", () => {
    const superCtx = ctx({ isSuperAdmin: true, customerId: null, workspaceObjectId: undefined, permissionScope: undefined });
    const otherTenantBooking = booking({ workspaceId: TENANT_B_CUSTOMER_ID, createdBy: OTHER_USER_ID });
    expect(canAccessBooking(superCtx, otherTenantBooking, "READ")).toBe(true);
  });

  it("SuperAdmin can access any booking regardless of tenant, WRITE", () => {
    const superCtx = ctx({ isSuperAdmin: true, customerId: null, workspaceObjectId: undefined, permissionScope: undefined });
    const otherTenantBooking = booking({ workspaceId: TENANT_B_CUSTOMER_ID, createdBy: OTHER_USER_ID });
    expect(canAccessBooking(superCtx, otherTenantBooking, "WRITE")).toBe(true);
  });
});

describe("canAccessBooking — HOUSE + ALL (preserved cross-tenant flow)", () => {
  it("HOUSE caller with scope=ALL can access another tenant's booking", () => {
    const houseCtx = ctx({ customerId: HOUSE_CUSTOMER_ID, workspaceObjectId: HOUSE_WORKSPACE_ID, permissionScope: "ALL" });
    const otherTenantBooking = booking({ workspaceId: TENANT_A_CUSTOMER_ID, createdBy: OTHER_USER_ID });
    expect(canAccessBooking(houseCtx, otherTenantBooking, "READ")).toBe(true);
    expect(canAccessBooking(houseCtx, otherTenantBooking, "WRITE")).toBe(true);
  });

  it("HOUSE caller with scope=ALL can access a HOUSE-tenant booking created by someone else", () => {
    const houseCtx = ctx({ customerId: HOUSE_CUSTOMER_ID, workspaceObjectId: HOUSE_WORKSPACE_ID, permissionScope: "ALL" });
    const houseBooking = booking({ workspaceId: HOUSE_CUSTOMER_ID, createdBy: OTHER_USER_ID });
    expect(canAccessBooking(houseCtx, houseBooking, "READ")).toBe(true);
  });
});

describe("canAccessBooking — non-HOUSE + ALL (THE FIX)", () => {
  it("non-HOUSE caller with scope=ALL CAN access their OWN tenant's booking", () => {
    const nonHouseAllCtx = ctx({
      customerId: TENANT_A_CUSTOMER_ID,
      workspaceObjectId: TENANT_A_WORKSPACE_ID,
      permissionScope: "ALL",
    });
    const ownTenantBooking = booking({ workspaceId: TENANT_A_CUSTOMER_ID, createdBy: OTHER_USER_ID });
    expect(canAccessBooking(nonHouseAllCtx, ownTenantBooking, "READ")).toBe(true);
  });

  it("non-HOUSE caller with scope=ALL CANNOT access another tenant's booking (READ) — the fix for the 3 flagged accounts", () => {
    const nonHouseAllCtx = ctx({
      customerId: TENANT_A_CUSTOMER_ID,
      workspaceObjectId: TENANT_A_WORKSPACE_ID,
      permissionScope: "ALL",
    });
    const otherTenantBooking = booking({ workspaceId: TENANT_B_CUSTOMER_ID, createdBy: OTHER_USER_ID });
    expect(canAccessBooking(nonHouseAllCtx, otherTenantBooking, "READ")).toBe(false);
  });

  it("non-HOUSE caller with scope=ALL CANNOT access another tenant's booking (WRITE) — PUT /:id had zero check before this fix", () => {
    const nonHouseAllCtx = ctx({
      customerId: TENANT_A_CUSTOMER_ID,
      workspaceObjectId: TENANT_A_WORKSPACE_ID,
      permissionScope: "ALL",
    });
    const otherTenantBooking = booking({ workspaceId: TENANT_B_CUSTOMER_ID, createdBy: OTHER_USER_ID });
    expect(canAccessBooking(nonHouseAllCtx, otherTenantBooking, "WRITE")).toBe(false);
  });
});

describe("canAccessBooking — creator / assignee / intake carve-outs", () => {
  it("creator can access their own booking (non-ALL scope, own tenant)", () => {
    const creatorCtx = ctx({ callerId: CALLER_ID, permissionScope: "OWN" });
    const ownBooking = booking({ workspaceId: TENANT_A_CUSTOMER_ID, createdBy: CALLER_ID });
    expect(canAccessBooking(creatorCtx, ownBooking, "READ")).toBe(true);
  });

  it("non-creator, non-assignee CANNOT access another user's booking in their own tenant (non-ALL scope)", () => {
    const callerCtx = ctx({ callerId: CALLER_ID, permissionScope: "OWN" });
    const someoneElsesBooking = booking({ workspaceId: TENANT_A_CUSTOMER_ID, createdBy: OTHER_USER_ID });
    expect(canAccessBooking(callerCtx, someoneElsesBooking, "READ")).toBe(false);
  });

  it("assignee can access a HOUSE booking assigned to them", () => {
    const assigneeCtx = ctx({
      callerId: CALLER_ID,
      customerId: HOUSE_CUSTOMER_ID,
      workspaceObjectId: HOUSE_WORKSPACE_ID,
      permissionScope: "OWN",
    });
    const assignedBooking = booking({
      workspaceId: HOUSE_CUSTOMER_ID,
      createdBy: "system-intake-user-id",
      assignPerson: CALLER_ID,
      assignmentStatus: "ASSIGNED",
    });
    expect(canAccessBooking(assigneeCtx, assignedBooking, "READ")).toBe(true);
  });

  it("HOUSE PENDING_TO_ASSIGN intake row is visible to any HOUSE staffer (triage carve-out)", () => {
    const triageStaffCtx = ctx({
      callerId: CALLER_ID,
      customerId: HOUSE_CUSTOMER_ID,
      workspaceObjectId: HOUSE_WORKSPACE_ID,
      permissionScope: "OWN",
    });
    const intakeRow = booking({
      workspaceId: HOUSE_CUSTOMER_ID,
      createdBy: "system-intake-user-id",
      assignmentStatus: "PENDING_TO_ASSIGN",
    });
    expect(canAccessBooking(triageStaffCtx, intakeRow, "READ")).toBe(true);
  });

  it("PENDING_TO_ASSIGN carve-out does NOT apply outside HOUSE tenant", () => {
    const nonHouseStaffCtx = ctx({
      callerId: CALLER_ID,
      customerId: TENANT_A_CUSTOMER_ID,
      workspaceObjectId: TENANT_A_WORKSPACE_ID,
      permissionScope: "OWN",
    });
    const nonHouseIntakeLikeRow = booking({
      workspaceId: TENANT_A_CUSTOMER_ID,
      createdBy: "someone-else",
      assignmentStatus: "PENDING_TO_ASSIGN",
    });
    expect(canAccessBooking(nonHouseStaffCtx, nonHouseIntakeLikeRow, "READ")).toBe(false);
  });
});

describe("canAccessBooking — dual-space tenant match (Inteletek case)", () => {
  it("a booking whose workspaceId is the caller's CustomerWorkspace._id (not Customer._id) is still accessible to that tenant's own ALL-scope user", () => {
    const tenantACtx = ctx({
      customerId: TENANT_A_CUSTOMER_ID,
      workspaceObjectId: TENANT_A_WORKSPACE_ID,
      permissionScope: "ALL",
    });
    // Mirrors the real 26-row prod anomaly: workspaceId holds the
    // CustomerWorkspace._id instead of the Customer._id.
    const legacyMiswrittenBooking = booking({ workspaceId: TENANT_A_WORKSPACE_ID, createdBy: OTHER_USER_ID });
    expect(canAccessBooking(tenantACtx, legacyMiswrittenBooking, "READ")).toBe(true);
  });

  it("dual-space fallback does NOT let a DIFFERENT tenant's user through", () => {
    const tenantBCtx = ctx({
      customerId: TENANT_B_CUSTOMER_ID,
      workspaceObjectId: TENANT_B_WORKSPACE_ID,
      permissionScope: "ALL",
    });
    // Tenant A's mis-written booking — Tenant B must not match either space.
    const tenantAsLegacyBooking = booking({ workspaceId: TENANT_A_WORKSPACE_ID, createdBy: OTHER_USER_ID });
    expect(canAccessBooking(tenantBCtx, tenantAsLegacyBooking, "READ")).toBe(false);
  });

  it("creator's own booking still resolves via dual-space match even at non-ALL scope", () => {
    const tenantACtx = ctx({
      callerId: CALLER_ID,
      customerId: TENANT_A_CUSTOMER_ID,
      workspaceObjectId: TENANT_A_WORKSPACE_ID,
      permissionScope: "OWN",
    });
    const ownLegacyMiswrittenBooking = booking({ workspaceId: TENANT_A_WORKSPACE_ID, createdBy: CALLER_ID });
    expect(canAccessBooking(tenantACtx, ownLegacyMiswrittenBooking, "READ")).toBe(true);
  });
});

describe("canAccessBooking — populated Mongoose refs are unwrapped", () => {
  it("handles a populated workspaceId ({_id: ...}) the same as a raw id string", () => {
    const nonHouseAllCtx = ctx({
      customerId: TENANT_A_CUSTOMER_ID,
      workspaceObjectId: TENANT_A_WORKSPACE_ID,
      permissionScope: "ALL",
    });
    const populatedBooking = booking({
      workspaceId: { _id: TENANT_A_CUSTOMER_ID, name: "Some Workspace" },
      createdBy: OTHER_USER_ID,
    });
    expect(canAccessBooking(nonHouseAllCtx, populatedBooking, "READ")).toBe(true);
  });

  it("denies a populated workspaceId belonging to a different tenant", () => {
    const nonHouseAllCtx = ctx({
      customerId: TENANT_A_CUSTOMER_ID,
      workspaceObjectId: TENANT_A_WORKSPACE_ID,
      permissionScope: "ALL",
    });
    const populatedBooking = booking({
      workspaceId: { _id: TENANT_B_CUSTOMER_ID, name: "Some Other Workspace" },
      createdBy: OTHER_USER_ID,
    });
    expect(canAccessBooking(nonHouseAllCtx, populatedBooking, "READ")).toBe(false);
  });
});
