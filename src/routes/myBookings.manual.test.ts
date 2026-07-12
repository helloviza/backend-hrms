// Route-level coverage for the customer-facing Manual (concierge) bookings
// table + export (GET /manual, GET /manual/export) — see
// infra/audit/customer-bookings-export-audit.md. Proves:
//   1. the routes re-run canCustomerAccessBookingAttachments() per record —
//      even if ManualBooking.find() somehow returned rows for another
//      company (simulating a filter bug), those rows never reach the
//      response (there's no client-suppliable id to attack here, so this is
//      the meaningful cross-tenant-denial test for a list/export endpoint);
//   2. OWN-scope (non-leader) email matching mirrors the attachment routes;
//   3. the response/export row NEVER carries cost/margin/PII fields, even
//      when the underlying ManualBooking doc has them.
//
// requireAuth / requireWorkspace are NOT part of this router (mounted by
// server.ts) — the test injects req.user / req.workspace directly, same
// approach as myBookings.attachments.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";

function makeFindChain(result: any[]) {
  const chain: any = {
    select: () => chain,
    populate: () => chain,
    sort: () => chain,
    limit: () => chain,
    lean: () => Promise.resolve(result),
  };
  return chain;
}

const findMock = vi.fn();
vi.mock("../models/ManualBooking.js", () => ({
  default: { find: (...args: any[]) => findMock(...args) },
}));

vi.mock("../models/TravelBooking.js", () => ({
  default: { find: () => ({ populate: () => ({ sort: () => ({ limit: () => ({ lean: () => ({ exec: () => Promise.resolve([]) }) }) }) }) }) },
}));

vi.mock("../utils/s3Presign.js", () => ({
  presignGetObject: vi.fn().mockResolvedValue("https://signed.example.com/fake-url"),
}));

import express from "express";
import request from "supertest";
import router from "./myBookings.js";

const COMPANY_A_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";
const COMPANY_B_ID = "cccccccccccccccccccccccc";
const LEADER_EMAIL = "leader@company-a.com";
const REQUESTER_EMAIL = "traveller@company-a.com";

function makeApp(user: any) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = user;
    req.workspace = { customerId: COMPANY_A_ID };
    req.workspaceObjectId = "some-other-space-id-not-a-customer-id";
    next();
  });
  app.use("/", router);
  return app;
}

// A "dirty" doc set — as if the Mongo tenant filter had a bug and let a
// company-B row through alongside a legitimate company-A one. The route must
// still filter it out via the per-record predicate.
function manualBookingDoc(overrides: any = {}) {
  return {
    _id: "mb0000000000000000000001",
    workspaceId: COMPANY_A_ID,
    bookingDate: "2026-06-01T00:00:00.000Z",
    reqDate: "2026-05-20T00:00:00.000Z",
    givenBy: "Priya Sharma",
    sector: "DEL-BOM",
    type: "GROUP_BOOKING",
    travelDate: "2026-07-01T00:00:00.000Z",
    returnDate: "2026-07-05T00:00:00.000Z",
    itinerary: { origin: "DEL", destination: "BOM", hotelName: "" },
    passengers: [
      { name: "Aditi Rao", email: REQUESTER_EMAIL, panNo: "ABCDE1234F", passportNo: "P1234567" },
      { name: "Rohan Mehta", email: "rohan@company-a.com", panNo: "ZZZZZ9999Z", passportNo: "P9999999" },
    ],
    invoiceId: { invoiceNo: "INV-2026-0042", invoiceDate: "2026-06-02T00:00:00.000Z" },
    pricing: {
      grandTotal: 125000,
      totalWithGST: 125000,
      quotedPrice: 125000,
      actualPrice: 90000,
      supplierCost: 90000,
      markupAmount: 35000,
      profitMargin: 28,
      basePrice: 105932,
    },
    supplierName: "Acme Travel Wholesalers",
    supplierPNR: "PNR-XYZ123",
    notes: "Client requested window seats, do not disclose margin to client.",
    ...overrides,
  };
}

beforeEach(() => {
  findMock.mockReset();
});

describe("GET /manual — cross-tenant denial (defense-in-depth, no trusted ids)", () => {
  it("drops a company-B row even if the Mongo query somehow returned it", async () => {
    const ownRow = manualBookingDoc();
    const otherCompanyRow = manualBookingDoc({
      _id: "mb0000000000000000000002",
      workspaceId: COMPANY_B_ID,
      passengers: [{ name: "Stranger", email: "stranger@company-b.com" }],
    });
    findMock.mockReturnValue(makeFindChain([ownRow, otherCompanyRow]));

    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/manual");

    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
    expect(res.body.bookings[0].givenBy).toBe("Priya Sharma");
  });

  it("GET /manual/export?format=csv also drops the company-B row", async () => {
    const ownRow = manualBookingDoc();
    const otherCompanyRow = manualBookingDoc({
      _id: "mb0000000000000000000002",
      workspaceId: COMPANY_B_ID,
      passengers: [{ name: "Stranger", email: "stranger@company-b.com" }],
    });
    findMock.mockReturnValue(makeFindChain([ownRow, otherCompanyRow]));

    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/manual/export?format=csv");

    expect(res.status).toBe(200);
    const rows = res.text.trim().split("\n");
    // header + exactly 1 data row (company-B row excluded)
    expect(rows).toHaveLength(2);
    expect(res.text).not.toContain("Stranger");
  });
});

describe("GET /manual — OWN-scope email matching (mirrors attachment routes, not the userId list filter)", () => {
  it("a plain traveller whose email matches a passenger sees the booking", async () => {
    findMock.mockReturnValue(makeFindChain([manualBookingDoc()]));
    const app = makeApp({ roles: ["CUSTOMER"], email: REQUESTER_EMAIL.toUpperCase() });
    const res = await request(app).get("/manual");
    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(1);
  });

  it("a plain traveller whose email matches NO passenger sees nothing", async () => {
    findMock.mockReturnValue(makeFindChain([manualBookingDoc()]));
    const app = makeApp({ roles: ["CUSTOMER"], email: "stranger@company-a.com" });
    const res = await request(app).get("/manual");
    expect(res.status).toBe(200);
    expect(res.body.bookings).toHaveLength(0);
  });
});

describe("GET /manual — response shape (exactly the 12 columns, never cost/margin/PII)", () => {
  it("returns only sNo + the 12 customer-safe fields", async () => {
    findMock.mockReturnValue(makeFindChain([manualBookingDoc()]));
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/manual");

    expect(res.status).toBe(200);
    const row = res.body.bookings[0];
    expect(Object.keys(row).sort()).toEqual(
      [
        "arrivalDate",
        "bookingDate",
        "givenBy",
        "invoiceDate",
        "invoiceNumber",
        "paxName",
        "reqDate",
        "sNo",
        "sector",
        "type",
        "travelDate",
        "grandTotal",
      ].sort(),
    );
  });

  it("Pax Name is the FULL passenger list, not the mirror's truncated lead+N", async () => {
    findMock.mockReturnValue(makeFindChain([manualBookingDoc()]));
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/manual");
    expect(res.body.bookings[0].paxName).toBe("Aditi Rao | Rohan Mehta");
  });

  it("Type is the real ManualBooking.type value (GROUP_BOOKING), not a collapsed mirror value", async () => {
    findMock.mockReturnValue(makeFindChain([manualBookingDoc()]));
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/manual");
    expect(res.body.bookings[0].type).toBe("GROUP_BOOKING");
  });

  it("never leaks cost/margin/supplier/PII, even though the source doc carries them", async () => {
    findMock.mockReturnValue(makeFindChain([manualBookingDoc()]));
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/manual");

    const raw = JSON.stringify(res.body);
    for (const forbidden of [
      "actualPrice", "supplierCost", "markupAmount", "profitMargin", "basePrice",
      "supplierName", "supplierPNR", "Acme Travel Wholesalers", "PNR-XYZ123",
      "panNo", "passportNo", "ABCDE1234F", "P1234567",
      "notes", "do not disclose margin",
      "90000", "35000", // cost / markup amounts
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});

describe("GET /manual/export — same security guarantees as the JSON list", () => {
  it("csv header is exactly the 12 requested columns, in order", async () => {
    findMock.mockReturnValue(makeFindChain([manualBookingDoc()]));
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/manual/export?format=csv");
    const header = res.text.split("\n")[0];
    expect(header).toBe(
      "S. No,Booking Date,Invoice Date,Invoice Number,Req Date,Pax Name,Given By,Type,Sector,Travel Date,Arrival Date,Grand Total",
    );
  });

  it("xlsx export never leaks cost/margin/supplier/PII", async () => {
    findMock.mockReturnValue(makeFindChain([manualBookingDoc()]));
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/manual/export?format=xlsx");
    expect(res.status).toBe(200);
    const buf: Buffer = res.body instanceof Buffer ? res.body : Buffer.from(res.text, "binary");
    const text = buf.toString("latin1");
    for (const forbidden of [
      "Acme Travel Wholesalers", "PNR-XYZ123", "ABCDE1234F", "P1234567",
      "do not disclose margin",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });
});
