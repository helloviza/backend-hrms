// apps/backend/src/routes/approvals.queueAccess.test.ts
//
// Ops queue + Travel Desk access = the Access Console "Admin Queue" grant
// (UserPermission.modules.adminQueue), not roles:
//   - a HOUSE user with only the grant (role EMPLOYEE) is a Travel Desk agent
//     and can open the queue, assign, book, draft/submit a proposal and reveal
//     a passport
//   - an ADMIN without the grant is not an agent but still views the queue
//   - a customer user with any role is refused
//   - READ views only; a suspended or revoked grant, or a deactivated user,
//     drops out of the picker; their open cases are flagged for reassignment
//     and settings show them without queue access; auto-allocation never picks
//     them
//
// Real: approvals + proposals routers, Travel Desk, holdsCapability,
// UserPermission, in-memory Mongo. Stubbed: requireAuth (user from a header),
// requireWorkspace (workspace from a header), mail, email tokens, TBO.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";

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
vi.mock("../utils/mailer.js", () => ({ sendMail: async () => ({ messageId: "test" }) }));
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
const { default: proposalsRouter } = await import("./proposals.js");
const { autoAllocate } = await import("../services/travelDesk.js");

const app = express();
app.use(express.json());
app.use("/api/approvals", approvalsRouter);
app.use("/api/proposals", proposalsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const WS = oid(); // a Flow 2 customer
const CUSTOMER_ID = oid();
const APPROVER = "approver@cust.test";

type Who = { sub: string; email: string; name: string; roles: string[]; ws: any };
const person = (name: string, roles: string[], ws: any = HOUSE): Who => ({ sub: String(oid()), email: `${name.toLowerCase()}@x.test`, name, roles, ws });
const AGENT = person("Agent", ["EMPLOYEE"]); // only the grant (WRITE)
const VIEWER = person("Viewer", ["EMPLOYEE"]); // grant at READ only
const ADMIN_NO_GRANT = person("Admin", ["ADMIN"]); // oversight, not an agent
const SECOND = person("Second", ["EMPLOYEE"]); // another WRITE agent
const PLAIN = person("Plain", ["EMPLOYEE"]); // HOUSE, no grant
const TENANT_ADMIN = person("Tenant", ["ADMIN"], WS); // customer workspace, ADMIN role
const LEADER = person("Leader", ["WORKSPACE_LEADER"], WS);
const REQUESTER = person("Requester", ["EMPLOYEE"], WS);
const APPROVER_USER: Who = { ...person("Approver", ["EMPLOYEE"], WS), email: APPROVER };

const as = (r: request.Test, who: Who) =>
  r.set("x-test-user", JSON.stringify({ sub: who.sub, email: who.email, name: who.name, roles: who.roles })).set("x-test-ws", String(who.ws));

const grant = (who: Who, access: string, status = "active") =>
  col("userpermissions").insertOne({
    userId: who.sub, email: who.email, workspaceId: String(HOUSE), universe: "STAFF", status, source: "manual",
    level: { code: "L1", name: "Employee", designation: "" }, modules: { adminQueue: { access, scope: "ALL" } },
  } as any);

async function approvedRequest(travellers: any[] = [{ kind: "manual", firstName: "Asha", lastName: "Guest" }]) {
  const created = await as(request(app).post("/api/approvals/requests"), REQUESTER).send({
    customerId: String(CUSTOMER_ID),
    cartItems: [{ type: "flight", title: "BLR → DEL", qty: 1, price: 0, meta: { origin: "BLR", destination: "DEL", tripType: "oneway", departDate: "2027-04-02", travelScope: "domestic", travellers } }],
  });
  expect(created.status).toBe(200);
  const id = String(created.body.request._id);
  expect((await as(request(app).put(`/api/approvals/requests/${id}/action`), APPROVER_USER).send({ action: "approved" })).status).toBe(200);
  return id;
}
const candidates = async () => (await as(request(app).get("/api/approvals/travel-desk/settings"), ADMIN_NO_GRANT)).body.candidates.map((c: any) => c.email);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-queue-access-test"));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertMany([
    { _id: HOUSE, customerId: "PLUMTRIPS-HOUSE", name: "Plumtrips", status: "ACTIVE", config: { features: {} } },
    { _id: WS, customerId: String(CUSTOMER_ID), name: "Acme", companyName: "Acme", status: "ACTIVE", tenantType: "CORPORATE", defaultApproverEmails: [APPROVER], config: { travelFlow: "APPROVAL_FLOW", features: { approvalFlowEnabled: true } } },
  ] as any[]);
  await col("customermembers").insertOne({ customerId: String(CUSTOMER_ID), email: LEADER.email, role: "WORKSPACE_LEADER", isActive: true } as any);
  await col("users").insertMany(
    [AGENT, VIEWER, ADMIN_NO_GRANT, SECOND, PLAIN].map((u) => ({ _id: new mongoose.Types.ObjectId(u.sub), workspaceId: HOUSE, email: u.email, name: u.name, roles: u.roles, status: "ACTIVE", passwordHash: "x" })) as any[],
  );
  await grant(AGENT, "WRITE");
  await grant(SECOND, "FULL");
  await grant(VIEWER, "READ");
});

describe("the grant, not the role", () => {
  it("queue-access: grant WRITE → view+work; READ → view; HOUSE ADMIN → oversight; no grant / customer (any role) → nothing", async () => {
    const qa = async (who: Who) => (await as(request(app).get("/api/approvals/queue-access"), who)).body;
    expect(await qa(AGENT)).toMatchObject({ view: true, work: true, via: "permission" });
    expect(await qa(VIEWER)).toMatchObject({ view: true, work: false, via: "permission" });
    expect(await qa(ADMIN_NO_GRANT)).toMatchObject({ view: true, work: true, via: "admin-role" });
    for (const who of [PLAIN, TENANT_ADMIN, LEADER, REQUESTER]) expect(await qa(who), who.name).toMatchObject({ view: false, work: false });
  });

  it("a HOUSE user with only the grant (EMPLOYEE) is in the picker and can open the queue, assign, book, propose and reveal", async () => {
    expect(await candidates()).toEqual(expect.arrayContaining([AGENT.email]));
    await as(request(app).put("/api/approvals/travel-desk/settings"), ADMIN_NO_GRANT).send({ mode: "off", agents: [{ userId: AGENT.sub }] });

    // Book path (Flow 2: approve → proposal) and the queue itself.
    const id = await approvedRequest([{ kind: "manual", firstName: "Asha", lastName: "Guest", passportNumber: "K1234567", nationality: "Indian", passportExpiry: "2030-01-01" }]);
    const queue = await as(request(app).get("/api/approvals/admin/approved"), AGENT);
    expect(queue.status).toBe(200);
    expect(queue.body.rows.map((r: any) => String(r._id))).toContain(id);

    expect((await as(request(app).put(`/api/approvals/admin/${id}/assign`), AGENT).send({ agentUserId: AGENT.sub })).status).toBe(200);
    const reveal = await as(request(app).post(`/api/approvals/admin/requests/${id}/passport-reveal`), AGENT).send({ itemIndex: 0, travellerIndex: 0 });
    expect([reveal.status, reveal.body.passportNumber]).toEqual([200, "K1234567"]);

    const d = await as(request(app).post(`/api/proposals/by-request/${id}/draft`), AGENT).send({});
    expect(d.status).toBe(200);
    const pid = String(d.body.proposal._id);
    const option = { optionNo: 1, title: "6E-201", currency: "INR", totalAmount: 0, attachments: [], lineItems: [{ itemIndex: 1, category: "flight", title: "6E-201", qty: 1, unitPrice: 5000, totalPrice: 5000, currency: "INR" }] };
    expect((await as(request(app).put(`/api/proposals/${pid}`), AGENT).send({ options: [option] })).status).toBe(200);
    expect((await as(request(app).post(`/api/proposals/${pid}/submit`), AGENT).send({})).status).toBe(200);

    expect((await as(request(app).put(`/api/approvals/admin/${id}/start-booking`), AGENT).send({})).status).toBe(200);
    expect((await col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(id) }))!.stage).toBe("BOOKING_IN_PROGRESS");
  });

  it("an ADMIN without the grant is not in the picker but still views the queue; READ-only views but cannot act", async () => {
    const list = await candidates();
    expect(list).not.toContain(ADMIN_NO_GRANT.email);
    expect(list).not.toContain(VIEWER.email); // READ is not enough to be an agent
    expect(list).not.toContain(PLAIN.email);
    expect((await as(request(app).get("/api/approvals/admin/approved"), ADMIN_NO_GRANT)).status).toBe(200);

    const id = await approvedRequest();
    expect((await as(request(app).get("/api/approvals/admin/approved"), VIEWER)).status).toBe(200);
    expect((await as(request(app).put(`/api/approvals/admin/${id}/start-booking`), VIEWER).send({})).status).toBe(403);
    expect((await as(request(app).post(`/api/proposals/by-request/${id}/draft`), VIEWER).send({})).status).toBe(403);
    expect((await as(request(app).get(`/api/proposals/by-request/${id}`), VIEWER)).status).toBe(200);
  });

  it("customer users with any role are refused every queue action, even a customer ADMIN", async () => {
    const id = await approvedRequest();
    for (const who of [TENANT_ADMIN, LEADER, REQUESTER, PLAIN]) {
      expect((await as(request(app).put(`/api/approvals/admin/${id}/assign`), who).send({ agentUserId: AGENT.sub })).status, who.name).toBe(403);
      expect((await as(request(app).put(`/api/approvals/admin/${id}/start-booking`), who).send({})).status, who.name).toBe(403);
      expect((await as(request(app).post(`/api/approvals/admin/requests/${id}/passport-reveal`), who).send({ itemIndex: 0, travellerIndex: 0 })).status, who.name).toBe(403);
      expect((await as(request(app).post(`/api/proposals/by-request/${id}/draft`), who).send({})).status, who.name).toBe(403);
      expect((await as(request(app).get("/api/approvals/travel-desk/agents"), who)).status, who.name).toBe(403);
    }
    // Workspace Leaders keep their own (pre-existing) read of the queue, scoped to their customer.
    expect((await as(request(app).get("/api/approvals/admin/approved"), PLAIN)).status).toBe(403);
  });
});

describe("revocation", () => {
  it("revoking the grant drops the agent from the picker, flags their open cases and shows 'no queue access' in settings", async () => {
    await as(request(app).put("/api/approvals/travel-desk/settings"), ADMIN_NO_GRANT).send({ mode: "off", agents: [{ userId: AGENT.sub }, { userId: SECOND.sub }] });
    const id = await approvedRequest();
    expect((await as(request(app).put(`/api/approvals/admin/${id}/assign`), ADMIN_NO_GRANT).send({ agentUserId: AGENT.sub })).status).toBe(200);

    let rows = (await as(request(app).get("/api/approvals/admin/approved"), ADMIN_NO_GRANT)).body.rows;
    expect(rows.find((r: any) => String(r._id) === id).needsReassignment).toBeUndefined();

    await col("userpermissions").deleteOne({ userId: AGENT.sub }); // Access Console revoke deletes the grant

    expect(await candidates()).not.toContain(AGENT.email);
    rows = (await as(request(app).get("/api/approvals/admin/approved"), ADMIN_NO_GRANT)).body.rows;
    expect(rows.find((r: any) => String(r._id) === id).needsReassignment).toBe(true);
    const team = (await as(request(app).get("/api/approvals/travel-desk/settings"), ADMIN_NO_GRANT)).body.agents;
    expect(team.find((a: any) => a.userId === AGENT.sub)).toMatchObject({ eligible: false });
    // And they can no longer use the queue themselves.
    expect((await as(request(app).get("/api/approvals/admin/approved"), AGENT)).status).toBe(403);
    expect((await as(request(app).put(`/api/approvals/admin/${id}/assign`), ADMIN_NO_GRANT).send({ agentUserId: AGENT.sub })).body.code).toBe("NOT_TEAM_AGENT");
  });

  it("a suspended grant or a deactivated user is out too", async () => {
    await col("userpermissions").updateOne({ userId: SECOND.sub }, { $set: { status: "suspended" } });
    expect(await candidates()).not.toContain(SECOND.email);
    expect((await as(request(app).get("/api/approvals/queue-access"), SECOND)).body.view).toBe(false);

    await col("users").updateOne({ _id: new mongoose.Types.ObjectId(AGENT.sub) }, { $set: { status: "INACTIVE" } });
    expect(await candidates()).not.toContain(AGENT.email);
  });

  it("auto-allocation never picks someone without the grant", async () => {
    await as(request(app).put("/api/approvals/travel-desk/settings"), ADMIN_NO_GRANT).send({ mode: "round_robin", rmFirst: false, agents: [{ userId: AGENT.sub }, { userId: SECOND.sub }] });
    await col("userpermissions").deleteOne({ userId: AGENT.sub });
    for (let i = 0; i < 3; i++) {
      const id = await approvedRequest();
      expect((await col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(id) }) as any).meta.adminAssigned.userId).toBe(SECOND.sub);
    }
    await col("userpermissions").deleteOne({ userId: SECOND.sub });
    const id = await approvedRequest();
    const doc: any = await col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect([doc.meta.adminAssigned, doc.meta.assignmentFlag?.code]).toEqual([undefined, "NO_AGENT_AVAILABLE"]);
    expect(await autoAllocate(id)).toEqual({ flagged: true });
  });
});
