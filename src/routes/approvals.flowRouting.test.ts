// apps/backend/src/routes/approvals.flowRouting.test.ts
//
// Who approves a request, in Flow 2 (APPROVAL_FLOW) and Flow 3 (APPROVAL_DIRECT):
//   - a plain requester's request goes pending to the workspace approver,
//     with the "Approval Needed" email — Flow 3 is no longer auto-approved
//   - approving moves Flow 3 straight to the ops queue (REQUEST_APPROVED, no
//     proposal) and Flow 2 to PROPOSAL_PENDING
//   - decline works the same in both flows and notifies the requester
//   - requester is the approver → routed to the Workspace Leader
//   - requester is a Workspace Leader → auto-approved
//   - nobody can act on their own request (in-app or email link)
//
// Real: approvals + proposals routers, requireFeature, travelModeGuard.
// Stubbed: requireAuth (user from a header), requireWorkspace (workspace from
// a header), mail (recorded), email-action tokens, TBO.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";

const sent: Array<{ to: string; subject: string }> = [];

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
    sent.push({ to: String(m.to), subject: String(m.subject) });
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
const { signApprovalLink } = await import("../utils/approvalLinkToken.js");

const app = express();
app.use(express.json());
app.use("/api/public/approval-links", approvalLinksRouter);
app.use("/api/proposals", proposalsRouter);
app.use("/api/approvals", approvalsRouter);

/** The single-use link an approver gets by email (no login needed to use it). */
const requestLink = (id: any, email: string) => signApprovalLink({ kind: "request", id: String(id), email }, 72)!;

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const WS_DIRECT = oid(); // Flow 3
const WS_FLOW = oid(); // Flow 2
const WS_NO_LEADER = oid(); // Flow 3, approver set, no Workspace Leader

const APPROVER = "approver@cust.test";
const LEADER = "leader@cust.test";

const ws = (_id: any, customerId: string, travelFlow: string) => ({
  _id, customerId, name: `WS ${customerId}`, status: "ACTIVE", tenantType: "CORPORATE",
  defaultApproverEmails: [APPROVER],
  config: {
    travelFlow,
    features: { approvalFlowEnabled: travelFlow === "APPROVAL_FLOW", approvalDirectEnabled: travelFlow === "APPROVAL_DIRECT" },
  },
});

type Who = { email: string; roles?: string[] };
const REQUESTER: Who = { email: "requestor@cust.test" };
const as = (r: request.Test, who: Who, wsId: any) =>
  r
    .set("x-test-user", JSON.stringify({ sub: String(oid()), email: who.email, name: who.email.split("@")[0], roles: who.roles || ["EMPLOYEE"] }))
    .set("x-test-ws", String(wsId));

const flightItem = {
  type: "flight", title: "BLR → BOM", qty: 1, price: 0,
  meta: {
    origin: "BLR", destination: "BOM", departDate: "2026-10-12",
    travellers: [{ kind: "manual", firstName: "Asha", lastName: "Rao" }],
  },
};
const cid = (wsId: any) => (wsId === WS_DIRECT ? "D1" : wsId === WS_FLOW ? "F1" : "N1");

async function submit(who: Who, wsId: any) {
  const r = await as(request(app).post("/api/approvals/requests"), who, wsId).send({ customerId: cid(wsId), cartItems: [flightItem] });
  const doc: any = r.status === 200 ? await col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(String(r.body.request._id)) }) : null;
  return { r, doc };
}
const act = (id: any, who: Who, wsId: any, action: string, comment?: string) =>
  as(request(app).put(`/api/approvals/requests/${String(id)}/action`), who, wsId).send({ action, comment });

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-flow-routing-test"));
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertMany([
    ws(WS_DIRECT, "D1", "APPROVAL_DIRECT"),
    ws(WS_FLOW, "F1", "APPROVAL_FLOW"),
    ws(WS_NO_LEADER, "N1", "APPROVAL_DIRECT"),
  ] as any[]);
  await col("customermembers").insertMany([
    { customerId: "D1", email: LEADER, role: "WORKSPACE_LEADER", isActive: true },
    { customerId: "F1", email: LEADER, role: "WORKSPACE_LEADER", isActive: true },
  ] as any[]);
  await col("users").insertOne({ _id: oid(), email: "ops@plumtrips.test", roles: ["SUPERADMIN"] } as any);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await col("approvalrequests").deleteMany({});
  sent.length = 0;
});

describe("Flow 3 (APPROVAL_DIRECT) requires approver approval", () => {
  it("a requester's submission goes pending to the approver with the Approval Needed email", async () => {
    const { r, doc } = await submit(REQUESTER, WS_DIRECT);
    expect(r.status).toBe(200);
    expect([doc.status, doc.stage, doc.adminState ?? null]).toEqual(["pending", "REQUEST_RAISED", null]);
    expect(doc.managerEmail).toBe(APPROVER);
    expect(doc.meta.travelFlow).toBe("APPROVAL_DIRECT");
    expect(doc.meta.autoApproved).toBeUndefined();
    expect(sent.find((m) => m.to === APPROVER)?.subject).toMatch(/^Approval Needed — /);

    const inbox = await as(request(app).get("/api/approvals/requests/inbox"), { email: APPROVER }, WS_DIRECT);
    expect(inbox.body.rows.map((x: any) => String(x._id))).toEqual([String(doc._id)]);
  });

  it("approval sends it straight to the ops queue with no proposal step, and tells the requester", async () => {
    const { doc } = await submit(REQUESTER, WS_DIRECT);
    sent.length = 0;
    const a = await act(doc._id, { email: APPROVER }, WS_DIRECT, "approved");
    expect(a.status).toBe(200);

    const after: any = await col("approvalrequests").findOne({ _id: doc._id });
    expect([after.status, after.stage, after.adminState]).toEqual(["approved", "REQUEST_APPROVED", "pending"]);
    expect(after.approvedByEmail).toBe(APPROVER);
    expect(sent.some((m) => m.to === REQUESTER.email && /^Approved — moved to Admin Queue/.test(m.subject))).toBe(true);

    const queue = await as(request(app).get("/api/approvals/admin/pending"), { email: "ops@plumtrips.test", roles: ["SUPERADMIN"] }, WS_DIRECT);
    expect(queue.status).toBe(200);
    const row = queue.body.rows.find((x: any) => String(x._id) === String(doc._id));
    expect(row?.meta?.travelFlow).toBe("APPROVAL_DIRECT");

    const draft = await as(request(app).post(`/api/proposals/by-request/${String(doc._id)}/draft`), { email: "ops@plumtrips.test", roles: ["OPS"] }, WS_DIRECT);
    expect([draft.status, draft.body.error]).toEqual([403, "This flow is not enabled for your workspace"]);
  });

  it("approval by email link (no login) also lands on REQUEST_APPROVED", async () => {
    const { doc } = await submit(REQUESTER, WS_DIRECT);
    const c = await request(app).post(`/api/public/approval-links/${requestLink(doc._id, APPROVER)}`).send({ action: "approve" });
    expect(c.status).toBe(200);
    const after: any = await col("approvalrequests").findOne({ _id: doc._id });
    expect([after.status, after.stage, after.adminState]).toEqual(["approved", "REQUEST_APPROVED", "pending"]);
  });

  it("decline closes it and notifies the requester", async () => {
    const { doc } = await submit(REQUESTER, WS_DIRECT);
    sent.length = 0;
    const d = await act(doc._id, { email: APPROVER }, WS_DIRECT, "declined", "Not this quarter");
    expect(d.status).toBe(200);
    const after: any = await col("approvalrequests").findOne({ _id: doc._id });
    expect([after.status, after.stage, after.adminState]).toEqual(["declined", "REQUEST_DECLINED", "cancelled"]);
    expect(after.history.at(-1).comment).toBe("Not this quarter");
    expect(sent.some((m) => m.to === REQUESTER.email && /Declined/.test(m.subject))).toBe(true);
  });

  it("the approver's own request is routed to the Workspace Leader", async () => {
    const { r, doc } = await submit({ email: APPROVER }, WS_DIRECT);
    expect(r.status).toBe(200);
    expect([doc.status, doc.stage, doc.managerEmail]).toEqual(["pending", "REQUEST_RAISED", LEADER]);
    expect(doc.meta.routedToLeaderReason).toBe("REQUESTER_IS_APPROVER");
    expect(sent.find((m) => m.to === LEADER)?.subject).toMatch(/^Approval Needed — /);

    // The approver can neither see it in their inbox nor act on it.
    const inbox = await as(request(app).get("/api/approvals/requests/inbox"), { email: APPROVER }, WS_DIRECT);
    expect(inbox.body.rows).toEqual([]);
    const self = await act(doc._id, { email: APPROVER }, WS_DIRECT, "approved");
    expect(self.status).toBe(403);

    const ok = await act(doc._id, { email: LEADER, roles: ["WORKSPACE_LEADER"] }, WS_DIRECT, "approved");
    expect(ok.status).toBe(200);
    const after: any = await col("approvalrequests").findOne({ _id: doc._id });
    expect([after.status, after.stage, after.approvedByEmail]).toEqual(["approved", "REQUEST_APPROVED", LEADER]);
  });

  it("the approver's own request is refused when there is no Workspace Leader above them", async () => {
    const { r } = await submit({ email: APPROVER }, WS_NO_LEADER);
    expect([r.status, r.body.code]).toEqual([400, "NO_APPROVER_ABOVE_REQUESTER"]);
    expect(await col("approvalrequests").countDocuments({})).toBe(0);
  });

  it("a Workspace Leader's request is auto-approved straight into the ops queue", async () => {
    const { r, doc } = await submit({ email: LEADER, roles: ["WORKSPACE_LEADER"] }, WS_DIRECT);
    expect(r.status).toBe(200);
    expect([doc.status, doc.stage, doc.adminState]).toEqual(["approved", "REQUEST_APPROVED", "pending"]);
    expect(doc.meta.selfApproved).toBe(true);
    expect(sent.some((m) => /^Approval Needed/.test(m.subject))).toBe(false);
  });
});

describe("Flow 2 (APPROVAL_FLOW) — same self-approval rule, otherwise unchanged", () => {
  it("a requester's submission goes pending; approval moves it to PROPOSAL_PENDING", async () => {
    const { doc } = await submit(REQUESTER, WS_FLOW);
    expect([doc.status, doc.stage, doc.managerEmail]).toEqual(["pending", "REQUEST_RAISED", APPROVER]);
    const a = await act(doc._id, { email: APPROVER }, WS_FLOW, "approved");
    expect(a.status).toBe(200);
    const after: any = await col("approvalrequests").findOne({ _id: doc._id });
    expect([after.status, after.stage, after.adminState]).toEqual(["approved", "PROPOSAL_PENDING", "pending"]);
  });

  it("on hold, then decline with a reason", async () => {
    const { doc } = await submit(REQUESTER, WS_FLOW);
    expect((await act(doc._id, { email: APPROVER }, WS_FLOW, "on_hold", "Which hotel?")).status).toBe(200);
    let after: any = await col("approvalrequests").findOne({ _id: doc._id });
    expect([after.status, after.stage]).toEqual(["pending", "REQUEST_ON_HOLD"]);
    // A decline needs a reason.
    const bare = await act(doc._id, { email: APPROVER }, WS_FLOW, "declined");
    expect([bare.status, bare.body.code]).toEqual([400, "REASON_REQUIRED"]);
    expect((await act(doc._id, { email: APPROVER }, WS_FLOW, "declined", "Over budget")).status).toBe(200);
    after = await col("approvalrequests").findOne({ _id: doc._id });
    expect([after.status, after.stage]).toEqual(["declined", "REQUEST_DECLINED"]);
  });

  it("the approver's own request is routed to the Workspace Leader, not self-approved", async () => {
    const { doc } = await submit({ email: APPROVER }, WS_FLOW);
    expect([doc.status, doc.stage, doc.managerEmail]).toEqual(["pending", "REQUEST_RAISED", LEADER]);
    expect(doc.meta.selfApproved).toBeUndefined();
  });

  it("a Workspace Leader's request is auto-approved to PROPOSAL_PENDING", async () => {
    const { doc } = await submit({ email: LEADER, roles: ["WORKSPACE_LEADER"] }, WS_FLOW);
    expect([doc.status, doc.stage, doc.adminState]).toEqual(["approved", "PROPOSAL_PENDING", "pending"]);
    expect(doc.meta.selfApproved).toBe(true);
  });

  it("a Workspace Leader cannot act on a pending request they raised themselves", async () => {
    // Legacy shape: a WL's request left pending (e.g. raised before this rule).
    const { doc } = await submit(REQUESTER, WS_FLOW);
    await col("approvalrequests").updateOne({ _id: doc._id }, { $set: { frontlinerEmail: LEADER } });
    const self = await act(doc._id, { email: LEADER, roles: ["WORKSPACE_LEADER"] }, WS_FLOW, "approved");
    expect([self.status, self.body.code]).toEqual([403, "SELF_APPROVAL_NOT_ALLOWED"]);
    const inbox = await as(request(app).get("/api/approvals/requests/inbox"), { email: LEADER, roles: ["WORKSPACE_LEADER"] }, WS_FLOW);
    expect(inbox.body.rows).toEqual([]);
  });

  it("an email link cannot be used to approve one's own request", async () => {
    const { doc } = await submit(REQUESTER, WS_FLOW);
    await col("approvalrequests").updateOne({ _id: doc._id }, { $set: { managerEmail: REQUESTER.email } });
    const c = await request(app).post(`/api/public/approval-links/${requestLink(doc._id, REQUESTER.email)}`).send({ action: "approve" });
    expect([c.status, c.body.code]).toEqual([403, "SELF_APPROVAL_NOT_ALLOWED"]);
    const after: any = await col("approvalrequests").findOne({ _id: doc._id });
    expect(after.status).toBe("pending");
  });
});
