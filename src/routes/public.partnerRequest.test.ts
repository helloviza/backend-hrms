// apps/backend/src/routes/public.partnerRequest.test.ts
//
// Partner lead links, public side → a case in the ops queue:
//   - the seam: a submit writes an approved, Direct, PARTNER_LINK case on the
//     LINK's partner workspace (CW._id + its customerId), with "Case created" /
//     "In Admin Queue" system rows, in the ops list, auto-assigned RM-first;
//   - tenant isolation: body ids ignored; unknown / inactive link, inactive
//     workspace and a stale customerId are one uniform 404;
//   - abuse: honeypot, Turnstile, 429 per IP, per-code daily cap, dedup on the
//     submission id (also when two land at once);
//   - travellers: "self" refused, international trips need passports (shared
//     rules), nothing saved to profiles / members / users;
//   - no price or id in any public response; the student's email has the case
//     number and no link, no price;
//   - emails: the Partner Intake address is never a recipient; "booking done"
//     doesn't copy the partner's leaders;
//   - Book Now lands the booking on the partner's Customer._id (CLIENT_MISMATCH
//     still guards it);
//   - meta.partnerLead is byte-identical after start-booking, assign, done, close;
//   - a partner Workspace Leader can't list, open or download a partner case.
//
// Real: public partner router + intake service, approvals and manual-bookings
// routers, enterOpsQueue / Travel Desk allocation, email dispatch + outbox,
// in-memory Mongo with the migration's indexes. Stubbed: auth (user from a
// header), requireWorkspace (workspace from a header), requirePermission,
// the mail transport, S3, Turnstile's siteverify (global fetch).
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

/* ───────────────────────── the seam ───────────────────────── */

describe("a submit becomes an approved case in the ops queue", () => {
  it("writes the born-approved Direct shape on the link's partner, with system rows, and lists it for ops", async () => {
    const res = await submit();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(["caseNumber", "ok"]);
    expect(res.body.caseNumber).toMatch(/^PL-[A-HJKMNP-Z2-9]{6}$/);

    const doc = await caseOf(res.body.caseNumber);
    expect(doc).toMatchObject({
      status: "approved",
      adminState: "pending",
      stage: "REQUEST_APPROVED",
      ticketId: res.body.caseNumber,
      customerId: String(AMBER_CUSTOMER),
      customerName: "Amber Student",
      frontlinerEmail: PARTNER_INTAKE_EMAIL,
      managerEmail: PARTNER_INTAKE_EMAIL,
      frontlinerId: String(INTAKE_ID),
    });
    expect(String(doc.workspaceId)).toBe(String(AMBER));
    expect(doc.meta).toMatchObject({ travelFlow: "APPROVAL_DIRECT", source: "PARTNER_LINK", ccLeaders: [] });
    expect(doc.meta.autoApproved).toBeUndefined();
    const pl = doc.meta.partnerLead;
    expect(pl).toMatchObject({
      caseNumber: res.body.caseNumber,
      code: CODE,
      placement: "homepage-banner",
      partnerWorkspaceId: String(AMBER),
      partnerName: "Amber Student",
      embedMode: "tab",
      referrer: "https://amberstudent.com/page",
      contact: { name: "Riya Sen", email: "riya@student.test", phone: "+91 98765 43210" },
      utm: { source: "amber", medium: "banner", campaign: "", content: "", term: "" },
    });
    expect(pl.intakeRef).toMatch(/^partner:[0-9a-f-]{36}$/);
    expect(pl.consent.version).toBe("2026-10");
    expect(pl.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(pl)).not.toContain("127.0.0.1");
    expect([0, undefined]).toContain(doc.cartItems[0].price); // the student's 99999 is never kept
    expect(doc.cartItems[0].meta.travellers[0].kind).toBe("manual");

    expect(doc.history.map((h: any) => [h.action, h.actorKind])).toEqual([["submitted", "system"], ["approved", "system"]]);
    expect(doc.history[0].comment).toMatch(/^Case created/);
    expect(doc.history[1].comment).toMatch(/^In Admin Queue/);

    const list = await as(request(app).get("/api/approvals/admin/approved"), OPS);
    expect(list.status).toBe(200);
    const rows = list.body.rows || list.body.requests || list.body.items || [];
    expect(rows.map((r: any) => String(r._id))).toContain(String(doc._id));

    const link: any = await col("partnerlinks").findOne({ code: CODE });
    expect(link.submissions).toBe(1);
  });

  it("is auto-assigned RM first when the Travel Desk is on, like any approved case", async () => {
    await col("traveldesksettings").insertOne({
      key: "default", mode: "round_robin", rmFirst: true,
      agents: [{ userId: new mongoose.Types.ObjectId(AGENT.sub), available: true }, { userId: new mongoose.Types.ObjectId(RM.sub), available: true }],
    } as any);
    const res = await submit();
    const doc = await caseOf(res.body.caseNumber);
    expect(doc.meta.adminAssigned).toMatchObject({ userId: RM.sub, agentName: "Rita Menon", via: "auto", reason: "rm" });
    expect(doc.adminState).toBe("assigned");
    expect(doc.history.map((h: any) => h.action)).toEqual(["submitted", "approved", "admin_auto_assigned"]);
  });

  it("the desk hears about the new case; the student gets the confirmation; nobody else", async () => {
    const res = await submit();
    const desk = mails.find((m) => [m.to].flat().map(String).includes(DESK_EMAIL));
    expect(desk, "ops desk email").toBeTruthy();
    const student = mails.filter((m) => [m.to].flat().includes("riya@student.test"));
    expect(student).toHaveLength(1);
    const html = String(student[0].html);
    expect(student[0].subject).toContain(res.body.caseNumber);
    expect(html).toContain(res.body.caseNumber);
    expect(html).toContain("A travel expert will contact you");
    for (const bad of ["₹", "INR", "/customer/approvals", "/login", "99999", "href=\"http"]) expect(html, bad).not.toContain(bad);
    expect(String(student[0].text)).toContain(res.body.caseNumber);
    expect(recipients()).not.toContain(PARTNER_INTAKE_EMAIL);
    expect(recipients()).not.toContain(LEAD.email);
  });
});

/* ───────────────────────── tenant isolation ───────────────────────── */

describe("the partner comes from the link only", () => {
  it("ids in the body are ignored", async () => {
    const res = await submit(body({ workspaceId: String(OTHER), customerId: String(OTHER_CUSTOMER), partnerWorkspaceId: String(OTHER) }));
    expect(res.status).toBe(201);
    const doc = await caseOf(res.body.caseNumber);
    expect(String(doc.workspaceId)).toBe(String(AMBER));
    expect(doc.customerId).toBe(String(AMBER_CUSTOMER));
  });

  it("an unknown or inactive link, an inactive workspace, a stale customerId: one uniform 404, nothing written", async () => {
    const bodies: any[] = [];
    const tryAll = async () => {
      const r1 = await submit();
      const r2 = await request(app).get(`/api/public/partner-links/${CODE}`);
      bodies.push([r1.status, r1.body], [r2.status, r2.body]);
    };
    // unknown code
    const unknown = await submit(body({ code: "Zz9Zz9Zz" }));
    const malformed = await request(app).get("/api/public/partner-links/not-a-code!");
    bodies.push([unknown.status, unknown.body], [malformed.status, malformed.body]);
    // inactive link
    await col("partnerlinks").updateOne({ code: CODE }, { $set: { active: false } });
    await tryAll();
    // inactive workspace
    await col("partnerlinks").updateOne({ code: CODE }, { $set: { active: true } });
    await col("customerworkspaces").updateOne({ _id: AMBER }, { $set: { status: "SUSPENDED" } });
    await tryAll();
    // the workspace's customerId moved since the link was made
    await col("customerworkspaces").updateOne({ _id: AMBER }, { $set: { status: "ACTIVE", customerId: String(oid()) } });
    await tryAll();

    for (const [status, b] of bodies) {
      expect(status).toBe(404);
      expect(b).toEqual({ error: "This link is not available." });
    }
    expect(await col("approvalrequests").countDocuments({})).toBe(0);
    expect((await col("partnerlinks").findOne({ code: CODE }))!.clicks).toBe(0);
  });

  it("resolve returns the display name and services only, and counts the click", async () => {
    const res = await request(app).get(`/api/public/partner-links/${CODE}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, partnerDisplayName: "Amber Student", services: ["flight", "hotel", "visa"] });
    expect((await col("partnerlinks").findOne({ code: CODE }))!.clicks).toBe(1);
  });
});

/* ───────────────────────── abuse ───────────────────────── */

describe("abuse", () => {
  it("a filled honeypot gets a fake success and writes nothing", async () => {
    const res = await submit(body({ hpField: "http://spam" }));
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(["caseNumber", "ok"]);
    expect(await col("approvalrequests").countDocuments({})).toBe(0);
    expect(mails).toHaveLength(0);
  });

  it("no Turnstile token, or a bad one: 400, nothing written, no daily slot used", async () => {
    const none = await submit(body({ turnstileToken: undefined }));
    const bad = await submit(body({ turnstileToken: "forged" }));
    expect([none.status, bad.status]).toEqual([400, 400]);
    expect(await col("approvalrequests").countDocuments({})).toBe(0);
    expect((await col("partnerlinks").findOne({ code: CODE }))!.dailyCount).toBe(0);
  });

  it("the ninth submit from one address in 15 minutes is 429", async () => {
    for (let i = 0; i < 8; i++) expect((await submit()).status).toBe(201);
    const ninth = await submit();
    expect(ninth.status).toBe(429);
    expect(await col("approvalrequests").countDocuments({})).toBe(8);
  });

  it("the per-code daily cap: 429 once used up; an invalid submit doesn't use a slot", async () => {
    await col("partnerlinks").updateOne({ code: CODE }, { $set: { dailyCap: 2 } });
    expect((await submit(body({ contact: { name: "No Email" } }))).status).toBe(400);
    expect((await submit()).status).toBe(201);
    expect((await submit()).status).toBe(201);
    const third = await submit();
    expect([third.status, third.body.code]).toEqual([429, "DAILY_CAP"]);
    expect(await col("approvalrequests").countDocuments({})).toBe(2);
  });

  it("the same submission twice is one case, and the second answer is the same case number", async () => {
    const b = body();
    const first = await submit(b);
    const again = await submit(b);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.caseNumber).toBe(first.body.caseNumber);
    expect(await col("approvalrequests").countDocuments({})).toBe(1);
    expect((await col("partnerlinks").findOne({ code: CODE }))!.submissions).toBe(1);
  });

  it("two copies landing at once still make one case", async () => {
    const b = body();
    const [x, y] = await Promise.all([submit(b), submit(b)]);
    expect([x.status, y.status].sort()).toEqual([200, 201]);
    expect(x.body.caseNumber).toBe(y.body.caseNumber);
    expect(await col("approvalrequests").countDocuments({})).toBe(1);
  });
});

/* ───────────────────────── travellers and items ───────────────────────── */

describe("travellers and items", () => {
  it("a 'self' traveller is refused", async () => {
    const res = await submit(body({ cartItems: [flight({ travellers: [{ kind: "self", firstName: "Me", lastName: "Self" }] })] }));
    expect([res.status, res.body.code]).toEqual([400, "SELF_NOT_ALLOWED"]);
    expect(await col("approvalrequests").countDocuments({})).toBe(0);
  });

  it("nothing is saved to traveller profiles, company members or users", async () => {
    const before = await Promise.all(["travellerprofiles", "customermembers", "users"].map((n) => col(n).countDocuments({})));
    expect((await submit()).status).toBe(201);
    const after = await Promise.all(["travellerprofiles", "customermembers", "users"].map((n) => col(n).countDocuments({})));
    expect(after).toEqual(before);
  });

  it("an international flight needs passport details (the request form's rule); with them it goes through", async () => {
    const intl = { origin: "BLR", destination: "LHR", travelScope: "international" };
    const without = await submit(body({ cartItems: [flight(intl)] }));
    expect(without.status).toBe(400);
    expect(JSON.stringify(without.body)).toMatch(/passport/i);
    const traveller = { firstName: "Riya", lastName: "Sen", dob: "2004-05-06", gender: "Female", nationality: "Indian", passportNumber: "Z1234567", passportExpiry: "2032-01-01", phone: "9876543210", email: "riya@student.test" };
    const withPassport = await submit(body({ cartItems: [flight({ ...intl, travellers: [traveller] })] }));
    expect(withPassport.status, JSON.stringify(withPassport.body)).toBe(201);
  });

  it("a domestic flight needs no passport", async () => {
    expect((await submit()).status).toBe(201);
  });

  it("a service the link doesn't offer is refused", async () => {
    await col("partnerlinks").updateOne({ code: CODE }, { $set: { services: ["visa"] } });
    const res = await submit();
    expect([res.status, res.body.code]).toEqual([400, "SERVICE_NOT_OFFERED"]);
  });

  it("contact (name, email, phone) and consent are required", async () => {
    const noPhone = await submit(body({ contact: { name: "Riya", email: "riya@student.test" } }));
    expect([noPhone.status, noPhone.body.code, noPhone.body.missing]).toEqual([400, "CONTACT_REQUIRED", ["phone"]]);
    const noConsent = await submit(body({ consent: { accepted: false, version: "2026-10" } }));
    expect([noConsent.status, noConsent.body.code]).toEqual([400, "CONSENT_REQUIRED"]);
  });
});

/* ───────────────────────── nothing priced or internal goes out ───────────────────────── */

describe("public responses", () => {
  it("resolve and submit carry no price key, no id", async () => {
    const resolve = await request(app).get(`/api/public/partner-links/${CODE}`);
    const created = await submit();
    for (const b of [resolve.body, created.body]) {
      expect(keysDeep(b).filter(isPriceKey)).toEqual([]);
      const text = JSON.stringify(b);
      expect(text).not.toContain(String(AMBER));
      expect(text).not.toContain(String(AMBER_CUSTOMER));
      expect(text).not.toMatch(/[0-9a-f]{24}/);
    }
  });
});

/* ───────────────────────── through ops ───────────────────────── */

const startBooking = (id: string) => as(request(app).put(`/api/approvals/admin/${id}/start-booking`), OPS).send({});
function bookingBody(rid: string, over: any = {}) {
  return {
    workspaceId: String(AMBER_CUSTOMER), type: "FLIGHT", status: "PENDING", source: "ADMIN_QUEUE", sourceBookingId: rid,
    supplierName: "IndiGo", givenBy: "Rita", travelDate: "2027-04-02", passengers: [{ name: "Riya Sen", type: "ADULT" }],
    pricing: { actualPrice: 4800, quotedPrice: 5600 }, ...over,
  };
}
async function upload(bookingId: string) {
  const res = await as(request(app).post(`/api/admin/manual-bookings/${bookingId}/attachments`), OPS)
    .field("type", "ticket")
    .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "ticket.pdf", contentType: "application/pdf" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return String(res.body.attachment._id);
}
async function bookedCase() {
  const res = await submit();
  const doc = await caseOf(res.body.caseNumber);
  const rid = String(doc._id);
  expect((await startBooking(rid)).status).toBe(200);
  const created = await as(request(app).post("/api/admin/manual-bookings"), OPS).send(bookingBody(rid));
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const bookingId = String(created.body.booking._id);
  const attId = await upload(bookingId);
  const done = await as(request(app).put(`/api/admin/manual-bookings/${bookingId}`), OPS).send({ status: "CONFIRMED" });
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  expect(done.body.requestSync).toBe("completed");
  return { rid, bookingId, attId, caseNumber: res.body.caseNumber };
}

describe("Book Now and booking done", () => {
  it("the booking lands on the partner's Customer._id; another client is still refused", async () => {
    const res = await submit();
    const rid = String((await caseOf(res.body.caseNumber))._id);
    const wrong = await as(request(app).post("/api/admin/manual-bookings"), OPS).send(bookingBody(rid, { workspaceId: String(OTHER_CUSTOMER) }));
    expect([wrong.status, wrong.body.code]).toEqual([400, "CLIENT_MISMATCH"]);
    const ok = await as(request(app).post("/api/admin/manual-bookings"), OPS).send(bookingBody(rid));
    expect(ok.status).toBe(201);
    expect(String(ok.body.booking.workspaceId)).toBe(String(AMBER_CUSTOMER));
  });

  it("Done completes the case; 'booking done' copies neither the partner's leaders nor the intake address", async () => {
    mails.length = 0;
    const { rid } = await bookedCase();
    const doc: any = await col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(rid) });
    expect([doc.adminState, doc.stage]).toEqual(["done", "COMPLETED"]);
    expect(recipients()).not.toContain(LEAD.email);
    expect(recipients()).not.toContain(PARTNER_INTAKE_EMAIL);
    expect(mails.some((m) => /Processed/.test(String(m.subject)))).toBe(false);
  });
});

describe("meta.partnerLead is untouched by ops actions", () => {
  it("start-booking, assign, done and close leave it byte-identical", async () => {
    await col("traveldesksettings").insertOne({ key: "default", mode: "off", rmFirst: true, agents: [{ userId: new mongoose.Types.ObjectId(AGENT.sub), available: true }] } as any);
    const one = await submit();
    const a: any = await caseOf(one.body.caseNumber);
    const before = JSON.stringify(a.meta.partnerLead);
    const id = String(a._id);
    for (const r of [
      await startBooking(id),
      await as(request(app).put(`/api/approvals/admin/${id}/assign`), OPS).send({ agentUserId: AGENT.sub }),
      await as(request(app).put(`/api/approvals/admin/${id}/done`), OPS).send({ comment: "Handled" }),
    ]) expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(JSON.stringify((await caseOf(one.body.caseNumber)).meta.partnerLead)).toBe(before);

    const two = await submit();
    const b: any = await caseOf(two.body.caseNumber);
    const beforeB = JSON.stringify(b.meta.partnerLead);
    const closed = await as(request(app).put(`/api/approvals/admin/${b._id}/close`), OPS).send({ reason: Object.keys(CLOSE_REASONS)[0], note: "Student not reachable" });
    expect(closed.status, JSON.stringify(closed.body)).toBe(200);
    expect(JSON.stringify((await caseOf(two.body.caseNumber)).meta.partnerLead)).toBe(beforeB);
  });
});

describe("a partner Workspace Leader can't reach partner cases", () => {
  it("not in the inbox or 'mine', can't open one, can't download its documents", async () => {
    const { rid, attId } = await bookedCase();
    const inbox = await as(request(app).get("/api/approvals/requests/inbox"), LEAD);
    const mine = await as(request(app).get("/api/approvals/requests/mine"), LEAD);
    for (const r of [inbox, mine]) {
      expect(r.status).toBeLessThan(500);
      expect(JSON.stringify(r.body)).not.toContain(rid);
    }
    const open = await as(request(app).get(`/api/approvals/requests/${rid}`), LEAD);
    expect([403, 404]).toContain(open.status);
    expect(JSON.stringify(open.body)).not.toContain("riya@student.test");
    const dl = await as(request(app).get(`/api/approvals/requests/${rid}/documents/mb-${attId}/download`), LEAD);
    expect(dl.status).toBe(404);
    // Staff still can.
    const staff = await as(request(app).get(`/api/approvals/requests/${rid}/documents/mb-${attId}/download`), OPS);
    expect(staff.status).toBe(200);
  });
});
