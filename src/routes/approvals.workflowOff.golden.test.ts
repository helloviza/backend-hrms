// apps/backend/src/routes/approvals.workflowOff.golden.test.ts
//
// "No published approval workflow = today's routing, byte for byte."
//
// The golden file (approvals.workflowOff.golden.json) was recorded on
// origin/main 357f42ec, BEFORE the approval-workflow build touched any code
// (UPDATE_GOLDEN=1). Every later commit must reproduce it exactly, for each
// of three "off" states of a workspace:
//   - NONE      no ApprovalWorkflowVersion row at all
//   - DRAFT     only a draft (never published)
//   - DISABLED  a published version with enabled: false
//
// What is compared, per scenario: every HTTP response (status + body), the
// stored request (all fields), and every email sent (to, cc, subject, and a
// hash of the HTML). Ids, link tokens and request codes are normalised, and
// the clock is frozen, so the record is deterministic.
//
// Scenarios: Flow 3 (APPROVAL_DIRECT) and Flow 2 (APPROVAL_FLOW) tenants —
// submit, approve in-app, decline by email link, approver's own request routed
// to a WL, clarification round trip, WL auto-approve, revoke, resubmit, no
// approver configured, inbox, request-context, detail view, resend; a tenant
// with department heads and reporting managers set (ignored while off); and a
// partner lead link case (public form) on a partner workspace.
//
// Real: approvals, approval-links and public partner routers, decisions,
// email map/dispatch/templates, outbox. Stubbed: auth (user from a header),
// requireWorkspace (workspace from a header), the mail transport, Turnstile.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
for (const [k, v] of Object.entries({
  MONGO_URI: "mongodb://127.0.0.1:1/unused",
  JWT_SECRET: "jwt-secret-for-tests",
  JWT_REFRESH_SECRET: "refresh-secret-for-tests",
  FRONTEND_ORIGIN: "http://localhost:5173",
  AWS_REGION: "ap-south-1",
  S3_BUCKET: "test-bucket",
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
  resolveWorkspaceForUser: async (user: any) => {
    const { default: mg } = await import("mongoose");
    if (!user?.workspaceId) return null;
    return mg.connection.db!.collection("customerworkspaces").findOne({ _id: new mg.Types.ObjectId(String(user.workspaceId)) });
  },
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
vi.mock("../services/tbo.flight.service.js", async (orig) => {
  const { vi: v } = await import("vitest");
  return { ...(await orig<any>()), searchFlights: v.fn() };
});
vi.mock("../services/tbo.hotel.search.service.js", async (orig) => {
  const { vi: v } = await import("vitest");
  return { ...(await orig<any>()), searchHotels: v.fn() };
});
vi.mock("../services/location.service.js", async (orig) => ({ ...(await orig<any>()), resolveActorFromRequest: async () => null }));
vi.mock("../utils/emailActionToken.js", () => ({ signEmailActionToken: () => "tok", verifyEmailActionToken: () => null, hashToken: () => "hash" }));

vi.stubGlobal("fetch", async (_url: any, init: any) => {
  const token = new URLSearchParams(String(init?.body || "")).get("response");
  return { ok: true, json: async () => ({ success: token === "ok" }) } as any;
});

const { default: approvalsRouter } = await import("./approvals.js");
const { default: approvalLinksRouter } = await import("./approvalLinks.js");
const { default: publicPartnerRouter } = await import("./public.partnerRequest.js");
const { partnerRequestLimiter, partnerLinkResolveLimiter } = await import("../middleware/rateLimit.js");
const { migratePartnerLeadIndexes } = await import("../scripts/migrate-partner-lead-indexes.js");
const { resetPartnerIntakeCache } = await import("../services/partnerIntake.create.js");
const { PARTNER_INTAKE_EMAIL } = await import("../services/partnerLeadCase.js");
const { signApprovalLink } = await import("../utils/approvalLinkToken.js");

const app = express();
app.use(express.json());
app.use("/api/public/approval-links", approvalLinksRouter);
app.use("/api/public", publicPartnerRouter);
app.use("/api/approvals", approvalsRouter);

const GOLDEN = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "approvals.workflowOff.golden.json");
const DB = "approval-workflow-off-golden";
let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const id = (hex: string) => new mongoose.Types.ObjectId(hex.padStart(24, "0"));

/* ── fixed world ── */
const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const WS3 = id("a3"); // Flow 3
const WS2 = id("a2"); // Flow 2
const WS3_ORG = id("a4"); // Flow 3 with department heads + reporting managers set
const WS_NOAPP = id("a5"); // Flow 3, no approver, no leader
const AMBER = id("a6"); // partner workspace
const AMBER_CUSTOMER = id("c6");
const DEPT = id("d1");
const INTAKE_ID = id("e0");

type Who = { sub: string; email: string; name: string; roles: string[]; ws: any };
const who = (n: number, email: string, name: string, roles: string[], ws: any): Who => ({ sub: String(id(`f${n}`)), email, name, roles, ws });
const REQ3 = who(1, "riya@flow3.test", "Riya Rao", ["EMPLOYEE"], WS3);
const APP3 = who(2, "approver@flow3.test", "Arjun Approver", ["EMPLOYEE"], WS3);
const WL3 = who(3, "leader@flow3.test", "Lata Leader", ["WORKSPACE_LEADER"], WS3);
const REQ2 = who(4, "riya@flow2.test", "Ravi Rao", ["EMPLOYEE"], WS2);
const WL2 = who(5, "leader@flow2.test", "Lina Leader", ["WORKSPACE_LEADER"], WS2);
const APP2 = who(6, "approver@flow2.test", "Anil Approver", ["EMPLOYEE"], WS2);
const REQ_ORG = who(7, "emp@org.test", "Esha Employee", ["EMPLOYEE"], WS3_ORG);
const HEAD_ORG = who(8, "head@org.test", "Hari Head", ["EMPLOYEE"], WS3_ORG);
const MGR_ORG = who(9, "mgr@org.test", "Mira Manager", ["EMPLOYEE"], WS3_ORG);
const APP_ORG = who(10, "approver@org.test", "Ola Approver", ["EMPLOYEE"], WS3_ORG);
const WL_ORG = who(11, "leader@org.test", "Leo Leader", ["WORKSPACE_LEADER"], WS3_ORG);
const REQ_NOAPP = who(12, "lonely@noapp.test", "Lone Requester", ["EMPLOYEE"], WS_NOAPP);
const PEOPLE = [REQ3, APP3, WL3, REQ2, WL2, APP2, REQ_ORG, HEAD_ORG, MGR_ORG, APP_ORG, WL_ORG, REQ_NOAPP];

const as = (r: request.Test, w: Who) =>
  r
    .set("x-test-user", JSON.stringify({ sub: w.sub, _id: w.sub, email: w.email, name: w.name, roles: w.roles, workspaceId: String(w.ws), customerId: String(w.ws) }))
    .set("x-test-ws", String(w.ws));

const flight = {
  type: "flight", title: "BLR → BOM", qty: 1, price: 0,
  meta: { origin: "BLR", destination: "BOM", tripType: "oneway", departDate: "2027-03-12", travellers: [{ kind: "manual", firstName: "Asha", lastName: "Rao" }] },
};
const hotel = {
  type: "hotel", title: "Mumbai hotel", qty: 1, price: 0,
  meta: { city: "Mumbai", checkIn: "2027-03-12", checkOut: "2027-03-14", rooms: 1, adults: 1, travellers: [{ kind: "manual", firstName: "Asha", lastName: "Rao" }] },
};

/* ── normalisation ── */
const oidNames = new Map<string, string>();
function nameIds() {
  oidNames.clear();
  const fixed: Record<string, any> = { HOUSE, WS3, WS2, WS3_ORG, WS_NOAPP, AMBER, AMBER_CUSTOMER, DEPT, INTAKE_ID };
  for (const [k, v] of Object.entries(fixed)) oidNames.set(String(v), k);
  for (const p of PEOPLE) oidNames.set(p.sub, p.email);
}
function normString(s: string): string {
  return s
    .replace(/token=[^&"'\s<]+/g, "token=<token>")
    .replace(/\b[0-9a-f]{24}\b/g, (h) => (oidNames.has(h) ? `<${oidNames.get(h)}>` : "<oid>"))
    .replace(/REQ-[0-9A-F]{6}\b/g, "REQ-XXXXXX")
    .replace(/PL-[A-HJKMNP-Z2-9]{6}\b/g, "PL-XXXXXX")
    .replace(/\b[0-9a-f]{32,64}\b/g, "<hex>")
    .replace(/partner:[0-9a-f-]{36}/g, "partner:<uuid>")
    .replace(/\bm-[0-9a-f]{16}\b/g, "m-<rand>")
    .replace(/^[0-9A-F]{6}$/, "XXXXXX");
}
function norm(v: any): any {
  if (v === null || v === undefined) return v;
  if (v instanceof Date) return "<date>";
  if (v instanceof mongoose.Types.ObjectId) return normString(String(v));
  if (Buffer.isBuffer(v)) return "<buffer>";
  if (Array.isArray(v)) return v.map(norm);
  if (typeof v === "object") {
    if (v._bsontype === "ObjectId" || v._bsontype === "ObjectID") return normString(String(v));
    const out: any = {};
    for (const k of Object.keys(v)) out[k] = norm(v[k]);
    return out;
  }
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v) ? "<date>" : normString(v);
  return v;
}
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
function takeMails() {
  const out = mails.splice(0).map((m) => {
    const html = normString(String(m.html || ""));
    return {
      to: norm([m.to].flat().filter(Boolean).map(String).sort()),
      cc: norm([m.cc].flat().filter(Boolean).map(String).sort()),
      subject: normString(String(m.subject || "")),
      replyTo: normString(String(m.replyTo || "")),
      html: sha(html),
    };
  });
  return out.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
async function stored(reqId: any) {
  if (!reqId) return null;
  return norm(await col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(String(reqId)) }));
}

/* ── scenarios ── */
type Rec = Record<string, any>;
const step = async (rec: Rec[], label: string, r: request.Response, reqId?: any) => {
  rec.push({ label, status: r.status, body: norm(r.body), request: await stored(reqId), mails: takeMails() });
};
const submit = (w: Who, items: any[] = [flight], extra: any = {}) =>
  as(request(app).post("/api/approvals/requests"), w).send({ cartItems: items, comments: "Client visit", ...extra });
const act = (reqId: any, w: Who, action: string, comment?: string) =>
  as(request(app).put(`/api/approvals/requests/${String(reqId)}/action`), w).send({ action, comment });
const link = (reqId: any, email: string) => signApprovalLink({ kind: "request", id: String(reqId), email }, 72)!;

async function runScenarios(): Promise<Rec[]> {
  const rec: Rec[] = [];

  // Flow 3: context, submit, inbox, detail, approve in-app.
  await step(rec, "f3.context", await as(request(app).get("/api/approvals/request-context"), REQ3));
  let r = await submit(REQ3, [flight, hotel]);
  const a = r.body?.request?._id;
  await step(rec, "f3.submit", r, a);
  await step(rec, "f3.inbox.approver", await as(request(app).get("/api/approvals/requests/inbox?view=all"), APP3));
  await step(rec, "f3.inbox.leader", await as(request(app).get("/api/approvals/requests/inbox"), WL3));
  await step(rec, "f3.detail.approver", await as(request(app).get(`/api/approvals/requests/${a}`), APP3));
  await step(rec, "f3.resend", await as(request(app).put(`/api/approvals/requests/${a}/action`), REQ3).send({ action: "resend_email" }), a);
  await step(rec, "f3.approve", await act(a, APP3, "approved", "ok"), a);

  // Flow 3: decline by email link (GET view, POST decision, reuse refused), then resubmit and leader approves.
  r = await submit(REQ3);
  const b = r.body?.request?._id;
  await step(rec, "f3.submit2", r, b);
  const tok = link(b, APP3.email);
  await step(rec, "f3.link.view", await request(app).get(`/api/public/approval-links/${tok}`));
  await step(rec, "f3.link.decline", await request(app).post(`/api/public/approval-links/${tok}`).send({ action: "decline", reason: "Over budget" }), b);
  await step(rec, "f3.link.reuse", await request(app).post(`/api/public/approval-links/${tok}`).send({ action: "approve" }), b);
  await step(rec, "f3.resubmit", await as(request(app).put(`/api/approvals/requests/${b}/resubmit`), REQ3).send({ comment: "Cheaper fare" }), b);
  await step(rec, "f3.leader.approve", await act(b, WL3, "approved"), b);

  // Flow 3: approver's own request → the leader; clarification round trip; leader declines.
  r = await submit(APP3);
  const c = r.body?.request?._id;
  await step(rec, "f3.ownApprover.submit", r, c);
  await step(rec, "f3.self.act", await act(c, APP3, "approved"), c);
  await step(rec, "f3.clarify", await act(c, WL3, "clarify", "Which project?"), c);
  await step(rec, "f3.reply", await as(request(app).post(`/api/approvals/requests/${c}/clarification`), APP3).send({ reply: "Project Atlas" }), c);
  await step(rec, "f3.decline.noReason", await act(c, WL3, "declined"), c);
  await step(rec, "f3.decline", await act(c, WL3, "declined", "Not this quarter"), c);

  // Flow 3: a leader's own request is auto-approved; a pending one revoked.
  r = await submit(WL3);
  await step(rec, "f3.leader.auto", r, r.body?.request?._id);
  r = await submit(REQ3);
  const d = r.body?.request?._id;
  await step(rec, "f3.submit3", r, d);
  await step(rec, "f3.revoke", await as(request(app).put(`/api/approvals/requests/${d}/revoke`), REQ3).send({ comment: "Trip off" }), d);
  await step(rec, "f3.mine", await as(request(app).get("/api/approvals/requests/mine"), REQ3));

  // Flow 2: submit, approve → PROPOSAL_PENDING; approver's own → leader; leader auto.
  r = await submit(REQ2);
  const e = r.body?.request?._id;
  await step(rec, "f2.submit", r, e);
  await step(rec, "f2.approve", await act(e, APP2, "approved"), e);
  r = await submit(APP2);
  await step(rec, "f2.ownApprover", r, r.body?.request?._id);
  r = await submit(WL2);
  await step(rec, "f2.leader.auto", r, r.body?.request?._id);

  // Flow 3 with heads + managers set: routing ignores them while the workflow is off.
  await step(rec, "org.context", await as(request(app).get("/api/approvals/request-context"), REQ_ORG));
  r = await submit(REQ_ORG);
  const f = r.body?.request?._id;
  await step(rec, "org.submit", r, f);
  await step(rec, "org.head.act", await act(f, HEAD_ORG, "approved"), f);
  await step(rec, "org.head.detail", await as(request(app).get(`/api/approvals/requests/${f}`), HEAD_ORG));
  await step(rec, "org.mgr.detail", await as(request(app).get(`/api/approvals/requests/${f}`), MGR_ORG));
  await step(rec, "org.leader.approve", await act(f, WL_ORG, "approved"), f);

  // No approver configured.
  await step(rec, "noapp.submit", await submit(REQ_NOAPP));

  // Partner lead link (public form) on the partner workspace.
  for (const key of ["::ffff:127.0.0.1", "127.0.0.1", "::1"]) {
    await (partnerRequestLimiter as any).resetKey?.(key);
    await (partnerLinkResolveLimiter as any).resetKey?.(key);
  }
  resetPartnerIntakeCache();
  r = await request(app)
    .post("/api/public/partner-request")
    .set("Referer", "https://amberstudent.com/page")
    .send({
      code: "AmbR2026",
      submissionId: "11111111-2222-4333-8444-555555555555",
      turnstileToken: "ok",
      cartItems: [{ type: "flight", meta: { origin: "BLR", destination: "DEL", tripType: "oneway", departDate: "2027-04-02", travelScope: "domestic", travellers: [{ firstName: "Riya", lastName: "Sen", phone: "9876543210", email: "riya@student.test" }] } }],
      contact: { name: "Riya Sen", email: "riya@student.test", phone: "+91 98765 43210" },
      consent: { accepted: true, version: "2026-10", text: "I agree" },
      embedMode: "tab",
      utm: { utm_source: "amber", utm_medium: "banner" },
    });
  const pcase: any = await col("approvalrequests").findOne({ "meta.partnerLead.code": "AmbR2026" });
  await step(rec, "partner.submit", r, pcase?._id);

  return rec;
}

/* ── seed ── */
async function seed() {
  await mongoose.connection.db!.dropDatabase();
  for (const n of ["approvalrequests", "manualbookings", "partnerlinks"]) await mongoose.connection.db!.createCollection(n);
  await migratePartnerLeadIndexes({ expectDb: DB, apply: true, log: () => {} });
  const flow3 = { travelFlow: "APPROVAL_DIRECT", features: { approvalDirectEnabled: true, approvalFlowEnabled: false } };
  const flow2 = { travelFlow: "APPROVAL_FLOW", features: { approvalFlowEnabled: true, approvalDirectEnabled: false } };
  await col("customerworkspaces").insertMany([
    { _id: HOUSE, customerId: "PLUMTRIPS-HOUSE", name: "Plumtrips", status: "ACTIVE", config: { features: {} } },
    { _id: WS3, customerId: "C3", name: "Flow Three Co", companyName: "Flow Three Co", status: "ACTIVE", tenantType: "CORPORATE", defaultApproverEmails: [APP3.email], config: flow3 },
    { _id: WS2, customerId: "C2", name: "Flow Two Co", companyName: "Flow Two Co", status: "ACTIVE", tenantType: "CORPORATE", defaultApproverEmails: [APP2.email], config: flow2 },
    { _id: WS3_ORG, customerId: "CO", name: "Org Co", companyName: "Org Co", status: "ACTIVE", tenantType: "CORPORATE", defaultApproverEmails: [APP_ORG.email], config: flow3 },
    { _id: WS_NOAPP, customerId: "CN", name: "No Approver Co", companyName: "No Approver Co", status: "ACTIVE", tenantType: "CORPORATE", defaultApproverEmails: [], config: flow3 },
    { _id: AMBER, customerId: String(AMBER_CUSTOMER), companyName: "Amber Student", status: "ACTIVE", tenantType: "CORPORATE", defaultApproverEmails: [], config: flow3 },
  ] as any[]);
  await col("customers").insertOne({ _id: AMBER_CUSTOMER, name: "Amber Student" } as any);
  await col("users").insertMany([
    { _id: INTAKE_ID, workspaceId: HOUSE, email: PARTNER_INTAKE_EMAIL, name: "Partner Intake", roles: ["SYSTEM_PARTNER_INTAKE"], status: "ACTIVE", passwordHash: "x" },
    ...PEOPLE.map((p) => ({
      _id: new mongoose.Types.ObjectId(p.sub), workspaceId: p.ws, email: p.email, name: p.name,
      firstName: p.name.split(" ")[0], lastName: p.name.split(" ")[1], roles: p.roles, status: "ACTIVE", passwordHash: "x",
    })),
  ] as any[]);
  await col("customermembers").insertMany([
    { customerId: "C3", workspaceId: WS3, email: WL3.email, role: "WORKSPACE_LEADER", isActive: true },
    { customerId: "C2", workspaceId: WS2, email: WL2.email, role: "WORKSPACE_LEADER", isActive: true },
    { customerId: "CO", workspaceId: WS3_ORG, email: WL_ORG.email, role: "WORKSPACE_LEADER", isActive: true },
  ] as any[]);
  await col("departments").insertOne({ _id: DEPT, workspaceId: WS3_ORG, name: "Engineering", isActive: true, managerId: new mongoose.Types.ObjectId(HEAD_ORG.sub) } as any);
  await col("travellerprofiles").insertOne({
    workspaceId: WS3_ORG, firstName: "Esha", lastName: "Employee", email: REQ_ORG.email, isActive: true,
    claimedBy: new mongoose.Types.ObjectId(REQ_ORG.sub), departmentId: DEPT, reportingManagerId: new mongoose.Types.ObjectId(MGR_ORG.sub),
  } as any);
  await col("partnerlinks").insertOne({
    code: "AmbR2026", workspaceId: AMBER, customerId: String(AMBER_CUSTOMER), label: "Amber — homepage banner", placement: "homepage-banner",
    services: ["flight", "hotel", "visa"], active: true, embedAllowed: false, allowedOrigins: ["https://amberstudent.com"],
    dailyCap: 200, dailyCount: 0, dailyCountDay: "", clicks: 0, submissions: 0,
  } as any);
}

/** A workflow row that is NOT in force. Raw insert: the shape the build stores. */
async function offState(kind: "NONE" | "DRAFT" | "DISABLED") {
  if (kind === "NONE") return;
  const steps = [
    { key: "head", label: "Department head approval", phase: "REQUEST", type: "DEPARTMENT_HEAD", role: "APPROVER", decisionRule: "ANY", fallback: "DEFAULT_APPROVER", selfRule: "NEXT_IN_LINE", samePersonRule: "AUTO_PASS" },
    { key: "rm", label: "Reporting manager (FYI)", phase: "REQUEST", type: "REPORTING_MANAGER", role: "WATCHER", fallback: "SKIP", watcherEvents: ["submitted", "approved", "declined", "booking_done"] },
  ];
  for (const ws of [WS3, WS2, WS3_ORG, WS_NOAPP, AMBER]) {
    await col("approvalworkflowversions").insertOne({
      workspaceId: ws,
      status: kind === "DRAFT" ? "DRAFT" : "PUBLISHED",
      versionNumber: kind === "DRAFT" ? null : 1,
      enabled: kind === "DISABLED" ? false : true,
      template: "DEPT_HEAD_WATCHER",
      raisedBy: "EMPLOYEE",
      requestOnlyMode: true,
      purpose: { required: true, options: ["Client meeting", "Other"] },
      completion: "ALL_SERVICES_BOOKED",
      leadersMayDecide: "OVERRIDE_WITH_REASON",
      steps,
      groups: [],
      email: { travelAdminEmails: ["travel@org.test"] },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
  }
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-12-01T04:30:00.000Z") });
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(DB));
  nameIds();
}, 120_000);

afterAll(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await mongoose.disconnect();
  await mongod?.stop();
});

describe("no approval workflow in force = today's routing, byte for byte", () => {
  const states = ["NONE", "DRAFT", "DISABLED"] as const;
  for (const state of states) {
    it(`${state}: every response, stored request and email matches the golden record`, async () => {
      await seed();
      await offState(state);
      mails.length = 0;
      const rec = await runScenarios();
      const actual = JSON.stringify(rec, null, 1);
      if (process.env.UPDATE_GOLDEN === "1" && state === "NONE") {
        fs.writeFileSync(GOLDEN, actual + "\n");
        return;
      }
      // A Windows checkout may turn the file's LF into CRLF.
      const golden = fs.readFileSync(GOLDEN, "utf8").replace(/\r\n/g, "\n").trimEnd();
      if (actual !== golden) {
        const out = path.join(path.dirname(GOLDEN), `../../tmp/workflowOff.actual.${state}.json`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, actual + "\n");
      }
      expect(actual).toBe(golden);
    }, 120_000);
  }
});
