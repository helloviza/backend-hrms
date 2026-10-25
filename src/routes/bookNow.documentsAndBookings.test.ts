// apps/backend/src/routes/bookNow.documentsAndBookings.test.ts
//
// Book Now, end to end on the real routers (harness: public.partnerRequest.test.ts):
//   - documents uploaded on the booking reach every customer screen and the
//     customer by email — booking done, or ONE documents-ready email for files
//     added after Done — never a file twice; internal never leaks;
//   - one booking per request unless asked for another (409 BOOKING_EXISTS),
//     the by-request lookup and the queue's booking summary.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import crypto from "crypto";
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
process.env.TURNSTILE_SECRET = "turnstile-test-secret";

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
vi.mock("../services/documentExtraction.service.js", async (orig) => ({ ...(await orig<any>()), enqueueExtraction: async () => undefined }));
vi.mock("../services/location.service.js", async (orig) => ({ ...(await orig<any>()), resolveActorFromRequest: async () => null }));
vi.mock("../utils/emailActionToken.js", () => ({ signEmailActionToken: () => "tok", verifyEmailActionToken: () => null, hashToken: () => "hash" }));

// Turnstile siteverify: "ok" passes, anything else fails.
vi.stubGlobal("fetch", async (_url: any, init: any) => {
  const token = new URLSearchParams(String(init?.body || "")).get("response");
  return { ok: true, json: async () => ({ success: token === "ok" }) } as any;
});

const { default: publicPartnerRouter } = await import("./public.partnerRequest.js");
const { default: approvalsRouter, CLOSE_REASONS } = await import("./approvals.js");
const { default: manualBookingsRouter } = await import("./manualBookings.js");
const { partnerRequestLimiter, partnerLinkResolveLimiter } = await import("../middleware/rateLimit.js");
const { migratePartnerLeadIndexes } = await import("../scripts/migrate-partner-lead-indexes.js");
const { resetPartnerIntakeCache } = await import("../services/partnerIntake.create.js");
const { PARTNER_INTAKE_EMAIL } = await import("../services/partnerLeadCase.js");
const { isPriceKey } = await import("./approvals.security.js");
const { DESK_EMAIL } = await import("../services/actorNames.js");
const { emailHash } = await import("../services/partnerTrackHash.js");

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const oid = () => new mongoose.Types.ObjectId();
const AMBER = oid(); // partner CustomerWorkspace._id
const AMBER_CUSTOMER = oid(); // its Customer._id
const OTHER = oid();
const OTHER_CUSTOMER = oid();

const app = express();
app.use(express.json());
app.use("/api/public", publicPartnerRouter);
app.use("/api/approvals", approvalsRouter);
app.use("/api/admin/manual-bookings", (req: any, _res, next) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  req.user._id = req.user.sub;
  req.workspace = { customerId: "PLUMTRIPS-HOUSE" };
  req.workspaceObjectId = HOUSE;
  req.permissionScope = "ALL";
  next();
}, manualBookingsRouter);

let mongod: MongoMemoryServer;
const DB = "public-partner-request-test";
const col = (n: string) => mongoose.connection.db!.collection(n);

type Who = { sub: string; email: string; name: string; roles: string[]; ws: any };
const person = (email: string, name: string, roles: string[], ws: any): Who => ({ sub: String(oid()), email, name, roles, ws });
const OPS = person("neel@plumtrips.com", "Neel Bhatia", ["SUPERADMIN"], HOUSE);
const RM = person("rita@plumtrips.com", "Rita Menon", ["EMPLOYEE"], HOUSE);
const AGENT = person("arun@plumtrips.com", "Arun Das", ["EMPLOYEE"], HOUSE);
const LEAD = person("lead@amber.test", "Lena Amber", ["WORKSPACE_LEADER", "CUSTOMER"], AMBER);
const INTAKE_ID = oid();

const as = (r: request.Test, who: Who) =>
  r
    .set("x-test-user", JSON.stringify({ sub: who.sub, _id: who.sub, email: who.email, name: who.name, roles: who.roles, workspaceId: String(who.ws), customerId: String(who.ws) }))
    .set("x-test-ws", String(who.ws));

const CODE = "AmbR2026";
const flight = (over: any = {}) => ({
  type: "flight",
  price: 99999, // a student can't set a price: dropped
  meta: { origin: "BLR", destination: "DEL", tripType: "oneway", departDate: "2027-04-02", travelScope: "domestic", travellers: [{ firstName: "Riya", lastName: "Sen", phone: "9876543210", email: "riya@student.test" }], ...over },
});
const body = (over: any = {}) => ({
  code: CODE,
  submissionId: crypto.randomUUID(),
  turnstileToken: "ok",
  cartItems: [flight()],
  contact: { name: "Riya Sen", email: "riya@student.test", phone: "+91 98765 43210" },
  consent: { accepted: true, version: "2026-10", text: "I agree…" },
  embedMode: "tab",
  utm: { utm_source: "amber", utm_medium: "banner" },
  ...over,
});
const submit = (b: any = body()) => request(app).post("/api/public/partner-request").set("Referer", "https://amberstudent.com/page").send(b);
const caseOf = (caseNumber: string) => col("approvalrequests").findOne({ "meta.partnerLead.caseNumber": caseNumber }) as Promise<any>;

async function resetLimiters() {
  for (const key of ["::ffff:127.0.0.1", "127.0.0.1", "::1"]) {
    await (partnerRequestLimiter as any).resetKey?.(key);
    await (partnerLinkResolveLimiter as any).resetKey?.(key);
  }
}

/** Every key, at any depth. */
function keysDeep(v: any, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.push(k), keysDeep(x, out));
  return out;
}
const recipients = () => mails.flatMap((m) => [m.to, m.cc].flat().filter(Boolean).map((e: any) => String(e).toLowerCase()));

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(DB));
  await mongoose.connection.db!.dropDatabase();
  for (const n of ["approvalrequests", "manualbookings", "partnerlinks"]) await mongoose.connection.db!.createCollection(n);
  await migratePartnerLeadIndexes({ expectDb: DB, apply: true, log: () => {} });
}, 120_000);
afterAll(async () => {
  vi.unstubAllGlobals();
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  mails.length = 0;
  resetPartnerIntakeCache();
  await resetLimiters();
  for (const n of ["approvalrequests", "manualbookings", "partnerlinks", "customerworkspaces", "users", "customers", "customermembers", "userpermissions", "traveldesksettings", "travellerprofiles", "emailoutboxes", "travelbookings"]) {
    await col(n).deleteMany({});
  }
  const flow = { travelFlow: "APPROVAL_FLOW", features: { approvalFlowEnabled: true } };
  await col("customerworkspaces").insertMany([
    { _id: HOUSE, customerId: "PLUMTRIPS-HOUSE", name: "Plumtrips", status: "ACTIVE", config: { features: {} } },
    { _id: AMBER, customerId: String(AMBER_CUSTOMER), companyName: "Amber Student", status: "ACTIVE", tenantType: "CORPORATE", defaultApproverEmails: [LEAD.email], config: flow },
    { _id: OTHER, customerId: String(OTHER_CUSTOMER), companyName: "Other Co", status: "ACTIVE", tenantType: "CORPORATE", config: flow },
  ] as any[]);
  await col("customers").insertOne({ _id: AMBER_CUSTOMER, name: "Amber Student", accountTeam: { accountManager: { userId: new mongoose.Types.ObjectId(RM.sub), name: RM.name, email: RM.email } } } as any);
  await col("users").insertMany([
    { _id: INTAKE_ID, workspaceId: HOUSE, email: PARTNER_INTAKE_EMAIL, name: "Partner Intake", roles: ["SYSTEM_PARTNER_INTAKE"], status: "ACTIVE", passwordHash: "x" },
    ...[OPS, RM, AGENT, LEAD].map((u) => ({ _id: new mongoose.Types.ObjectId(u.sub), workspaceId: u.ws, email: u.email, name: u.name, firstName: u.name.split(" ")[0], lastName: u.name.split(" ")[1], roles: u.roles, status: "ACTIVE", passwordHash: "x" })),
  ] as any[]);
  await col("customermembers").insertOne({ email: LEAD.email, customerId: String(AMBER_CUSTOMER), workspaceId: AMBER, role: "WORKSPACE_LEADER", isActive: true } as any);
  await col("userpermissions").insertMany(
    [RM, AGENT].map((u) => ({
      userId: u.sub, email: u.email, workspaceId: String(HOUSE), universe: "STAFF", status: "active", source: "manual",
      level: { code: "L1", name: "Employee", designation: "" }, modules: { adminQueue: { access: "WRITE", scope: "ALL" } },
    })) as any[],
  );
  await col("partnerlinks").insertOne({
    code: CODE, workspaceId: AMBER, customerId: String(AMBER_CUSTOMER), label: "Amber — homepage banner", placement: "homepage-banner",
    services: ["flight", "hotel", "visa"], active: true, embedAllowed: false, allowedOrigins: ["https://amberstudent.com"],
    dailyCap: 200, dailyCount: 0, dailyCountDay: "", clicks: 0, submissions: 0,
  } as any);
});


/* ═══════════════════ Book Now: documents reach the customer, once ═══════════════════
 * (The harness above is public.partnerRequest.test.ts's: real partner intake,
 * approvals + manual-bookings routers, outbox, in-memory Mongo.) */
const { default: myBookingsRouter } = await import("./myBookings.js");
const { trackerRow } = await import("../services/partnerLeadTracker.js");
const { bookingsOfCases } = await import("../services/partnerLeadBooking.js");
app.use("/api/my-bookings", async (req: any, res, next) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  const ws = await col("customerworkspaces").findOne({ _id: new mongoose.Types.ObjectId(String(req.headers["x-test-ws"])) });
  if (!ws) return res.status(403).json({ error: "no workspace" });
  req.workspace = ws;
  req.workspaceObjectId = ws._id;
  next();
}, myBookingsRouter);

const DIRECT = oid();
const DIRECT_CUSTOMER = oid();
const ASHA = person("asha@acme.test", "Asha Rao", ["CUSTOMER"], DIRECT); // Flow 3 requester (and passenger)
const MEERA = person("meera@acme.test", "Meera Iyer", ["CUSTOMER"], DIRECT); // approver
const STUDENT = "riya@student.test";
const SENTINEL = "INTERNAL-SENTINEL-supplier-invoice";

async function seedDirect() {
  await col("customerworkspaces").insertOne({ _id: DIRECT, customerId: String(DIRECT_CUSTOMER), name: "Acme", companyName: "Acme", status: "ACTIVE", tenantType: "CORPORATE", defaultApproverEmails: [MEERA.email], config: { travelFlow: "APPROVAL_DIRECT", features: { approvalDirectEnabled: true } } } as any);
  await col("users").insertMany([ASHA, MEERA].map((u) => ({ _id: new mongoose.Types.ObjectId(u.sub), workspaceId: DIRECT, email: u.email, name: u.name, firstName: u.name.split(" ")[0], lastName: u.name.split(" ")[1], roles: u.roles, status: "ACTIVE", passwordHash: "x" })) as any[]);
}

type Case = { kind: "Flow 3" | "PARTNER_LINK"; rid: string; customer: string; passengerEmail: string; caseNumber?: string };
async function flow3Case(): Promise<Case> {
  await seedDirect();
  const created = await as(request(app).post("/api/approvals/requests"), ASHA).send({ cartItems: [{ type: "flight", title: "BLR → DEL", qty: 1, price: 0, meta: { origin: "BLR", destination: "DEL", tripType: "oneway", departDate: "2027-04-02", travelScope: "domestic", travellers: [{ kind: "manual", firstName: "Asha", lastName: "Rao" }] } }] });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const rid = String(created.body.request._id);
  expect((await as(request(app).put(`/api/approvals/requests/${rid}/action`), MEERA).send({ action: "approved" })).status).toBe(200);
  return { kind: "Flow 3", rid, customer: String(DIRECT_CUSTOMER), passengerEmail: ASHA.email };
}
async function partnerCase(): Promise<Case> {
  const res = await submit();
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const doc = await caseOf(res.body.caseNumber);
  return { kind: "PARTNER_LINK", rid: String(doc._id), customer: String(AMBER_CUSTOMER), passengerEmail: STUDENT, caseNumber: res.body.caseNumber };
}
const CASES: Array<[string, () => Promise<Case>]> = [["Flow 3", flow3Case], ["PARTNER_LINK", partnerCase]];

const bookNowClick = (rid: string) => as(request(app).put(`/api/approvals/admin/${rid}/start-booking`), OPS).send({});
const newBooking = (c: Case, over: any = {}) =>
  as(request(app).post("/api/admin/manual-bookings"), OPS).send({
    workspaceId: c.customer, type: "FLIGHT", status: "PENDING", source: "ADMIN_QUEUE", sourceBookingId: c.rid,
    supplierName: "IndiGo", givenBy: "Ops", travelDate: "2027-04-02", passengers: [{ name: "Traveller", type: "ADULT", email: c.passengerEmail }],
    pricing: { actualPrice: 9800, quotedPrice: 12000 }, ...over,
  });
async function createBooking(c: Case, over: any = {}) {
  const res = await newBooking(c, over);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.booking;
}
async function upload(bookingId: string, type: string, filename: string) {
  const res = await as(request(app).post(`/api/admin/manual-bookings/${bookingId}/attachments`), OPS).field("type", type)
    .attach("file", Buffer.from("%PDF-1.4"), { filename, contentType: "application/pdf" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.attachment._id);
}
const save = (bookingId: string, body: any) => as(request(app).put(`/api/admin/manual-bookings/${bookingId}`), OPS).send(body);
const retype = (bookingId: string, attId: string, type: string) => as(request(app).patch(`/api/admin/manual-bookings/${bookingId}/attachments/${attId}`), OPS).send({ type });
const getReq = (rid: string) => col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(rid) }) as Promise<any>;

const isDone = (m: any) => /Your Booking has been Processed/.test(String(m.subject));
const isReady = (m: any) => /Your travel documents/.test(String(m.subject));
const files = (m: any) => (m.attachments || []).map((a: any) => a.filename);
/** Every file the customer side was emailed, in order (booking done + documents ready). */
const customerFilesEmailed = () => mails.filter((m) => isDone(m) || isReady(m)).flatMap(files);

/** What each customer screen shows for this case (ticket / voucher / document names). */
async function customerScreens(c: Case, bookingRef: string) {
  const out: Record<string, any> = {};
  const staff = await as(request(app).get(`/api/approvals/admin/requests/${c.rid}`), OPS);
  const sdoc = staff.body.request || staff.body;
  out.adminQueue = (sdoc?.meta?.bookingDocuments || []).map((d: any) => d.filename);
  if (c.kind === "Flow 3") {
    const mine = await as(request(app).get(`/api/approvals/requests/${c.rid}`), ASHA);
    out.request = (mine.body.request?._documents || []).map((d: any) => d.name);
    const mb = await as(request(app).get(`/api/my-bookings/${bookingRef}/attachments`), ASHA);
    out.myBookings = (mb.body.attachments || []).map((a: any) => a.originalFilename);
  } else {
    const row = trackerRow(await getReq(c.rid), await bookingsOfCases(c.customer, [c.rid]));
    out.tracker = row.documents;
  }
  return out;
}

for (const [kind, makeCase] of CASES) {
  describe(`${kind} — Book Now documents reach the customer`, () => {
    it("upload the ticket, then save Confirmed → booking done carries it; no documents-ready email", async () => {
      const c = await makeCase();
      await bookNowClick(c.rid);
      const b = await createBooking(c);
      await upload(b._id, "ticket", "ticket.pdf");
      mails.length = 0;
      expect((await save(b._id, { status: "CONFIRMED" })).body.requestSync).toBe("completed");
      expect(mails.filter(isDone).map(files)).toEqual([["ticket.pdf"]]);
      expect(mails.filter(isReady)).toHaveLength(0);
      const scr = await customerScreens(c, b.bookingRef);
      expect(scr.adminQueue).toEqual(["ticket.pdf"]);
      if (kind === "Flow 3") expect([scr.request, scr.myBookings]).toEqual([["ticket.pdf"], ["ticket.pdf"]]);
      else expect(scr.tracker).toEqual([{ service: "Flight", ticketIssued: true, voucherIssued: false, documentIssued: false }]);
      expect((await getReq(c.rid)).meta.documentsEmailed).toHaveLength(1);
    });

    it("FLIGHT linked: Done refused with only an internal file; a ticket added after Done → ONE documents-ready email", async () => {
      const c = await makeCase();
      await bookNowClick(c.rid);
      const b = await createBooking(c);
      await upload(b._id, "internal", `${SENTINEL}.pdf`);
      const refused = await save(b._id, { status: "CONFIRMED" });
      expect([refused.status, refused.body.code]).toEqual([400, "ATTACHMENT_REQUIRED"]);

      await upload(b._id, "ticket", "onward.pdf");
      mails.length = 0;
      expect((await save(b._id, { status: "CONFIRMED" })).body.requestSync).toBe("completed");
      // Confirm first, then upload: the return ticket arrives after Done.
      const ret = await upload(b._id, "ticket", "return.pdf");
      expect(mails.filter(isDone).map(files)).toEqual([["onward.pdf"]]);
      expect(mails.filter(isReady).map(files), "one email, the new file only").toEqual([["return.pdf"]]);
      // Saved again, retyped away and back: never a second email for it.
      await save(b._id, { notes: "seat 3A" });
      await retype(b._id, ret, "internal");
      await retype(b._id, ret, "ticket");
      expect(customerFilesEmailed()).toEqual(["onward.pdf", "return.pdf"]);
      if (kind === "PARTNER_LINK") {
        const to = mails.filter(isReady).flatMap((m) => [m.to, m.cc].flat().filter(Boolean)).map((e: any) => String(e).toLowerCase());
        expect(to, "the student only").toEqual([STUDENT]);
      }
      const ready = mails.find(isReady);
      // Price-free and no way into the app: no request / login / approval links.
      expect(ready.html).not.toMatch(/9800|12000|₹/);
      expect(ready.html).not.toMatch(/\/customer\/|\/login|\/approval|\/p\/|token=/);
    });

    it("VISA: a document file reaches every customer screen and the booking-done email", async () => {
      const c = await makeCase();
      await bookNowClick(c.rid);
      // The create form's order now: created Pending, file uploaded, then Confirmed.
      const b = await createBooking(c, { type: "VISA", itinerary: { visaCountry: "AE", visaType: "Tourist" } });
      await upload(b._id, "document", "visa.pdf");
      await upload(b._id, "internal", `${SENTINEL}.pdf`);
      mails.length = 0;
      expect((await save(b._id, { status: "CONFIRMED" })).body.requestSync).toBe("completed");
      expect(mails.filter(isDone).map(files)).toEqual([["visa.pdf"]]);
      const scr = await customerScreens(c, b.bookingRef);
      expect(scr.adminQueue).toEqual(["visa.pdf"]);
      if (kind === "Flow 3") expect([scr.request, scr.myBookings]).toEqual([["visa.pdf"], ["visa.pdf"]]);
      else expect(scr.tracker).toEqual([{ service: "Visa", ticketIssued: false, voucherIssued: false, documentIssued: true }]);
    });

    it("VISA created Confirmed before its file (an API caller's order): the file still reaches the customer, once", async () => {
      const c = await makeCase();
      await bookNowClick(c.rid);
      mails.length = 0;
      const created = await newBooking(c, { type: "VISA", status: "CONFIRMED", itinerary: { visaCountry: "AE", visaType: "Tourist" } });
      expect(created.body.requestSync).toBe("completed");
      await upload(created.body.booking._id, "document", "visa.pdf");
      expect(mails.filter(isDone).map(files)).toEqual([[]]);
      expect(mails.filter(isReady).map(files)).toEqual([["visa.pdf"]]);
      expect(customerFilesEmailed()).toEqual(["visa.pdf"]);
    });
  });
}

describe("'internal' never reaches the customer (deep scan)", () => {
  it("Flow 3: request, list, Booking History, My Bookings, export, every email and the outbox", async () => {
    const c = await flow3Case();
    await bookNowClick(c.rid);
    const b = await createBooking(c);
    const internalId = await upload(b._id, "internal", `${SENTINEL}.pdf`);
    await upload(b._id, "ticket", "ticket.pdf");
    await save(b._id, { status: "CONFIRMED" });
    await upload(b._id, "document", "insurance.pdf"); // → documents ready
    const seen: string[] = [];
    for (const path of [`/api/approvals/requests/${c.rid}`, "/api/approvals/requests/mine", `/api/my-bookings/${b.bookingRef}/attachments`, "/api/my-bookings/manual", "/api/my-bookings/manual/export?format=csv"]) {
      const res = await as(request(app).get(path), ASHA);
      seen.push(`${path} ${res.text}`);
    }
    for (const m of mails) seen.push(JSON.stringify({ ...m, attachments: (m.attachments || []).map((a: any) => ({ filename: a.filename, content: String(a.content ?? "") })) }));
    for (const row of await col("emailoutboxes").find({}).toArray()) seen.push(JSON.stringify(row));
    for (const text of seen) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(internalId);
    }
    expect(mails.filter(isReady).map(files)).toEqual([["insurance.pdf"]]);
  });

  it("PARTNER_LINK: tracker, emails and outbox", async () => {
    const c = await partnerCase();
    await bookNowClick(c.rid);
    const b = await createBooking(c);
    const internalId = await upload(b._id, "internal", `${SENTINEL}.pdf`);
    await upload(b._id, "ticket", "ticket.pdf");
    await save(b._id, { status: "CONFIRMED" });
    await upload(b._id, "ticket", "return.pdf");
    const seen = [
      JSON.stringify(trackerRow(await getReq(c.rid), await bookingsOfCases(c.customer, [c.rid]))),
      ...mails.map((m) => JSON.stringify({ ...m, attachments: (m.attachments || []).map((a: any) => a.filename) })),
      ...(await col("emailoutboxes").find({}).toArray()).map((r) => JSON.stringify(r)),
    ];
    for (const text of seen) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(internalId);
    }
  });
});

/* ═══════════════════ One booking per request, unless asked for ═══════════════════ */

const FLOW2 = oid();
const FLOW2_CUSTOMER = oid();
const RAVI = person("ravi@beta.test", "Ravi Kumar", ["CUSTOMER"], FLOW2);
const BEA = person("bea@beta.test", "Bea Approver", ["CUSTOMER"], FLOW2);
async function flow2Case(): Promise<Case> {
  await col("customerworkspaces").insertOne({ _id: FLOW2, customerId: String(FLOW2_CUSTOMER), name: "Beta", companyName: "Beta", status: "ACTIVE", tenantType: "CORPORATE", defaultApproverEmails: [BEA.email], config: { travelFlow: "APPROVAL_FLOW", features: { approvalFlowEnabled: true } } } as any);
  await col("users").insertMany([RAVI, BEA].map((u) => ({ _id: new mongoose.Types.ObjectId(u.sub), workspaceId: FLOW2, email: u.email, name: u.name, firstName: u.name.split(" ")[0], lastName: u.name.split(" ")[1], roles: u.roles, status: "ACTIVE", passwordHash: "x" })) as any[]);
  const created = await as(request(app).post("/api/approvals/requests"), RAVI).send({ cartItems: [{ type: "flight", title: "BLR → DEL", qty: 1, price: 0, meta: { origin: "BLR", destination: "DEL", tripType: "oneway", departDate: "2027-04-02", travelScope: "domestic", travellers: [{ kind: "manual", firstName: "Ravi", lastName: "Kumar" }] } }] });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const rid = String(created.body.request._id);
  expect((await as(request(app).put(`/api/approvals/requests/${rid}/action`), BEA).send({ action: "approved" })).status).toBe(200);
  return { kind: "Flow 3", rid, customer: String(FLOW2_CUSTOMER), passengerEmail: RAVI.email };
}

const byRequest = (rid: string) => as(request(app).get(`/api/admin/manual-bookings/by-request/${rid}`), OPS);
/** The queue row of a request, from whichever staff list carries it. */
async function queueRow(rid: string) {
  for (const list of ["pending", "approved", "done"]) {
    const res = await as(request(app).get(`/api/approvals/admin/${list}`), OPS);
    const row = (res.body.rows || []).find((r: any) => String(r._id) === rid);
    if (row) return row;
  }
  return null;
}

for (const [kind, makeCase] of [...CASES, ["Flow 2", flow2Case] as [string, () => Promise<Case>]]) {
  describe(`${kind} — Book Now twice opens the existing booking`, () => {
    it("second create → 409 BOOKING_EXISTS naming the first; additional: true creates a second; the queue row and by-request list them", async () => {
      const c = await makeCase();
      await bookNowClick(c.rid);
      const first = await createBooking(c);
      expect((await queueRow(c.rid))._bookings).toEqual([
        { _id: String(first._id), bookingRef: first.bookingRef, type: "FLIGHT", status: "PENDING", subStatus: "", createdAt: expect.any(String) },
      ]);

      // Book Now again → the start-booking is a no-op, and a new booking is refused.
      expect((await bookNowClick(c.rid)).status).toBe(200);
      const again = await newBooking(c);
      expect([again.status, again.body.code]).toEqual([409, "BOOKING_EXISTS"]);
      expect(again.body.bookings.map((b: any) => b.bookingRef)).toEqual([first.bookingRef]);
      expect(await col("manualbookings").countDocuments({ sourceBookingId: new mongoose.Types.ObjectId(c.rid) })).toBe(1);

      // "+ Add another booking"
      const second = await newBooking(c, { additional: true, type: "HOTEL", supplierName: "Taj", itinerary: { destination: "Delhi" }, returnDate: "2027-04-04" });
      expect(second.status, JSON.stringify(second.body)).toBe(201);
      expect(second.body.booking.additional, "the flag is not stored").toBeUndefined();
      const listed = (await byRequest(c.rid)).body.bookings.map((b: any) => [b.bookingRef, b.type]);
      expect(listed).toEqual([[first.bookingRef, "FLIGHT"], [second.body.booking.bookingRef, "HOTEL"]]);
      expect((await queueRow(c.rid))._bookings.map((b: any) => b.type)).toEqual(["FLIGHT", "HOTEL"]);
    });
  });
}

describe("one booking per request — edges", () => {
  it("a request booked without a booking (Mark done) takes a new booking only on purpose", async () => {
    const c = await flow3Case();
    await bookNowClick(c.rid);
    await col("approvalrequests").updateOne({ _id: new mongoose.Types.ObjectId(c.rid) }, { $set: { stage: "COMPLETED", adminState: "done" } });
    const refused = await newBooking(c);
    expect([refused.status, refused.body.code, refused.body.bookings]).toEqual([409, "BOOKING_EXISTS", []]);
    expect((await newBooking(c, { additional: true })).status).toBe(201);
  });

  it("a deleted booking doesn't count; plain manual bookings are untouched by the rule", async () => {
    const c = await flow3Case();
    const first = await createBooking(c);
    await col("manualbookings").updateOne({ _id: new mongoose.Types.ObjectId(first._id) }, { $set: { isActive: false } });
    expect((await newBooking(c)).status).toBe(201);
    const plain = { workspaceId: c.customer, type: "FLIGHT", status: "PENDING", supplierName: "IndiGo", givenBy: "Ops", travelDate: "2027-04-02", passengers: [{ name: "X", type: "ADULT" }], pricing: { actualPrice: 1, quotedPrice: 2 } };
    expect((await as(request(app).post("/api/admin/manual-bookings"), OPS).send(plain)).status).toBe(201);
    expect((await as(request(app).post("/api/admin/manual-bookings"), OPS).send(plain)).status, "no request, no limit").toBe(201);
  });

  it("customers never get the booking summary", async () => {
    const c = await flow3Case();
    await createBooking(c);
    const mine = await as(request(app).get(`/api/approvals/requests/${c.rid}`), ASHA);
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.body)).not.toContain("_bookings");
    expect((await byRequest("not-an-id")).status).toBe(400);
  });
});
