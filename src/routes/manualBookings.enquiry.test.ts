// apps/backend/src/routes/manualBookings.enquiry.test.ts
//
// POST /api/admin/manual-bookings/enquiry — a walk-in / phone enquiry logged
// by staff (ManualBookingForm mode="enquiry", /admin/manual-bookings/log-enquiry):
//   - same create as POST / (tenant gate, base rules, status gate), always
//     PENDING with no sub status, always MANUAL (no Book Now link);
//   - the lead passenger needs a phone or an email;
//   - the row is tagged metadata.channel = "ADMIN_ENQUIRY" by the ROUTE —
//     a client can't set metadata on either route;
//   - an enquiry can't reach Done without supplier / given by (the gate).
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

const { default: manualBookingsRouter, ADMIN_ENQUIRY_CHANNEL, ENQUIRY_CONTACT_REQUIRED } = await import("./manualBookings.js");

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

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("manual-bookings-enquiry-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
});

/** Only what the enquiry form requires: type, client, dates, lead name + a contact. */
const enquiry = (over: any = {}) => ({
  workspaceId: HOUSE_CUSTOMER,
  type: "FLIGHT",
  bookingDate: "2026-11-16",
  travelDate: "2027-01-18",
  passengers: [{ name: "Walk-in Guest", phone: "+919800000000", type: "ADULT" }],
  pricing: { actualPrice: 0, quotedPrice: 0 },
  notes: "Purpose: Leisure | Travelers: 2",
  ...over,
});
const logEnquiry = (b: any) => request(app).post("/api/admin/manual-bookings/enquiry").send(b);
const create = (b: any) => request(app).post("/api/admin/manual-bookings").send(b);
const put = (id: string, b: any) => request(app).put(`/api/admin/manual-bookings/${id}`).send(b);
const stored = async (id: string) => col("manualbookings").findOne({ _id: new mongoose.Types.ObjectId(id) });

describe("POST /enquiry", () => {
  for (const type of ["FLIGHT", "HOTEL", "TRAIN", "CAB", "VISA", "OTHER"]) {
    it(`${type}: only the required fields → 201, Pending, tagged ADMIN_ENQUIRY`, async () => {
      // A hotel still needs its city (not status-gated); its check-out is not needed.
      const res = await logEnquiry(enquiry({ type, ...(type === "HOTEL" ? { itinerary: { destination: "Goa" } } : {}) }));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const row: any = await stored(String(res.body.booking._id));
      expect([row.status, row.subStatus, row.source]).toEqual(["PENDING", "", "MANUAL"]);
      expect(row.metadata?.channel).toBe(ADMIN_ENQUIRY_CHANNEL);
      expect(row.supplierName ?? "").toBe("");
      expect(String(row.workspaceId)).toBe(HOUSE_CUSTOMER);
    });
  }

  it("a hotel with no return date saves", async () => {
    const res = await logEnquiry(enquiry({ type: "HOTEL", sector: "Goa" }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.booking.returnDate ?? null).toBeNull();
  });

  it("an email alone is enough contact; neither phone nor email is refused", async () => {
    expect((await logEnquiry(enquiry({ passengers: [{ name: "A", email: "a@x.test" }] }))).status).toBe(201);
    const res = await logEnquiry(enquiry({ passengers: [{ name: "A", phone: " ", email: "" }] }));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(ENQUIRY_CONTACT_REQUIRED);
  });

  it("is always Pending: any other status is refused", async () => {
    for (const status of ["WIP", "CONFIRMED", "CANCELLED"]) {
      const res = await logEnquiry(enquiry({ status, type: "VISA", supplierName: "VFS", givenBy: "R" }));
      expect([res.status, res.body.code], status).toEqual([400, "ENQUIRY_STATUS"]);
    }
    expect((await logEnquiry(enquiry({ status: "pending" }))).status).toBe(201);
  });

  it("a sub status sent by the client is dropped", async () => {
    const res = await logEnquiry(enquiry({ subStatus: "Pending for Customer Confirmation" }));
    expect(res.status).toBe(201);
    expect((await stored(String(res.body.booking._id)))!.subStatus).toBe("");
  });

  it("can't be a Book Now booking", async () => {
    const res = await logEnquiry(enquiry({ source: "ADMIN_QUEUE", sourceBookingId: String(oid()) }));
    expect([res.status, res.body.code]).toEqual([400, "ENQUIRY_SOURCE"]);
  });

  it("any client, not only HOUSE", async () => {
    const res = await logEnquiry(enquiry({ workspaceId: String(oid()) }));
    expect(res.status).toBe(201);
    expect((await stored(String(res.body.booking._id)) as any).metadata.channel).toBe(ADMIN_ENQUIRY_CHANNEL);
  });

  it("the base rules still apply (client required)", async () => {
    const res = await logEnquiry(enquiry({ workspaceId: "" }));
    expect([res.status, res.body.error]).toEqual([400, "workspaceId is required"]);
  });
});

describe("the tag can't be spoofed", () => {
  it("POST / ignores a client-sent metadata.channel", async () => {
    const res = await create({ ...enquiry(), type: "VISA", metadata: { channel: ADMIN_ENQUIRY_CHANNEL } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await stored(String(res.body.booking._id)) as any).metadata?.channel).toBeUndefined();
  });

  it("PUT can't set or change it either", async () => {
    const id = String((await logEnquiry(enquiry({ type: "VISA" }))).body.booking._id);
    expect((await put(id, { metadata: { channel: "TRAVEL_INTAKE_FORM" } })).status).toBe(200);
    expect((await stored(id) as any).metadata.channel).toBe(ADMIN_ENQUIRY_CHANNEL);
  });
});

describe("an enquiry becomes a booking on the edit page", () => {
  it("Done without supplier / given by → 400; with them → 200", async () => {
    const id = String((await logEnquiry(enquiry({ type: "VISA" }))).body.booking._id);
    const bare = await put(id, { status: "CONFIRMED" });
    expect(bare.status).toBe(400);
    expect(bare.body.details).toEqual(["Supplier Name is required", "Given By is required"]);
    const ok = await put(id, { status: "CONFIRMED", supplierName: "VFS Global", givenBy: "Rita" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await stored(id) as any).metadata.channel).toBe(ADMIN_ENQUIRY_CHANNEL); // the tag survives
  });

  it("a flight enquiry still needs its ticket to be Done", async () => {
    const id = String((await logEnquiry(enquiry())).body.booking._id);
    const res = await put(id, { status: "CONFIRMED", supplierName: "IndiGo", givenBy: "Rita" });
    expect([res.status, res.body.code]).toEqual([400, "ATTACHMENT_REQUIRED"]);
  });
});
