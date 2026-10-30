// apps/backend/src/routes/approvals.flow2Journey.test.ts
//
// Flow 2 (APPROVAL_FLOW) end to end, against a real database:
//   requester submits → approver approves (in-app, or by email link with no
//   login) → ops create, save and submit a proposal → the approver OR a
//   Workspace Leader decides it (first decision wins; the other sees who
//   decided) → a declined proposal can be revised and resubmitted.
// Plus the email-link rules: opening a link changes nothing, a link works
// once, expires, and re-checks that its recipient may still decide; and a
// decline always needs a reason.
//
// Real: approvals, proposals and approval-link routers, guards, models.
// Stubbed: requireAuth (user from a header), requireWorkspace (workspace from
// a header), mail (recorded), TBO.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";

const sent: Array<{ to: string; subject: string; html: string; cc?: string[] }> = [];

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
    sent.push({ to: String(m.to), subject: String(m.subject), html: String(m.html || ""), cc: m.cc });
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

const { default: approvalsRouter } = await import("./approvals.js");
const { default: proposalsRouter } = await import("./proposals.js");
const { default: approvalLinksRouter } = await import("./approvalLinks.js");
const { signApprovalLink, approvalLinkSecret } = await import("../utils/approvalLinkToken.js");

const app = express();
app.use(express.json());
app.use("/api/public/approval-links", approvalLinksRouter);
app.use("/api/proposals", proposalsRouter);
app.use("/api/approvals", approvalsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const WS = oid();
const CUSTOMER_ID = "F1";
const APPROVER = "approver@cust.test";
const LEADER = "leader@cust.test";
const REQUESTER = "requestor@cust.test";
/** The ops desk mailbox (DESK_EMAIL default). */
const DESK = "ops@plumtrips.com";

type Who = { email: string; roles?: string[]; sub?: string; ws?: any };
const R: Who = { email: REQUESTER };
const A: Who = { email: APPROVER };
const L: Who = { email: LEADER, roles: ["WORKSPACE_LEADER"] };
// Plumtrips ops: signed in to HOUSE, role EMPLOYEE, with the Access Console
// "Admin Queue" grant (WRITE) — the booking team is defined by that grant.
const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const OPS_SUB = String(oid());
const OPS: Who = { email: "ops@plumtrips.test", roles: ["EMPLOYEE"], sub: OPS_SUB, ws: HOUSE };

const as = (r: request.Test, who: Who) =>
  r
    .set("x-test-user", JSON.stringify({ sub: who.sub || String(oid()), email: who.email, name: who.email.split("@")[0], roles: who.roles || ["EMPLOYEE"] }))
    .set("x-test-ws", String(who.ws || WS));

/** An Access Console grant of the "Admin Queue" module. */
const grantAdminQueue = (sub: string, email: string, access = "WRITE") =>
  col("userpermissions").insertOne({
    userId: sub, email, workspaceId: String(HOUSE), universe: "STAFF", status: "active", source: "manual",
    level: { code: "L1", name: "Employee", designation: "" }, modules: { adminQueue: { access, scope: "ALL" } },
  } as any);

const flightItem = {
  type: "flight", title: "BLR → BOM", qty: 1, price: 0,
  meta: {
    origin: "BLR", destination: "BOM", departDate: "2027-03-12",
    travellers: [{ kind: "manual", firstName: "Asha", lastName: "Rao" }],
  },
};

const linkFor = (kind: "request" | "proposal", id: any, email: string) =>
  `/api/public/approval-links/${signApprovalLink({ kind, id: String(id), email }, 72)}`;

const reqDoc = async (id: any): Promise<any> => col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
const propDoc = async (id: any): Promise<any> => col("proposals").findOne({ _id: new mongoose.Types.ObjectId(String(id)) });

async function submitRequest() {
  const r = await as(request(app).post("/api/approvals/requests"), R).send({ customerId: CUSTOMER_ID, cartItems: [flightItem] });
  expect(r.status).toBe(200);
  return String(r.body.request._id);
}

async function approvedRequest() {
  const id = await submitRequest();
  const a = await as(request(app).put(`/api/approvals/requests/${id}/action`), A).send({ action: "approved" });
  expect(a.status).toBe(200);
  return id;
}

const option = {
  optionNo: 1, title: "IndiGo 6E-201 + Taj", currency: "INR", totalAmount: 0, attachments: [],
  lineItems: [{ itemIndex: 1, category: "flight", title: "BLR → BOM 6E-201", qty: 1, unitPrice: 5000, totalPrice: 5000, currency: "INR" }],
};

async function submittedProposal(requestId: string) {
  const d = await as(request(app).post(`/api/proposals/by-request/${requestId}/draft`), OPS).send({});
  expect([d.status, d.body.created]).toEqual([200, true]);
  const pid = String(d.body.proposal._id);
  const put = await as(request(app).put(`/api/proposals/${pid}`), OPS).send({ options: [option] });
  expect(put.status).toBe(200);
  const sub = await as(request(app).post(`/api/proposals/${pid}/submit`), OPS).send({});
  expect(sub.status).toBe(200);
  return pid;
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-flow2-journey-test"));
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  sent.length = 0;
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertOne({
    _id: WS, customerId: CUSTOMER_ID, name: "WS F1", status: "ACTIVE", tenantType: "CORPORATE",
    defaultApproverEmails: [APPROVER],
    config: { travelFlow: "APPROVAL_FLOW", tokenExpiryHours: 12, features: { approvalFlowEnabled: true } },
  } as any);
  await col("customermembers").insertOne({ customerId: CUSTOMER_ID, email: LEADER, role: "WORKSPACE_LEADER", isActive: true } as any);
  await col("customerworkspaces").insertOne({ _id: HOUSE, customerId: "PLUMTRIPS-HOUSE", name: "Plumtrips", status: "ACTIVE", config: { features: {} } } as any);
  await grantAdminQueue(OPS_SUB, OPS.email);
  await col("users").insertMany([
    { email: APPROVER, name: "Anil Approver", roles: ["CUSTOMER"] },
    { email: LEADER, name: "Lata Leader", roles: ["CUSTOMER"] },
  ] as any[]);
});

describe("F2-01 — ops can create, save and revise a proposal draft", () => {
  it("creates v1 with the request's workspaceId; a declined proposal can be revised and resubmitted", async () => {
    const rid = await approvedRequest();
    const pid = await submittedProposal(rid);
    const p = await propDoc(pid);
    expect(String(p.workspaceId)).toBe(String(WS));
    expect((await reqDoc(rid)).stage).toBe("PROPOSAL_SUBMITTED");

    const dec = await as(request(app).post(`/api/proposals/${pid}/decide`), A).send({ decision: "DECLINED", reason: "Too early" });
    expect(dec.status).toBe(200);
    expect((await reqDoc(rid)).stage).toBe("PROPOSAL_DECLINED");

    // Revision: v2 draft goes back to PROPOSAL_PENDING, then SUBMITTED (no forward-only trap).
    const d2 = await as(request(app).post(`/api/proposals/by-request/${rid}/draft`), OPS).send({});
    expect([d2.status, d2.body.created, d2.body.proposal.version]).toEqual([200, true, 2]);
    expect((await reqDoc(rid)).stage).toBe("PROPOSAL_PENDING");
    const s2 = await as(request(app).post(`/api/proposals/${d2.body.proposal._id}/submit`), OPS).send({});
    expect(s2.status).toBe(200);
    expect((await reqDoc(rid)).stage).toBe("PROPOSAL_SUBMITTED");
  });
});

describe("Flow 2 journey", () => {
  it("email-link approval without login → proposal → approver approves; the leader's later action shows who decided", async () => {
    const rid = await submitRequest();
    // The approver email carries links to the confirm page.
    const approverMail = sent.find((m) => m.to === APPROVER && /Approval Needed/.test(m.subject))!;
    expect(approverMail.html).toMatch(/\/approval\/email\?token=/);

    const link = linkFor("request", rid, APPROVER);
    // A scanner (or the approver) opening the link changes nothing.
    for (let i = 0; i < 2; i++) {
      const g = await request(app).get(link);
      expect([g.status, g.body.link.state]).toEqual([200, "OPEN"]);
    }
    expect((await reqDoc(rid)).status).toBe("pending");

    const post = await request(app).post(link).send({ action: "approve" });
    expect(post.status).toBe(200);
    expect([(await reqDoc(rid)).status, (await reqDoc(rid)).stage]).toEqual(["approved", "PROPOSAL_PENDING"]);

    sent.length = 0;
    const pid = await submittedProposal(rid);
    // Both the approver and the Workspace Leader get their own link.
    expect(sent.filter((m) => /Proposal Approval Needed/.test(m.subject)).map((m) => m.to).sort()).toEqual([APPROVER, LEADER].sort());

    const ok = await as(request(app).post(`/api/proposals/${pid}/decide`), A).send({ decision: "APPROVED" });
    expect(ok.status).toBe(200);
    expect((await propDoc(pid)).status).toBe("APPROVED");
    expect((await reqDoc(rid)).stage).toBe("PROPOSAL_APPROVED");

    // The leader is second: in-app and by link, told who decided.
    const late = await as(request(app).post(`/api/proposals/${pid}/decide`), L).send({ decision: "DECLINED", reason: "x" });
    expect([late.status, late.body.code, late.body.decided?.byEmail]).toEqual([409, "ALREADY_DECIDED", APPROVER]);
    const leaderLink = linkFor("proposal", pid, LEADER);
    const lg = await request(app).get(leaderLink);
    expect([lg.body.link.state, lg.body.link.decided.byName]).toEqual(["DECIDED", "approver"]);
    const lp = await request(app).post(leaderLink).send({ action: "decline", reason: "x" });
    expect([lp.status, lp.body.code]).toEqual([409, "ALREADY_DECIDED"]);
    expect((await propDoc(pid)).status).toBe("APPROVED");
  });

  it("a Workspace Leader can approve the proposal by email link before the approver", async () => {
    const rid = await approvedRequest();
    const pid = await submittedProposal(rid);
    const r = await request(app).post(linkFor("proposal", pid, LEADER)).send({ action: "approve" });
    expect(r.status).toBe(200);
    const p = await propDoc(pid);
    expect([p.status, p.approvals.l2.byEmail]).toEqual(["APPROVED", LEADER]);
    const a = await as(request(app).post(`/api/proposals/${pid}/decide`), A).send({ decision: "APPROVED" });
    expect([a.status, a.body.decided?.byEmail]).toEqual([409, LEADER]);
  });

  it("the requester cannot decide the proposal", async () => {
    const rid = await approvedRequest();
    const pid = await submittedProposal(rid);
    const r = await as(request(app).post(`/api/proposals/${pid}/decide`), R).send({ decision: "APPROVED" });
    expect([r.status, r.body.code]).toEqual([403, "SELF_APPROVAL_NOT_ALLOWED"]);
  });
});

describe("decline needs a reason", () => {
  it("request (in-app and by link) and proposal", async () => {
    const rid = await submitRequest();
    const a = await as(request(app).put(`/api/approvals/requests/${rid}/action`), A).send({ action: "declined" });
    expect([a.status, a.body.code]).toEqual([400, "REASON_REQUIRED"]);
    const l = await request(app).post(linkFor("request", rid, APPROVER)).send({ action: "decline" });
    expect([l.status, l.body.code]).toEqual([400, "REASON_REQUIRED"]);
    // The refused decline did not use up the link.
    const ok = await request(app).post(linkFor("request", rid, APPROVER)).send({ action: "decline", reason: "Not needed" });
    expect(ok.status).toBe(200);
    expect((await reqDoc(rid)).history.at(-1).comment).toBe("Not needed");

    const rid2 = await approvedRequest();
    const pid = await submittedProposal(rid2);
    const p = await as(request(app).post(`/api/proposals/${pid}/decide`), A).send({ decision: "DECLINED" });
    expect([p.status, p.body.code]).toEqual([400, "REASON_REQUIRED"]);
    const pl = await request(app).post(linkFor("proposal", pid, LEADER)).send({ action: "decline", reason: "" });
    expect([pl.status, pl.body.code]).toEqual([400, "REASON_REQUIRED"]);
  });
});

describe("email links", () => {
  it("work once", async () => {
    const rid = await submitRequest();
    const link = linkFor("request", rid, APPROVER);
    expect((await request(app).post(link).send({ action: "approve" })).status).toBe(200);
    const again = await request(app).post(link).send({ action: "approve" });
    expect([again.status, again.body.code]).toEqual([409, "LINK_USED"]);
    expect((await request(app).get(link)).body.link.state).toBe("USED");
  });

  it("expire", async () => {
    const rid = await submitRequest();
    const expired = jwt.sign(
      { jti: "x1", kind: "request", id: rid, email: APPROVER, exp: Math.floor(Date.now() / 1000) - 60 },
      approvalLinkSecret(),
      { audience: "approval-link" },
    );
    const g = await request(app).get(`/api/public/approval-links/${expired}`);
    expect([g.status, g.body.code]).toEqual([410, "LINK_EXPIRED"]);
    const p = await request(app).post(`/api/public/approval-links/${expired}`).send({ action: "approve" });
    expect([p.status, (await reqDoc(rid)).status]).toEqual([410, "pending"]);
  });

  it("a tampered or JWT_SECRET-signed token is refused", async () => {
    const rid = await submitRequest();
    const forged = jwt.sign({ jti: "x2", kind: "request", id: rid, email: APPROVER }, process.env.JWT_SECRET!, { audience: "approval-link" });
    const r = await request(app).post(`/api/public/approval-links/${forged}`).send({ action: "approve" });
    expect([r.status, r.body.code]).toEqual([400, "LINK_INVALID"]);
  });

  it("re-check the recipient: an approver removed from the workspace can no longer decide", async () => {
    const rid = await submitRequest();
    const link = linkFor("request", rid, APPROVER);
    await col("customerworkspaces").updateOne({ _id: WS }, { $set: { defaultApproverEmails: [] } });
    expect((await request(app).get(link)).body.link.state).toBe("NOT_ALLOWED");
    const p = await request(app).post(link).send({ action: "approve" });
    expect([p.status, p.body.code]).toEqual([403, "NOT_AN_APPROVER"]);
    expect((await reqDoc(rid)).status).toBe("pending");
  });

  it("an inactive approver account can no longer decide", async () => {
    const rid = await submitRequest();
    await col("users").updateOne({ email: APPROVER }, { $set: { status: "INACTIVE" } });
    const p = await request(app).post(linkFor("request", rid, APPROVER)).send({ action: "approve" });
    expect([p.status, p.body.code]).toEqual([403, "NOT_AN_APPROVER"]);
  });
});

describe("Phase B — clarification at the request step", () => {
  it("approver asks → requester edits and replies → back to the same approver, thread visible to all", async () => {
    const rid = await submitRequest();

    const noQ = await as(request(app).put(`/api/approvals/requests/${rid}/action`), A).send({ action: "clarify" });
    expect([noQ.status, noQ.body.code]).toEqual([400, "QUESTION_REQUIRED"]);

    sent.length = 0;
    const q = await as(request(app).put(`/api/approvals/requests/${rid}/action`), A).send({ action: "clarify", comment: "Why business class?" });
    expect(q.status).toBe(200);
    let doc = await reqDoc(rid);
    expect([doc.status, doc.stage]).toEqual(["pending", "REQUEST_NEEDS_CLARIFICATION"]);
    expect(sent.some((m) => m.to === REQUESTER && /has a question/.test(m.subject) && m.html.includes("Why business class?"))).toBe(true);

    // Not in the approver's inbox while it waits for the requester.
    const inbox = await as(request(app).get("/api/approvals/requests/inbox"), A);
    expect(inbox.body.rows.map((r: any) => String(r._id))).not.toContain(rid);
    // The approver cannot decide it while the question is open.
    const early = await as(request(app).put(`/api/approvals/requests/${rid}/action`), A).send({ action: "approved" });
    expect([early.status, early.body.code]).toEqual([409, "ALREADY_DECIDED"]);

    // Only the requester replies; they may edit first.
    const notOwner = await as(request(app).post(`/api/approvals/requests/${rid}/clarification`), A).send({ reply: "x" });
    expect(notOwner.status).toBe(403);
    const edit = await as(request(app).put(`/api/approvals/requests/${rid}`), R).send({ cartItems: [flightItem], comments: "Economy is fine" });
    expect(edit.status).toBe(200);
    const empty = await as(request(app).post(`/api/approvals/requests/${rid}/clarification`), R).send({ reply: " " });
    expect([empty.status, empty.body.code]).toEqual([400, "REPLY_REQUIRED"]);

    sent.length = 0;
    const reply = await as(request(app).post(`/api/approvals/requests/${rid}/clarification`), R).send({ reply: "Changed to economy." });
    expect(reply.status).toBe(200);
    doc = await reqDoc(rid);
    expect([doc.status, doc.stage, doc.managerEmail]).toEqual(["pending", "REQUEST_RAISED", APPROVER]);
    expect(doc.clarifications.map((c: any) => [c.kind, c.text, c.edited])).toEqual([
      ["question", "Why business class?", false],
      ["reply", "Changed to economy.", true],
    ]);
    const back = sent.find((m) => m.to === APPROVER && /Reply received/.test(m.subject))!;
    expect(back.html).toContain("Changed to economy.");
    expect(back.html).toMatch(/\/approval\/email\?token=/);

    // Thread is visible to requester, approver and ops.
    for (const who of [R, A]) {
      const g = await as(request(app).get(`/api/approvals/requests/${rid}`), who);
      expect(g.body.request.clarifications.map((c: any) => c.kind)).toEqual(["question", "reply"]);
    }
    const ops = await as(request(app).get(`/api/approvals/admin/requests/${rid}`), { email: "ops@plumtrips.test", roles: ["SUPERADMIN"] });
    expect(ops.body.clarifications.length).toBe(2);

    // Back in the inbox; the approver decides.
    expect((await as(request(app).get("/api/approvals/requests/inbox"), A)).body.rows.map((r: any) => String(r._id))).toContain(rid);
    expect((await as(request(app).put(`/api/approvals/requests/${rid}/action`), A).send({ action: "approved" })).status).toBe(200);
  });

  it("the approver can ask by email link too", async () => {
    const rid = await submitRequest();
    const link = linkFor("request", rid, APPROVER);
    expect((await request(app).get(link)).body.link.actions).toEqual(["approve", "decline", "clarify"]);
    const p = await request(app).post(link).send({ action: "clarify", reason: "Which dates exactly?" });
    expect(p.status).toBe(200);
    expect((await reqDoc(rid)).stage).toBe("REQUEST_NEEDS_CLARIFICATION");
  });

  it("On Hold is no longer an approver action", async () => {
    const rid = await submitRequest();
    const h = await as(request(app).put(`/api/approvals/requests/${rid}/action`), A).send({ action: "on_hold", comment: "x" });
    expect([h.status, h.body.code]).toEqual([400, "HOLD_REMOVED"]);
  });
});

describe("Phase B — request changes at the proposal step", () => {
  it("leader requests changes → ops notified → ops revise and resubmit → approver approves", async () => {
    const rid = await approvedRequest();
    const pid = await submittedProposal(rid);

    const noNote = await as(request(app).post(`/api/proposals/${pid}/decide`), L).send({ decision: "CHANGES_REQUESTED" });
    expect([noNote.status, noNote.body.code]).toEqual([400, "NOTE_REQUIRED"]);

    sent.length = 0;
    const back = await request(app).post(linkFor("proposal", pid, LEADER)).send({ action: "request_changes", reason: "Need a later flight" });
    expect(back.status).toBe(200);
    expect((await propDoc(pid)).status).toBe("CHANGES_REQUESTED");
    expect((await reqDoc(rid)).stage).toBe("PROPOSAL_CHANGES_REQUESTED");
    // The ops desk is told, copying the staff who drafted/submitted the proposal.
    const opsMail = sent.find((m) => m.to === DESK && (m.cc || []).includes(OPS.email) && /changes requested/i.test(m.subject))!;
    expect(opsMail.html).toContain("Need a later flight");

    // The approver's decision now comes too late, and says who sent it back.
    const late = await as(request(app).post(`/api/proposals/${pid}/decide`), A).send({ decision: "APPROVED" });
    expect([late.status, late.body.decided?.decision, late.body.decided?.byEmail]).toEqual([409, "CHANGES_REQUESTED", LEADER]);

    // Ops revise into v2 and resubmit; the approver and leaders are asked again.
    const d2 = await as(request(app).post(`/api/proposals/by-request/${rid}/draft`), OPS).send({});
    expect([d2.status, d2.body.proposal.version]).toEqual([200, 2]);
    expect((await reqDoc(rid)).stage).toBe("PROPOSAL_PENDING");
    sent.length = 0;
    const s2 = await as(request(app).post(`/api/proposals/${d2.body.proposal._id}/submit`), OPS).send({});
    expect(s2.status).toBe(200);
    expect((await reqDoc(rid)).stage).toBe("PROPOSAL_SUBMITTED");
    expect(sent.filter((m) => /Proposal Approval Needed/.test(m.subject)).map((m) => m.to).sort()).toEqual([APPROVER, LEADER].sort());

    const ok = await as(request(app).post(`/api/proposals/${d2.body.proposal._id}/decide`), A).send({ decision: "APPROVED" });
    expect(ok.status).toBe(200);
    expect((await reqDoc(rid)).stage).toBe("PROPOSAL_APPROVED");
  });
});

describe("Phase C — notifications and the one 'booking done' path", () => {
  it("full journey: proposal ready → approved (approver + leaders told) → booking started → done from the proposal page", async () => {
    const rid = await approvedRequest();
    sent.length = 0;
    const pid = await submittedProposal(rid);
    const ready = sent.find((m) => m.to === REQUESTER && /proposal is ready/i.test(m.subject))!;
    expect(ready.html).toContain(`/customer/approvals/proposal/${pid}`);
    expect(ready.html).not.toMatch(/₹|INR|5000/);

    // The requester can open the read-only, price-free proposal.
    const view = await as(request(app).get(`/api/proposals/${pid}`), R);
    expect(view.status).toBe(200);
    expect(JSON.stringify(view.body)).not.toMatch(/unitPrice|totalPrice|5000/);
    expect(view.body.proposal._canDecide).toBe(false);
    // My Requests links to it.
    const mine = await as(request(app).get("/api/approvals/requests/mine"), R);
    expect(mine.body.rows.find((r: any) => String(r._id) === rid)._proposal).toMatchObject({ id: pid, status: "SUBMITTED" });

    sent.length = 0;
    expect((await as(request(app).post(`/api/proposals/${pid}/decide`), A).send({ decision: "APPROVED" })).status).toBe(200);
    // The other deciders hear — not the approver who just decided.
    const fyi = sent.find((m) => /^Proposal approved/.test(m.subject) && m.to.includes(LEADER))!;
    expect(fyi.to.split(",").sort()).toEqual([LEADER]);
    expect(sent.some((m) => m.to === DESK && (m.cc || []).includes(OPS.email) && /Proposal approved/.test(m.subject))).toBe(true);
    expect(sent.some((m) => m.to === REQUESTER && /Proposal Has Been Approved/.test(m.subject))).toBe(true);

    // Done before start is refused on the proposal page too (one path, one rule).
    const early = await as(request(app).post(`/api/proposals/${pid}/booking/done`), OPS).send({});
    expect(early.status).toBe(400);

    sent.length = 0;
    expect((await as(request(app).post(`/api/proposals/${pid}/booking/start`), OPS).send({})).status).toBe(200);
    expect(sent.some((m) => m.to === REQUESTER && /Booking in progress/.test(m.subject))).toBe(true);

    sent.length = 0;
    const done = await as(request(app).post(`/api/proposals/${pid}/booking/done`), OPS).send({ note: "Tickets attached" });
    expect(done.status).toBe(200);
    expect([(await reqDoc(rid)).stage, (await reqDoc(rid)).adminState]).toEqual(["COMPLETED", "done"]);
    expect((await propDoc(pid)).booking.status).toBe("DONE");
    const processed = sent.filter((m) => /Your Booking has been Processed/.test(m.subject));
    expect(processed.map((m) => m.to)).toEqual([REQUESTER]);
    expect([...(processed[0].cc || [])].sort()).toEqual([APPROVER, LEADER].sort());
  });

  it("the queue's Mark Done copies the approver and Workspace Leaders", async () => {
    const rid = await approvedRequest();
    const pid = await submittedProposal(rid);
    await as(request(app).post(`/api/proposals/${pid}/decide`), A).send({ decision: "APPROVED" });
    await as(request(app).put(`/api/approvals/admin/${rid}/under-process`), { email: "ops@plumtrips.test", roles: ["SUPERADMIN"] }).send({});
    sent.length = 0;
    const d = await as(request(app).put(`/api/approvals/admin/${rid}/done`), { email: "ops@plumtrips.test", roles: ["SUPERADMIN"] }).send({ comment: "Booked" });
    expect(d.status).toBe(200);
    const processed = sent.find((m) => m.to === REQUESTER && /Processed/.test(m.subject))!;
    expect([...(processed.cc || [])].sort()).toEqual([APPROVER, LEADER].sort());
    expect((await propDoc(pid)).booking.status).toBe("DONE");
  });

  it("ops hold and cancel tell the requester; the cancel email links to My Requests", async () => {
    const rid = await approvedRequest();
    const STAFF = { email: "ops@plumtrips.test", roles: ["SUPERADMIN"] };
    sent.length = 0;
    expect((await as(request(app).put(`/api/approvals/admin/${rid}/on-hold`), STAFF).send({ comment: "Waiting on fares" })).status).toBe(200);
    expect(sent.some((m) => m.to === REQUESTER && /on hold/i.test(m.subject) && m.html.includes("Waiting on fares"))).toBe(true);

    sent.length = 0;
    expect((await as(request(app).put(`/api/approvals/admin/${rid}/cancel`), STAFF).send({ comment: "Trip called off" })).status).toBe(200);
    const c = sent.find((m) => m.to === REQUESTER && /Cancelled/.test(m.subject))!;
    expect(c.html).toContain("/customer/approvals/mine");
    expect(c.html).toContain("Trip called off");
  });
});

describe("Proposals list (GET /proposals/mine) is by workspace membership, not login roles", () => {
  it("the approver and a leader whose logins carry no approver role still see it; drafts stay hidden", async () => {
    const rid = await approvedRequest();
    const d = await as(request(app).post(`/api/proposals/by-request/${rid}/draft`), OPS).send({});
    const plain = (email: string) => ({ email, roles: ["CUSTOMER"] });
    expect((await as(request(app).get("/api/proposals/mine"), plain(APPROVER))).body.items).toEqual([]);

    await as(request(app).put(`/api/proposals/${d.body.proposal._id}`), OPS).send({ options: [option] });
    await as(request(app).post(`/api/proposals/${d.body.proposal._id}/submit`), OPS).send({});
    const a = await as(request(app).get("/api/proposals/mine"), plain(APPROVER));
    expect([a.status, a.body.scope, a.body.items.map((p: any) => String(p._id))]).toEqual([200, "USER", [String(d.body.proposal._id)]]);
    const l = await as(request(app).get("/api/proposals/mine"), plain(LEADER));
    expect([l.status, l.body.scope, l.body.items.length]).toEqual([200, "WORKSPACE_L0", 1]);
    expect(JSON.stringify(a.body)).not.toMatch(/unitPrice|totalPrice/);
  });
});

describe("Ops record the customer's proposal decision on their behalf", () => {
  const STAFF = OPS;

  it("needs a note; non-staff cannot use it", async () => {
    const rid = await approvedRequest();
    const pid = await submittedProposal(rid);
    const noNote = await as(request(app).post(`/api/proposals/${pid}/record-decision`), STAFF).send({ decision: "APPROVED" });
    expect([noNote.status, noNote.body.code]).toEqual([400, "NOTE_REQUIRED"]);
    for (const who of [A, L, R]) {
      const r = await as(request(app).post(`/api/proposals/${pid}/record-decision`), who).send({ decision: "APPROVED", note: "x" });
      expect(r.status, who.email).toBe(403);
    }
    expect((await propDoc(pid)).status).toBe("SUBMITTED");
  });

  it("records the decision with 'Recorded by … on behalf of the customer', emails as usual, and blocks later customer decisions", async () => {
    const rid = await approvedRequest();
    const pid = await submittedProposal(rid);
    sent.length = 0;
    const r = await as(request(app).post(`/api/proposals/${pid}/record-decision`), STAFF).send({
      decision: "APPROVED",
      note: "Kavya approved by phone, 3 Oct 11:00",
    });
    expect(r.status).toBe(200);
    const p = await propDoc(pid);
    expect(p.status).toBe("APPROVED");
    const h = p.history.at(-1);
    expect(h.action).toBe("RECORDED_APPROVED");
    // Customers read this note: the travel desk, not the staff member — who is on the row's actor.
    expect(h.note).toBe("Recorded by Plumtrips Travel Desk on behalf of the customer: Kavya approved by phone, 3 Oct 11:00");
    expect(h.actorKind).toBe("staff");
    expect((await reqDoc(rid)).stage).toBe("PROPOSAL_APPROVED");

    const fyi = sent.find((m) => /^Proposal approved/.test(m.subject) && m.to.includes(APPROVER))!;
    expect(fyi.to.split(",").sort()).toEqual([APPROVER, LEADER].sort());
    expect(fyi.html).toContain("on behalf of the customer: Kavya approved by phone");
    expect(sent.some((m) => m.to === REQUESTER && /Proposal Has Been Approved/.test(m.subject))).toBe(true);

    const late = await as(request(app).post(`/api/proposals/${pid}/decide`), A).send({ decision: "DECLINED", reason: "x" });
    expect([late.status, late.body.code]).toEqual([409, "ALREADY_DECIDED"]);
    const link = await request(app).post(linkFor("proposal", pid, LEADER)).send({ action: "approve" });
    expect([link.status, link.body.code]).toEqual([409, "ALREADY_DECIDED"]);
  });

  it("a customer decision first means ops cannot record over it; changes requested tells approver and leaders", async () => {
    const rid = await approvedRequest();
    const pid = await submittedProposal(rid);
    await as(request(app).post(`/api/proposals/${pid}/decide`), L).send({ decision: "APPROVED" });
    const r = await as(request(app).post(`/api/proposals/${pid}/record-decision`), STAFF).send({ decision: "DECLINED", note: "x" });
    expect([r.status, r.body.code]).toEqual([409, "ALREADY_DECIDED"]);

    const rid2 = await approvedRequest();
    const pid2 = await submittedProposal(rid2);
    sent.length = 0;
    const c = await as(request(app).post(`/api/proposals/${pid2}/record-decision`), STAFF).send({
      decision: "CHANGES_REQUESTED",
      note: "Lata asked on email for a later flight",
    });
    expect(c.status).toBe(200);
    expect((await propDoc(pid2)).status).toBe("CHANGES_REQUESTED");
    expect(sent.some((m) => /sent back for changes/.test(m.subject) && m.to.includes(LEADER) && m.to.includes(APPROVER))).toBe(true);
  });
});

describe("one-way flights never store or email a return date (REQ-563ECF)", () => {
  it("create and edit drop returnDate on one-way; a round trip keeps it; the approver email shows no Return Date for one-way", async () => {
    const oneWay = { ...flightItem, meta: { ...flightItem.meta, tripType: "oneway", returnDate: "2027-03-10" } };
    sent.length = 0;
    const r = await as(request(app).post("/api/approvals/requests"), R).send({ customerId: CUSTOMER_ID, cartItems: [oneWay] });
    expect(r.status).toBe(200);
    const id = String(r.body.request._id);
    expect("returnDate" in (await reqDoc(id)).cartItems[0].meta).toBe(false);
    const mail = sent.find((m) => m.to === APPROVER && /Approval Needed/.test(m.subject))!;
    expect(mail.html).not.toContain("Return Date");

    const e = await as(request(app).put(`/api/approvals/requests/${id}`), R).send({ cartItems: [oneWay] });
    expect(e.status).toBe(200);
    expect("returnDate" in (await reqDoc(id)).cartItems[0].meta).toBe(false);

    const rt = { ...flightItem, meta: { ...flightItem.meta, tripType: "roundtrip", returnDate: "2027-03-15" } };
    const r2 = await as(request(app).post("/api/approvals/requests"), R).send({ customerId: CUSTOMER_ID, cartItems: [rt] });
    expect((await reqDoc(r2.body.request._id)).cartItems[0].meta.returnDate).toBe("2027-03-15");
  });
});

describe("Plumtrips staff (HOUSE login) work a customer's proposal", () => {
  // Prod shape: the staff token carries the HOUSE workspace, not the customer's.
  // (The other tests here run ops inside the customer's workspace, which is
  // why the HOUSE-scoped lookups looked fine until prod.)
  const OTHER_WS = oid();
  const HOUSE_ADMIN: Who = { email: "desk@plumtrips.test", roles: ["ADMIN"] };
  const OUTSIDER: Who = { email: "someone@other.test" };
  const asIn = (r: request.Test, who: Who, ws: any) =>
    r
      .set("x-test-user", JSON.stringify({ sub: who.sub || String(oid()), email: who.email, name: who.email.split("@")[0], roles: who.roles || ["EMPLOYEE"] }))
      .set("x-test-ws", String(ws));

  beforeEach(async () => {
    await col("customerworkspaces").insertMany([
      { _id: OTHER_WS, customerId: "O1", name: "Other Co", status: "ACTIVE", tenantType: "CORPORATE", config: { travelFlow: "APPROVAL_FLOW", features: { approvalFlowEnabled: true } } },
    ] as any[]);
  });

  it("creates, edits, submits, views and records a decision; a customer from another workspace still gets 404", async () => {
    const rid = await approvedRequest();

    const d = await asIn(request(app).post(`/api/proposals/by-request/${rid}/draft`), HOUSE_ADMIN, HOUSE).send({});
    expect([d.status, d.body.created]).toEqual([200, true]);
    const pid = String(d.body.proposal._id);
    expect(String((await propDoc(pid)).workspaceId)).toBe(String(WS)); // stored on the customer's workspace

    expect((await asIn(request(app).put(`/api/proposals/${pid}`), HOUSE_ADMIN, HOUSE).send({ options: [option] })).status).toBe(200);
    expect((await asIn(request(app).post(`/api/proposals/${pid}/submit`), HOUSE_ADMIN, HOUSE).send({})).status).toBe(200);

    const queue = await asIn(request(app).get("/api/proposals/queue"), HOUSE_ADMIN, HOUSE);
    expect(queue.body.items.map((p: any) => String(p._id))).toContain(pid);
    expect((await asIn(request(app).get(`/api/proposals/by-request/${rid}`), HOUSE_ADMIN, HOUSE)).body.proposal?._id).toBe(pid);
    expect((await asIn(request(app).get(`/api/proposals/${pid}`), HOUSE_ADMIN, HOUSE)).status).toBe(200);

    const rec = await asIn(request(app).post(`/api/proposals/${pid}/record-decision`), HOUSE_ADMIN, HOUSE)
      .send({ decision: "APPROVED", note: "Lata approved on the phone" });
    expect(rec.status).toBe(200);
    expect((await propDoc(pid)).status).toBe("APPROVED");

    const start = await asIn(request(app).post(`/api/proposals/${pid}/booking/start`), HOUSE_ADMIN, HOUSE).send({});
    expect(start.status).toBe(200);

    // The customer's own approver sees it; someone from another workspace does not.
    expect((await as(request(app).get(`/api/proposals/${pid}`), A)).status).toBe(200);
    expect((await asIn(request(app).get(`/api/proposals/${pid}`), OUTSIDER, OTHER_WS)).status).toBe(404);
    expect((await asIn(request(app).post(`/api/proposals/${pid}/decide`), OUTSIDER, OTHER_WS).send({ decision: "DECLINED", reason: "x" })).status).toBe(404);
  });
});

describe("travel-mode gate: staff are checked against the CUSTOMER's flow, not HOUSE", () => {
  const WS3 = oid(); // a Flow 3 (APPROVAL_DIRECT) customer
  const HOUSE_OPS: Who = OPS; // EMPLOYEE + Admin Queue grant: not ADMIN, no blanket bypass
  const asIn = (r: request.Test, who: Who, ws: any) =>
    r
      .set("x-test-user", JSON.stringify({ sub: who.sub || String(oid()), email: who.email, name: who.email.split("@")[0], roles: who.roles || ["EMPLOYEE"] }))
      .set("x-test-ws", String(ws));

  beforeEach(async () => {
    // HOUSE (no travel flow of its own — the old gate refused OPS agents on that) exists for every test.
    await col("customerworkspaces").insertMany([
      { _id: WS3, customerId: "D3", name: "Direct Co", status: "ACTIVE", tenantType: "CORPORATE", config: { travelFlow: "APPROVAL_DIRECT", features: { approvalDirectEnabled: true } } },
    ] as any[]);
  });

  it("an OPS-role HOUSE user drafts, submits and records a decision on a Flow 2 customer's proposal", async () => {
    const rid = await approvedRequest();
    const d = await asIn(request(app).post(`/api/proposals/by-request/${rid}/draft`), HOUSE_OPS, HOUSE).send({});
    expect([d.status, d.body.created]).toEqual([200, true]);
    const pid = String(d.body.proposal._id);
    expect((await asIn(request(app).put(`/api/proposals/${pid}`), HOUSE_OPS, HOUSE).send({ options: [option] })).status).toBe(200);
    expect((await asIn(request(app).post(`/api/proposals/${pid}/submit`), HOUSE_OPS, HOUSE).send({})).status).toBe(200);
    const rec = await asIn(request(app).post(`/api/proposals/${pid}/record-decision`), HOUSE_OPS, HOUSE)
      .send({ decision: "APPROVED", note: "Approved on a call" });
    expect(rec.status).toBe(200);
    expect((await propDoc(pid)).status).toBe("APPROVED");
  });

  it("the same OPS user is refused a proposal draft on a Flow 3 customer's request (the customer's flow decides)", async () => {
    const r3 = await col("approvalrequests").insertOne({
      workspaceId: WS3, customerId: "D3", customerName: "Direct Co", frontlinerId: String(oid()), frontlinerEmail: "x@d3.test",
      status: "approved", stage: "REQUEST_APPROVED", adminState: "pending", cartItems: [flightItem], meta: { travelFlow: "APPROVAL_FLOW" }, history: [],
    } as any);
    const d = await asIn(request(app).post(`/api/proposals/by-request/${r3.insertedId}/draft`), HOUSE_OPS, HOUSE).send({});
    expect([d.status, d.body.workspaceFlow]).toEqual([403, "APPROVAL_DIRECT"]);
    expect(await col("proposals").countDocuments({ requestId: r3.insertedId })).toBe(0);
  });
});
