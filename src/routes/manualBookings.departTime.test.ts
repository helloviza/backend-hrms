// apps/backend/src/routes/manualBookings.departTime.test.ts
//
// Departure time on manual FLIGHT bookings (Travel Spend Phase B,
// utils/departTimeGate.ts, decision 2026-11-18):
//   - optional while Pending / WIP;
//   - every leg needs a time, or "Unknown", on the move INTO Confirmed (a new
//     booking at Done, or an edit into Done);
//   - a flight that is already Confirmed is not asked (legacy rows stay editable).
//
// Real: manual-bookings router, models, in-memory Mongo. Stubbed: the caller,
// requirePermission, mail, S3.
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
vi.mock("../utils/mailer.js", () => ({ sendMail: async () => ({ messageId: "test" }) }));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: async (o: any) => ({ bucket: "test-bucket", key: `${o.keyPrefix}/${o.originalName}`, url: "" }),
  getObjectBuffer: async (key: string) => Buffer.from(`BYTES:${key}`),
}));
vi.mock("../services/documentExtraction.service.js", async (orig) => ({ ...(await orig<any>()), enqueueExtraction: async () => undefined }));
vi.mock("../services/location.service.js", async (orig) => ({ ...(await orig<any>()), resolveActorFromRequest: async () => null }));

const { default: manualBookingsRouter } = await import("./manualBookings.js");

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const HOUSE_CUSTOMER = "6a4e0d2ea90c293c9e129f48";
const oid = () => new mongoose.Types.ObjectId();
const OPS = { sub: String(oid()), email: "rita@plumtrips.com", name: "Rita Menon", roles: ["SUPERADMIN"] };

const app = express();
app.use(express.json());
app.use("/api/admin/manual-bookings", (req: any, _res, next) => {
  req.user = { ...OPS, _id: OPS.sub };
  req.workspace = { customerId: "PLUMTRIPS-HOUSE" };
  req.workspaceObjectId = HOUSE;
  req.permissionScope = "ALL";
  next();
}, manualBookingsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const CLIENT = oid();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("manual-bookings-depart-time-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
});

const legs = (...times: (string | null)[]) =>
  times.map((t, i) => ({
    origin: i % 2 ? "BOM" : "DEL", destination: i % 2 ? "DEL" : "BOM", flightNo: `6E ${100 + i}`, airline: "IndiGo",
    departDate: "2027-01-18", ...(t === null ? {} : t === "unknown" ? { departTimeUnknown: true } : { departTime: t }),
  }));
const flight = (over: any = {}) => ({
  workspaceId: String(CLIENT), type: "FLIGHT", bookingDate: "2026-11-16", travelDate: "2027-01-18", status: "PENDING",
  supplierName: "TBO", givenBy: "Ops", passengers: [{ name: "Riya Sen", type: "ADULT" }],
  pricing: { actualPrice: 100, quotedPrice: 120 },
  itinerary: { origin: "DEL", destination: "BOM", flightNo: "6E 100", airline: "IndiGo", tripType: "ONE_WAY", legs: legs(null) },
  ...over,
});
const create = (b: any) => request(app).post("/api/admin/manual-bookings").send(b);
const put = (id: string, b: any) => request(app).put(`/api/admin/manual-bookings/${id}`).send(b);
const DT = (n: number) => `Leg ${n} Depart Time is required (or mark it Unknown)`;

describe("departure time on manual flights (Travel Spend Phase B)", () => {
  it("a Pending flight without a time saves", async () => {
    const r = await create(flight());
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("a new flight at Done is refused per leg without a time", async () => {
    const r = await create(flight({ status: "CONFIRMED", itinerary: { ...flight().itinerary, tripType: "ROUND_TRIP", legs: legs("06:30", null) } }));
    expect(r.status).toBe(400);
    expect(r.body.details).toContain(DT(2));
    expect(r.body.details).not.toContain(DT(1));
  });

  it("moving a flight into Done needs the time; 'Unknown' satisfies it and is stored", async () => {
    const id = String((await create(flight())).body.booking._id);
    const r1 = await put(id, { status: "CONFIRMED" });
    expect(r1.status).toBe(400);
    expect(r1.body.details).toContain(DT(1));
    const r2 = await put(id, { status: "CONFIRMED", itinerary: { ...flight().itinerary, legs: legs("unknown") } });
    // Past the time rule; the attachment gate (no ticket on record) is what stops it now.
    expect(String(r2.body.error || "")).not.toContain("Depart Time");
    expect(r2.body.code).toBe("ATTACHMENT_REQUIRED");
    const pending = await put(id, { itinerary: { ...flight().itinerary, legs: legs("unknown") } });
    expect(pending.status, JSON.stringify(pending.body)).toBe(200);
    const saved: any = await col("manualbookings").findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect(saved.itinerary.legs[0].departTimeUnknown).toBe(true);
  });

  it("an already-Done flight without a time stays editable", async () => {
    const { insertedId } = await col("manualbookings").insertOne({
      workspaceId: CLIENT, bookedBy: oid(), type: "FLIGHT", status: "CONFIRMED", source: "MANUAL", supplierName: "TBO", givenBy: "Ops",
      bookingDate: new Date("2026-10-01"), travelDate: new Date("2027-01-18"), passengers: [{ name: "Riya Sen", type: "ADULT" }],
      pricing: { actualPrice: 100, quotedPrice: 120, gstMode: "ON_MARKUP", gstPercent: 18, currency: "INR" },
      itinerary: { origin: "DEL", destination: "BOM", flightNo: "6E 1", airline: "IndiGo", legs: legs(null) },
      bookingRef: "MB-OLD-1",
    } as any);
    const r = await put(String(insertedId), { notes: "touch" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });
});
