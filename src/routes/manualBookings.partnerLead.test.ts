// apps/backend/src/routes/manualBookings.partnerLead.test.ts
//
// Manual bookings made for a partner lead case, against the same operations on
// an ordinary case's booking:
//   - each Status / Sub Status change of a partner booking writes one
//     "booking_status" row on the case (status, sub status, who, when); an
//     unchanged re-save writes none; an ordinary booking writes none, ever;
//   - the case rollup over several bookings (most advanced open booking; Done
//     only when none is open; Closed when all are cancelled);
//   - supplier / given-by optional while a partner booking is Pending / WIP,
//     required at Confirmed, ₹0 allowed while open; ordinary bookings keep the
//     old rule;
//   - (all bookings) a booking can't be re-pointed at another request on edit;
//   - (all bookings) a request with several bookings keeps every booking's
//     documents — a later booking's save no longer overwrites the list.
//
// Real: manual-bookings router, booking → request sync (markRequestDone, the
// email outbox), models, in-memory Mongo, raw-insert fixtures for the cases
// (the ordinary one has no meta.source at all). Stubbed: the caller,
// requirePermission, mail transport, S3, document extraction.
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
  const requireAuth = (_req: any, _res: any, next: any) => next(); // the caller is set by the mount below
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
const { bookingRollup } = await import("../services/partnerLeadBooking.js");

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
const AMBER_CUSTOMER = oid();
const ACME_CUSTOMER = oid();
let PARTNER_CASE: mongoose.Types.ObjectId;
let PARTNER_CASE_2: mongoose.Types.ObjectId;
let ORDINARY_CASE: mongoose.Types.ObjectId;

function caseRow(customerId: any, meta: any) {
  return {
    workspaceId: oid(), customerId: String(customerId), customerName: "X", frontlinerId: "f", frontlinerEmail: "f@x.test", managerEmail: "m@x.test",
    status: "approved", adminState: "in_progress", stage: "BOOKING_IN_PROGRESS", cartItems: [], history: [], meta,
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("manual-bookings-partner-lead-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  const ins = await col("approvalrequests").insertMany([
    caseRow(AMBER_CUSTOMER, { source: "PARTNER_LINK", travelFlow: "APPROVAL_DIRECT", partnerLead: { caseNumber: "PL-AAAAAA" } }),
    caseRow(AMBER_CUSTOMER, { source: "PARTNER_LINK", travelFlow: "APPROVAL_DIRECT", partnerLead: { caseNumber: "PL-BBBBBB" } }),
    caseRow(ACME_CUSTOMER, { travelFlow: "APPROVAL_DIRECT" }), // an ordinary case: no meta.source
  ] as any[]);
  [PARTNER_CASE, PARTNER_CASE_2, ORDINARY_CASE] = Object.values(ins.insertedIds) as any;
});

const partnerBody = (over: any = {}) => ({
  workspaceId: String(AMBER_CUSTOMER), type: "VISA", status: "PENDING", source: "ADMIN_QUEUE", sourceBookingId: String(PARTNER_CASE),
  travelDate: "2027-04-02", passengers: [{ name: "Riya Sen", type: "ADULT" }], pricing: { actualPrice: 0, quotedPrice: 0 }, ...over,
});
const ordinaryBody = (over: any = {}) => ({
  ...partnerBody(), workspaceId: String(ACME_CUSTOMER), sourceBookingId: String(ORDINARY_CASE), supplierName: "VFS", givenBy: "Ravi", ...over,
});
const create = (b: any) => request(app).post("/api/admin/manual-bookings").send(b);
const put = (id: string, b: any) => request(app).put(`/api/admin/manual-bookings/${id}`).send(b);
const cancel = (id: string) => request(app).post(`/api/admin/manual-bookings/${id}/cancel`).send({ reason: "CUSTOMER_CANCELLED" });
const rows = async (caseId: any) =>
  ((await col("approvalrequests").findOne({ _id: caseId }))!.history || []).filter((h: any) => h.action === "booking_status");
async function upload(bookingId: string, type: string, filename: string) {
  const res = await request(app).post(`/api/admin/manual-bookings/${bookingId}/attachments`)
    .field("type", type)
    .attach("file", Buffer.from("%PDF-1.4 fake"), { filename, contentType: "application/pdf" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.attachment._id);
}

/* ───────────────────────── case history from the booking ───────────────────────── */

describe("case history rows from a partner booking", () => {
  it("one row per Status / Sub Status change, with who and when; an unchanged re-save writes none", async () => {
    const created = await create(partnerBody());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body.booking._id);
    const ref = created.body.booking.bookingRef;

    expect((await put(id, { subStatus: "Lead Not Contactable" })).status).toBe(200);
    expect((await put(id, { notes: "called twice" })).status).toBe(200); // no status change
    expect((await put(id, { subStatus: "Lead Not Contactable", notes: "again" })).status).toBe(200);
    expect((await put(id, { subStatus: "NC Leads - Email Sent" })).status).toBe(200);
    expect((await put(id, { status: "WIP", subStatus: "" })).status).toBe(200);
    expect((await cancel(id)).status).toBe(200);

    const r = await rows(PARTNER_CASE);
    expect(r.map((h: any) => [h.bookingStatus, h.bookingSubStatus])).toEqual([
      ["PENDING", ""],
      ["PENDING", "Lead Not Contactable"],
      ["PENDING", "NC Leads - Email Sent"],
      ["WIP", ""],
      ["CANCELLED", ""],
    ]);
    expect(r[1].comment).toBe(`Booking ${ref}: Pending – Lead Not Contactable`);
    for (const h of r) {
      expect(h).toMatchObject({ actorKind: "staff", actorName: "Rita Menon", userEmail: OPS.email, manualBookingId: id, bookingRef: ref });
      expect(h.at).toBeInstanceOf(Date);
    }
  });

  it("an ordinary booking writes no row, whatever changes", async () => {
    const created = await create(ordinaryBody());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body.booking._id);
    const before: any = await col("approvalrequests").findOne({ _id: ORDINARY_CASE });
    expect((await put(id, { subStatus: "Pending for Customer Confirmation" })).status).toBe(200);
    expect((await put(id, { status: "WIP", subStatus: "" })).status).toBe(200);
    expect((await cancel(id)).status).toBe(200);
    const after: any = await col("approvalrequests").findOne({ _id: ORDINARY_CASE });
    expect(await rows(ORDINARY_CASE)).toEqual([]);
    // The ordinary case's trail is exactly what the booking sync wrote before this change.
    expect(after.history.map((h: any) => h.action)).toEqual(before.history.map((h: any) => h.action));
    expect(Object.keys(after.history[0] || {}).some((k) => k.startsWith("booking") && k !== "bookingRef")).toBe(false);
  });

  it("a booking for a partner case of ANOTHER customer is not a partner booking", async () => {
    // The route refuses CLIENT_MISMATCH, so point an ACME booking at Amber's case in the database.
    const id = String((await create(ordinaryBody())).body.booking._id);
    await col("manualbookings").updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { sourceBookingId: PARTNER_CASE } });
    const res = await put(id, { status: "WIP" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await rows(PARTNER_CASE)).toEqual([]);
  });
});

describe("case rollup over several bookings", () => {
  const b = (status: string, subStatus = "", min = 0, isActive?: boolean) => ({ status, subStatus, updatedAt: new Date(Date.UTC(2026, 9, 1, 0, min)), ...(isActive === false ? { isActive } : {}) });
  it("most advanced open booking; Done only when none is open; Closed when all are cancelled", () => {
    expect(bookingRollup([])).toEqual({ state: "none" });
    expect(bookingRollup([b("PENDING", "Lead Not Contactable"), b("CONFIRMED")])).toMatchObject({ state: "pending", label: "Pending – Lead Not Contactable" });
    expect(bookingRollup([b("PENDING"), b("WIP", "", 1), b("CONFIRMED", "", 2)])).toMatchObject({ state: "wip", label: "WIP" });
    expect(bookingRollup([b("PENDING", "NC Leads - Email Sent", 1), b("PENDING", "Lead Not Contactable", 2)])).toMatchObject({ label: "Pending – Lead Not Contactable" });
    expect(bookingRollup([b("CONFIRMED"), b("CANCELLED", "Plan changed", 5)])).toMatchObject({ state: "done", label: "Done" });
    expect(bookingRollup([b("INVOICED"), b("CANCELLED")])).toMatchObject({ state: "done" });
    expect(bookingRollup([b("CANCELLED", "Lead Not Contactable", 1), b("CANCELLED", "Plan changed", 0)])).toMatchObject({ state: "closed", label: "Cancelled – Lead Not Contactable" });
    // A deleted booking doesn't count.
    expect(bookingRollup([b("PENDING", "", 0, false), b("CONFIRMED")])).toMatchObject({ state: "done" });
  });
});

/* ───────────────────────── supplier / given-by ───────────────────────── */

describe("supplier name and given-by on partner bookings", () => {
  it("optional while Pending / WIP (₹0 allowed), required at Confirmed", async () => {
    const created = await create(partnerBody());
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = String(created.body.booking._id);
    expect((await put(id, { status: "WIP" })).status).toBe(200);
    const confirm = await put(id, { status: "CONFIRMED" });
    expect(confirm.status).toBe(400);
    expect(confirm.body.details).toEqual(["Supplier Name is required", "Given By is required"]);
    expect((await put(id, { status: "CONFIRMED", supplierName: "VFS Global", givenBy: "Rita" })).status).toBe(200);
    // Born Confirmed needs them too.
    const born = await create(partnerBody({ sourceBookingId: String(PARTNER_CASE_2), status: "CONFIRMED" }));
    expect(born.status).toBe(400);
    expect(born.body.details).toEqual(["Supplier Name is required", "Given By is required"]);
  });

  it("an ordinary booking keeps the old rule: required at create, whatever the status", async () => {
    const res = await create(ordinaryBody({ supplierName: "", givenBy: "" }));
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(["Supplier Name is required", "Given By is required"]);
  });
});

/* ───────────────────────── the linked request can't change ───────────────────────── */

describe("a booking's request is fixed at create (every booking)", () => {
  it("an edit can't re-point it; sending the same value is fine", async () => {
    const p = String((await create(partnerBody())).body.booking._id);
    const o = String((await create(ordinaryBody())).body.booking._id);
    for (const [id, own] of [[p, PARTNER_CASE], [o, ORDINARY_CASE]] as const) {
      const moved = await put(id, { sourceBookingId: String(PARTNER_CASE_2) });
      expect([moved.status, moved.body.code]).toEqual([400, "LINKED_CASE_LOCKED"]);
      expect((await put(id, { sourceBookingId: String(own), notes: "same" })).status).toBe(200);
    }
    // A manual booking with no request can't be attached to one later either.
    const manual = await create({ ...ordinaryBody(), source: "MANUAL", sourceBookingId: undefined });
    expect(manual.status).toBe(201);
    const attach = await put(String(manual.body.booking._id), { sourceBookingId: String(ORDINARY_CASE) });
    expect([attach.status, attach.body.code]).toEqual([400, "LINKED_CASE_LOCKED"]);
    expect(String((await col("manualbookings").findOne({ _id: new mongoose.Types.ObjectId(p) }))!.sourceBookingId)).toBe(String(PARTNER_CASE));
  });
});

/* ───────────────────────── documents of several bookings ───────────────────────── */

describe("a request with several bookings keeps every booking's documents (every request)", () => {
  it("a later booking's save adds its documents instead of replacing the list", async () => {
    const flight = (await create(ordinaryBody({ type: "FLIGHT" }))).body.booking;
    const hotel = (await create(ordinaryBody({ type: "HOTEL", sector: "Delhi", returnDate: "2027-04-05" }))).body.booking;
    const ticket = await upload(flight._id, "ticket", "ticket.pdf");
    expect((await put(flight._id, { status: "CONFIRMED" })).body.requestSync).toBe("completed");
    const voucher = await upload(hotel._id, "voucher", "voucher.pdf");
    expect((await put(hotel._id, { status: "CONFIRMED" })).status).toBe(200);
    // The flight saved again (an unrelated edit) keeps the hotel's voucher too.
    expect((await put(flight._id, { notes: "seat 12A" })).status).toBe(200);

    const docs = (await col("approvalrequests").findOne({ _id: ORDINARY_CASE }))!.meta.bookingDocuments;
    expect(docs.map((d: any) => [d.attachmentId, d.manualBookingId]).sort()).toEqual(
      [[ticket, String(flight._id)], [voucher, String(hotel._id)]].sort(),
    );
  });

  it("a list written before documents were tagged is kept and tagged with the booking that wrote it", async () => {
    const hotel = (await create(ordinaryBody({ type: "HOTEL", sector: "Delhi", returnDate: "2027-04-05" }))).body.booking;
    const earlier = String(oid());
    await col("approvalrequests").updateOne({ _id: ORDINARY_CASE }, {
      $set: {
        adminState: "done", stage: "COMPLETED", "meta.manualBookingId": earlier,
        "meta.bookingDocuments": [{ attachmentId: "old1", type: "ticket", filename: "old.pdf", s3Key: "k/old.pdf" }],
      },
    });
    await upload(hotel._id, "voucher", "voucher.pdf");
    const docs = (await col("approvalrequests").findOne({ _id: ORDINARY_CASE }))!.meta.bookingDocuments;
    expect(docs.find((d: any) => d.attachmentId === "old1")).toMatchObject({ manualBookingId: earlier });
    expect(docs.filter((d: any) => d.manualBookingId === String(hotel._id))).toHaveLength(1);
  });
});
