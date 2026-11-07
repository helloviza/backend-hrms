// The stored billing period is the IST month of the invoice date, on the month
// and financial-year boundaries, whatever zone the server runs in. Run this
// under TZ=UTC as well: App Runner is UTC, an IST machine passes by accident.
//
// Real: invoices router, generation service, models, mongodb-memory-server.
// Stubbed: requireAuth, requirePermission.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
  requireAnyPermission: () => (_req: any, _res: any, next: any) => next(),
}));

const { default: invoicesRouter } = await import("./invoices.js");
const { default: Customer } = await import("../models/Customer.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");

const app = express();
app.use(express.json());
app.use("/api/admin/invoices", invoicesRouter);

let mongod: MongoMemoryReplSet;
const col = (n: string) => mongoose.connection.db!.collection(n);
const SA_ID = new mongoose.Types.ObjectId();
const SA = JSON.stringify({ _id: String(SA_ID), id: String(SA_ID), sub: String(SA_ID), roles: ["SUPERADMIN"] });

let CUST: mongoose.Types.ObjectId;
let seq = 0;
async function booking() {
  seq += 1;
  const b: any = await ManualBooking.create({
    workspaceId: CUST, bookedBy: SA_ID, type: "FLIGHT", supplierName: "TBO", givenBy: "Ops",
    status: "CONFIRMED", bookingRef: `MB-BP-${seq}`,
    travelDate: new Date("2026-12-01T00:00:00Z"), passengers: [{ name: "Asha Rao", type: "ADULT" }],
    pricing: { gstMode: "ON_MARKUP", gstPercent: 18, actualPrice: 10000, quotedPrice: 11180 },
  });
  return String(b._id);
}
const post = (path: string, body: any) =>
  request(app).post(`/api/admin/invoices${path}`).set("x-test-user", SA).send(body);
const storedPeriods = async () =>
  (await col("invoices").find({}).toArray()).map((i: any) => i.billingPeriod);

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(mongod.getUri("invoice-billing-period-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await col("companysettings").insertOne({
    companyName: "Plumtrips", invoiceSeriesCadence: "annual",
    gstProfiles: [{ gstin: "29ABCDE1234F1Z5", state: "Karnataka", stateCode: "29", legalName: "Plumtrips KA", addressLine1: "", addressLine2: "", city: "Bengaluru", pincode: "560001", isDefault: true, active: true, invoiceSeriesPrefix: "" }],
  } as any);
  const c: any = await Customer.create({ name: "Acme", legalName: "Acme Pvt Ltd", gstRegisteredState: "Karnataka" });
  CUST = c._id;
  await CustomerWorkspace.create({ customerId: String(c._id), companyName: "Acme" });
});
afterEach(() => { vi.useRealTimers(); });

const BOUNDARIES: [string, string][] = [
  ["2026-11-30", "November 2026"],
  ["2026-12-01", "December 2026"],
  ["2027-03-31", "March 2027"],
  ["2027-04-01", "April 2027"],
];

describe("bulk generate derives the period from the invoice date", () => {
  it.each(BOUNDARIES)("%s is %s", async (invoiceDate, period) => {
    const r = await post("/bulk-generate", { bookingIds: [await booking()], invoiceDate });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    expect(await storedPeriods()).toEqual([period]);
  });
});

describe("generate", () => {
  it.each(BOUNDARIES)("a blank period on %s falls back to %s", async (invoiceDate, period) => {
    const r = await post("/generate", { bookingIds: [await booking()], invoiceDate, billingPeriod: "  " });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await storedPeriods()).toEqual([period]);
  });

  it("stores exactly what the popup sent, including a period the operator typed", async () => {
    const r = await post("/generate", { bookingIds: [await booking()], invoiceDate: "2026-12-01", billingPeriod: "Q3 FY26-27" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await storedPeriods()).toEqual(["Q3 FY26-27"]);
  });
});

describe("no invoice date sent, 2 AM IST on the 1st (still yesterday in UTC)", () => {
  const CLOCKS: [string, string, string][] = [
    ["1 Dec", "2026-11-30T20:30:00Z", "December 2026"],
    ["1 Apr", "2027-03-31T20:30:00Z", "April 2027"],
  ];

  it.each(CLOCKS)("generate on %s", async (_label, now, period) => {
    const id = await booking();
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(now) });
    const r = await post("/generate", { bookingIds: [id] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await storedPeriods()).toEqual([period]);
  });

  it.each(CLOCKS)("bulk generate on %s", async (_label, now, period) => {
    const id = await booking();
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(now) });
    const r = await post("/bulk-generate", { bookingIds: [id] });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    expect(await storedPeriods()).toEqual([period]);
  });
});
