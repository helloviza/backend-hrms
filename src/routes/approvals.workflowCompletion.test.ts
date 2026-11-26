// apps/backend/src/routes/approvals.workflowCompletion.test.ts
//
// S5: approval workflow completion ALL_SERVICES_BOOKED (D6). A flight +
// hotel + cab request booked through Book Now (Manual Booking, D7):
//   - the first two confirmed bookings leave it "Partly booked" (in progress,
//     meta.partlyBooked lists what is booked and what is missing), each
//     booking's documents emailed once (documents ready), no "booking done";
//   - the third completes it: Booked, one "booking done";
//   - a cancelled booking does not count; a TRANSFER booking covers a cab;
//   - staff Mark done finishes a partly booked request;
//   - FIRST_BOOKING (and no workflow at all) keep today's first-booking rule.
//
// Harness copied from approvals.bookingCompletion.test.ts (real approvals and
// manual-bookings routers, outbox, in-memory Mongo).
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
const { saveWorkflowDraft, publishWorkflowDraft } = await import("../services/approvalWorkflow/store.js");

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

const hotelItem = {
  type: "hotel", title: "Delhi hotel", qty: 1, price: 0,
  meta: { city: "Delhi", travelScope: "domestic", checkIn: "2027-04-02", checkOut: "2027-04-04", rooms: 1, adults: 1, travellers: [{ kind: "manual", firstName: "Asha", lastName: "Rao" }] },
};
const cabItem = {
  type: "cab", title: "Airport → hotel", qty: 1, price: 0,
  meta: { city: "Delhi", travelScope: "domestic", tripType: "oneway", pickup: "DEL T1", drop: "Aerocity", pickupDate: "2027-04-02", pickupTime: "10:30", travellers: [{ kind: "manual", firstName: "Asha", lastName: "Rao" }] },
};
const sysActor = { id: "", name: "test", email: "", kind: "SCRIPT" as const, roles: [] };
async function publish(completion: "ALL_SERVICES_BOOKED" | "FIRST_BOOKING") {
  await saveWorkflowDraft({
    workspaceId: ACME, actor: sysActor,
    config: {
      enabled: true, completion, requestOnlyMode: true,
      steps: [{ key: "approver", label: "Travel approver", type: "DEFAULT_APPROVER", role: "APPROVER", fallback: "REFUSE_SUBMIT" }],
    },
  });
  await publishWorkflowDraft({ workspaceId: ACME, actor: sysActor, changeSummary: "test" });
}
async function approvedTrip(items: any[] = [flightItem, hotelItem, cabItem]) {
  const created = await as(request(app).post("/api/approvals/requests"), ASHA).send({ cartItems: items });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const id = String(created.body.request._id);
  expect((await as(request(app).put(`/api/approvals/requests/${id}/action`), MEERA).send({ action: "approved" })).status).toBe(200);
  expect((await startBooking(id)).status).toBe(200);
  return id;
}
/** Book Now for one service (the 2nd+ booking is "+ Add another booking"); a flight / hotel gets its file. */
async function book(rid: string, type: string, over: any = {}) {
  const first = !(await col("manualbookings").countDocuments({ sourceBookingId: new mongoose.Types.ObjectId(rid) }));
  const { booking } = await createBooking(rid, { type, ...(type === "HOTEL" ? { sector: "Delhi", returnDate: "2027-04-04" } : {}), ...(first ? {} : { additional: true }), ...over });
  if (type === "FLIGHT") await upload(booking._id, "ticket", "ticket.pdf");
  if (type === "HOTEL") await upload(booking._id, "voucher", "voucher.pdf");
  return booking;
}
const confirm = (bookingId: string) => as(request(app).put(`/api/admin/manual-bookings/${bookingId}`), OPS).send({ status: "CONFIRMED" });
const doneMails = () => mails.filter((m) => /Processed/.test(String(m.subject)));
const docsMails = () => mails.filter((m) => /travel documents/.test(String(m.subject)));

describe("ALL_SERVICES_BOOKED", () => {
  beforeEach(() => publish("ALL_SERVICES_BOOKED"));

  it("flight, then hotel: Partly booked with documents each time; the cab completes it", async () => {
    const rid = await approvedTrip();
    const f = await book(rid, "FLIGHT");
    mails.length = 0;
    let r = await confirm(f._id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.requestSync).toBe("partly_booked");
    let doc = await getDoc(rid);
    expect(doc).toMatchObject({ stage: "BOOKING_IN_PROGRESS", adminState: "in_progress" });
    expect(doc.meta.partlyBooked).toMatchObject({ booked: ["FLIGHT"], missing: ["HOTEL", "CAB"] });
    expect(doc.history.filter((h: any) => h.action === "partly_booked").map((h: any) => h.comment)).toEqual(["Flight booked — still to book: Hotel, Cab"]);
    expect(doneMails()).toHaveLength(0);
    expect(docsMails()).toHaveLength(1);
    expect(docsMails()[0].attachments.map((a: any) => a.filename)).toEqual(["ticket.pdf"]);
    // The requester sees "Partly booked" data on My Requests (the label is the frontend's).
    const mine = await as(request(app).get("/api/approvals/requests/mine"), ASHA);
    expect(mine.body.rows[0].meta.partlyBooked.missing).toEqual(["HOTEL", "CAB"]);

    const h = await book(rid, "HOTEL", { supplierName: "Taj" });
    mails.length = 0;
    r = await confirm(h._id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.requestSync).toBe("partly_booked");
    doc = await getDoc(rid);
    expect(doc.meta.partlyBooked).toMatchObject({ booked: ["FLIGHT", "HOTEL"], missing: ["CAB"] });
    expect(docsMails().map((m) => m.attachments.map((a: any) => a.filename))).toEqual([["voucher.pdf"]]); // the ticket is not sent twice
    expect(doneMails()).toHaveLength(0);

    // Re-saving a booking already counted changes nothing and sends nothing.
    mails.length = 0;
    await as(request(app).put(`/api/admin/manual-bookings/${h._id}`), OPS).send({ notes: "late checkout" });
    expect(mails).toHaveLength(0);

    const c = await book(rid, "CAB", { supplierName: "Meru" });
    mails.length = 0;
    r = await confirm(c._id);
    expect(r.body.requestSync).toBe("completed");
    doc = await getDoc(rid);
    expect(doc).toMatchObject({ stage: "COMPLETED", adminState: "done" });
    expect(doc.meta.partlyBooked).toMatchObject({ booked: ["FLIGHT", "HOTEL", "CAB"], missing: [] });
    expect(doneMails()).toHaveLength(1);
  });

  it("a cancelled booking does not count; a TRANSFER booking covers the cab", async () => {
    const rid = await approvedTrip([flightItem, cabItem]);
    const f = await book(rid, "FLIGHT");
    await confirm(f._id);
    const dead = await book(rid, "CAB");
    await as(request(app).put(`/api/admin/manual-bookings/${dead._id}`), OPS).send({ status: "CANCELLED" });
    expect((await getDoc(rid)).meta.partlyBooked.missing).toEqual(["CAB"]);
    const t = await book(rid, "TRANSFER");
    expect((await confirm(t._id)).body.requestSync).toBe("completed");
  });

  it("staff Mark done finishes a partly booked request", async () => {
    const rid = await approvedTrip();
    const f = await book(rid, "FLIGHT");
    await confirm(f._id);
    expect((await getDoc(rid)).stage).toBe("BOOKING_IN_PROGRESS");
    const r = await as(request(app).put(`/api/approvals/admin/${rid}/done`), OPS).send({ comment: "Hotel and cab booked by the client" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await getDoc(rid)).toMatchObject({ stage: "COMPLETED", adminState: "done" });
  });

  it("a one-service request completes on its one booking", async () => {
    const rid = await approvedTrip([flightItem]);
    const f = await book(rid, "FLIGHT");
    expect((await confirm(f._id)).body.requestSync).toBe("completed");
  });
});

describe("today's first-booking rule stays", () => {
  it("FIRST_BOOKING: the first confirmed booking completes a three-service request", async () => {
    await publish("FIRST_BOOKING");
    const rid = await approvedTrip();
    const f = await book(rid, "FLIGHT");
    expect((await confirm(f._id)).body.requestSync).toBe("completed");
  });

  it("no workflow: the first confirmed booking completes it", async () => {
    const rid = await approvedTrip();
    const f = await book(rid, "FLIGHT");
    expect((await confirm(f._id)).body.requestSync).toBe("completed");
    expect((await getDoc(rid)).meta.partlyBooked).toBeUndefined();
  });
});
