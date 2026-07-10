// Route-level coverage for the customer-facing booking attachment endpoints
// (infra/audit/booking-attachments-customer-access-audit.md, section B): proves
// the routes actually call canCustomerAccessBookingAttachments and 404 a
// cross-company caller — not just the pure predicate in isolation, already
// covered by bookingCustomerAccess.test.ts.
//
// requireAuth / requireWorkspace are NOT part of this router (mounted by
// server.ts) — the test injects req.user / req.workspace directly, same
// approach as manualBookings.attachments.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

const findOneMock = vi.fn();
vi.mock("../models/ManualBooking.js", () => ({
  default: { findOne: (...args: any[]) => findOneMock(...args) },
}));

vi.mock("../models/TravelBooking.js", () => ({
  default: { find: () => ({ populate: () => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) }) }) }) }) },
}));

const presignMock = vi.fn().mockResolvedValue("https://signed.example.com/fake-url");
vi.mock("../utils/s3Presign.js", () => ({
  presignGetObject: (...args: any[]) => presignMock(...args),
}));

import express from "express";
import request from "supertest";
import router from "./myBookings.js";

const COMPANY_A_CUSTOMER_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const COMPANY_B_CUSTOMER_ID = "cccccccccccccccccccccccc";
const LEADER_EMAIL = "leader@company-a.com";
const REQUESTER_EMAIL = "traveller@company-a.com";

function makeApp(user: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    req.workspace = { customerId: COMPANY_A_CUSTOMER_ID };
    req.workspaceObjectId = "some-other-space-id-not-a-customer-id";
    next();
  });
  app.use("/", router);
  return app;
}

function makeQuery(result: any) {
  const query: any = {
    select: () => query,
    lean: () => Promise.resolve(result),
    then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
  };
  return query;
}

function ownCompanyBooking(overrides: any = {}) {
  return {
    _id: "booking00000000000000001",
    workspaceId: COMPANY_A_CUSTOMER_ID,
    passengers: [{ email: REQUESTER_EMAIL }],
    attachments: [
      {
        _id: "att0000000000000000001",
        type: "ticket",
        originalFilename: "ticket.pdf",
        size: 12345,
        mimeType: "application/pdf",
        uploadedBy: "staffer000000000000000001",
        uploadedAt: new Date().toISOString(),
        s3Key: "bookings/attachments/booking00000000000000001/ticket.pdf",
      },
    ],
    ...overrides,
  };
}

function otherCompanyBooking() {
  return ownCompanyBooking({ workspaceId: COMPANY_B_CUSTOMER_ID });
}

beforeEach(() => {
  findOneMock.mockReset();
  presignMock.mockClear();
});

describe("GET /:bookingRef/attachments — own company", () => {
  it("WORKSPACE_LEADER can list attachments for their own company's booking", async () => {
    findOneMock.mockReturnValue(makeQuery(ownCompanyBooking()));
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/MB-2607-0001/attachments");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.attachments).toHaveLength(1);
    // s3Key / uploadedBy must never reach the customer response.
    expect(res.body.attachments[0].s3Key).toBeUndefined();
    expect(res.body.attachments[0].uploadedBy).toBeUndefined();
    expect(res.body.attachments[0].originalFilename).toBe("ticket.pdf");
  });

  it("a plain traveller whose email matches a passenger can list attachments", async () => {
    findOneMock.mockReturnValue(makeQuery(ownCompanyBooking()));
    const app = makeApp({ roles: ["CUSTOMER"], email: REQUESTER_EMAIL.toUpperCase() });
    const res = await request(app).get("/MB-2607-0001/attachments");
    expect(res.status).toBe(200);
    expect(res.body.attachments).toHaveLength(1);
  });

  it("a plain traveller whose email does NOT match any passenger is denied", async () => {
    findOneMock.mockReturnValue(makeQuery(ownCompanyBooking()));
    const app = makeApp({ roles: ["CUSTOMER"], email: "stranger@company-a.com" });
    const res = await request(app).get("/MB-2607-0001/attachments");
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });
});

describe("GET /:bookingRef/attachments — cross-company denial", () => {
  it("404s a company-B booking for a company-A leader (not 403 — no existence leak)", async () => {
    findOneMock.mockReturnValue(makeQuery(otherCompanyBooking()));
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/MB-2607-0001/attachments");
    expect(res.status).toBe(404);
  });

  it("404s a company-B booking even when the passenger email happens to match", async () => {
    findOneMock.mockReturnValue(
      makeQuery(otherCompanyBooking()),
    );
    const app = makeApp({ roles: ["CUSTOMER"], email: REQUESTER_EMAIL });
    const res = await request(app).get("/MB-2607-0001/attachments");
    expect(res.status).toBe(404);
  });

  it("404s when the booking doesn't exist at all", async () => {
    findOneMock.mockReturnValue(makeQuery(null));
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/does-not-exist/attachments");
    expect(res.status).toBe(404);
  });
});

describe("GET /:bookingRef/attachments/:attId/url", () => {
  it("returns a presigned url for an authorized caller", async () => {
    findOneMock.mockReturnValue(makeQuery(ownCompanyBooking()));
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/MB-2607-0001/attachments/att0000000000000000001/url");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.url).toBe("https://signed.example.com/fake-url");
    expect(presignMock).toHaveBeenCalledTimes(1);
  });

  it("404s for a cross-company caller instead of presigning", async () => {
    findOneMock.mockReturnValue(makeQuery(otherCompanyBooking()));
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/MB-2607-0001/attachments/att0000000000000000001/url");
    expect(res.status).toBe(404);
    expect(presignMock).not.toHaveBeenCalled();
  });

  it("404s for an unknown attachment id on an owned booking", async () => {
    findOneMock.mockReturnValue(makeQuery(ownCompanyBooking()));
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/MB-2607-0001/attachments/doesnotexist/url");
    expect(res.status).toBe(404);
    expect(presignMock).not.toHaveBeenCalled();
  });
});
