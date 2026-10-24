// apps/backend/src/routes/manualBookings.sbtImport.test.ts
//
// A CANCELLED SBT booking is not a sale: it no longer appears in the SBT
// import queue, and /import-from-sbt refuses it (it used to write a full-fare
// CONFIRMED ManualBooking). Flight and hotel alike.
//
// Real: manualBookings router, SBT + ManualBooking models, in-memory Mongo,
// raw-insert fixtures. Stubbed as in manualBookings.stats.test.ts.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
    req.workspaceObjectId = new mongoose.Types.ObjectId();
    req.workspace = { _id: req.workspaceObjectId, customerId: null };
    next();
  },
  requireResolvedWorkspace: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireFeature.js", () => ({
  requireFeature: () => (_req: any, _res: any, next: any) => next(),
  requireAnyFeature: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (req: any, _res: any, next: any) => {
    req.permissionScope = "ALL";
    req.permissionAccess = "FULL";
    next();
  },
  requireAnyPermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../utils/s3Upload.js", () => ({ uploadBufferToS3: async () => ({ bucket: "b", key: "k", url: "u" }), deleteObject: async () => {} }));
vi.mock("../utils/s3Presign.js", () => ({ presignGetObject: async () => "signed://x" }));
vi.mock("../config/aws.js", () => ({ s3: { send: async () => ({}) } }));
vi.mock("../services/location.service.js", () => ({
  resolveActorFromRequest: async () => ({ location: { city: null, rawCity: null, source: "private-ip", confidence: 0, reason: "test" } }),
}));
vi.mock("../services/documentExtraction.service.js", () => ({ enqueueExtraction: async () => null }));
vi.mock("../services/taskAutomation.js", () => ({ triggerTaskAutomation: async () => null }));

const { default: manualBookingsRouter } = await import("./manualBookings.js");

const app = express();
app.use(express.json());
app.use("/api/admin/manual-bookings", manualBookingsRouter);

let mongod: MongoMemoryServer;
const oid = () => new mongoose.Types.ObjectId();
const STAFF = oid();
const superAdmin = { _id: String(STAFF), sub: String(STAFF), email: "sa@plumtrips.com", roles: ["SUPERADMIN"] };
const as = (r: request.Test) => r.set("x-test-user", JSON.stringify(superAdmin));

const F = { live: oid(), cancelled: oid() };
const H = { live: oid(), cancelled: oid() };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sbt-import-cancelled-test"));
  const db = mongoose.connection.db!;
  await db.collection("sbtbookings").insertMany([
    { _id: F.live, status: "CONFIRMED", pnr: "LIVE01", userId: STAFF, createdAt: new Date() },
    { _id: F.cancelled, status: "CANCELLED", pnr: "CANC01", userId: STAFF, createdAt: new Date(), cancellationCharge: 1500 },
  ]);
  await db.collection("sbthotelbookings").insertMany([
    { _id: H.live, status: "CONFIRMED", hotelName: "Live Inn", userId: STAFF, createdAt: new Date() },
    { _id: H.cancelled, status: "CANCELLED", hotelName: "Gone Inn", userId: STAFF, createdAt: new Date() },
  ]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe("SBT import — cancelled bookings", () => {
  it("the queue leaves cancelled flights and hotels out", async () => {
    const res = await as(request(app).get("/api/admin/manual-bookings/sbt-queue"));
    expect(res.status).toBe(200);
    const ids = res.body.items.map((i: any) => i._id);
    expect(ids).toContain(String(F.live));
    expect(ids).toContain(String(H.live));
    expect(ids).not.toContain(String(F.cancelled));
    expect(ids).not.toContain(String(H.cancelled));
  });

  it("refuses to import a cancelled flight or hotel and writes nothing", async () => {
    const res = await as(request(app).post("/api/admin/manual-bookings/import-from-sbt"))
      .send({ bookingIds: [String(F.cancelled), String(H.cancelled)] });
    expect(res.status).toBe(200);
    const details = res.body.details as any[];
    expect(details.map((d) => [d.bookingId, d.status, d.error])).toEqual([
      [String(F.cancelled), "failed", "cancelled booking — not imported"],
      [String(H.cancelled), "failed", "cancelled booking — not imported"],
    ]);
    expect(await mongoose.connection.db!.collection("manualbookings").countDocuments({})).toBe(0);
  });
});
