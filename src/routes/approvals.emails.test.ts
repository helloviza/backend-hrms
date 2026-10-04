// apps/backend/src/routes/approvals.emails.test.ts
//
// Approval Flow Slice 3 — every email in Flows 2 & 3, against a real database
// and the real routers. Mail goes to a recording stub (never SMTP); a
// recipient can be made to fail to exercise the outbox.
//
//   - each event reaches exactly the right people and nobody else
//   - Reply-To is ops@ on every customer-facing email; ops@ receives only the
//     agreed events
//   - decision links last 72h and every email with links says so
//   - reminders at 24h/48h/72h, max 3, stop on decision / revoke / waiting on
//     the requester / cancel; nothing for stale requests
//   - the outbox retries then marks FAILED, lists it for staff and alerts the
//     desk; "notified" is recorded only after a real send
//   - audit bugs 1–8, price + HTML stripping, no staff names or ids to
//     customers, passports never in an email, deactivated people never emailed
//   - the email map doc is generated from the map and up to date
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import fs from "fs";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";

type Mail = { to: string[]; cc: string[]; replyTo: string; subject: string; html: string; attachments?: any[] };
const sent: Mail[] = [];
/** Sends to these addresses fail (SMTP-style { ok: false }). */
const failFor = new Set<string>();

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", () => ({
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
vi.mock("../utils/mailer.js", () => ({
  sendMail: async (m: any) => {
    const to = ([] as string[]).concat(m.to || []).map(String);
    if (to.some((t) => failFor.has(t))) return { ok: false, error: "421 try again later" };
    sent.push({ to, cc: ([] as string[]).concat(m.cc || []).map(String), replyTo: String(m.replyTo || ""), subject: String(m.subject), html: String(m.html || ""), attachments: m.attachments });
    return { ok: true, messageId: "test" };
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

const { default: approvalsRouter } = await import("./approvals.js");
const { default: proposalsRouter } = await import("./proposals.js");
const { default: approvalLinksRouter } = await import("./approvalLinks.js");
const { signApprovalLink } = await import("../utils/approvalLinkToken.js");
const { runApprovalReminders } = await import("../services/approvalReminders.js");
const { processOutbox, enqueueEmail, listEmailFailures, RETRY_DELAYS_MS } = await import("../services/emailOutbox.js");
const { APPROVAL_EMAIL_MAP } = await import("../services/approvalEmails/map.js");
const { renderApprovalEmail } = await import("../services/approvalEmails/templates.js");
const { renderApprovalEmailsDoc, DOC_PATH } = await import("../scripts/gen-approval-emails-doc.js");
const { stripPriceText } = await import("./approvals.security.js");

const app = express();
app.use(express.json());
app.use("/api/public/approval-links", approvalLinksRouter);
app.use("/api/proposals", proposalsRouter);
app.use("/api/approvals", approvalsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const DESK = "ops@plumtrips.com";
const WS = oid(); // Flow 2
const WS3 = oid(); // Flow 3
const WS_SOLO = oid(); // one Workspace Leader, no approver
const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");

const REQUESTER = "riya@cust.test";
const APPROVER = "anil@cust.test";
const LEADER = "lata@cust.test";
const LEADER2 = "lalit@cust.test";
const LEADER_OFF = "gone@cust.test"; // deactivated Workspace Leader membership
const SOLO = "solo@solo.test";
const PASSPORT = "Z9876543";

type Who = { email: string; name: string; roles?: string[]; sub?: string; ws?: any };
const R: Who = { email: REQUESTER, name: "Riya Requester" };
const A: Who = { email: APPROVER, name: "Anil Approver" };
const L: Who = { email: LEADER, name: "Lata Leader", roles: ["WORKSPACE_LEADER"] };
const L2: Who = { email: LEADER2, name: "Lalit Leader", roles: ["WORKSPACE_LEADER"] };
const S: Who = { email: SOLO, name: "Sol Leader", roles: ["WORKSPACE_LEADER"] };
const OPS_SUB = String(oid());
const OPS: Who = { email: "olivia@plumtrips.test", name: "Olivia Opsworth", roles: ["EMPLOYEE"], sub: OPS_SUB, ws: HOUSE };

const as = (r: request.Test, who: Who, ws: any = WS) =>
  r
    .set("x-test-user", JSON.stringify({ sub: who.sub || String(oid()), email: who.email, name: who.name, roles: who.roles || ["EMPLOYEE"] }))
    .set("x-test-ws", String(who.ws || ws));

const flightItem = {
  type: "flight", title: "BLR → BOM", qty: 1, price: 0,
  meta: {
    origin: "BLR", destination: "BOM", departDate: "2027-03-12",
    travellers: [{ kind: "manual", firstName: "Asha", lastName: "Rao", passportNumber: PASSPORT }],
  },
};

const option = {
  optionNo: 1, title: "IndiGo <b>fast</b> ₹5,000", notes: "Total INR 9,800 incl. taxes", currency: "INR", totalAmount: 0, attachments: [],
  lineItems: [
    { itemIndex: 1, category: "hotel", title: "Taj <script>x</script> 5000/- (4,200 rupees)", qty: 1, unitPrice: 5000, totalPrice: 5000, currency: "INR" },
  ],
};

const linkFor = (kind: "request" | "proposal", id: any, email: string) =>
  `/api/public/approval-links/${signApprovalLink({ kind, id: String(id), email }, 72)}`;
const reqDoc = async (id: any): Promise<any> => col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
const outbox = async (): Promise<any[]> => col("emailoutboxes").find({}).toArray();

/** Everyone emailed (To + CC), sorted and unique. */
const everyone = (mails = sent) => Array.from(new Set(mails.flatMap((m) => [...m.to, ...m.cc]))).sort();
const to = (email: string, mails = sent) => mails.filter((m) => m.to.includes(email));
const tokenHrefs = (html: string) => [...html.matchAll(/approval\/email\?token=([^"&]+)/g)].map((m) => decodeURIComponent(m[1]));

async function submit(who: Who = R, ws: any = WS) {
  const r = await as(request(app).post("/api/approvals/requests"), who, ws).send({ cartItems: [flightItem], comments: "Client visit" });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return String(r.body.request._id);
}

async function approved(ws: any = WS) {
  const id = await submit(R, ws);
  const a = await as(request(app).put(`/api/approvals/requests/${id}/action`), A, ws).send({ action: "approved" });
  expect(a.status).toBe(200);
  return id;
}

async function proposalFor(rid: string) {
  const d = await as(request(app).post(`/api/proposals/by-request/${rid}/draft`), OPS).send({});
  expect(d.status).toBe(200);
  const pid = String(d.body.proposal._id);
  expect((await as(request(app).put(`/api/proposals/${pid}`), OPS).send({ options: [option] })).status).toBe(200);
  const sub = await as(request(app).post(`/api/proposals/${pid}/submit`), OPS).send({});
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  return pid;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-emails-test"));
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  sent.length = 0;
  failFor.clear();
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertMany([
    {
      _id: WS, customerId: "C1", name: "Acme Corp", status: "ACTIVE", tenantType: "CORPORATE", defaultApproverEmails: [APPROVER],
      config: { travelFlow: "APPROVAL_FLOW", tokenExpiryHours: 12, features: { approvalFlowEnabled: true } },
    },
    {
      _id: WS3, customerId: "C3", name: "Direct Co", status: "ACTIVE", tenantType: "CORPORATE", defaultApproverEmails: [APPROVER],
      config: { travelFlow: "APPROVAL_DIRECT", features: { approvalDirectEnabled: true } },
    },
    {
      _id: WS_SOLO, customerId: "S1", name: "Solo Ltd", status: "ACTIVE", tenantType: "CORPORATE", defaultApproverEmails: [],
      config: { travelFlow: "APPROVAL_FLOW", features: { approvalFlowEnabled: true } },
    },
    { _id: HOUSE, customerId: "PLUMTRIPS-HOUSE", name: "Plumtrips", status: "ACTIVE", config: { features: { approvalFlowEnabled: true } } },
  ] as any[]);
  await col("customermembers").insertMany([
    { customerId: "C1", email: LEADER, role: "WORKSPACE_LEADER", isActive: true },
    { customerId: "C1", email: LEADER2, role: "WORKSPACE_LEADER", isActive: true },
    { customerId: "C1", email: LEADER_OFF, role: "WORKSPACE_LEADER", isActive: false },
    { customerId: "C3", email: LEADER, role: "WORKSPACE_LEADER", isActive: true },
    { customerId: "S1", email: SOLO, role: "WORKSPACE_LEADER", isActive: true },
  ] as any[]);
  await col("users").insertMany([
    { email: REQUESTER, name: "Riya Requester", roles: ["CUSTOMER"] },
    { email: APPROVER, name: "Anil Approver", roles: ["CUSTOMER"] },
    { email: LEADER, name: "Lata Leader", roles: ["CUSTOMER"] },
    { email: LEADER2, name: "Lalit Leader", roles: ["CUSTOMER"] },
    { email: LEADER_OFF, name: "Gone Leader", roles: ["CUSTOMER"] },
    { email: SOLO, name: "Sol Leader", roles: ["CUSTOMER"] },
  ] as any[]);
  await col("userpermissions").insertOne({
    userId: OPS_SUB, email: OPS.email, workspaceId: String(HOUSE), universe: "STAFF", status: "active", source: "manual",
    level: { code: "L1", name: "Employee", designation: "" }, modules: { adminQueue: { access: "WRITE", scope: "ALL" } },
  } as any);
});

/* ───────────────────────── the map ───────────────────────── */

describe("the email map", () => {
  it("docs/approval-emails.md is generated from the map and up to date", () => {
    if (!fs.existsSync(DOC_PATH)) return; // the GitHub subtree has no docs/
    expect(fs.readFileSync(DOC_PATH, "utf8")).toBe(renderApprovalEmailsDoc());
  });

  it("every event renders; customer events reply to ops@, staff events are not customer-facing", () => {
    for (const [event, spec] of Object.entries(APPROVAL_EMAIL_MAP) as Array<[any, any]>) {
      const r = renderApprovalEmail(event, { ar: { _id: oid(), customerName: "Acme", cartItems: [flightItem] }, decision: "APPROVED", reminderNo: 1 }, APPROVER);
      expect(r.subject, event).toBeTruthy();
      expect(r.html, event).toContain("<");
      expect(spec.replyTo, event).toBe(spec.audience === "customer" ? "desk" : "none");
      // ops@ only ever receives the agreed events
      if (spec.to.includes("desk") || spec.cc.includes("desk")) {
        expect(["ops_new_case", "ops_no_agent", "ops_proposal_outcome", "ops_customer_cancelled", "email_send_failed_alert"]).toContain(event);
      }
    }
  });
});

/* ───────────────────────── submit ───────────────────────── */

describe("submit", () => {
  it("approver + each active leader get their own 72h decision links, the requester a confirmation; nobody else", async () => {
    const id = await submit();
    expect(everyone()).toEqual([APPROVER, LEADER, LEADER2, REQUESTER].sort());
    for (const who of [APPROVER, LEADER, LEADER2]) {
      const [m] = to(who);
      expect(m.subject).toMatch(/^Approval Needed — Acme Corp/);
      expect(m.html).toContain("These links expire in 72 hours");
      const tokens = tokenHrefs(m.html);
      expect(tokens.length).toBe(3);
      for (const t of tokens) {
        const p: any = jwt.decode(t);
        expect([p.email, p.id, p.exp - p.iat]).toEqual([who, id, 72 * 3600]);
      }
    }
    const [conf] = to(REQUESTER);
    expect(conf.subject).toMatch(/^We've received your travel request/);
    expect(conf.html).toContain("/customer/approvals/mine");
    expect(sent.every((m) => m.replyTo === DESK)).toBe(true);
    // stored in the outbox as SENT, one row per email
    expect((await outbox()).map((o) => o.status)).toEqual(["SENT", "SENT", "SENT", "SENT"]);
  });

  it("bugs 1 + 5: auto-approved — real My Requests link, no leader 'new request' email, the desk hears", async () => {
    await submit(L);
    expect(everyone()).toEqual([DESK, LEADER].sort());
    const [mine] = to(LEADER);
    expect(mine.subject).toMatch(/^Request Approved/);
    expect(mine.html).toContain("/customer/approvals/mine");
    expect(mine.html).not.toContain("/approvals/requests/mine");
    expect(mine.html).not.toMatch(/Admin Queue/);
    const [desk] = to(DESK);
    expect(desk.subject).toMatch(/^New case — /);
    expect(desk.replyTo).toBe("");
  });

  it("bug 7: a deactivated approver (User INACTIVE) is not emailed; resend goes to who can decide now", async () => {
    await col("users").updateOne({ email: APPROVER }, { $set: { status: "INACTIVE" } });
    const id = await submit();
    expect(everyone()).toEqual([LEADER, LEADER2, REQUESTER].sort());
    sent.length = 0;
    const r = await as(request(app).put(`/api/approvals/requests/${id}/action`), R).send({ action: "resend_email" });
    expect(r.status).toBe(200);
    expect(everyone()).toEqual([LEADER, LEADER2].sort());
  });
});

/* ───────────────────────── request decisions ───────────────────────── */

describe("request decisions", () => {
  it("approve: requester told, the other deciders FYI (not the approver), the desk gets the new case", async () => {
    const id = await submit();
    sent.length = 0;
    expect((await as(request(app).put(`/api/approvals/requests/${id}/action`), A).send({ action: "approved" })).status).toBe(200);
    expect(everyone()).toEqual([DESK, LEADER, LEADER2, REQUESTER].sort());
    expect(to(REQUESTER)[0].subject).toMatch(/^Request approved — Acme Corp/);
    const fyi = sent.find((m) => /^Request approved/.test(m.subject) && m.to.includes(LEADER))!;
    expect(fyi.to.sort()).toEqual([LEADER, LEADER2].sort());
    expect(fyi.html).toContain("Anil Approver");
    expect(to(APPROVER)).toEqual([]);
    expect(to(DESK)[0].html).toContain("Unassigned (auto-allocation is off)");
  });

  it("decline by a leader's email link: requester + approver + other leader; the desk is not told", async () => {
    const id = await submit();
    sent.length = 0;
    const r = await request(app).post(linkFor("request", id, LEADER)).send({ action: "decline", reason: "Not this quarter" });
    expect(r.status).toBe(200);
    expect(everyone()).toEqual([APPROVER, LEADER2, REQUESTER].sort());
    expect(to(REQUESTER)[0].subject).toMatch(/^Your Travel Request Has Been Declined — REQ-/);
    expect(to(REQUESTER)[0].html).toContain("Not this quarter");
  });

  it("bug 2: a leader's question — the requester's reply goes back to that leader, not the approver", async () => {
    const id = await submit();
    sent.length = 0;
    expect((await as(request(app).put(`/api/approvals/requests/${id}/action`), L).send({ action: "clarify", comment: "Why Mumbai?" })).status).toBe(200);
    expect(everyone()).toEqual([REQUESTER]);
    sent.length = 0;
    expect((await as(request(app).post(`/api/approvals/requests/${id}/clarification`), R).send({ reply: "Client office" })).status).toBe(200);
    expect(everyone()).toEqual([LEADER]);
    expect(sent[0].subject).toMatch(/^Reply received/);
    expect(sent[0].html).toContain("Client office");
    expect(tokenHrefs(sent[0].html).every((t) => (jwt.decode(t) as any).email === LEADER)).toBe(true);
  });

  it("no-agent: the desk gets 'no agent available' instead of 'new case'", async () => {
    await col("traveldesksettings").insertOne({ key: "default", mode: "round_robin", rmFirst: false, agents: [] } as any);
    await approved();
    const desk = to(DESK);
    expect(desk.map((m) => m.subject.split(" — ")[0])).toEqual(["Unassigned"]);
    expect(desk[0].html).toContain("No agent available");
  });
});

/* ───────────────────────── proposals (Flow 2) ───────────────────────── */

describe("proposals", () => {
  it("bug 3: each decider gets their own links; titles are price-stripped and HTML-escaped; the requester hears it is ready", async () => {
    const rid = await approved();
    sent.length = 0;
    await proposalFor(rid);
    expect(everyone()).toEqual([APPROVER, LEADER, LEADER2, REQUESTER].sort());
    for (const who of [APPROVER, LEADER, LEADER2]) {
      const [m] = to(who);
      expect(m.subject).toMatch(/^Proposal Approval Needed/);
      expect(m.html).toContain("These links expire in 72 hours");
      expect(m.html).toContain("IndiGo &lt;b&gt;fast&lt;/b&gt;");
      expect(m.html).not.toContain("<b>fast</b>");
      expect(m.html).not.toContain("<script>");
      expect(m.html).not.toMatch(/₹|5,000|5000|9,800|4,200|rupees|\/-/);
      expect(tokenHrefs(m.html).every((t) => (jwt.decode(t) as any).email === who)).toBe(true);
    }
    expect(to(REQUESTER)[0].subject).toMatch(/^Your travel proposal is ready/);
  });

  it("approved: requester; FYI to the other deciders; the desk, copying the proposal's staff", async () => {
    const rid = await approved();
    const pid = await proposalFor(rid);
    sent.length = 0;
    expect((await as(request(app).post(`/api/proposals/${pid}/decide`), A).send({ decision: "APPROVED" })).status).toBe(200);
    expect(everyone()).toEqual([DESK, LEADER, LEADER2, OPS.email, REQUESTER].sort());
    expect(to(APPROVER)).toEqual([]);
    expect(to(REQUESTER)[0].subject).toMatch(/^Your Travel Proposal Has Been Approved/);
    const desk = to(DESK)[0];
    expect([desk.subject.startsWith("Proposal approved"), desk.cc]).toEqual([true, [OPS.email]]);
  });

  it("changes requested (new email): the requester gets the note; FYI to approver + other leader; the desk", async () => {
    const rid = await approved();
    const pid = await proposalFor(rid);
    sent.length = 0;
    const r = await request(app).post(linkFor("proposal", pid, LEADER)).send({ action: "request_changes", reason: "Later flight please" });
    expect(r.status).toBe(200);
    expect(everyone()).toEqual([APPROVER, DESK, LEADER2, OPS.email, REQUESTER].sort());
    const req = to(REQUESTER)[0];
    expect(req.subject).toMatch(/^Changes requested on your travel proposal/);
    expect(req.html).toContain("Later flight please");
    expect(req.html).toContain("Lata Leader");
  });

  it("bug 4: recorded on behalf — customers see Plumtrips Travel Desk, never the staff member, on emails and the link page", async () => {
    const rid = await approved();
    const pid = await proposalFor(rid);
    sent.length = 0;
    const c = await as(request(app).post(`/api/proposals/${pid}/record-decision`), OPS).send({ decision: "APPROVED", note: "Anil approved on the phone" });
    expect(c.status).toBe(200);
    // every decider hears (nobody customer-side acted)
    expect(sent.find((m) => /^Proposal approved/.test(m.subject) && m.to.includes(APPROVER))!.to.sort()).toEqual([APPROVER, LEADER, LEADER2].sort());
    for (const m of sent.filter((x) => !x.to.includes(DESK))) {
      expect(m.html, m.subject).not.toContain("Olivia");
      expect(m.html, m.subject).not.toContain(OPS.email);
    }
    const page = await request(app).get(linkFor("proposal", pid, LEADER));
    expect(page.status).toBe(200);
    expect(page.body.link.decided).toMatchObject({ byName: "Plumtrips Travel Desk" });
    expect(JSON.stringify(page.body)).not.toMatch(/Olivia|plumtrips\.test/);
    expect(page.body.link.decided.byEmail).toBeUndefined();
  });

  it("bug 6: a Workspace Leader who raised it and is its only decider gets one email per step", async () => {
    const rid = await submit(S, WS_SOLO);
    sent.length = 0;
    const pid = await proposalFor(rid);
    expect(to(SOLO).map((m) => m.subject.split(" — ")[0])).toEqual(["Proposal Approval Needed"]);
    sent.length = 0;
    expect((await as(request(app).post(`/api/proposals/${pid}/decide`), S, WS_SOLO).send({ decision: "APPROVED" })).status).toBe(200);
    expect(to(SOLO).map((m) => m.subject.split(" — ")[0])).toEqual(["Your Travel Proposal Has Been Approved"]);
    expect(everyone()).toEqual([DESK, OPS.email, SOLO].sort());
  });
});

/* ───────────────────────── booking ───────────────────────── */

async function inProgress(ws: any = WS3) {
  const id = await approved(ws);
  expect((await as(request(app).put(`/api/approvals/admin/${id}/under-process`), OPS).send({})).status).toBe(200);
  return id;
}

describe("booking", () => {
  it("bug 7: done — CC approver + active leaders only (no stale snapshot, no deactivated people); notified after the send", async () => {
    // Flow 3 workspace: LEADER active; LEADER2 a member whose login is INACTIVE; LEADER_OFF's membership is off.
    await col("customermembers").insertMany([
      { customerId: "C3", email: LEADER2, role: "WORKSPACE_LEADER", isActive: true },
      { customerId: "C3", email: LEADER_OFF, role: "WORKSPACE_LEADER", isActive: false },
    ] as any[]);
    await col("users").updateOne({ email: LEADER2 }, { $set: { status: "INACTIVE" } });
    const id = await inProgress(WS3);
    await col("approvalrequests").updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { "meta.ccLeaders": [LEADER, LEADER_OFF, "old.leader@cust.test"] } });
    sent.length = 0;
    const d = await as(request(app).put(`/api/approvals/admin/${id}/done`), OPS).send({ comment: "PNR K7Q2LX" });
    expect([d.status, d.body.message]).toEqual([200, "Marked done"]);
    const [m] = sent;
    expect(sent.length).toBe(1);
    expect([m.to, m.cc.sort(), m.replyTo]).toEqual([[REQUESTER], [APPROVER, LEADER].sort(), DESK]);
    expect(m.html).toContain("Plumtrips Travel Desk");
    expect(m.html).not.toContain("Olivia");
    const h = (await reqDoc(id)).history.map((x: any) => x.action);
    expect(h).toContain("admin_notify_sent");
    expect(h).not.toContain("admin_notify_queued");
  });

  it("outbox: a failed send is retried at +2 min and +10 min, then FAILED — listed for staff, alerted to ops@, never 'notified'", async () => {
    const id = await inProgress();
    sent.length = 0;
    failFor.add(REQUESTER);
    const t0 = Date.now();
    const d = await as(request(app).put(`/api/approvals/admin/${id}/done`), OPS).send({});
    expect([d.status, d.body.message]).toEqual([200, "Marked done (email will be retried)"]);
    let h = (await reqDoc(id)).history.map((x: any) => x.action);
    expect(h).toContain("admin_notify_queued");
    expect(h).not.toContain("admin_notify_sent");

    const row = () => col("emailoutboxes").findOne({ event: "booking_done" }) as Promise<any>;
    expect([(await row()).status, (await row()).attempts]).toEqual(["PENDING", 1]);
    expect(await processOutbox(new Date(t0 + RETRY_DELAYS_MS[0] - 30_000))).toMatchObject({ tried: 0 });
    await processOutbox(new Date(t0 + RETRY_DELAYS_MS[0] + 1_000));
    expect([(await row()).status, (await row()).attempts]).toEqual(["PENDING", 2]);
    await processOutbox(new Date(t0 + RETRY_DELAYS_MS[0] + RETRY_DELAYS_MS[1] + 5_000));
    expect([(await row()).status, (await row()).attempts]).toEqual(["FAILED", 3]);

    h = (await reqDoc(id)).history.map((x: any) => x.action);
    expect(h).toContain("admin_notify_failed");
    expect(h).not.toContain("admin_notify_sent");
    const alert = to(DESK).find((m) => /^Email not delivered/.test(m.subject))!;
    expect(alert.html).toContain("421 try again later");
    expect((await listEmailFailures()).map((f) => f.event)).toEqual(["booking_done"]);

    const staff = await as(request(app).get("/api/approvals/admin/email-failures"), OPS);
    expect([staff.status, staff.body.failures.length, staff.body.failures[0].caseCode]).toEqual([200, 1, expect.stringMatching(/^REQ-/)]);
    expect((await as(request(app).get("/api/approvals/admin/email-failures"), R, WS3)).status).toBe(403);
  });

  it("outbox: a retry that succeeds records 'notified' then", async () => {
    const id = await inProgress();
    failFor.add(REQUESTER);
    await as(request(app).put(`/api/approvals/admin/${id}/done`), OPS).send({});
    failFor.clear();
    await processOutbox(new Date(Date.now() + RETRY_DELAYS_MS[0] + 1_000));
    expect((await reqDoc(id)).history.map((x: any) => x.action)).toContain("admin_notify_sent");
    expect((await col("emailoutboxes").findOne({ event: "booking_done" }))!.status).toBe("SENT");
  });

  it("bug 8: cancelling an already-cancelled case is refused and emails nobody (queue and proposal page)", async () => {
    const id = await inProgress();
    sent.length = 0;
    expect((await as(request(app).put(`/api/approvals/admin/${id}/cancel`), OPS).send({ comment: "Trip dropped" })).status).toBe(200);
    expect(to(REQUESTER).map((m) => m.subject.split(" — ")[0])).toEqual(["Booking Update"]);
    sent.length = 0;
    const again = await as(request(app).put(`/api/approvals/admin/${id}/cancel`), OPS).send({});
    expect([again.status, again.body.code]).toEqual([409, "ALREADY_CANCELLED"]);
    expect(sent).toEqual([]);

    const rid = await approved();
    const pid = await proposalFor(rid);
    await as(request(app).post(`/api/proposals/${pid}/decide`), A).send({ decision: "APPROVED" });
    expect((await as(request(app).post(`/api/proposals/${pid}/booking/cancel`), OPS).send({ reason: "x" })).status).toBe(200);
    sent.length = 0;
    const twice = await as(request(app).post(`/api/proposals/${pid}/booking/cancel`), OPS).send({ reason: "x" });
    expect([twice.status, twice.body.code]).toEqual([409, "ALREADY_CANCELLED"]);
    expect(sent).toEqual([]);
  });

  it("Flow 3: approve → requester + desk; start, hold, done reach the requester only (plus CCs on done)", async () => {
    const id = await approved(WS3);
    expect(sent.some((m) => /Proposal/.test(m.subject))).toBe(false);
    sent.length = 0;
    await as(request(app).put(`/api/approvals/admin/${id}/under-process`), OPS).send({});
    await as(request(app).put(`/api/approvals/admin/${id}/on-hold`), OPS).send({ comment: "Waiting on fares" });
    expect(sent.map((m) => [m.to.join(), m.subject.split(" — ")[0]])).toEqual([
      [REQUESTER, "Booking in progress"],
      [REQUESTER, "Your booking is on hold"],
    ]);
  });
});

/* ───────────────────────── reminders ───────────────────────── */

const H = 3600_000;

describe("reminders", () => {
  it("request: 24h, 48h, 72h to the approver and leaders, never a 4th, never twice for one slot", async () => {
    const t0 = Date.now();
    await submit();
    sent.length = 0;
    expect(await runApprovalReminders(new Date(t0 + 23 * H))).toEqual({ requests: 0, proposals: 0 });
    for (const n of [1, 2, 3]) {
      expect(await runApprovalReminders(new Date(t0 + n * 24 * H + 60_000))).toEqual({ requests: 1, proposals: 0 });
      expect(await runApprovalReminders(new Date(t0 + n * 24 * H + 120_000))).toEqual({ requests: 0, proposals: 0 });
    }
    expect(await runApprovalReminders(new Date(t0 + 95 * H))).toEqual({ requests: 0, proposals: 0 });
    expect(everyone()).toEqual([APPROVER, LEADER, LEADER2].sort());
    expect(to(LEADER).map((m) => m.subject.split(":")[0])).toEqual(["Reminder 1 of 3", "Reminder 2 of 3", "Reminder 3 of 3"]);
    expect(to(LEADER)[0].html).toContain("These links expire in 72 hours");
  });

  it("request: stops once decided, revoked, or waiting on the requester's reply", async () => {
    const t0 = Date.now();
    const a = await submit();
    const b = await submit();
    const c = await submit();
    expect(await runApprovalReminders(new Date(t0 + 24 * H + 60_000))).toMatchObject({ requests: 3 });
    await as(request(app).put(`/api/approvals/requests/${a}/action`), A).send({ action: "approved" });
    await as(request(app).put(`/api/approvals/requests/${b}/revoke`), R).send({});
    await as(request(app).put(`/api/approvals/requests/${c}/action`), A).send({ action: "clarify", comment: "?" });
    expect(await runApprovalReminders(new Date(t0 + 48 * H + 60_000))).toEqual({ requests: 0, proposals: 0 });
  });

  it("request: nothing for a request that reached the approver more than 4 days ago", async () => {
    const id = await submit();
    const old = new Date(Date.now() - 5 * 24 * H);
    await col("approvalrequests").updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { "history.0.at": old, createdAt: old } });
    expect(await runApprovalReminders(new Date())).toEqual({ requests: 0, proposals: 0 });
  });

  it("proposal: 24h/48h/72h to the deciders, stop once decided or the request is cancelled", async () => {
    const rid = await approved();
    const t0 = Date.now();
    const pid = await proposalFor(rid);
    sent.length = 0;
    expect(await runApprovalReminders(new Date(t0 + 24 * H + 60_000))).toEqual({ requests: 0, proposals: 1 });
    expect(everyone()).toEqual([APPROVER, LEADER, LEADER2].sort());
    expect(sent[0].subject).toMatch(/^Reminder 1 of 3: Proposal Approval Needed/);
    expect(await runApprovalReminders(new Date(t0 + 48 * H + 60_000))).toEqual({ requests: 0, proposals: 1 });
    await as(request(app).post(`/api/proposals/${pid}/decide`), L).send({ decision: "APPROVED" });
    expect(await runApprovalReminders(new Date(t0 + 72 * H + 60_000))).toEqual({ requests: 0, proposals: 0 });

    const rid2 = await approved();
    const t1 = Date.now();
    await proposalFor(rid2);
    await col("approvalrequests").updateOne({ _id: new mongoose.Types.ObjectId(rid2) }, { $set: { adminState: "cancelled", stage: "BOOKING_CANCELLED" } });
    expect(await runApprovalReminders(new Date(t1 + 24 * H + 60_000))).toEqual({ requests: 0, proposals: 0 });
  });
});

/* ───────────────────────── whole journey rules ───────────────────────── */

describe("across a whole Flow 2 journey", () => {
  it("ops@ only gets the agreed events; customer emails reply to ops@, name no staff, carry no ids, prices or passports; deactivated never emailed", async () => {
    const rid = await submit();
    await as(request(app).put(`/api/approvals/requests/${rid}/action`), L).send({ action: "clarify", comment: "Why?" });
    await as(request(app).post(`/api/approvals/requests/${rid}/clarification`), R).send({ reply: "Client" });
    await as(request(app).put(`/api/approvals/requests/${rid}/action`), A).send({ action: "approved" });
    const pid = await proposalFor(rid);
    await request(app).post(linkFor("proposal", pid, LEADER2)).send({ action: "approve" });
    await as(request(app).put(`/api/approvals/admin/${rid}/under-process`), OPS).send({});
    await as(request(app).put(`/api/approvals/admin/${rid}/done`), OPS).send({ comment: "PNR K7Q2LX" });

    const rows = await outbox();
    const deskEvents = new Set(rows.filter((r) => r.to.includes(DESK) || r.cc.includes(DESK)).map((r) => r.event));
    expect([...deskEvents].sort()).toEqual(["ops_new_case", "ops_proposal_outcome"]);
    for (const r of rows) {
      const spec: any = (APPROVAL_EMAIL_MAP as any)[r.event];
      expect(r.replyTo, r.event).toBe(spec.audience === "customer" ? DESK : "");
    }

    const customer = sent.filter((m) => !m.to.includes(DESK));
    expect(customer.length).toBeGreaterThan(8);
    for (const m of customer) {
      const text = m.html.replace(/href="[^"]*"/g, "");
      expect(text, m.subject).not.toMatch(/\b[a-f0-9]{24}\b/);
      expect(m.html, m.subject).not.toMatch(/Olivia|plumtrips\.test/);
      expect(m.html, m.subject).not.toMatch(/₹|\bINR\s*\d|5,000|9,800/);
    }
    for (const m of sent) expect(m.html, m.subject).not.toContain(PASSPORT);
    expect(everyone()).not.toContain(LEADER_OFF);
  });
});

describe("price stripping (widened)", () => {
  it("strips /-, rupees, Rs, lakh/k and price words; keeps flight numbers, times and counts", () => {
    for (const s of ["Rs. 5000/-", "5000/-", "5,000 rupees", "rupees 5000", "INR 1.2 lakh", "₹5k", "Fare: 12,400", "total 9800", "Rs500", "1.5 lakh rupees"]) {
      expect(stripPriceText(s), s).toBe("");
    }
    expect(stripPriceText("BLR → BOM 6E-201 — ₹5000")).toBe("BLR → BOM 6E-201");
    for (const s of ["6E-201 BLR 10:30", "Total 3 nights", "2 adults, 1 room", "Hotel Rsl Grand"]) expect(stripPriceText(s)).toBe(s);
  });

  it("outbox unit: one try only for the desk alert; failures never re-alert", async () => {
    failFor.add(DESK);
    const r = await enqueueEmail({ event: "email_send_failed_alert", to: [DESK], subject: "x", html: "<p>x</p>" }, { maxAttempts: 1 });
    expect(r.status).toBe("FAILED");
    expect((await outbox()).length).toBe(1);
  });
});
