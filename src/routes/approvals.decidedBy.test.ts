// apps/backend/src/routes/approvals.decidedBy.test.ts
//
// "Decided by" names the person who clicked (audit company-vs-person-name
// §0.7). The access JWT carries no name, so req.user.name is "" in prod; the
// request decision used to fall back to the approver ON FILE (managerName), so
// a Workspace Leader approving someone else's request was recorded and emailed
// as the assigned approver. Every token here carries no name, like prod.
//
// Fails on origin/main: approvedByName / history / email name the assigned
// approver (request), or the leader's email (proposal), or "" (ops history).
//
// Real: approvals + proposals routers, decision service, email templates,
// models. Stubbed: requireAuth (user from a header, no name), requireWorkspace,
// mail (recorded), TBO.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";

const sent: Array<{ to: string; subject: string; html: string }> = [];

vi.mock("../middleware/auth.js", () => {
  // Like the real access token: sub, email, roles — never a name.
  const requireAuth = async (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    const { default: mg } = await import("mongoose");
    const users = mg.connection.db!.collection("users");
    const same: any = await users.findOne({ email: String(req.user.email || "").toLowerCase() });
    if (same) req.user.sub = String(same._id);
    else await users.insertOne({ _id: new mg.Types.ObjectId(String(req.user.sub)), email: req.user.email, roles: req.user.roles || [] } as any);
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: async (req: any, res: any, next: any) => {
    const { default: mg } = await import("mongoose");
    const ws = await mg.connection.db!.collection("customerworkspaces").findOne({ _id: new mg.Types.ObjectId(String(req.headers["x-test-ws"] || "")) });
    if (!ws) return res.status(403).json({ error: "no workspace" });
    req.workspace = ws;
    req.workspaceObjectId = ws._id;
    req.workspaceId = String(ws._id);
    next();
  },
}));
vi.mock("../utils/mailer.js", () => ({
  sendMail: async (m: any) => {
    sent.push({ to: String(m.to), subject: String(m.subject), html: String(m.html || "") });
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
const { applyRequestDecision } = await import("../services/approvalDecisions.js");
const { actorName } = await import("../services/actorNames.js");

const app = express();
app.use(express.json());
app.use("/api/proposals", proposalsRouter);
app.use("/api/approvals", approvalsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const WS = oid();
const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const CUSTOMER_ID = "F1";
const APPROVER = "approver@cust.test";
const LEADER = "leader@cust.test";
const REQUESTER = "requestor@cust.test";
const OPS_ID = oid();

type Who = { email: string; roles?: string[]; ws?: any };
const R: Who = { email: REQUESTER };
const L: Who = { email: LEADER, roles: ["WORKSPACE_LEADER"] };
const OPS: Who = { email: "ops@plumtrips.test", roles: ["EMPLOYEE"], ws: HOUSE };

const as = (r: request.Test, who: Who) =>
  r
    .set("x-test-user", JSON.stringify({ sub: String(oid()), email: who.email, roles: who.roles || ["EMPLOYEE"] }))
    .set("x-test-ws", String(who.ws || WS));

const reqDoc = async (id: any): Promise<any> => col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(String(id)) });

async function submitRequest() {
  const r = await as(request(app).post("/api/approvals/requests"), R).send({
    customerId: CUSTOMER_ID,
    cartItems: [{ type: "flight", title: "BLR → BOM", qty: 1, price: 0, meta: { origin: "BLR", destination: "BOM", departDate: "2027-03-12", travellers: [{ kind: "manual", firstName: "Asha", lastName: "Rao" }] } }],
  });
  expect(r.status).toBe(200);
  return String(r.body.request._id);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-decided-by-test"));
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  sent.length = 0;
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertMany([
    {
      _id: WS, customerId: CUSTOMER_ID, name: "WS F1", status: "ACTIVE", tenantType: "CORPORATE",
      defaultApproverEmails: [APPROVER],
      config: { travelFlow: "APPROVAL_FLOW", tokenExpiryHours: 12, features: { approvalFlowEnabled: true } },
    },
    { _id: HOUSE, customerId: "PLUMTRIPS-HOUSE", name: "Plumtrips", status: "ACTIVE", config: { features: {} } },
  ] as any[]);
  await col("customermembers").insertOne({ customerId: CUSTOMER_ID, email: LEADER, role: "WORKSPACE_LEADER", isActive: true } as any);
  await col("users").insertMany([
    { email: APPROVER, firstName: "Anil", lastName: "Approver", roles: ["CUSTOMER"] },
    { email: LEADER, firstName: "Lata", lastName: "Leader", roles: ["CUSTOMER"] },
    { email: REQUESTER, firstName: "Ravi", lastName: "Requester", roles: ["CUSTOMER"] },
    { _id: OPS_ID, email: OPS.email, firstName: "Omar", lastName: "Ops", roles: ["EMPLOYEE"] },
  ] as any[]);
  await col("userpermissions").insertOne({
    userId: String(OPS_ID), email: OPS.email, workspaceId: String(HOUSE), universe: "STAFF", status: "active", source: "manual",
    level: { code: "L1", name: "Employee", designation: "" }, modules: { adminQueue: { access: "WRITE", scope: "ALL" } },
  } as any);
});

describe("decided by = the person who clicked", () => {
  it("a Workspace Leader approves a request assigned to someone else: stored, history and emails name the leader", async () => {
    const rid = await submitRequest();
    expect((await reqDoc(rid)).managerName).toBe("Anil Approver");
    sent.length = 0;

    const a = await as(request(app).put(`/api/approvals/requests/${rid}/action`), L).send({ action: "approved" });
    expect(a.status).toBe(200);

    const doc = await reqDoc(rid);
    expect([doc.approvedByEmail, doc.approvedByName]).toEqual([LEADER, "Lata Leader"]);
    const row = doc.history.find((h: any) => h.action === "approved");
    expect([row.userEmail, row.userName]).toEqual([LEADER, "Lata Leader"]);

    const toRequester = sent.find((m) => m.to === REQUESTER && /approved/i.test(m.subject))!;
    expect(toRequester).toBeTruthy();
    expect(toRequester.html).toContain("Lata Leader");
    expect(toRequester.html).not.toContain("Anil Approver");
  });

  it("a decline by the leader is recorded and emailed as the leader too", async () => {
    const rid = await submitRequest();
    sent.length = 0;
    const d = await as(request(app).put(`/api/approvals/requests/${rid}/action`), L).send({ action: "declined", comment: "Not this quarter" });
    expect(d.status).toBe(200);
    expect((await reqDoc(rid)).approvedByName).toBe("Lata Leader");
    const toRequester = sent.find((m) => m.to === REQUESTER && /declined|rejected/i.test(m.subject))!;
    expect(toRequester.html).toContain("Lata Leader");
    expect(toRequester.html).not.toContain("Anil Approver");
  });

  it("a proposal approved in-app by the second approver stores their name, not their email", async () => {
    const rid = await submitRequest();
    await as(request(app).put(`/api/approvals/requests/${rid}/action`), { email: APPROVER }).send({ action: "approved" });
    const draft = await as(request(app).post(`/api/proposals/by-request/${rid}/draft`), OPS).send({});
    expect(draft.status).toBe(200);
    const pid = String(draft.body.proposal._id);
    const option = {
      optionNo: 1, title: "IndiGo 6E-201", currency: "INR", totalAmount: 0, attachments: [],
      lineItems: [{ itemIndex: 1, category: "flight", title: "BLR → BOM", qty: 1, unitPrice: 5000, totalPrice: 5000, currency: "INR" }],
    };
    expect((await as(request(app).put(`/api/proposals/${pid}`), OPS).send({ options: [option] })).status).toBe(200);
    expect((await as(request(app).post(`/api/proposals/${pid}/submit`), OPS).send({})).status).toBe(200);

    const ok = await as(request(app).post(`/api/proposals/${pid}/decide`), L).send({ decision: "APPROVED" });
    expect(ok.status).toBe(200);
    const p: any = await col("proposals").findOne({ _id: new mongoose.Types.ObjectId(pid) });
    expect([p.approvals.l2.byEmail, p.approvals.l2.byName]).toEqual([LEADER, "Lata Leader"]);
  });

  it("an ops action's history row names the ops user (userName and actorName)", async () => {
    const rid = await submitRequest();
    await as(request(app).put(`/api/approvals/requests/${rid}/action`), L).send({ action: "approved" });
    const h = await as(request(app).put(`/api/approvals/admin/${rid}/on-hold`), OPS).send({ comment: "Waiting on fares" });
    expect(h.status).toBe(200);
    const row = (await reqDoc(rid)).history.find((r: any) => r.action === "admin_on_hold");
    expect([row.userName, row.actorName]).toEqual(["Omar Ops", "Omar Ops"]);
  });

  it("the service, called with no name, never falls back to the approver on file", async () => {
    const rid = await submitRequest();
    // A leader with no name anywhere: their email, not "Anil Approver".
    await col("users").updateOne({ email: LEADER }, { $unset: { firstName: "", lastName: "" } });
    await applyRequestDecision({ requestId: rid, actor: { email: LEADER, via: "app" }, action: "approved" });
    expect((await reqDoc(rid)).approvedByName).toBe(LEADER);
  });
});

describe("actorName", () => {
  it("reads the User record by id, else email; '' when nobody can be named", async () => {
    const leader: any = await col("users").findOne({ email: LEADER });
    expect(await actorName({ sub: String(leader._id), email: "" })).toBe("Lata Leader");
    expect(await actorName({ email: LEADER.toUpperCase() })).toBe("Lata Leader");
    expect(await actorName({ name: "Given Name", sub: String(leader._id) })).toBe("Given Name");
    expect(await actorName({ sub: String(oid()), email: "nobody@x.test" })).toBe("");
  });
});
