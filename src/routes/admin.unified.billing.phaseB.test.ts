// apps/backend/src/routes/admin.unified.billing.phaseB.test.ts
//
// Travel Spend Phase B routes (2026-11-18), real router + in-memory mongod:
//   /flight-insights (new), /bookings status + server-side sort/paging (N6/N8),
//   /bookings/export.csv status + IST dates + city + tenant-scoped traveller
//   ID (N6), /quarterly relative stats (N10), /spend-trend calendar months
//   (N10), /summary travellers sparkline = passengers (N9).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    req.workspace = { tenantType: "CORPORATE" };
    next();
  };
  return { requireAuth, default: requireAuth };
});

const { default: router, buildBucketPlan, statusFilter, bookingSort, istDate } = await import("./admin.unified.billing.js");

const oid = () => new mongoose.Types.ObjectId();
const ACME = "6a00000000000000000000f1";
const BETA = "6a00000000000000000000f2";
const STAFF = oid();
const superadmin = { _id: String(oid()), roles: ["SUPERADMIN"] };
const acmeAdmin = { _id: String(oid()), roles: ["CUSTOMER_ADMIN"], customerId: ACME };

const app = express();
app.use("/api/admin/unified", router);
const get = (path: string, u: any = superadmin) => request(app).get(`/api/admin/unified${path}`).set("x-test-user", JSON.stringify(u));
const col = (n: string) => mongoose.connection.db!.collection(n);

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("phaseb_routes_test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

const row = (over: any) => ({
  tenantId: ACME, userId: STAFF, service: "FLIGHT", status: "CONFIRMED", amount: 1000, paymentMode: "OFFICIAL",
  source: "CONCIERGE", referenceModel: "ManualBooking", reference: oid(), travellerName: "Asha Rao",
  bookedAt: new Date("2026-11-10T00:00:00Z"), ...over,
});

beforeEach(async () => {
  await col("travelbookings").deleteMany({});
  await col("customermembers").deleteMany({});
});

describe("GET /flight-insights", () => {
  it("dom/intl for flights + hotels, airline share, slot coverage — confirmed and in scope only", async () => {
    await col("travelbookings").insertMany([
      row({ amount: 1000, isInternational: false, metadata: { carrierShares: [{ name: "IndiGo", share: 1 }], departMinutesIST: 400 } }),
      row({ amount: 3000, isInternational: true, metadata: { carrierShares: [{ name: "Emirates", share: 1 }], departMinutesIST: 1300 } }),
      row({ amount: 500, isInternational: null, metadata: { departTimeUnknown: true } }),
      row({ service: "HOTEL", amount: 800, isInternational: true }),
      row({ status: "PENDING", amount: 99999, isInternational: true }),
      row({ tenantId: BETA, amount: 7777, isInternational: false }),
      row({ isTest: true, amount: 5555 }),
    ]);
    const r = await get("/flight-insights?from=2026-11-01&to=2026-11-30", acmeAdmin);
    expect(r.status).toBe(200);
    expect(r.body.domesticInternational.FLIGHT).toEqual({ domestic: { count: 1, spend: 1000 }, international: { count: 1, spend: 3000 }, unknown: { count: 1, spend: 500 } });
    expect(r.body.domesticInternational.HOTEL.international).toEqual({ count: 1, spend: 800 });
    expect(r.body.airlines.flights).toBe(3);
    expect(r.body.departureSlots).toMatchObject({ timed: 2, total: 3, markedUnknown: 1 });
    // A service filter that excludes both FLIGHT and HOTEL returns empty panels.
    const v = await get("/flight-insights?from=2026-11-01&to=2026-11-30&service=VISA", acmeAdmin);
    expect(v.body.airlines.flights).toBe(0);
  });
});

describe("GET /bookings — status + server-side sort and paging", () => {
  beforeEach(async () => {
    const rows = Array.from({ length: 25 }, (_, i) => row({ amount: (i + 1) * 100, bookedAt: new Date(Date.UTC(2026, 10, 1 + i)) }));
    rows.push(row({ status: "PENDING", amount: 999999, bookedAt: new Date("2026-11-28T00:00:00Z") }));
    await col("travelbookings").insertMany(rows);
  });
  it("sorts by amount across the whole range, not just the newest page", async () => {
    const r = await get("/bookings?from=2026-11-01&to=2026-11-30&status=CONFIRMED&sort=amount&dir=desc&page=1&limit=8");
    expect(r.body.total).toBe(25);
    expect(r.body.totalPages).toBe(4);
    expect(r.body.bookings[0].amount).toBe(2500);
    const p4 = await get("/bookings?from=2026-11-01&to=2026-11-30&status=CONFIRMED&sort=amount&dir=desc&page=4&limit=8");
    expect(p4.body.bookings.map((b: any) => b.amount)).toEqual([100]);
  });
  it("status=ALL includes pending; date asc pages oldest first", async () => {
    const all = await get("/bookings?from=2026-11-01&to=2026-11-30&status=ALL&limit=50");
    expect(all.body.total).toBe(26);
    const asc = await get("/bookings?from=2026-11-01&to=2026-11-30&status=CONFIRMED&sort=date&dir=asc&limit=2");
    expect(asc.body.bookings.map((b: any) => b.amount)).toEqual([100, 200]);
  });
  it("helpers", () => {
    expect(statusFilter("CONFIRMED,pending")).toEqual({ $in: ["CONFIRMED", "PENDING"] });
    expect(statusFilter("ALL")).toBeNull();
    expect(statusFilter(undefined)).toBeNull();
    expect(statusFilter("bogus")).toEqual({ $in: ["__none__"] });
    expect(bookingSort({ sort: "amount" }, "bookedAt")).toEqual({ amount: -1, bookedAt: -1, _id: -1 });
    expect(istDate(new Date("2026-11-10T20:00:00Z"))).toBe("2026-11-11");
  });
});

describe("GET /bookings/export.csv", () => {
  it("honours status, writes IST dates + city, and scopes the traveller ID to the row's company", async () => {
    await col("travelbookings").insertMany([
      row({ travellerEmail: "shared@x.com", destination: "MNL", destinationCity: "Manila", destinationCountry: "PH", bookedAt: new Date("2026-11-10T20:00:00Z") }),
      row({ status: "PENDING", amount: 5 }),
    ]);
    await col("customermembers").insertMany([
      { customerId: BETA, email: "shared@x.com", travelerId: "BETA-007" },
      { customerId: ACME, email: "shared@x.com", travelerId: "ACME-001" },
    ] as any[]);
    const r = await get("/bookings/export.csv?from=2026-11-01&to=2026-11-30&status=CONFIRMED");
    const lines = r.text.split("\n");
    expect(lines[0]).toContain("Destination City");
    // Department column removed (booker-based) — Phase B additions.
    expect(lines[0]).not.toContain("Department");
    expect(lines[0].split(",")).toHaveLength(15);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"2026-11-11"');
    expect(lines[1]).toContain('"Manila"');
    expect(lines[1]).toContain('"ACME-001"');
    expect(lines[1]).not.toContain("BETA-007");
  });
});

describe("GET /quarterly", () => {
  it("last 4 IST quarters ending at `to`, stats relative to that quarter", async () => {
    await col("travelbookings").insertMany([
      row({ amount: 900, bookedAt: new Date("2026-08-15T00:00:00Z") }),
      row({ amount: 400, bookedAt: new Date("2026-10-15T00:00:00Z") }),
      row({ amount: 100, service: "HOTEL", bookedAt: new Date("2026-11-10T00:00:00Z") }),
      // 30 Sep 20:00 UTC = 1 Oct 01:30 IST → Q4
      row({ amount: 50, bookedAt: new Date("2026-09-30T20:00:00Z") }),
    ]);
    const r = await get("/quarterly?from=2026-11-01&to=2026-11-30");
    expect(r.body.quarters.map((q: any) => q.label.replace("*", ""))).toEqual(["Q1 2026", "Q2 2026", "Q3 2026", "Q4 2026"]);
    expect(r.body.stats.prevLabel).toBe("Q3 2026");
    expect(r.body.stats.prevClosed).toBe(900);
    expect(r.body.stats.currentToDate).toBe(550);
  });
});

describe("bucketing (N10) and the travellers sparkline (N9)", () => {
  it("ranges over 70 days use IST calendar months", () => {
    const day = (s: string) => Date.parse(`${s}T00:00:00Z`);
    const plan = buildBucketPlan(day("2026-01-15"), day("2026-04-10"));
    expect(plan.granularity).toBe("monthly");
    expect(plan.buckets.map((b: any) => b.label)).toEqual(["Jan 2026", "Feb 2026", "Mar 2026", "Apr 2026"]);
    expect(plan.buckets.map((b: any) => b.date)).toEqual(["2026-01-15", "2026-02-01", "2026-03-01", "2026-04-01"]);
    expect(new Date(plan.buckets[3].end).toISOString().slice(0, 10)).toBe("2026-04-11");
    expect(plan.prevBuckets.map((b: any) => b.label)).toEqual(["Sep 2025", "Oct 2025", "Nov 2025", "Dec 2025"]);
  });
  it("spend-trend groups by calendar month and travellers count passengers", async () => {
    await col("travelbookings").insertMany([
      row({ amount: 100, bookedAt: new Date("2026-03-31T00:00:00Z"), travellerName: "Asha Rao" }),
      row({ amount: 200, bookedAt: new Date("2026-04-01T00:00:00Z"), travellerName: "Asha Rao" }),
      row({ amount: 300, bookedAt: new Date("2026-04-02T00:00:00Z"), travellerName: "Ravi Kumar" }),
    ]);
    const t = await get("/spend-trend?from=2026-01-01&to=2026-04-30");
    expect(t.body.granularity).toBe("monthly");
    const byLabel = Object.fromEntries(t.body.buckets.map((b: any) => [b.label, b.thisPeriod]));
    expect(byLabel).toMatchObject({ "Mar 2026": 100, "Apr 2026": 500 });
    const s = await get("/summary?from=2026-01-01&to=2026-04-30");
    // Same staff booker on every row: the old userId count would be 1.
    expect(s.body.sparklines.travellers.at(-1)).toBe(2);
    expect(s.body.uniqueTravellers).toBe(2);
  });
});
