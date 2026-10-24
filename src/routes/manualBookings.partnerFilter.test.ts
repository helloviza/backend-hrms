// apps/backend/src/routes/manualBookings.partnerFilter.test.ts
//
// /admin/manual-bookings "More filters" → Partner:
//   - options: every workspace with a partner link (active or deactivated), so
//     a new partner appears after its first link;
//   - ?partner= narrows the list, the stats strip (default Confirmed +
//     Invoiced rule unchanged) and the export to bookings made for that
//     partner's partner-lead cases — not its ordinary bookings, not another
//     partner's; it ANDs with the other filters; an unknown partner matches
//     nothing.
//
// Real: manual-bookings router, filters, models, in-memory Mongo, raw-insert
// fixtures. Stubbed: the caller, requirePermission.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
for (const [k, v] of Object.entries({
  MONGO_URI: "mongodb://127.0.0.1:1/unused",
  JWT_SECRET: "jwt-secret-for-tests",
  JWT_REFRESH_SECRET: "refresh-secret-for-tests",
  FRONTEND_ORIGIN: "http://localhost:5173",
  AWS_REGION: "ap-south-1",
  S3_BUCKET: "test-bucket",
  GEMINI_API_KEY: "test",
})) process.env[k] ||= v;

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (_req: any, _res: any, next: any) => next();
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));

const { default: manualBookingsRouter } = await import("./manualBookings.js");

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const oid = () => new mongoose.Types.ObjectId();
const app = express();
app.use(express.json());
app.use("/api/admin/manual-bookings", (req: any, _res, next) => {
  req.user = { sub: "ops", _id: "ops", email: "ops@plumtrips.com", roles: ["SUPERADMIN"] };
  req.workspace = { customerId: "PLUMTRIPS-HOUSE" };
  req.workspaceObjectId = HOUSE;
  req.permissionScope = "ALL";
  next();
}, manualBookingsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const AMBER = oid(), AMBER_CUST = oid();
const UNI = oid(), UNI_CUST = oid();
const ACME = oid(), ACME_CUST = oid();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("manual-bookings-partner-filter-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

let n = 0;
const booking = (cust: any, over: any = {}) => ({
  workspaceId: cust, bookingRef: `MB-${++n}`, type: "VISA", status: "CONFIRMED", source: "MANUAL", isActive: true,
  bookingDate: new Date("2026-10-20"), passengers: [{ name: `Pax ${n}` }], pricing: { grandTotal: 1000, quotedPrice: 1000, basePrice: 100 }, ...over,
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  n = 0;
  await col("customerworkspaces").insertMany([
    { _id: AMBER, customerId: String(AMBER_CUST), companyName: "Amber Student", status: "ACTIVE" },
    { _id: UNI, customerId: String(UNI_CUST), companyName: "University Living", status: "ACTIVE" },
    { _id: ACME, customerId: String(ACME_CUST), companyName: "Acme Corp", status: "ACTIVE" },
  ] as any[]);
  const base = { frontlinerId: "f", frontlinerEmail: "f@x.test", managerEmail: "m@x.test", status: "approved", cartItems: [], history: [] };
  const cases = await col("approvalrequests").insertMany([
    { ...base, workspaceId: AMBER, customerId: String(AMBER_CUST), meta: { source: "PARTNER_LINK" } },
    { ...base, workspaceId: AMBER, customerId: String(AMBER_CUST), meta: {} }, // Amber's own (non-partner) case
    { ...base, workspaceId: UNI, customerId: String(UNI_CUST), meta: { source: "PARTNER_LINK" } },
  ] as any[]);
  const [amberLead, amberOwn, uniLead] = Object.values(cases.insertedIds);
  await col("manualbookings").insertMany([
    booking(AMBER_CUST, { bookingRef: "AMB-LEAD-1", source: "ADMIN_QUEUE", sourceBookingId: amberLead }),
    booking(AMBER_CUST, { bookingRef: "AMB-LEAD-2", source: "ADMIN_QUEUE", sourceBookingId: amberLead, status: "PENDING", pricing: { grandTotal: 700, quotedPrice: 700 } }),
    booking(AMBER_CUST, { bookingRef: "AMB-OWN", source: "ADMIN_QUEUE", sourceBookingId: amberOwn }),
    booking(AMBER_CUST, { bookingRef: "AMB-MANUAL" }),
    booking(UNI_CUST, { bookingRef: "UNI-LEAD", source: "ADMIN_QUEUE", sourceBookingId: uniLead }),
    booking(ACME_CUST, { bookingRef: "ACME-1" }),
  ] as any[]);
});

const list = (q = "") => request(app).get(`/api/admin/manual-bookings${q}`);
const refs = (res: any) => (res.body.docs || []).map((d: any) => d.bookingRef).sort();

describe("Partner filter options", () => {
  it("every workspace with a partner link — a new partner appears after its first link, deactivated links count", async () => {
    expect((await request(app).get("/api/admin/manual-bookings/partner-options")).body.partners).toEqual([]);
    await col("partnerlinks").insertOne({ code: "AmbR2026", workspaceId: AMBER, customerId: String(AMBER_CUST), label: "a", active: true } as any);
    expect((await request(app).get("/api/admin/manual-bookings/partner-options")).body.partners).toEqual([{ workspaceId: String(AMBER), name: "Amber Student" }]);
    await col("partnerlinks").insertOne({ code: "UniOld01", workspaceId: UNI, customerId: String(UNI_CUST), label: "u", active: false } as any);
    expect((await request(app).get("/api/admin/manual-bookings/partner-options")).body.partners.map((p: any) => p.name)).toEqual(["Amber Student", "University Living"]);
  });
});

describe("?partner=", () => {
  it("the list shows only that partner's partner-lead bookings", async () => {
    expect(refs(await list(`?partner=${AMBER}`))).toEqual(["AMB-LEAD-1", "AMB-LEAD-2"]);
    expect(refs(await list(`?partner=${UNI}`))).toEqual(["UNI-LEAD"]);
    expect(refs(await list(`?partner=${ACME}`))).toEqual([]); // a workspace with no partner cases
    expect(refs(await list(`?partner=${oid()}`))).toEqual([]);
    expect(refs(await list(`?partner=not-an-id`))).toEqual([]);
    expect(refs(await list())).toHaveLength(6); // no partner: unchanged
  });

  it("ANDs with the other filters", async () => {
    expect(refs(await list(`?partner=${AMBER}&status=PENDING`))).toEqual(["AMB-LEAD-2"]);
    expect(refs(await list(`?partner=${AMBER}&workspaceId=${UNI_CUST}`))).toEqual([]);
    expect(refs(await list(`?partner=${AMBER}&search=LEAD-1`))).toEqual(["AMB-LEAD-1"]);
  });

  it("the stats strip follows it, with the default Confirmed + Invoiced rule", async () => {
    const res = await list(`?partner=${AMBER}`);
    expect(res.body.stats).toMatchObject({ grossSales: 1000, bookingCount: 1 }); // the PENDING one doesn't count
  });

  it("the export follows it", async () => {
    const csv = await request(app).get(`/api/admin/manual-bookings/export?partner=${AMBER}&format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.text).toContain("AMB-LEAD-1");
    expect(csv.text).toContain("AMB-LEAD-2");
    for (const other of ["AMB-OWN", "AMB-MANUAL", "UNI-LEAD", "ACME-1"]) expect(csv.text).not.toContain(other);
  });
});
