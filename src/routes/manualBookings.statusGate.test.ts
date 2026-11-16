// apps/backend/src/routes/manualBookings.statusGate.test.ts
//
// Supplier Name, Given By and a hotel's Check-out are gated on STATUS for
// every manual booking (utils/bookingStatusGate.ts, decision 2026-11-16):
//   - optional while Pending / WIP (create and edit);
//   - required on the move INTO Confirmed — ignoring Option B, so a row born
//     without them (public intake, an admin enquiry) can't reach Done
//     without them;
//   - on a row that is already Confirmed, Option B: only removing a value
//     that was there is refused (legacy Done rows stay editable);
//   - Cancelled never requires them; the NC / partner exemptions are
//     unchanged (manualBookings.ncLead.test.ts / manualBookings.partnerLead.test.ts).
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
const { statusGatedRequiredErrors } = await import("../utils/bookingStatusGate.js");

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
  await mongoose.connect(mongod.getUri("manual-bookings-status-gate-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
});

/** A plain /new booking with no supplier / given by. VISA: not attachment-gated. */
const body = (over: any = {}) => ({
  workspaceId: String(CLIENT),
  type: "VISA",
  bookingDate: "2026-11-16",
  travelDate: "2027-01-18",
  status: "PENDING",
  passengers: [{ name: "Riya Sen", type: "ADULT" }],
  pricing: { actualPrice: 100, quotedPrice: 120 },
  ...over,
});
const create = (b: any) => request(app).post("/api/admin/manual-bookings").send(b);
const put = (id: string, b: any) => request(app).put(`/api/admin/manual-bookings/${id}`).send(b);

/** A row shaped like services/travelIntake.create.ts writes it: no supplier, no given by, no check-out. */
async function intakeRow(over: any = {}) {
  const { insertedId } = await col("manualbookings").insertOne({
    workspaceId: new mongoose.Types.ObjectId(HOUSE_CUSTOMER),
    bookedBy: oid(), createdBy: "system-intake", type: "VISA", status: "PENDING", subStatus: "", source: "MANUAL",
    bookingDate: new Date(), travelDate: new Date("2027-01-18"),
    passengers: [{ name: "Walk-in", type: "ADULT" }],
    pricing: { actualPrice: 0, quotedPrice: 0, gstMode: "ON_MARKUP", gstPercent: 18, currency: "INR" },
    assignmentStatus: "PENDING_TO_ASSIGN", metadata: { intakeRef: "public:x", channel: "TRAVEL_INTAKE_FORM" },
    bookingRef: `QC-${Math.random().toString(36).slice(2, 8)}`,
    ...over,
  });
  return String(insertedId);
}

describe("open bookings don't need supplier / given by", () => {
  it("Pending create with no supplier → 201", async () => {
    const res = await create(body());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.booking.status).toBe("PENDING");
  });

  it("WIP create with no supplier → 201, and moving Pending ↔ WIP stays light", async () => {
    expect((await create(body({ status: "WIP" }))).status).toBe(201);
    const id = String((await create(body())).body.booking._id);
    expect((await put(id, { status: "WIP" })).status).toBe(200);
    expect((await put(id, { status: "PENDING" })).status).toBe(200);
  });

  it("a hotel without a check-out date saves while Pending (city still required)", async () => {
    const res = await create(body({ type: "HOTEL", sector: "Goa" }));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const noCity = await create(body({ type: "HOTEL" }));
    expect(noCity.body.details).toEqual(["City is required for hotel bookings"]);
  });
});

describe("Confirmed (Done) needs supplier and given by", () => {
  it("move to Done with no supplier → 400", async () => {
    const id = String((await create(body())).body.booking._id);
    const res = await put(id, { status: "CONFIRMED" });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(["Supplier Name is required", "Given By is required"]);
    expect(res.body.error).toBe("Supplier Name is required; Given By is required");
  });

  it("move to Done with supplier + given by → 200", async () => {
    const id = String((await create(body())).body.booking._id);
    const res = await put(id, { status: "CONFIRMED", supplierName: "VFS Global", givenBy: "Rita" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.booking.status).toBe("CONFIRMED");
  });

  it("only the missing one is named", async () => {
    const id = String((await create(body({ supplierName: "VFS Global" }))).body.booking._id);
    expect((await put(id, { status: "CONFIRMED" })).body.details).toEqual(["Given By is required"]);
  });

  it("born Confirmed without them → 400", async () => {
    const res = await create(body({ status: "CONFIRMED" }));
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(["Supplier Name is required", "Given By is required"]);
  });

  it("a hotel needs its check-out to enter Done", async () => {
    const id = String((await create(body({ type: "HOTEL", sector: "Goa", supplierName: "Taj", givenBy: "Rita" }))).body.booking._id);
    const res = await put(id, { status: "CONFIRMED" });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(["Check-out (return) date is required for hotel bookings"]);
    // With the check-out it reaches the (unchanged) attachment gate instead.
    const next = await put(id, { status: "CONFIRMED", returnDate: "2027-01-20" });
    expect([next.status, next.body.code]).toEqual([400, "ATTACHMENT_REQUIRED"]);
  });
});

describe("Option B: shields an already-Done row, never the move into Done", () => {
  it("an intake-born row (no supplier) → Done → 400; with both → 200", async () => {
    const id = await intakeRow();
    const res = await put(id, { status: "CONFIRMED" });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(["Supplier Name is required", "Given By is required"]);
    const ok = await put(id, { status: "CONFIRMED", supplierName: "VFS Global", givenBy: "Rita" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("an intake-born row can still be edited while open", async () => {
    const id = await intakeRow();
    expect((await put(id, { notes: "called back", status: "WIP" })).status).toBe(200);
  });

  it("a legacy Done row without supplier / given by can still be edited → 200", async () => {
    const id = await intakeRow({ status: "CONFIRMED" });
    const res = await put(id, { notes: "typo fix" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.booking.status).toBe("CONFIRMED");
  });

  it("a Done row that has a supplier can't have it cleared → 400", async () => {
    const id = await intakeRow({ status: "CONFIRMED", supplierName: "VFS Global", givenBy: "Rita" });
    const res = await put(id, { supplierName: "" });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(["Supplier Name is required"]);
    const gb = await put(id, { givenBy: " " });
    expect(gb.body.details).toEqual(["Given By is required"]);
  });

  it("a legacy Done hotel without check-out stays editable, one with it can't drop it", async () => {
    const legacy = await intakeRow({ status: "CONFIRMED", type: "HOTEL", sector: "Goa" });
    expect((await put(legacy, { notes: "x" })).status).toBe(200);
    const withOut = await intakeRow({ status: "CONFIRMED", type: "HOTEL", sector: "Goa", returnDate: new Date("2027-01-20") });
    const res = await put(withOut, { returnDate: null });
    expect(res.body.details).toEqual(["Check-out (return) date is required for hotel bookings"]);
  });

  it("Option B still protects open legacy rows from other blanked fields", async () => {
    // City is not status-gated: blanking a present city is still refused.
    const id = String((await create(body({ type: "HOTEL", sector: "Goa" }))).body.booking._id);
    const res = await put(id, { sector: "" });
    expect(res.body.details).toEqual(["City is required for hotel bookings"]);
  });
});

describe("Cancelled never needs supplier / given by / check-out", () => {
  it("cancel an enquiry with no supplier → 200", async () => {
    const id = String((await create(body())).body.booking._id);
    const res = await put(id, { status: "CANCELLED" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.booking.status).toBe("CANCELLED");
  });

  it("born Cancelled without them → 201, hotel without check-out too", async () => {
    expect((await create(body({ status: "CANCELLED" }))).status).toBe(201);
    expect((await create(body({ status: "CANCELLED", type: "HOTEL", sector: "Goa" }))).status).toBe(201);
  });

  it("a cancelled row may have its supplier cleared", async () => {
    const id = await intakeRow({ status: "CANCELLED", supplierName: "VFS Global", givenBy: "Rita" });
    expect((await put(id, { supplierName: "", givenBy: "" })).status).toBe(200);
  });
});

describe("statusGatedRequiredErrors (unit)", () => {
  const ALL = ["Supplier Name is required", "Given By is required", "City is required for hotel bookings", "Check-out (return) date is required for hotel bookings"];
  it("open statuses drop the gated three and keep the rest", () => {
    for (const status of ["PENDING", "WIP", "pending", ""]) {
      expect(statusGatedRequiredErrors(ALL, { status, type: "HOTEL" })).toEqual(["City is required for hotel bookings"]);
    }
  });
  it("Confirmed adds what is missing, in a stable order, even when the base list omitted it", () => {
    expect(statusGatedRequiredErrors(["City is required for hotel bookings"], { status: "CONFIRMED", type: "HOTEL" })).toEqual(ALL);
    expect(statusGatedRequiredErrors([], { status: "CONFIRMED", type: "HOTEL", supplierName: "Taj", givenBy: "R", returnDate: "2027-01-01" })).toEqual([]);
    expect(statusGatedRequiredErrors([], { status: "CONFIRMED", type: "VISA" })).toEqual(ALL.slice(0, 2));
  });
  it("SBT-sourced rows are never asked for Given By (supplier still required)", () => {
    for (const source of ["SBT", "SBT_AUTO"]) {
      expect(statusGatedRequiredErrors([], { status: "CONFIRMED", type: "FLIGHT", source })).toEqual(["Supplier Name is required"]);
      expect(statusGatedRequiredErrors([], { status: "CONFIRMED", type: "FLIGHT", source, supplierName: "TBO" })).toEqual([]);
    }
    expect(statusGatedRequiredErrors([], { status: "CONFIRMED", type: "FLIGHT", source: "MANUAL", supplierName: "TBO" })).toEqual(["Given By is required"]);
  });
  it("Cancelled drops the gated three and keeps the rest", () => {
    expect(statusGatedRequiredErrors(ALL, { status: "CANCELLED", type: "HOTEL" })).toEqual(["City is required for hotel bookings"]);
    expect(statusGatedRequiredErrors([], { status: "CANCELLED", type: "HOTEL" })).toEqual([]);
  });
  it("already Confirmed: the base (Option B) list passes through unchanged", () => {
    expect(statusGatedRequiredErrors([], { status: "CONFIRMED", type: "HOTEL" }, "CONFIRMED")).toEqual([]);
    expect(statusGatedRequiredErrors(["Supplier Name is required"], { status: "CONFIRMED", type: "VISA" }, "confirmed")).toEqual(["Supplier Name is required"]);
    // From any other status it is a transition — everything missing is named.
    expect(statusGatedRequiredErrors([], { status: "CONFIRMED", type: "VISA" }, "WIP")).toEqual(ALL.slice(0, 2));
  });
});
