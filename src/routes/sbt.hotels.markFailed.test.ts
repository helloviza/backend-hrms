// apps/backend/src/routes/sbt.hotels.markFailed.test.ts
//
// POST /api/sbt/hotels/bookings/:id/mark-failed — Plumtrips staff (signed in
// to HOUSE) fail a customer's stuck PENDING booking, which is stored on the
// customer's workspace. Tenant admins (requireAdmin admits them) stay inside
// their own workspace.
//
// Real: hotels router, requireAdmin, SBTHotelBooking, in-memory Mongo.
// Stubbed: requireAuth / requireWorkspace (from headers), feature gate, TBO bits.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", async (orig) => ({
  ...(await orig<any>()),
  requireWorkspace: (req: any, _res: any, next: any) => {
    const id = String(req.headers["x-test-ws"] || "");
    req.workspaceId = id;
    req.workspaceObjectId = new mongoose.Types.ObjectId(id);
    req.workspace = { _id: req.workspaceObjectId, tenantType: "CORPORATE" };
    next();
  },
}));
vi.mock("../middleware/requireFeature.js", async (orig) => ({
  ...(await orig<any>()),
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../utils/tboFileLogger.js", () => ({ logTBOCall: () => {}, listTBOLogs: () => [], readTBOLog: () => null }));
vi.mock("../jobs/static-data-refresh.js", () => ({
  resolveCityCodeAgainstCatalog: () => null,
  resolveCityCode: () => null,
  TBOHotelMaster: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));

const { default: hotelsRouter } = await import("./sbt.hotels.js");
const app = express();
app.use(express.json());
app.use("/api/sbt/hotels", hotelsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const HOUSE = "69679a7628330a58d29f2254";
const CUST_WS = oid();
const OTHER_WS = oid();

const as = (r: request.Test, roles: string[], ws: any) =>
  r.set("x-test-user", JSON.stringify({ sub: String(oid()), _id: String(oid()), email: "x@test", roles })).set("x-test-ws", String(ws));

let bookingId: mongoose.Types.ObjectId;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sbt-hotels-mark-failed-test"));
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await col("sbthotelbookings").deleteMany({});
  bookingId = oid();
  await col("sbthotelbookings").insertOne({ _id: bookingId, userId: oid(), workspaceId: CUST_WS, status: "PENDING", bookingId: "" } as any);
});

const statusOf = async () => ((await col("sbthotelbookings").findOne({ _id: bookingId })) as any).status;

describe("hotel mark-failed", () => {
  it("a HOUSE ADMIN fails a customer's stuck booking", async () => {
    const r = await as(request(app).post(`/api/sbt/hotels/bookings/${bookingId}/mark-failed`), ["ADMIN"], HOUSE).send({ reason: "No BookingId" });
    expect([r.status, r.body.newStatus]).toEqual([200, "FAILED"]);
    expect(await statusOf()).toBe("FAILED");
  });

  it("a tenant admin from another workspace gets 404; the customer's own tenant admin still can (unchanged)", async () => {
    expect((await as(request(app).post(`/api/sbt/hotels/bookings/${bookingId}/mark-failed`), ["TENANT_ADMIN"], OTHER_WS).send({})).status).toBe(404);
    expect(await statusOf()).toBe("PENDING");
    expect((await as(request(app).post(`/api/sbt/hotels/bookings/${bookingId}/mark-failed`), ["TENANT_ADMIN"], CUST_WS).send({})).status).toBe(200);
  });
});
