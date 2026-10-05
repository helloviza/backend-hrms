// apps/backend/src/routes/approvals.bookingCompletion.test.ts
//
// Slice 4 — booking completion and documents:
//   - Book Now's manual booking is locked to the request's client;
//   - saved Done (CONFIRMED) it completes the request: Booked, documents and
//     final prices from the booking, "booking done" email with the ticket
//     attached (read from S3 at send time); saved Pending it stays "Booking in
//     progress";
//   - Mark Processed (no booking) takes a reason + note only;
//   - booking documents download only for the requester, approver, Workspace
//     Leaders of that company and staff; another company / unknown id /
//     internal file → 404; no raw URL or S3 key in any customer response;
//   - the activity trail is plain English, "Booking started" never repeats,
//     the requester shows by real name (claimed traveller profile over the
//     "Workspace User" placeholder);
//   - Booking History: requester own, leader company, customer rows carry no
//     emails but the viewer's own, no prices, no people ids.
//
// Real: approvals, bookingHistory and manualBookings routers, markRequestDone,
// the email outbox, actor names, in-memory Mongo. Stubbed: requireAuth (user
// from a header), requireWorkspace (workspace from a header),
// requirePermission (pass-through), mail transport, S3, document extraction.
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

const { mails } = vi.hoisted(() => ({ mails: [] as any[] }));

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

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const ACME = oid();
const ACME_CUSTOMER = oid(); // Customer._id — what a manual booking's workspaceId holds
const OTHER = oid();

type Who = { sub: string; email: string; name: string; roles: string[]; ws: any };
const person = (email: string, name: string, roles: string[], ws: any): Who => ({ sub: String(oid()), email, name, roles, ws });
// The token still says "Workspace User" — the placeholder the account was created with.
const ASHA = person("asha@acme.test", "Workspace User", ["CUSTOMER"], ACME);
const RAVI = person("ravi@acme.test", "Ravi Kumar", ["CUSTOMER"], ACME);
const MEERA = person("meera@acme.test", "Meera Iyer", ["CUSTOMER"], ACME); // approver
const LEELA = person("leela@acme.test", "Leela Shah", ["CUSTOMER"], ACME); // Workspace Leader
const OUTSIDER = person("boss@other.test", "Olly Other", ["WORKSPACE_LEADER", "CUSTOMER"], OTHER);
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

async function approvedRequest(by: Who = ASHA) {
  const created = await as(request(app).post("/api/approvals/requests"), by).send({ cartItems: [flightItem] });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = String(created.body.request._id);
  const approved = await as(request(app).put(`/api/approvals/requests/${id}/action`), MEERA).send({ action: "approved" });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  return id;
}

const startBooking = (id: string) => as(request(app).put(`/api/approvals/admin/${id}/start-booking`), OPS).send({});

function bookingBody(rid: string, over: any = {}) {
  return {
    workspaceId: String(ACME_CUSTOMER),
    type: "FLIGHT",
    status: "PENDING",
    source: "ADMIN_QUEUE",
    sourceBookingId: rid,
    supplierName: "IndiGo",
    givenBy: "Asha Rao",
    travelDate: "2027-04-02",
    passengers: [{ name: "Asha Rao", type: "ADULT" }],
    pricing: { actualPrice: 9800, quotedPrice: 12000 },
    ...over,
  };
}

async function createBooking(rid: string, over: any = {}) {
  const res = await as(request(app).post("/api/admin/manual-bookings"), OPS).send(bookingBody(rid, over));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function upload(bookingId: string, type: string, filename: string) {
  const res = await as(request(app).post(`/api/admin/manual-bookings/${bookingId}/attachments`), OPS)
    .field("type", type)
    .attach("file", Buffer.from("%PDF-1.4 fake"), { filename, contentType: "application/pdf" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.attachment._id);
}

const getDoc = (id: string) => col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(id) }) as Promise<any>;

/** Book Now → manual booking with a ticket and an internal file → saved Done. */
async function bookedRequest() {
  const rid = await approvedRequest();
  expect((await startBooking(rid)).status).toBe(200);
  const { booking } = await createBooking(rid);
  const ticketId = await upload(booking._id, "ticket", "ticket.pdf");
  const internalId = await upload(booking._id, "other", "supplier-invoice.pdf");
  mails.length = 0;
  const done = await as(request(app).put(`/api/admin/manual-bookings/${booking._id}`), OPS).send({ status: "CONFIRMED" });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect(done.body.requestSync).toBe("completed");
  return { rid, bookingId: String(booking._id), ticketId, internalId };
}

const download = (rid: string, docId: string, who: Who) =>
  as(request(app).get(`/api/approvals/requests/${rid}/documents/${docId}/download`), who)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });

/** Anything a customer must never receive. */
function expectCustomerSafe(body: any, where: string) {
  const text = JSON.stringify(body);
  for (const bad of ["s3Key", "bookings/attachments", "/uploads/", "http://", "https://", "Notified:", "[ADMIN]", "[MODE:", "[REASON:", "supplier-invoice.pdf", "9800", "12000", "Workspace User", "manualBookingId"]) {
    expect(text, `${where} carries "${bad}"`).not.toContain(bad);
  }
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-booking-completion-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  mails.length = 0;
  await mongoose.connection.db!.dropDatabase();
  const direct = { travelFlow: "APPROVAL_DIRECT", features: { approvalDirectEnabled: true } };
  await col("customerworkspaces").insertMany([
    { _id: HOUSE, customerId: "PLUMTRIPS-HOUSE", name: "Plumtrips", status: "ACTIVE", config: { features: {} } },
    { _id: ACME, customerId: String(ACME_CUSTOMER), name: "Peachmint Advisors", companyName: "Peachmint Advisors", status: "ACTIVE", tenantType: "CORPORATE", defaultApproverEmails: [MEERA.email], config: direct },
    { _id: OTHER, customerId: "OTHER-CO", name: "Other Co", status: "ACTIVE", tenantType: "CORPORATE", defaultApproverEmails: ["x@other.test"], config: direct },
  ] as any[]);
  await col("users").insertMany([
    // Asha's account was created with the placeholder; her claimed traveller profile has her name.
    { _id: new mongoose.Types.ObjectId(ASHA.sub), workspaceId: ACME, email: ASHA.email, firstName: "Workspace User", lastName: "", roles: ASHA.roles, status: "ACTIVE", passwordHash: "x" },
    ...[RAVI, MEERA, LEELA, OUTSIDER].map((u) => ({ _id: new mongoose.Types.ObjectId(u.sub), workspaceId: u.ws, email: u.email, name: u.name, firstName: u.name.split(" ")[0], lastName: u.name.split(" ")[1], roles: u.roles, status: "ACTIVE", passwordHash: "x" })),
    { _id: new mongoose.Types.ObjectId(OPS.sub), workspaceId: HOUSE, email: OPS.email, firstName: "Neel", lastName: "Bhatia", roles: OPS.roles, status: "ACTIVE", passwordHash: "x" },
  ] as any[]);
  await col("travellerprofiles").insertOne({ workspaceId: ACME, travelerId: "PEA-001", firstName: "Asha", lastName: "Rao", claimedBy: new mongoose.Types.ObjectId(ASHA.sub) } as any);
  await col("customermembers").insertMany([
    { email: LEELA.email, customerId: String(ACME_CUSTOMER), workspaceId: ACME, role: "WORKSPACE_LEADER", isActive: true },
    { email: OUTSIDER.email, customerId: "OTHER-CO", workspaceId: OTHER, role: "WORKSPACE_LEADER", isActive: true },
  ] as any[]);
});

/* ───────────────────────── Book Now → manual booking ───────────────────────── */

describe("Book Now → manual booking", () => {
  it("the booking is locked to the request's client: another client or an unknown request is refused", async () => {
    const rid = await approvedRequest();
    const wrong = await as(request(app).post("/api/admin/manual-bookings"), OPS).send(bookingBody(rid, { workspaceId: String(oid()) }));
    expect([wrong.status, wrong.body.code]).toEqual([400, "CLIENT_MISMATCH"]);
    const unknown = await as(request(app).post("/api/admin/manual-bookings"), OPS).send(bookingBody(String(oid())));
    expect([unknown.status, unknown.body.code]).toEqual([400, "REQUEST_NOT_FOUND"]);
  });

  it("saved as Pending (or WIP) the request stays 'Booking in progress'", async () => {
    const rid = await approvedRequest();
    // Book Now's start-booking never landed: saving the booking starts it, once.
    const { booking, requestSync } = await createBooking(rid);
    expect(requestSync).toBe("in_progress");
    let doc = await getDoc(rid);
    expect([doc.stage, doc.adminState]).toEqual(["BOOKING_IN_PROGRESS", "in_progress"]);
    const wip = await as(request(app).put(`/api/admin/manual-bookings/${booking._id}`), OPS).send({ status: "WIP" });
    expect(wip.status).toBe(200);
    doc = await getDoc(rid);
    expect(doc.stage).toBe("BOOKING_IN_PROGRESS");
    expect(doc.history.filter((h: any) => h.action === "booking_started")).toHaveLength(1);
  });

  it("saved Done it completes the request: Booked, documents + final prices from the booking, email with the ticket only", async () => {
    const { rid, bookingId } = await bookedRequest();
    const doc = await getDoc(rid);
    expect([doc.stage, doc.adminState]).toEqual(["COMPLETED", "done"]);
    expect(doc.meta.manualBookingId).toBe(bookingId);
    expect(doc.meta.bookingDocuments.map((d: any) => [d.type, d.filename])).toEqual([["ticket", "ticket.pdf"]]);
    expect(doc.actualBookingPrice).toBe(9800);
    expect(doc.bookingAmount).toBeGreaterThanOrEqual(12000);

    const doneMail = mails.find((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(ASHA.email) && m.attachments?.length);
    expect(doneMail, "booking done email to the requester").toBeTruthy();
    expect(doneMail.attachments.map((a: any) => a.filename)).toEqual(["ticket.pdf"]);
    expect(String(doneMail.attachments[0].content)).toBe(`BYTES:bookings/attachments/${bookingId}/ticket.pdf`);
    expect(doneMail.html).not.toMatch(/9800|12000|₹/);

    // Saving again (or uploading another file) never emails twice.
    mails.length = 0;
    expect((await as(request(app).put(`/api/admin/manual-bookings/${bookingId}`), OPS).send({ notes: "seat 3A" })).status).toBe(200);
    expect(mails).toHaveLength(0);
    expect((await getDoc(rid)).history.filter((h: any) => h.action === "admin_done")).toHaveLength(1);
  });
});

/* ───────────────────────── Mark Processed (no booking) ───────────────────────── */

describe("Mark Processed — outcomes without a booking", () => {
  it("needs a reason, takes a note, never prices or a file; closes as Cancelled with that reason", async () => {
    const rid = await approvedRequest();
    expect((await startBooking(rid)).status).toBe(200);
    const none = await as(request(app).put(`/api/approvals/admin/${rid}/close`), OPS).send({ note: "x" });
    expect([none.status, none.body.code]).toEqual([400, "REASON_REQUIRED"]);

    const res = await as(request(app).put(`/api/approvals/admin/${rid}/close`), OPS).send({ reason: "NOT_AVAILABLE", note: "No seats on any carrier", bookingAmount: 5000, actualBookingPrice: 4000 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const doc = await getDoc(rid);
    expect([doc.stage, doc.adminState, doc.bookingAmount, doc.actualBookingPrice]).toEqual(["BOOKING_CANCELLED", "cancelled", undefined, undefined]);
    expect(doc.history.at(-1)).toMatchObject({ action: "admin_closed", comment: "Not available — No seats on any carrier" });

    // A closed request is not closed again, and a booked one never is.
    expect((await as(request(app).put(`/api/approvals/admin/${rid}/close`), OPS).send({ reason: "DUPLICATE" })).status).toBe(409);
  });
});

/* ───────────────────────── documents ───────────────────────── */

describe("booking documents", () => {
  it("requester, approver, Workspace Leader and staff download; another company, unknown ids and internal files get 404", async () => {
    const { rid, ticketId, internalId } = await bookedRequest();
    const docId = `mb-${ticketId}`;
    for (const who of [ASHA, MEERA, LEELA, OPS]) {
      const res = await download(rid, docId, who);
      expect(res.status, who.name).toBe(200);
      expect(String(res.body), who.name).toContain("ticket.pdf");
      expect(String(res.headers["content-disposition"])).toContain('filename="ticket.pdf"');
    }
    expect((await download(rid, docId, OUTSIDER)).status).toBe(404);
    expect((await download(rid, docId, RAVI)).status, "a colleague who is not requester / approver / leader").toBe(404);
    expect((await download(rid, `mb-${internalId}`, ASHA)).status, "internal file").toBe(404);
    expect((await download(rid, `mb-${internalId}`, OPS)).status, "internal file is not a booking document").toBe(404);
    expect((await download(rid, "po-option-1.pdf", ASHA)).status, "proposal option PDF").toBe(404);
    expect((await download(String(oid()), docId, ASHA)).status).toBe(404);
  });

  it("customer responses list documents by name/type only — no URL, key, internal file, price or tag anywhere", async () => {
    const { rid, ticketId } = await bookedRequest();
    for (const [path, who] of [
      [`/api/approvals/requests/${rid}`, ASHA],
      ["/api/approvals/requests/mine", ASHA],
      ["/api/booking-history/history", ASHA],
      ["/api/booking-history/history", LEELA],
    ] as const) {
      const res = await as(request(app).get(path), who);
      expect(res.status, path).toBe(200);
      expectCustomerSafe(res.body, `${path} (${who.name})`);
      const row = res.body.request || (res.body.rows || []).find((r: any) => String(r._id) === rid);
      expect(row._documents, path).toEqual([{ id: `mb-${ticketId}`, name: "ticket.pdf", type: "Ticket", size: expect.any(Number), mime: "application/pdf", uploadedAt: expect.any(String) }]);
    }
  });
});

/* ───────────────────────── activity trail ───────────────────────── */

describe("activity trail", () => {
  it("repeated Book Now writes one 'Booking started'; a closed or booked request refuses it", async () => {
    const rid = await approvedRequest();
    for (let i = 0; i < 4; i++) expect((await startBooking(rid)).status).toBe(200);
    const doc = await getDoc(rid);
    expect(doc.history.filter((h: any) => h.action === "booking_started")).toHaveLength(1);
  });

  it("customers read plain English with real names: tags and URLs gone, delivery rows hidden, attachment as a file name", async () => {
    const rid = await approvedRequest();
    expect((await startBooking(rid)).status).toBe(200);
    // An old-style Mark Processed row, as the queue used to write it.
    await col("approvalrequests").updateOne({ _id: new mongoose.Types.ObjectId(rid) }, {
      $set: { stage: "COMPLETED", adminState: "done" },
      $push: {
        history: {
          $each: [
            { action: "admin_done", at: new Date(), by: OPS.sub, actorKind: "staff", comment: "[ADMIN] [MODE:DONE] [SERVICE:FLIGHT] [REASON:TICKET_ISSUED] [BOOKING_AMOUNT:12000] Ticket issued & shared — Attachment: https://api.hrms.plumtrips.com/api/approvals/attachments/1700000000-ticket.pdf/download" },
            { action: "admin_notify_sent", at: new Date(), by: OPS.sub, actorKind: "staff", comment: `Notified: to=${ASHA.email} cc=${MEERA.email} attachments=1` },
          ],
        },
      } as any,
    });

    const res = await as(request(app).get(`/api/approvals/requests/${rid}`), ASHA);
    expect(res.status).toBe(200);
    expectCustomerSafe(res.body, "request detail");
    const hist: any[] = res.body.request.history;
    expect(hist.find((h) => h.action === "admin_notify_sent")).toBeUndefined();
    expect(hist.find((h) => h.action === "admin_done")).toMatchObject({
      comment: "Ticket issued and shared",
      documentName: "1700000000-ticket.pdf",
      actorName: "Plumtrips Travel Desk",
    });
    expect(hist.find((h) => h.action === "submitted").actorName).toBe("Asha Rao");
    expect(res.body.request.frontlinerName).toBe("Asha Rao");

    // Stored right for new requests too (not only fixed on the way out).
    expect((await getDoc(rid)).frontlinerName).toBe("Asha Rao");
  });
});

/* ───────────────────────── Booking History ───────────────────────── */

describe("Booking History scope and shape", () => {
  it("requester sees their own, the Workspace Leader the company, another company nothing; staff all", async () => {
    const { rid: mine } = await bookedRequest();
    const ravis = await approvedRequest(RAVI);
    await col("approvalrequests").updateOne({ _id: new mongoose.Types.ObjectId(ravis) }, { $set: { adminState: "done", stage: "COMPLETED" } });

    const ids = async (who: Who) => {
      const r = await as(request(app).get("/api/booking-history/history"), who);
      expect(r.status, who.name).toBe(200);
      return r.body.rows.map((x: any) => String(x._id)).sort();
    };
    expect(await ids(ASHA)).toEqual([mine]);
    expect(await ids(RAVI)).toEqual([ravis]);
    expect(await ids(LEELA)).toEqual([mine, ravis].sort());
    expect(await ids(OUTSIDER)).toEqual([]);
    expect(await ids(OPS)).toEqual([mine, ravis].sort());
  });

  it("customer rows: no other person's email, no ids of people, no prices; names and documents present", async () => {
    const { rid } = await bookedRequest();
    const res = await as(request(app).get("/api/booking-history/history"), LEELA);
    const row = res.body.rows.find((r: any) => String(r._id) === rid);
    const text = JSON.stringify(row);
    for (const e of [ASHA.email, MEERA.email, OPS.email]) expect(text).not.toContain(e);
    for (const id of [ASHA.sub, MEERA.sub, OPS.sub]) expect(text).not.toContain(id);
    expect(row).toMatchObject({ requesterName: "Asha Rao", approverName: "Meera Iyer", customerName: "Peachmint Advisors", adminState: "done" });
    expect(row.bookedAt).toBeTruthy();
    expect(row.frontlinerId).toBeUndefined();
    expect(row.managerEmail).toBeUndefined();
    expect(row._documents).toHaveLength(1);

    // The requester keeps their own email (their row, their history).
    const own = await as(request(app).get("/api/booking-history/history"), ASHA);
    expect(JSON.stringify(own.body)).not.toContain(MEERA.email);
  });
});
