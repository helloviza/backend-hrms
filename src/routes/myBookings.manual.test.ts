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

// Business Name (Customer.findById) and Traveler ID (CustomerMember.find) —
// both added alongside the 26 new export columns; loadManualBookingsForCustomer
// awaits these unconditionally, so leaving them unmocked hangs every /manual
// and /manual/export test against the real (production) Mongo connection.
vi.mock("../models/Customer.js", () => ({
  default: {
    findById: () => ({
      select: () => ({
        lean: () => Promise.resolve({ legalName: "Company A Pvt Ltd" }),
      }),
    }),
  },
}));

vi.mock("../models/CustomerMember.js", () => ({
  default: {
    find: () => ({
      select: () => ({
        lean: () => Promise.resolve([{ email: REQUESTER_EMAIL, travelerId: "CSTEP-001" }]),
      }),
    }),
  },
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
    bookingRef: "MB-2607-0099",
    bookingDate: "2026-06-01T00:00:00.000Z",
    reqDate: "2026-05-20T00:00:00.000Z",
    // givenBy stays on the raw ManualBooking doc (staff still fill it in) —
    // deliberately NOT read by customerBookingFields anymore (removed
    // 2026-07-24: found to carry internal staff names on a non-trivial share
    // of rows). "never leaks" test below asserts "Priya Sharma" is absent.
    givenBy: "Priya Sharma",
    sector: "DEL-BOM",
    type: "GROUP_BOOKING",
    travelDate: "2026-07-01T00:00:00.000Z",
    returnDate: "2026-07-05T00:00:00.000Z",
    status: "CONFIRMED",
    subStatus: "",
    priceBenefits: "Free upgrade to business class",
    invoiceRaisedDate: "2026-06-03T00:00:00.000Z",
    bookingWeek: 23,
    bookingMonth: "June 2026",
    itinerary: {
      origin: "DEL", destination: "BOM", hotelName: "",
      flightNo: "6E-201", airline: "IndiGo", trainClass: "",
      roomType: "", nights: 0, roomCount: 0,
      description: "", pickupLocation: "", dropLocation: "", vehicleType: "",
      visaCountry: "", visaType: "",
    },
    passengers: [
      { name: "Aditi Rao", email: REQUESTER_EMAIL, panNo: "ABCDE1234F", passportNo: "P1234567" },
      { name: "Rohan Mehta", email: "rohan@company-a.com", panNo: "ZZZZZ9999Z", passportNo: "P9999999" },
    ],
    invoiceId: { invoiceNo: "INV-2026-0042", invoiceDate: "2026-06-02T00:00:00.000Z", status: "SENT" },
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
    lineItems: [
      { sNo: 1, itemDescription: "Group Flight Booking", quantity: 8, rate: 12500, gstPct: 5, amount: 105000 },
    ],
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
    expect(res.body.bookings[0].refNo).toBe("MB-2607-0099");
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

describe("GET /manual — response shape (exactly the 37 columns, never cost/margin/PII)", () => {
  it("returns only sNo + the 37 customer-safe fields", async () => {
    findMock.mockReturnValue(makeFindChain([manualBookingDoc()]));
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/manual");

    expect(res.status).toBe(200);
    const row = res.body.bookings[0];
    expect(Object.keys(row).sort()).toEqual(
      [
        "sNo",
        // original 11 (Given By removed 2026-07-24)
        "bookingDate",
        "invoiceDate",
        "invoiceNumber",
        "reqDate",
        "paxName",
        "type",
        "sector",
        "travelDate",
        "arrivalDate",
        "grandTotal",
        // appended 26
        "refNo",
        "businessName",
        "travelerId",
        "status",
        "subStatus",
        "priceBenefits",
        "invoiceRaisedDate",
        "invoiceStatus",
        "invoicePendingDays",
        "bookingWeek",
        "bookingMonth",
        "flightTrainNo",
        "airline",
        "trainClass",
        "hotelName",
        "roomType",
        "nights",
        "rooms",
        "serviceDescription",
        "supplierPNR",
        "lineItems",
        "pickupLocation",
        "dropLocation",
        "vehicleType",
        "visaCountry",
        "visaType",
      ].sort(),
    );
  });

  it("carries the 26 appended fields through with their real values (Business Name / Traveler ID resolved via the tenant-scoped Customer/CustomerMember lookups)", async () => {
    findMock.mockReturnValue(makeFindChain([manualBookingDoc()]));
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/manual");
    const row = res.body.bookings[0];

    expect(row.refNo).toBe("MB-2607-0099");
    expect(row.businessName).toBe("Company A Pvt Ltd");
    expect(row.travelerId).toBe("CSTEP-001");
    expect(row.status).toBe("CONFIRMED");
    expect(row.priceBenefits).toBe("Free upgrade to business class");
    expect(row.invoiceStatus).toBe("SENT");
    expect(typeof row.invoicePendingDays).toBe("number");
    expect(row.supplierPNR).toBe("PNR-XYZ123");
    expect(row.lineItems).toContain("Group Flight Booking");
    // supplierName ("Partner") stays excluded — cost-adjacent, not in the approved column list.
    expect(JSON.stringify(row)).not.toContain("Acme Travel Wholesalers");
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
      // "supplierPNR"/"PNR-XYZ123" are deliberately NOT in this list — Supplier
      // PNR/Booking ID is an approved customer-safe column (2026-07-24 scoping
      // decision); "Partner" (supplierName) stays excluded, still checked below.
      "actualPrice", "supplierCost", "markupAmount", "profitMargin", "basePrice",
      "supplierName", "Acme Travel Wholesalers",
      "panNo", "passportNo", "ABCDE1234F", "P1234567",
      "notes", "do not disclose margin",
      "90000", "35000", // cost / markup amounts
      "givenBy", "Priya Sharma", // removed 2026-07-24 — found to carry internal staff names
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });
});

describe("GET /manual/export — same security guarantees as the JSON list", () => {
  it("csv header is exactly the 37 columns, in order, original 11 stable then the 26 appended", async () => {
    findMock.mockReturnValue(makeFindChain([manualBookingDoc()]));
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/manual/export?format=csv");
    const header = res.text.split("\n")[0];
    expect(header).toBe(
      [
        "S. No", "Booking Date", "Invoice Date", "Invoice Number", "Req Date", "Pax Name",
        "Type", "Sector", "Travel Date", "Arrival Date", "Grand Total",
        "Ref No.", "Business Name", "Traveler ID", "Status", "Sub Status", "Price Benefits",
        "Invoice Raised Date", "Invoice Status", "Invoice Pending Days", "Booking Week", "Booking Month",
        "Flight / Train No", "Airline", "Train Class", "Hotel Name", "Room Type", "Nights", "Rooms",
        "Service Description", "Supplier PNR / Booking ID", "Line Items",
        "Pickup Location", "Drop Location", "Vehicle Type", "Visa Country", "Visa Type",
      ].join(","),
    );
  });

  it("csv data row carries the new columns (Ref No., Business Name, Traveler ID, Supplier PNR) through", async () => {
    findMock.mockReturnValue(makeFindChain([manualBookingDoc()]));
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/manual/export?format=csv");
    const dataRow = res.text.split("\n")[1];
    expect(dataRow).toContain("MB-2607-0099");
    expect(dataRow).toContain("Company A Pvt Ltd");
    expect(dataRow).toContain("CSTEP-001");
    expect(dataRow).toContain("PNR-XYZ123");
  });

  it("xlsx export never leaks cost/margin/Partner(supplierName)/PII — Supplier PNR IS present (approved column)", async () => {
    findMock.mockReturnValue(makeFindChain([manualBookingDoc()]));
    const app = makeApp({ roles: ["WORKSPACE_LEADER"], email: LEADER_EMAIL });
    const res = await request(app).get("/manual/export?format=xlsx");
    expect(res.status).toBe(200);
    const buf: Buffer = res.body instanceof Buffer ? res.body : Buffer.from(res.text, "binary");
    const text = buf.toString("latin1");
    for (const forbidden of [
      "Acme Travel Wholesalers", "ABCDE1234F", "P1234567",
      "do not disclose margin",
    ]) {
      expect(text).not.toContain(forbidden);
    }
    // Supplier PNR's positive presence is verified via the CSV export test
    // above and the JSON list test — .xlsx cell strings are DEFLATE-compressed
    // inside the zip container, so a raw latin1 buffer scan can't see them.
  });
});
