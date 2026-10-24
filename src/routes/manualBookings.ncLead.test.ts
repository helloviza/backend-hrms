// apps/backend/src/routes/manualBookings.ncLead.test.ts
//
// "Not Contactable" leads (utils/ncLead.ts):
//   - each of the four NC pairs (Pending × 3, Cancelled × 1) saves with only
//     the basics — no supplier, given by, PNR, prices or hotel city — for a
//     partner booking and an ordinary one, on create and on update;
//   - the basics are still required (type, client, booking date, travel date,
//     a passenger name);
//   - moving OFF an NC sub status re-applies the full create rules: to
//     Pending for Customer Confirmation / WIP / Confirmed with missing fields
//     is refused (partner bookings keep their own supplier rule while open);
//   - every other Status / Sub Status is validated exactly as before;
//   - partner bookings still write a case history row for each NC change.
//
// Real: manual-bookings router, booking → request sync, models, in-memory
// Mongo, raw-insert cases. Stubbed: the caller, requirePermission, mail, S3.
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
const { NC_LEAD_SUB_STATUSES, isNcLead } = await import("../utils/ncLead.js");

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
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
const AMBER = oid();
const ACME = oid();
let PARTNER_CASE: any;
let ORDINARY_CASE: any;

const NC_PAIRS: Array<[string, string]> = [
  ["PENDING", "Lead Not Contactable"],
  ["PENDING", "NC Leads - Email Sent"],
  ["PENDING", "NC Leads - Multiple Follow-up Done"],
  ["CANCELLED", "Lead Not Contactable"],
];

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("manual-bookings-nc-lead-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  const base = { workspaceId: oid(), frontlinerId: "f", frontlinerEmail: "f@x.test", managerEmail: "m@x.test", status: "approved", adminState: "in_progress", stage: "BOOKING_IN_PROGRESS", cartItems: [], history: [] };
  const ins = await col("approvalrequests").insertMany([
    { ...base, customerId: String(AMBER), meta: { source: "PARTNER_LINK", travelFlow: "APPROVAL_DIRECT", partnerLead: { caseNumber: "PL-AAAAAA" } } },
    { ...base, customerId: String(ACME), meta: { travelFlow: "APPROVAL_DIRECT" } },
  ] as any[]);
  [PARTNER_CASE, ORDINARY_CASE] = Object.values(ins.insertedIds);
});

/** Only the basics: no supplier, given by, PNR, prices, itinerary or hotel city. */
const minimal = (kind: "partner" | "ordinary", status: string, subStatus: string, over: any = {}) => ({
  workspaceId: String(kind === "partner" ? AMBER : ACME),
  source: "ADMIN_QUEUE",
  sourceBookingId: String(kind === "partner" ? PARTNER_CASE : ORDINARY_CASE),
  type: "FLIGHT",
  bookingDate: "2026-10-24",
  travelDate: "2027-01-18",
  status,
  subStatus,
  passengers: [{ name: "Riya Sen", type: "ADULT" }],
  ...over,
});
const create = (b: any) => request(app).post("/api/admin/manual-bookings").send(b);
const put = (id: string, b: any) => request(app).put(`/api/admin/manual-bookings/${id}`).send(b);

describe("the NC list", () => {
  it("is exactly the four new pairs", () => {
    expect(NC_LEAD_SUB_STATUSES).toEqual({
      PENDING: ["Lead Not Contactable", "NC Leads - Email Sent", "NC Leads - Multiple Follow-up Done"],
      CANCELLED: ["Lead Not Contactable"],
    });
    expect(isNcLead("PENDING", "Pending for Customer Confirmation")).toBe(false);
    expect(isNcLead("CANCELLED", "NC Leads - Email Sent")).toBe(false); // a Pending-only value
    expect(isNcLead("WIP", "Lead Not Contactable")).toBe(false);
    expect(isNcLead("pending", "Lead Not Contactable")).toBe(true);
  });
});

describe("an NC lead saves with only the basics", () => {
  for (const kind of ["partner", "ordinary"] as const) {
    for (const [status, sub] of NC_PAIRS) {
      it(`${kind} · ${status} · ${sub}`, async () => {
        const res = await create(minimal(kind, status, sub));
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        const b = res.body.booking;
        expect([b.status, b.subStatus]).toEqual([status, sub]);
        expect(b.pricing?.grandTotal ?? 0).toBe(0);
      });
    }
  }

  it("a hotel NC lead needs no city or check-out either", async () => {
    expect((await create(minimal("ordinary", "PENDING", "Lead Not Contactable", { type: "HOTEL" }))).status).toBe(201);
  });

  it("the basics are still required", async () => {
    const res = await create(minimal("ordinary", "PENDING", "Lead Not Contactable", { travelDate: undefined, passengers: [{ name: " " }], bookingDate: undefined }));
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(["Booking Date is required", "Travel Date is required", "Passenger name is required"]);
  });

  it("moving between NC values on update stays light", async () => {
    const id = String((await create(minimal("ordinary", "PENDING", "Lead Not Contactable"))).body.booking._id);
    expect((await put(id, { subStatus: "NC Leads - Email Sent" })).status).toBe(200);
    expect((await put(id, { subStatus: "NC Leads - Multiple Follow-up Done" })).status).toBe(200);
    expect((await put(id, { status: "CANCELLED", subStatus: "Lead Not Contactable" })).status).toBe(200);
  });
});

describe("leaving NC re-applies the full rules", () => {
  it("ordinary: to Pending for Customer Confirmation, WIP or Confirmed with missing fields is refused", async () => {
    const id = String((await create(minimal("ordinary", "PENDING", "Lead Not Contactable"))).body.booking._id);
    for (const change of [{ subStatus: "Pending for Customer Confirmation" }, { status: "WIP", subStatus: "" }]) {
      const r = await put(id, change);
      expect(r.status, JSON.stringify(change)).toBe(400);
      expect(r.body.details).toEqual(["Supplier Name is required", "Given By is required"]);
    }
    const confirm = await put(id, { status: "CONFIRMED", subStatus: "", supplierName: "IndiGo", givenBy: "Rita" });
    expect([confirm.status, confirm.body.code]).toEqual([400, "ATTACHMENT_REQUIRED"]);
    // With everything it goes through to WIP.
    expect((await put(id, { status: "WIP", subStatus: "", supplierName: "IndiGo", givenBy: "Rita" })).status).toBe(200);
  });

  it("partner: still open (WIP) keeps the partner relaxation; Confirmed needs supplier, given by and the attachment", async () => {
    const id = String((await create(minimal("partner", "PENDING", "Lead Not Contactable"))).body.booking._id);
    expect((await put(id, { status: "WIP", subStatus: "" })).status).toBe(200);
    const confirm = await put(id, { status: "CONFIRMED" });
    expect(confirm.status).toBe(400);
    expect(confirm.body.details).toEqual(["Supplier Name is required", "Given By is required"]);
  });

  it("a hotel NC lead moved to Pending for Supplier Confirmation needs its city and check-out back", async () => {
    const id = String((await create(minimal("ordinary", "PENDING", "Lead Not Contactable", { type: "HOTEL", supplierName: "Taj", givenBy: "Rita" }))).body.booking._id);
    const r = await put(id, { subStatus: "Pending for Supplier Confirmation" });
    expect(r.status).toBe(400);
    expect(r.body.details).toEqual(["City is required for hotel bookings", "Check-out (return) date is required for hotel bookings"]);
  });
});

describe("every other Status / Sub Status: exactly as before", () => {
  // The required-field answer per status for a create with no supplier / given by (today's rule set).
  const SNAPSHOT: Array<[string, string, string[]]> = [
    ["PENDING", "", ["Supplier Name is required", "Given By is required"]],
    ["PENDING", "Pending for Customer Confirmation", ["Supplier Name is required", "Given By is required"]],
    ["PENDING", "Pending for Supplier Confirmation", ["Supplier Name is required", "Given By is required"]],
    ["WIP", "", ["Supplier Name is required", "Given By is required"]],
    ["CONFIRMED", "", ["Supplier Name is required", "Given By is required"]],
    ["CANCELLED", "Plan changed", ["Supplier Name is required", "Given By is required"]],
    ["CANCELLED", "Travel cancelled", ["Supplier Name is required", "Given By is required"]],
  ];
  for (const [status, sub, expected] of SNAPSHOT) {
    it(`ordinary · ${status} · ${sub || "(none)"}`, async () => {
      const res = await create(minimal("ordinary", status, sub, { type: "VISA" }));
      expect(res.status).toBe(400);
      expect(res.body.details).toEqual(expected);
    });
  }

  it("an ordinary non-NC hotel still needs city and check-out", async () => {
    const res = await create(minimal("ordinary", "PENDING", "", { type: "HOTEL", supplierName: "Taj", givenBy: "Rita" }));
    expect(res.body.details).toEqual(["City is required for hotel bookings", "Check-out (return) date is required for hotel bookings"]);
  });

  it("the partner relaxation is unchanged: open without supplier OK, Confirmed refused", async () => {
    expect((await create(minimal("partner", "PENDING", "Pending for Customer Confirmation", { type: "VISA" }))).status).toBe(201);
    const confirmed = await create({ ...minimal("partner", "CONFIRMED", "", { type: "VISA" }), sourceBookingId: String(PARTNER_CASE) });
    expect(confirmed.body.details).toEqual(["Supplier Name is required", "Given By is required"]);
  });

  it("Option B on update is unchanged for a booking that was never NC", async () => {
    // A legacy booking without a supplier stays editable (the field was never present).
    const id = String((await create(minimal("ordinary", "PENDING", "", { type: "VISA", supplierName: "VFS", givenBy: "Rita" }))).body.booking._id);
    await col("manualbookings").updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $unset: { supplierName: 1, givenBy: 1 } });
    const res = await put(id, { status: "WIP" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe("partner case history for NC changes", () => {
  it("one booking_status row per NC change", async () => {
    const id = String((await create(minimal("partner", "PENDING", "Lead Not Contactable"))).body.booking._id);
    await put(id, { subStatus: "NC Leads - Email Sent" });
    await put(id, { subStatus: "NC Leads - Multiple Follow-up Done" });
    await put(id, { status: "CANCELLED", subStatus: "Lead Not Contactable" });
    const rows = ((await col("approvalrequests").findOne({ _id: PARTNER_CASE }))!.history || []).filter((h: any) => h.action === "booking_status");
    expect(rows.map((h: any) => [h.bookingStatus, h.bookingSubStatus])).toEqual([
      ["PENDING", "Lead Not Contactable"],
      ["PENDING", "NC Leads - Email Sent"],
      ["PENDING", "NC Leads - Multiple Follow-up Done"],
      ["CANCELLED", "Lead Not Contactable"],
    ]);
  });
});
