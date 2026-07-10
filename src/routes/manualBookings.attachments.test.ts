// Endpoint-level coverage for the ticket/voucher attachment routes
// (infra/audit/manual-bookings-voucher-upload-audit.md): proves the routes
// themselves — not just the canAccessBooking predicate in isolation, already
// fully covered by bookingAccess.test.ts — actually call canAccessBooking and
// 403 a cross-tenant caller, the same way GET/PUT/:id do post-fix.
//
// requireAuth / requirePermission (the coarse, module-level gates) are
// mocked to pass-through: this test isolates the FINE, per-record gate
// (canAccessBooking, used for real, not mocked) that governs attachment
// access. ManualBooking.findById is mocked to avoid needing a live Mongo —
// same rationale as bookingAccess.test.ts's no-DB approach, just applied at
// the route layer instead of the pure-function layer.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

const findByIdMock = vi.fn();
vi.mock("../models/ManualBooking.js", () => ({
  default: { findById: (...args: any[]) => findByIdMock(...args) },
}));

import express from "express";
import request from "supertest";
import router from "./manualBookings.js";

const TENANT_A_CUSTOMER_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TENANT_A_WORKSPACE_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";
const TENANT_B_CUSTOMER_ID = "cccccccccccccccccccccccc";

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  // Real caller identity, real (non-HOUSE, non-SuperAdmin) tenant, real
  // "ALL" permission scope — mirrors the 3 flagged accounts from
  // infra/audit/manual-bookings-access-verification.md exactly.
  req.user = { _id: "caller000000000000000001", roles: ["TENANT_ADMIN"] };
  req.workspace = { customerId: TENANT_A_CUSTOMER_ID };
  req.workspaceObjectId = TENANT_A_WORKSPACE_ID;
  req.permissionScope = "ALL";
  next();
});
app.use("/", router);

// Chainable + thenable fake Mongoose Query — supports both
// `await Model.findById(id)` (POST/DELETE routes) and
// `await Model.findById(id).select(...).lean()` (GET routes).
function makeQuery(result: any) {
  const query: any = {
    select: () => query,
    lean: () => Promise.resolve(result),
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
  };
  return query;
}

function crossTenantBooking() {
  return {
    _id: "booking00000000000000001",
    workspaceId: TENANT_B_CUSTOMER_ID, // a DIFFERENT tenant from the caller
    createdBy: "someone-else",
    assignPerson: undefined,
    assignmentStatus: undefined,
    attachments: [{ _id: "att0000000000000000001", type: "ticket", originalFilename: "x.pdf", s3Key: "bookings/attachments/booking1/x.pdf" }],
  };
}

function ownTenantBooking() {
  return {
    _id: "booking00000000000000002",
    workspaceId: TENANT_A_CUSTOMER_ID, // the caller's OWN tenant
    createdBy: "caller000000000000000001",
    assignPerson: undefined,
    assignmentStatus: undefined,
    attachments: [],
  };
}

beforeEach(() => {
  findByIdMock.mockReset();
});

describe("attachment endpoints — cross-tenant caller is rejected via canAccessBooking", () => {
  it("POST /:id/attachments — 403 for a cross-tenant booking", async () => {
    findByIdMock.mockReturnValue(makeQuery(crossTenantBooking()));
    const res = await request(app)
      .post("/booking00000000000000001/attachments")
      .field("type", "ticket")
      .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "ticket.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(403);
  });

  it("GET /:id/attachments — 403 for a cross-tenant booking", async () => {
    findByIdMock.mockReturnValue(makeQuery(crossTenantBooking()));
    const res = await request(app).get("/booking00000000000000001/attachments");
    expect(res.status).toBe(403);
  });

  it("GET /:id/attachments/:attId/url — 403 for a cross-tenant booking", async () => {
    findByIdMock.mockReturnValue(makeQuery(crossTenantBooking()));
    const res = await request(app).get("/booking00000000000000001/attachments/att0000000000000000001/url");
    expect(res.status).toBe(403);
  });

  it("DELETE /:id/attachments/:attId — 403 for a cross-tenant booking", async () => {
    findByIdMock.mockReturnValue(makeQuery(crossTenantBooking()));
    const res = await request(app).delete("/booking00000000000000001/attachments/att0000000000000000001");
    expect(res.status).toBe(403);
  });

  it("404s (not 403) when the booking itself doesn't exist, regardless of tenant", async () => {
    findByIdMock.mockReturnValue(makeQuery(null));
    const res = await request(app).get("/doesnotexist/attachments");
    expect(res.status).toBe(404);
  });
});

describe("attachment endpoints — same-tenant caller is NOT rejected", () => {
  it("GET /:id/attachments — not a 403 for the caller's own tenant", async () => {
    findByIdMock.mockReturnValue(makeQuery(ownTenantBooking()));
    const res = await request(app).get("/booking00000000000000002/attachments");
    expect(res.status).not.toBe(403);
    expect(res.status).toBe(200);
    expect(res.body.attachments).toEqual([]);
  });
});
