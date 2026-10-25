// apps/backend/src/routes/manualBookings.attachmentTypes.test.ts
//
// Attachment types on a manual booking:
//   ticket / voucher  customer documents: request Documents, the "booking
//                     done" email, My Bookings, the partner / student tracker;
//   internal          staff only — never on any customer surface;
//   other             legacy, exactly as before: staff + My Bookings only.
// Plus the type change after upload (PATCH): validated, recorded (who, when),
// and it re-syncs a booked request's documents without a second email.
//
// Real: approvals, bookingHistory, manualBookings and myBookings routers,
// markRequestDone, the email outbox, the partner tracker services, in-memory
// Mongo. Stubbed (same as approvals.bookingCompletion.test.ts): requireAuth,
// requireWorkspace, requirePermission, mail transport, S3, extraction.
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

const { mails, presigned } = vi.hoisted(() => ({ mails: [] as any[], presigned: [] as any[] }));

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", async (orig) => ({
  ...(await orig<any>()),
  requireWorkspace: async (req: any, res: any, next: any) => {
    const { default: mg } = await import("mongoose");
    const id = String(req.headers["x-test-ws"] || "");
    const ws = await mg.connection.db!.collection("customerworkspaces").findOne({ _id: new mg.Types.ObjectId(id) });
    if (!ws) return res.status(403).json({ error: "no workspace" });
    req.workspace = ws;
    req.workspaceObjectId = ws._id;
    req.workspaceId = String(ws._id);
    next();
  },
}));
vi.mock("../middleware/requirePermission.js", () => ({
  requirePermission: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../utils/mailer.js", () => ({
  sendMail: async (m: any) => {
    mails.push(m);
    return { messageId: "test" };
  },
}));
vi.mock("../utils/s3Upload.js", () => ({
  uploadBufferToS3: async (o: any) => ({ bucket: "test-bucket", key: `${o.keyPrefix}/${o.originalName}`, url: "" }),
  getObjectBuffer: async (key: string) => Buffer.from(`BYTES:${key}`),
}));
vi.mock("../utils/s3Presign.js", () => ({
  presignGetObject: async (o: any) => {
    presigned.push(o);
    return `https://signed.test/${o.key}`;
  },
}));
vi.mock("../services/documentExtraction.service.js", async (orig) => ({
  ...(await orig<any>()),
  enqueueExtraction: async () => undefined,
}));
vi.mock("../services/location.service.js", async (orig) => ({
  ...(await orig<any>()),
  resolveActorFromRequest: async () => null,
}));
vi.mock("../services/tbo.flight.service.js", async (orig) => {
  const { vi: v } = await import("vitest");
  return { ...(await orig<any>()), searchFlights: v.fn() };
});
vi.mock("../services/tbo.hotel.search.service.js", async (orig) => {
  const { vi: v } = await import("vitest");
  return { ...(await orig<any>()), searchHotels: v.fn() };
});
vi.mock("../utils/emailActionToken.js", () => ({ signEmailActionToken: () => "tok", verifyEmailActionToken: () => null, hashToken: () => "hash" }));

const { default: approvalsRouter } = await import("./approvals.js");
const { default: bookingHistoryRouter } = await import("./bookingHistory.js");
const { default: manualBookingsRouter } = await import("./manualBookings.js");
const { default: myBookingsRouter } = await import("./myBookings.js");
const { bookingsOfCases } = await import("../services/partnerLeadBooking.js");
const { trackerRow } = await import("../services/partnerLeadTracker.js");

const app = express();
app.use(express.json());
app.use("/api/approvals", approvalsRouter);
app.use("/api/booking-history", bookingHistoryRouter);
app.use("/api/admin/manual-bookings", (req: any, _res, next) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  req.user._id = req.user.sub;
  req.workspace = { customerId: "PLUMTRIPS-HOUSE" };
  req.workspaceObjectId = HOUSE;
  req.permissionScope = "ALL";
  next();
}, manualBookingsRouter);
// server.ts mounts My Bookings behind requireAuth + requireWorkspace.
app.use("/api/my-bookings", async (req: any, res, next) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  const ws = await col("customerworkspaces").findOne({ _id: new mongoose.Types.ObjectId(String(req.headers["x-test-ws"])) });
  if (!ws) return res.status(403).json({ error: "no workspace" });
  req.workspace = ws;
  req.workspaceObjectId = ws._id;
  next();
}, myBookingsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const ACME = oid();
const ACME_CUSTOMER = oid(); // Customer._id — what a manual booking's workspaceId holds

type Who = { sub: string; email: string; name: string; roles: string[]; ws: any };
const person = (email: string, name: string, roles: string[], ws: any): Who => ({ sub: String(oid()), email, name, roles, ws });
const ASHA = person("asha@acme.test", "Asha Rao", ["CUSTOMER"], ACME); // requester + passenger
const MEERA = person("meera@acme.test", "Meera Iyer", ["CUSTOMER"], ACME); // approver
const LEELA = person("leela@acme.test", "Leela Shah", ["WORKSPACE_LEADER", "CUSTOMER"], ACME);
const OPS = person("neel@plumtrips.com", "Neel Bhatia", ["SUPERADMIN"], HOUSE);

const as = (r: request.Test, who: Who) =>
  r
    .set("x-test-user", JSON.stringify({ sub: who.sub, _id: who.sub, email: who.email, name: who.name, roles: who.roles, workspaceId: String(who.ws), customerId: String(who.ws) }))
    .set("x-test-ws", String(who.ws));

const flightItem = {
  type: "flight",
  title: "BLR → DEL",
  qty: 1,
  price: 0,
  meta: { origin: "BLR", destination: "DEL", tripType: "oneway", departDate: "2027-04-02", travelScope: "domestic", travellers: [{ kind: "manual", firstName: "Asha", lastName: "Rao" }] },
};

/** Marks a staff-only file wherever it could leak: its name and (through it) its S3 key. */
const SENTINEL = "INTERNAL-SENTINEL-supplier-invoice";

async function approvedRequest() {
  const created = await as(request(app).post("/api/approvals/requests"), ASHA).send({ cartItems: [flightItem] });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = String(created.body.request._id);
  const approved = await as(request(app).put(`/api/approvals/requests/${id}/action`), MEERA).send({ action: "approved" });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return id;
}

async function createBooking(rid: string, over: any = {}) {
  const res = await as(request(app).post("/api/admin/manual-bookings"), OPS).send({
    workspaceId: String(ACME_CUSTOMER),
    type: "FLIGHT",
    status: "PENDING",
    source: "ADMIN_QUEUE",
    sourceBookingId: rid,
    supplierName: "IndiGo",
    givenBy: "Asha Rao",
    travelDate: "2027-04-02",
    passengers: [{ name: "Asha Rao", type: "ADULT", email: ASHA.email }],
    pricing: { actualPrice: 9800, quotedPrice: 12000 },
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.booking;
}

async function upload(bookingId: string, type: string, filename: string) {
  const res = await as(request(app).post(`/api/admin/manual-bookings/${bookingId}/attachments`), OPS)
    .field("type", type)
    .attach("file", Buffer.from("%PDF-1.4 fake"), { filename, contentType: "application/pdf" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.attachment._id);
}

const setType = (bookingId: string, attId: string, type: string) =>
  as(request(app).patch(`/api/admin/manual-bookings/${bookingId}/attachments/${attId}`), OPS).send({ type });

const markDone = (bookingId: string) => as(request(app).put(`/api/admin/manual-bookings/${bookingId}`), OPS).send({ status: "CONFIRMED" });

const getDoc = (id: string) => col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(id) }) as Promise<any>;
const getBooking = (id: string) => col("manualbookings").findOne({ _id: new mongoose.Types.ObjectId(id) }) as Promise<any>;

/** Mails to the requester that carry files (the "booking done" email). */
const doneMails = () => mails.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(ASHA.email) && m.attachments?.length);

/** A booked request whose booking holds a ticket, an internal file and a legacy "other" file. */
async function bookedWithAllTypes() {
  const rid = await approvedRequest();
  const booking = await createBooking(rid);
  const ticketId = await upload(booking._id, "ticket", "e-ticket.pdf");
  const internalId = await upload(booking._id, "internal", `${SENTINEL}.pdf`);
  const otherId = await upload(booking._id, "other", "legacy-other.pdf");
  mails.length = 0;
  const done = await markDone(booking._id);
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect(done.body.requestSync).toBe("completed");
  return { rid, bookingId: String(booking._id), bookingRef: String(booking.bookingRef), ticketId, internalId, otherId };
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("manual-booking-attachment-types-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  mails.length = 0;
  presigned.length = 0;
  await mongoose.connection.db!.dropDatabase();
  const direct = { travelFlow: "APPROVAL_DIRECT", features: { approvalDirectEnabled: true } };
  await col("customerworkspaces").insertMany([
    { _id: HOUSE, customerId: "PLUMTRIPS-HOUSE", name: "Plumtrips", status: "ACTIVE", config: { features: {} } },
    { _id: ACME, customerId: String(ACME_CUSTOMER), name: "Peachmint Advisors", companyName: "Peachmint Advisors", status: "ACTIVE", tenantType: "CORPORATE", defaultApproverEmails: [MEERA.email], config: direct },
  ] as any[]);
  await col("users").insertMany([
    ...[ASHA, MEERA, LEELA].map((u) => ({ _id: new mongoose.Types.ObjectId(u.sub), workspaceId: u.ws, email: u.email, name: u.name, firstName: u.name.split(" ")[0], lastName: u.name.split(" ")[1], roles: u.roles, status: "ACTIVE", passwordHash: "x" })),
    { _id: new mongoose.Types.ObjectId(OPS.sub), workspaceId: HOUSE, email: OPS.email, firstName: "Neel", lastName: "Bhatia", roles: OPS.roles, status: "ACTIVE", passwordHash: "x" },
  ] as any[]);
  await col("customermembers").insertOne({ email: LEELA.email, customerId: String(ACME_CUSTOMER), workspaceId: ACME, role: "WORKSPACE_LEADER", isActive: true } as any);
});

/* ───────────────────────── upload + type change ───────────────────────── */

describe("attachment types — upload and change", () => {
  it("upload accepts ticket, voucher, document, internal and other; anything else is 400", async () => {
    const rid = await approvedRequest();
    const booking = await createBooking(rid);
    for (const t of ["ticket", "voucher", "document", "internal", "other"]) await upload(booking._id, t, `${t}.pdf`);
    const bad = await as(request(app).post(`/api/admin/manual-bookings/${booking._id}/attachments`), OPS)
      .field("type", "secret")
      .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "x.pdf", contentType: "application/pdf" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("type must be one of: ticket, voucher, document, internal, other");
    expect((await getBooking(booking._id)).attachments.map((a: any) => a.type)).toEqual(["ticket", "voucher", "document", "internal", "other"]);
  });

  it("the picker saves: PATCH changes the type and records who and when; a bad type or unknown file is refused", async () => {
    const rid = await approvedRequest();
    const booking = await createBooking(rid);
    const attId = await upload(booking._id, "other", "e-ticket.pdf");

    const res = await setType(booking._id, attId, "ticket");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.attachment.type).toBe("ticket");
    const att = (await getBooking(booking._id)).attachments[0];
    expect(att.type).toBe("ticket");
    expect(att.typeChanges).toHaveLength(1);
    expect(att.typeChanges[0]).toMatchObject({ from: "other", to: "ticket", byName: "Neel Bhatia" });
    expect(String(att.typeChanges[0].by)).toBe(OPS.sub);
    expect(att.typeChanges[0].at).toBeInstanceOf(Date);

    // Same type again: nothing to record.
    expect((await setType(booking._id, attId, "ticket")).status).toBe(200);
    expect((await getBooking(booking._id)).attachments[0].typeChanges).toHaveLength(1);

    expect((await setType(booking._id, attId, "secret")).status).toBe(400);
    expect((await setType(booking._id, String(oid()), "voucher")).status).toBe(404);
    expect((await setType(String(oid()), attId, "voucher")).status).toBe(404);
  });
});

/* ───────────────────────── booking done + re-sync ───────────────────────── */

describe("booking done — documents and email follow the type", () => {
  it("booking_done attaches the ticket only: never the internal or legacy other file", async () => {
    const { rid, bookingId } = await bookedWithAllTypes();
    const doc = await getDoc(rid);
    expect(doc.meta.bookingDocuments.map((d: any) => [d.type, d.filename])).toEqual([["ticket", "e-ticket.pdf"]]);
    const mail = doneMails();
    expect(mail).toHaveLength(1);
    expect(mail[0].attachments.map((a: any) => a.filename)).toEqual(["e-ticket.pdf"]);
    expect(String(mail[0].attachments[0].content)).toBe(`BYTES:bookings/attachments/${bookingId}/e-ticket.pdf`);
  });

  it("a hotel booking's voucher is attached to the booking_done email", async () => {
    const rid = await approvedRequest();
    const booking = await createBooking(rid, { type: "HOTEL", supplierName: "Taj", itinerary: { destination: "Delhi" }, returnDate: "2027-04-04" });
    await upload(booking._id, "voucher", "hotel-voucher.pdf");
    await upload(booking._id, "internal", `${SENTINEL}.pdf`);
    mails.length = 0;
    expect((await markDone(booking._id)).body.requestSync).toBe("completed");
    expect((await getDoc(rid)).meta.bookingDocuments.map((d: any) => d.type)).toEqual(["voucher"]);
    expect(doneMails().map((m) => m.attachments.map((a: any) => a.filename))).toEqual([["hotel-voucher.pdf"]]);
  });

  it("PL-T46PH8's shape is refused now: Done with only an 'other' file → 400; typed as a ticket → Done, emailed with it", async () => {
    const rid = await approvedRequest();
    const booking = await createBooking(rid);
    const attId = await upload(booking._id, "other", "E-Ticket MR ADITYA.pdf");
    const refused = await markDone(booking._id);
    expect([refused.status, refused.body.code]).toEqual([400, "ATTACHMENT_REQUIRED"]);
    expect(refused.body.error).toMatch(/Ticket or Voucher/);
    expect((await getDoc(rid)).stage).toBe("BOOKING_IN_PROGRESS");

    expect((await setType(booking._id, attId, "ticket")).body.requestSync).toBe("in_progress");
    mails.length = 0;
    expect((await markDone(booking._id)).body.requestSync).toBe("completed");
    expect((await getDoc(rid)).meta.bookingDocuments.map((d: any) => [d.type, d.filename, d.attachmentId])).toEqual([["ticket", "E-Ticket MR ADITYA.pdf", attId]]);
    expect(doneMails().map((m) => m.attachments.map((x: any) => x.filename))).toEqual([["E-Ticket MR ADITYA.pdf"]]);
  });

  it("a Done request booking keeps its last ticket: delete / retype away → 409; with a second ticket it may go", async () => {
    const rid = await approvedRequest();
    const booking = await createBooking(rid);
    const t1 = await upload(booking._id, "ticket", "t1.pdf");
    await upload(booking._id, "internal", "invoice.pdf");
    expect((await markDone(booking._id)).body.requestSync).toBe("completed");

    const retype = await setType(booking._id, t1, "internal");
    expect([retype.status, retype.body.code]).toEqual([409, "ATTACHMENT_REQUIRED"]);
    const del = await as(request(app).delete(`/api/admin/manual-bookings/${booking._id}/attachments/${t1}`), OPS);
    expect([del.status, del.body.code]).toEqual([409, "ATTACHMENT_REQUIRED"]);
    expect((await setType(booking._id, t1, "voucher")).status, "ticket ↔ voucher is fine").toBe(200);

    await upload(booking._id, "ticket", "t2.pdf");
    expect((await as(request(app).delete(`/api/admin/manual-bookings/${booking._id}/attachments/${t1}`), OPS)).status).toBe(200);
  });

  it("plain manual bookings (no request) keep the any-file rule", async () => {
    const res = await as(request(app).post("/api/admin/manual-bookings"), OPS).send({
      workspaceId: String(ACME_CUSTOMER), type: "FLIGHT", status: "PENDING", supplierName: "IndiGo", givenBy: "Asha Rao",
      travelDate: "2027-04-02", passengers: [{ name: "Asha Rao", type: "ADULT" }], pricing: { actualPrice: 9800, quotedPrice: 12000 },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const id = res.body.booking._id;
    expect((await markDone(id)).status, "no file at all").toBe(400);
    const attId = await upload(id, "internal", "invoice.pdf");
    expect((await markDone(id)).status, "an internal file is enough here, as before").toBe(200);
    expect((await as(request(app).delete(`/api/admin/manual-bookings/${id}/attachments/${attId}`), OPS)).status, "last file rule as before").toBe(409);
  });
});

/* ───────────────────────── tracker ───────────────────────── */

describe("partner / student tracker", () => {
  it("shows 'Ticket issued' for a ticket; an internal or other file never counts", async () => {
    const rid = await approvedRequest();
    const booking = await createBooking(rid);
    const attId = await upload(booking._id, "internal", `${SENTINEL}.pdf`);
    await upload(booking._id, "other", "legacy-other.pdf");
    const row = async () => trackerRow(await getDoc(rid), await bookingsOfCases(String(ACME_CUSTOMER), [rid]));

    expect((await row()).documents).toEqual([{ service: "Flight", ticketIssued: false, voucherIssued: false, documentIssued: false }]);
    await setType(booking._id, attId, "ticket");
    expect((await row()).documents).toEqual([{ service: "Flight", ticketIssued: true, voucherIssued: false, documentIssued: false }]);
  });
});

/* ───────────────────────── My Bookings ───────────────────────── */

describe("My Bookings", () => {
  it("lists ticket and legacy 'other' exactly as before; never 'internal'", async () => {
    const { bookingRef, ticketId, otherId, internalId } = await bookedWithAllTypes();
    for (const who of [ASHA, LEELA]) {
      const res = await as(request(app).get(`/api/my-bookings/${bookingRef}/attachments`), who);
      expect(res.status, who.name).toBe(200);
      expect(res.body.attachments.map((a: any) => [a._id, a.type, a.originalFilename])).toEqual([
        [ticketId, "ticket", "e-ticket.pdf"],
        [otherId, "other", "legacy-other.pdf"],
      ]);
    }
    expect((await as(request(app).get(`/api/my-bookings/${bookingRef}/attachments/${otherId}/url`), ASHA)).status).toBe(200);
    expect((await as(request(app).get(`/api/my-bookings/${bookingRef}/attachments/${ticketId}/url`), ASHA)).status).toBe(200);
    presigned.length = 0;
    const internal = await as(request(app).get(`/api/my-bookings/${bookingRef}/attachments/${internalId}/url`), ASHA);
    expect(internal.status).toBe(404);
    expect(presigned, "an internal file is never presigned for a customer").toHaveLength(0);
  });
});

/* ───────────────────────── deep scan ───────────────────────── */

describe("'internal' never reaches a customer", () => {
  it("deep scan: every customer endpoint, export, email and the tracker", async () => {
    const { rid, bookingRef, internalId } = await bookedWithAllTypes();
    const seen: Array<[string, string]> = [];

    for (const who of [ASHA, LEELA]) {
      for (const path of [
        `/api/approvals/requests/${rid}`,
        "/api/approvals/requests/mine",
        "/api/booking-history/history",
        "/api/my-bookings",
        "/api/my-bookings/manual",
        `/api/my-bookings/${bookingRef}/attachments`,
      ]) {
        const res = await as(request(app).get(path), who);
        expect([200, 404], `${path} (${who.name})`).toContain(res.status);
        seen.push([`${path} (${who.name})`, JSON.stringify(res.body)]);
      }
      const csv = await as(request(app).get("/api/my-bookings/manual/export?format=csv"), who);
      expect(csv.status).toBe(200);
      expect(csv.text, "the export has the booking").toContain(bookingRef);
      seen.push([`csv export (${who.name})`, csv.text]);
      const xlsx = await as(request(app).get("/api/my-bookings/manual/export?format=xlsx"), who)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => cb(null, Buffer.concat(chunks)));
        });
      expect(xlsx.status).toBe(200);
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xlsx.body as any);
      const cells: string[] = [];
      wb.eachSheet((s) => s.eachRow((r) => cells.push(JSON.stringify(r.values))));
      seen.push([`xlsx export (${who.name})`, cells.join("\n")]);

      const dl = await as(request(app).get(`/api/approvals/requests/${rid}/documents/mb-${internalId}/download`), who);
      expect(dl.status, `internal download (${who.name})`).toBe(404);
      const url = await as(request(app).get(`/api/my-bookings/${bookingRef}/attachments/${internalId}/url`), who);
      expect(url.status, `internal url (${who.name})`).toBe(404);
    }

    // The request listing really carries the booking documents it should.
    const detail = await as(request(app).get(`/api/approvals/requests/${rid}`), ASHA);
    expect(detail.body.request._documents.map((d: any) => d.name)).toEqual(["e-ticket.pdf"]);

    // Every email sent so far (submit, approve, booking done…).
    expect(mails.length).toBeGreaterThan(0);
    for (const m of mails) seen.push([`mail "${m.subject}"`, JSON.stringify({ ...m, attachments: (m.attachments || []).map((a: any) => ({ filename: a.filename, path: a.path, content: String(a.content ?? "") })) })]);
    // And the queued outbox rows (retries read these).
    for (const row of await col("emailoutboxes").find({}).toArray()) seen.push(["outbox row", JSON.stringify(row)]);

    // The tracker (partner Student Cases and the student's Track my case).
    seen.push(["tracker", JSON.stringify(trackerRow(await getDoc(rid), await bookingsOfCases(String(ACME_CUSTOMER), [rid])))]);

    for (const [where, text] of seen) {
      expect(text, `${where} carries the internal file`).not.toContain(SENTINEL);
      expect(text, `${where} carries the internal file's id`).not.toContain(internalId);
    }
    expect(seen.length).toBeGreaterThan(15);
  });
});
