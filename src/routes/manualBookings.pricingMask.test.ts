// Internal-money masking for /admin/manual-bookings — list AND export.
//
// What is being protected: OUR cost and OUR margin. The customer's own number
// (quotedPrice / grandTotal / gstAmount) is not secret and must keep shipping
// to everyone — a mask that also hid the sell price would just break the page.
//
// Unlike manualBookings.filters.test.ts, this file needs the mocked model to
// RETURN a document: the assertion is about the shape of the outgoing object,
// not about the query that fetched it.
//
// NO DATABASE — apps/backend/.env points MONGO_URI at PROD Atlas. Every model
// and requirePermission is mocked.
import { describe, it, expect, vi } from "vitest";
import mongoose from "mongoose";
import { HOUSE_CUSTOMER_ID, HOUSE_WORKSPACE_ID } from "../utils/bookingAccess.js";

/** The fields that must never reach an unprivileged caller. */
const WITHHELD = ["supplierCost", "actualPrice", "markupAmount", "profitMargin", "basePrice", "diff"];

const FIXTURE = {
  _id: new mongoose.Types.ObjectId(),
  bookingRef: "MB-TEST-0001",
  status: "CONFIRMED",
  type: "FLIGHT",
  workspaceId: new mongoose.Types.ObjectId(),
  passengers: [{ name: "A Traveller", panNo: "ABCDE1234F", passportNo: "Z1234567" }],
  pricing: {
    quotedPrice: 50000,
    sellingPrice: 50000,
    grandTotal: 59000,
    gstAmount: 9000,
    // ── everything below is internal ──
    supplierCost: 42000,
    actualPrice: 42000,
    markupAmount: 8000,
    profitMargin: 16,
    basePrice: 8000,
    diff: 8000,
  },
  lineItems: [
    { sNo: 1, itemDescription: "Fare", quantity: 1, quotedRate: 50000, actualRate: 42000, gstAmount: 9000, amount: 59000 },
  ],
};

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  default: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requirePermission.js", () => ({
  // ALL scope + FULL access for EVERY caller in this file. That is the point:
  // it proves the mask is decided by SuperAdmin/HOUSE and NOT by scope, so a
  // tenant admin holding ALL within their own workspace still gets nothing.
  requirePermission: () => (req: any, _res: any, next: any) => {
    req.permissionScope = "ALL";
    req.permissionAccess = "FULL";
    next();
  },
  requireAnyPermission: () => (_req: any, _res: any, next: any) => next(),
}));

vi.mock("../models/ManualBooking.js", async () => {
  const actual: any = await vi.importActual("../models/ManualBooking.js");
  const chain = (): any => {
    const node: any = {
      sort: () => node, skip: () => node, limit: () => node, populate: () => node,
      lean: () => Promise.resolve([{ ...FIXTURE }]),
      then: (r: any, j: any) => Promise.resolve([{ ...FIXTURE }]).then(r, j),
    };
    return node;
  };
  return {
    MANUAL_BOOKING_TYPES: actual.MANUAL_BOOKING_TYPES,
    ALL_SUB_STATUSES: actual.ALL_SUB_STATUSES,
    ATTACHMENT_REQUIRED_TYPES: [],
    // Forces formatLineItems down its two-rate branch, the one that prints cost.
    isNewModelLineItems: () => true,
    default: {
      find: () => chain(),
      countDocuments: () => Promise.resolve(1),
      aggregate: () => Promise.resolve([{ grossSales: 59000, gstPayable: 9000, netProfit: 8000, pendingInvoices: 0 }]),
    },
  };
});

vi.mock("../models/Invoice.js", () => ({
  default: { find: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) },
}));
vi.mock("../models/Customer.js", () => ({
  default: { findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }), lean: () => Promise.resolve(null) }) },
}));
vi.mock("../models/CustomerWorkspace.js", () => ({
  default: { findOne: () => ({ lean: () => Promise.resolve(null) }), findById: () => ({ lean: () => Promise.resolve(null) }) },
}));
vi.mock("../models/CustomerMember.js", () => ({ default: { find: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) } }));
vi.mock("../models/User.js", () => ({ default: { findById: () => ({ select: () => ({ lean: () => Promise.resolve(null) }) }) } }));
vi.mock("../models/SBTBooking.js", () => ({ default: { find: () => ({ lean: () => Promise.resolve([]) }) } }));
vi.mock("../models/SBTHotelBooking.js", () => ({ default: { find: () => ({ lean: () => Promise.resolve([]) }) } }));
vi.mock("../models/ExtractedDocument.js", () => ({ default: { find: () => ({ lean: () => Promise.resolve([]) }) } }));

import express from "express";
import request from "supertest";
import router from "./manualBookings.js";

type Caller = "superadmin" | "house" | "restricted";

function makeApp(caller: Caller) {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = {
      _id: String(new mongoose.Types.ObjectId()),
      roles: caller === "superadmin" ? ["SUPERADMIN"] : ["ADMIN"],
    };
    if (caller === "house") {
      // HOUSE staff are identified by their own workspace, not by a role.
      req.workspaceObjectId = HOUSE_WORKSPACE_ID;
      req.workspace = { customerId: HOUSE_CUSTOMER_ID };
    } else if (caller === "restricted") {
      // A real tenant: ALL scope (granted above) but NOT house, NOT superadmin.
      req.workspaceObjectId = String(new mongoose.Types.ObjectId());
      req.workspace = { customerId: String(new mongoose.Types.ObjectId()) };
    }
    next();
  });
  app.use("/", router);
  return app;
}

const list   = (c: Caller) => request(makeApp(c)).get("/");
const csv    = (c: Caller) => request(makeApp(c)).get("/export?format=csv");

describe("list — internal money is withheld from non-HOUSE callers", () => {
  it("a restricted caller gets NONE of the withheld pricing fields", async () => {
    const res = await list("restricted");
    expect(res.status).toBe(200);
    const pricing = res.body.docs[0].pricing;
    for (const f of WITHHELD) {
      expect(pricing, `${f} leaked to a restricted caller`).not.toHaveProperty(f);
    }
  });

  it("…but still gets the client-facing price", async () => {
    const { body } = await list("restricted");
    const pricing = body.docs[0].pricing;
    expect(pricing.quotedPrice).toBe(50000);
    expect(pricing.grandTotal).toBe(59000);
    expect(pricing.gstAmount).toBe(9000);
  });

  it("strips the per-line supplier rate too, not just the pricing block", async () => {
    const { body } = await list("restricted");
    expect(body.docs[0].lineItems[0]).not.toHaveProperty("actualRate");
    // The customer-facing half of the line item survives.
    expect(body.docs[0].lineItems[0].quotedRate).toBe(50000);
  });

  it("zeroes the aggregate margin — the same numbers one level up", async () => {
    const { body } = await list("restricted");
    expect(body.stats.netProfit).toBe(0);
    expect(body.stats.avgMargin).toBe(0);
    // Client-facing totals are untouched.
    expect(body.stats.grossSales).toBe(59000);
    expect(body.stats.gstPayable).toBe(9000);
  });

  it("a SuperAdmin still sees everything", async () => {
    const { body } = await list("superadmin");
    const pricing = body.docs[0].pricing;
    for (const f of WITHHELD) {
      expect(pricing, `${f} withheld from a SuperAdmin`).toHaveProperty(f);
    }
    expect(pricing.supplierCost).toBe(42000);
    expect(body.docs[0].lineItems[0].actualRate).toBe(42000);
    expect(body.stats.netProfit).toBe(8000);
  });

  it("a HOUSE caller still sees everything", async () => {
    const { body } = await list("house");
    const pricing = body.docs[0].pricing;
    for (const f of WITHHELD) {
      expect(pricing, `${f} withheld from a HOUSE caller`).toHaveProperty(f);
    }
    expect(body.stats.netProfit).toBe(8000);
  });
});

describe("export — the same rule, because it is the same rows", () => {
  it("a restricted caller's CSV carries no cost, margin or base profit", async () => {
    const res = await csv("restricted");
    expect(res.status).toBe(200);
    const body = res.text;
    for (const n of ["42000", "16", "8000"]) {
      expect(body, `${n} appears in a restricted caller's export`).not.toContain(n);
    }
    // The sell side is still there.
    expect(body).toContain("50000");
    expect(body).toContain("59000");
  });

  it("…and no 'cost ₹' in the Line Items cell", async () => {
    const res = await csv("restricted");
    expect(res.text).not.toContain("cost ₹");
    expect(res.text).toContain("Qty 1 x ₹50000");
  });

  it("a SuperAdmin's CSV keeps cost, margin and the line-item cost", async () => {
    const res = await csv("superadmin");
    expect(res.text).toContain("42000");
    expect(res.text).toContain("cost ₹42000");
  });

  it("a HOUSE caller's CSV keeps them too", async () => {
    const res = await csv("house");
    expect(res.text).toContain("42000");
    expect(res.text).toContain("cost ₹42000");
  });
});

describe("scope is not the predicate", () => {
  it("ALL scope alone does not unlock internals — only SuperAdmin/HOUSE does", async () => {
    // requirePermission hands EVERY caller in this file scope 'ALL'. If the
    // mask keyed on scope instead of SuperAdmin/HOUSE, this restricted caller
    // would see cost — which is precisely the seeded admin@northwind.local
    // "leak profile": ALL scope inside its own tenant, but still a customer.
    const { body } = await list("restricted");
    expect(body.docs[0].pricing).not.toHaveProperty("supplierCost");
  });
});
