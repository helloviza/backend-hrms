// apps/backend/src/routes/travelSpend.phaseB2.test.ts
//
// Travel Spend Phase B additions (2026-11-18), real routers + in-memory mongod:
//   GET /admin/unified/travel-kpis    lead time, hotel rates, routes, carbon
//   GET /admin/unified/service-cards  Visa / Forex / eSIM
//   GET /admin/unified/flight-insights cabin mix + "from ticket" counts
//   GET/PUT/DELETE /api/me/preferences/:key  own row only, closed key list
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

const { default: unified } = await import("./admin.unified.billing.js");
const { requireAuth } = await import("../middleware/auth.js");
const { default: prefs } = await import("./me.preferences.js");

const oid = () => new mongoose.Types.ObjectId();
const ACME = "6a00000000000000000000f1";
const BETA = "6a00000000000000000000f2";
const STAFF = oid();
const acmeAdmin = { _id: String(oid()), roles: ["CUSTOMER_ADMIN"], customerId: ACME };

const app = express();
app.use(express.json());
app.use("/api/admin/unified", unified);
app.use("/api/me/preferences", requireAuth, prefs);
const as = (u: any) => ({
  get: (p: string) => request(app).get(p).set("x-test-user", JSON.stringify(u)),
  put: (p: string, body: any) => request(app).put(p).set("x-test-user", JSON.stringify(u)).send(body),
  del: (p: string) => request(app).delete(p).set("x-test-user", JSON.stringify(u)),
});
const col = (n: string) => mongoose.connection.db!.collection(n);

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("phaseb2_routes_test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  for (const c of ["travelbookings", "carbonrecords", "userpreferences"]) await col(c).deleteMany({});
});

const row = (over: any) => ({
  tenantId: ACME, userId: STAFF, service: "FLIGHT", status: "CONFIRMED", amount: 1000, paymentMode: "OFFICIAL",
  source: "CONCIERGE", referenceModel: "ManualBooking", reference: oid(), travellerName: "Asha",
  bookedAt: new Date("2026-11-10T00:00:00Z"), ...over,
});
const Q = "?from=2026-11-01&to=2026-11-30";

describe("GET /travel-kpis", () => {
  it("lead time, hotel rates, routes, carbon — confirmed, in scope, with coverage", async () => {
    const f1 = row({ amount: 10000, travelDate: new Date("2026-11-12T00:00:00Z"), destinationCity: "Mumbai", metadata: { originCity: "Delhi" } });
    const f2 = row({ amount: 12000, travelDate: new Date("2026-11-30T00:00:00Z"), destinationCity: "Delhi", metadata: { originCity: "Mumbai" } });
    const f3 = row({ amount: 5000, travelDate: null, destinationCity: "Goa", metadata: {} });
    await col("travelbookings").insertMany([
      f1, f2, f3,
      row({ service: "HOTEL", amount: 12000, destinationCity: "Mumbai", metadata: { nights: 2, rooms: 1 } }),
      row({ service: "HOTEL", amount: 6000, destinationCity: "Mumbai", metadata: { nights: 1, rooms: 1 } }),
      row({ status: "PENDING", amount: 99999, travelDate: new Date("2026-11-10T00:00:00Z") }),
      row({ tenantId: BETA, amount: 7777, travelDate: new Date("2026-11-10T00:00:00Z") }),
    ]);
    await col("carbonrecords").insertMany([
      { bookingId: f1.reference, status: "calculated", co2eKg: 120, distanceKm: 1200 },
      { bookingId: f2.reference, status: "insufficient_data", co2eKg: null },
      { bookingId: oid(), status: "calculated", co2eKg: 5000, distanceKm: 1 },
    ]);
    const r = await as(acmeAdmin).get(`/api/admin/unified/travel-kpis${Q}`);
    expect(r.status).toBe(200);
    expect(r.body.leadTime).toMatchObject({ total: 3, measured: 2, missingTravelDate: 1, lastMinute: { count: 1, pct: 50 } });
    expect(r.body.hotels).toMatchObject({ total: 2, measured: 2, avgStay: 1.5 });
    expect(r.body.hotels.cities[0]).toEqual({ city: "Mumbai", bookings: 2, roomNights: 3, spend: 18000, avgNightly: 6000 });
    expect(r.body.routes).toMatchObject({ resolved: 2, total: 3 });
    expect(r.body.routes.routes[0]).toMatchObject({ route: "Delhi ⇄ Mumbai", count: 2, avgFare: 11000 });
    expect(r.body.carbon).toMatchObject({ co2eKg: 120, covered: 1, total: 3, gramsPerKm: 100 });
  });

  it("a service filter without flights/hotels returns empty panels", async () => {
    await col("travelbookings").insertOne(row({ travelDate: new Date("2026-11-12T00:00:00Z") }));
    const r = await as(acmeAdmin).get(`/api/admin/unified/travel-kpis${Q}&service=VISA`);
    expect(r.body.leadTime.total).toBe(0);
    expect(r.body.carbon.total).toBe(0);
  });
});

describe("GET /service-cards", () => {
  it("visa (incl. the US appointment fee), forex, esim — processed / under processing / cost / outcomes", async () => {
    await col("travelbookings").insertMany([
      row({ service: "VISA", amount: 10000, metadata: { manualType: "VISA", visaOutcome: "APPROVED" } }),
      row({ service: "OTHER", amount: 60000, metadata: { manualType: "US_VISA_EARLY_APPOINTMENT_FEE" } }),
      row({ service: "VISA", status: "PENDING", amount: 4000, metadata: { manualType: "VISA" } }),
      row({ service: "VISA", status: "CANCELLED", amount: 999, metadata: { manualType: "VISA" } }),
      row({ service: "FOREX", amount: 2500 }),
      row({ service: "VISA", tenantId: BETA, amount: 5555 }),
      row({ service: "OTHER", amount: 1, metadata: { manualType: "INSURANCE" } }),
    ]);
    const r = await as(acmeAdmin).get(`/api/admin/unified/service-cards${Q}`);
    expect(r.status).toBe(200);
    expect(r.body.cards.VISA).toEqual({ processed: 2, underProcessing: 1, totalCost: 70000, avgCost: 35000, outcomes: { APPROVED: 1, REJECTED: 0, AWAITING: 0, recorded: 1 } });
    expect(r.body.cards.FOREX).toMatchObject({ processed: 1, totalCost: 2500 });
    expect(r.body.cards.ESIM).toMatchObject({ processed: 0, underProcessing: 0 });
    const v = await as(acmeAdmin).get(`/api/admin/unified/service-cards${Q}&service=FOREX`);
    expect(Object.keys(v.body.cards)).toEqual(["FOREX"]);
  });
});

describe("GET /flight-insights — cabin mix", () => {
  it("returns cabins with coverage and ticket counts", async () => {
    await col("travelbookings").insertMany([
      row({ metadata: { cabinClass: "Economy", cabinClassSource: "ticket", departMinutesIST: 600, departTimeSource: "ticket" } }),
      row({ metadata: { cabinClass: "Business", cabinClassSource: "booking" } }),
      row({ metadata: {} }),
    ]);
    const r = await as(acmeAdmin).get(`/api/admin/unified/flight-insights${Q}`);
    expect(r.body.cabins).toMatchObject({ known: 2, total: 3, fromTicket: 1 });
    expect(r.body.departureSlots).toMatchObject({ timed: 1, fromTicket: 1 });
  });
});

describe("/api/me/preferences/:key", () => {
  const u1 = { _id: String(oid()) };
  const u2 = { _id: String(oid()) };
  const P = "/api/me/preferences/travelSpend.cards";

  it("defaults → null; PUT saves; another user never sees it; DELETE resets", async () => {
    expect((await as(u1).get(P)).body).toEqual({ ok: true, key: "travelSpend.cards", value: null });
    const put = await as(u1).put(P, { value: { hidden: ["airlines", "carbon", "airlines"] } });
    expect(put.status).toBe(200);
    expect(put.body.value).toEqual({ hidden: ["airlines", "carbon"], v: 1 });
    expect((await as(u1).get(P)).body.value).toEqual({ hidden: ["airlines", "carbon"], v: 1 });
    expect((await as(u2).get(P)).body.value).toBeNull();
    // Overwrite, not append.
    await as(u1).put(P, { value: { hidden: ["visa"] } });
    expect(await col("userpreferences").countDocuments({})).toBe(1);
    expect((await as(u1).get(P)).body.value.hidden).toEqual(["visa"]);
    expect((await as(u1).del(P)).body.value).toBeNull();
    expect((await as(u1).get(P)).body.value).toBeNull();
  });

  it("rejects unknown keys, bad values, and anonymous callers", async () => {
    expect((await as(u1).get("/api/me/preferences/anything")).status).toBe(404);
    expect((await as(u1).put(P, { value: { hidden: "airlines" } })).status).toBe(400);
    expect((await as(u1).put(P, { value: { hidden: ["<script>"] } })).status).toBe(400);
    expect((await as(u1).put(P, { value: { hidden: Array.from({ length: 51 }, (_, i) => `c${i}`) } })).status).toBe(400);
    expect((await as({}).get(P)).status).toBe(401);
  });
});
