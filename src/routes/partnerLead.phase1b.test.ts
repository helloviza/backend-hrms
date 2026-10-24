// apps/backend/src/routes/partnerLead.phase1b.test.ts
//
// The small backend pieces behind the partner lead screens:
//   - My Bookings: a partner lead booking's lead traveller email is blank in
//     GET /api/my-bookings and in the manual export rows; every other
//     booking's email is exactly as before;
//   - GET /api/admin/manual-bookings/:id says partnerLead: true for a partner
//     lead booking only (the key is absent otherwise);
//   - GET /api/public/partner-links/:code/hotel-cities: the request form's
//     typeahead for an active link that offers hotels; 404 otherwise.
//
// Real: routers, models, in-memory Mongo, raw-insert fixtures. Stubbed: the
// caller and workspace, requirePermission.
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

const { default: myBookingsRouter } = await import("./myBookings.js");
const { default: manualBookingsRouter } = await import("./manualBookings.js");
const { default: publicPartnerRouter } = await import("./public.partnerRequest.js");
const { partnerHotelCityLimiter, partnerLinkResolveLimiter } = await import("../middleware/rateLimit.js");

const oid = () => new mongoose.Types.ObjectId();
const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const AMBER = oid();
const AMBER_CUSTOMER = oid();
const LEAD = { sub: String(oid()), email: "lead@amber.test", roles: ["WORKSPACE_LEADER"] };

const app = express();
app.use(express.json());
app.use("/api/my-bookings", async (req: any, _res: any, next: any) => {
  req.user = { ...LEAD, _id: LEAD.sub };
  req.workspace = await mongoose.connection.db!.collection("customerworkspaces").findOne({ _id: AMBER });
  req.workspaceObjectId = AMBER;
  next();
}, myBookingsRouter);
app.use("/api/admin/manual-bookings", (req: any, _res: any, next: any) => {
  req.user = { sub: "ops", _id: "ops", email: "ops@plumtrips.com", roles: ["SUPERADMIN"] };
  req.workspace = { customerId: "PLUMTRIPS-HOUSE" };
  req.workspaceObjectId = HOUSE;
  req.permissionScope = "ALL";
  next();
}, manualBookingsRouter);
app.use("/api/public", publicPartnerRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
let PARTNER_BOOKING: any;
let ORDINARY_BOOKING: any;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("partner-lead-phase1b-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  for (const key of ["::ffff:127.0.0.1", "127.0.0.1", "::1"]) {
    await (partnerHotelCityLimiter as any).resetKey?.(key);
    await (partnerLinkResolveLimiter as any).resetKey?.(key);
  }
  await col("customerworkspaces").insertOne({ _id: AMBER, customerId: String(AMBER_CUSTOMER), companyName: "Amber Student", status: "ACTIVE" } as any);
  const base = { workspaceId: AMBER, customerId: String(AMBER_CUSTOMER), frontlinerId: "f", frontlinerEmail: "f@x.test", managerEmail: "m@x.test", status: "approved", cartItems: [], history: [] };
  const cases = await col("approvalrequests").insertMany([
    { ...base, meta: { source: "PARTNER_LINK", partnerLead: { caseNumber: "PL-AAAAAA" } } },
    { ...base, meta: {} },
  ] as any[]);
  const [pcase, ocase] = Object.values(cases.insertedIds);
  const booking = (ref: string, caseId: any, email: string) => ({
    workspaceId: AMBER_CUSTOMER, bookingRef: ref, type: "FLIGHT", status: "CONFIRMED", source: "ADMIN_QUEUE", sourceBookingId: caseId,
    bookingDate: new Date("2026-10-20"), passengers: [{ name: "Traveller " + ref, email }], pricing: { grandTotal: 5600 }, isActive: true,
  });
  const ins = await col("manualbookings").insertMany([
    booking("MB-P1", pcase, "riya@student.test"),
    booking("MB-O1", ocase, "asha@amber.test"),
  ] as any[]);
  [PARTNER_BOOKING, ORDINARY_BOOKING] = Object.values(ins.insertedIds);
  const mirror = (ref: any, bookingRef: string, email: string) => ({
    reference: ref, referenceModel: "ManualBooking", source: "CONCIERGE", service: "FLIGHT", status: "CONFIRMED", amount: 5600,
    tenantId: String(AMBER_CUSTOMER), workspaceId: AMBER, customerId: String(AMBER_CUSTOMER), travellerName: "T " + bookingRef, travellerEmail: email,
    bookedAt: new Date("2026-10-20"), metadata: { bookingRef }, isActive: true,
  });
  await col("travelbookings").insertMany([mirror(PARTNER_BOOKING, "MB-P1", "riya@student.test"), mirror(ORDINARY_BOOKING, "MB-O1", "asha@amber.test")] as any[]);
});

describe("My Bookings — partner lead email", () => {
  it("GET /api/my-bookings blanks it for the partner lead booking only", async () => {
    const res = await request(app).get("/api/my-bookings");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const byRef = Object.fromEntries(res.body.bookings.map((b: any) => [b.bookingRef, b]));
    expect(byRef["MB-P1"]._user).toEqual({ name: "T MB-P1", email: "" });
    expect(byRef["MB-O1"]._user).toEqual({ name: "T MB-O1", email: "asha@amber.test" });
    expect(JSON.stringify(res.body)).not.toContain("riya@student.test");
  });

  it("the manual list and its export carry no partner lead email; the ordinary booking is unchanged", async () => {
    const list = await request(app).get("/api/my-bookings/manual");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain("riya@student.test");
    expect(list.body.bookings.map((b: any) => b.refNo).sort()).toEqual(["MB-O1", "MB-P1"]);
    const csv = await request(app).get("/api/my-bookings/manual/export?format=csv");
    expect(csv.status).toBe(200);
    expect(csv.text).not.toContain("riya@student.test");
    expect(csv.text).toContain("MB-P1");
  });
});

describe("manual booking GET — partnerLead", () => {
  it("true for a partner lead booking; absent for any other", async () => {
    const p = await request(app).get(`/api/admin/manual-bookings/${PARTNER_BOOKING}`);
    const o = await request(app).get(`/api/admin/manual-bookings/${ORDINARY_BOOKING}`);
    expect(p.body.partnerLead).toBe(true);
    expect(o.status).toBe(200);
    expect("partnerLead" in o.body).toBe(false);
  });
});

describe("public hotel city typeahead", () => {
  it("answers for an active link that offers hotels; 404 for anything else", async () => {
    await col("partnerlinks").insertMany([
      { code: "HotelOk1", workspaceId: AMBER, customerId: String(AMBER_CUSTOMER), label: "x", services: ["flight", "hotel"], active: true },
      { code: "NoHotel1", workspaceId: AMBER, customerId: String(AMBER_CUSTOMER), label: "x", services: ["visa"], active: true },
      { code: "Inactive", workspaceId: AMBER, customerId: String(AMBER_CUSTOMER), label: "x", services: ["hotel"], active: false },
    ] as any[]);
    const ok = await request(app).get("/api/public/partner-links/HotelOk1/hotel-cities?q=mu");
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, results: expect.any(Array) });
    for (const code of ["NoHotel1", "Inactive", "Zz9Zz9Zz"]) {
      const r = await request(app).get(`/api/public/partner-links/${code}/hotel-cities?q=mu`);
      expect([r.status, r.body]).toEqual([404, { error: "This link is not available." }]);
    }
  });
});
