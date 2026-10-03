// apps/backend/src/routes/approvals.queueScope.test.ts
//
// Admin Queue grant SCOPE (UserPermission.modules.adminQueue.scope):
//   - OWN: the queue lists only cases assigned to the caller; every per-case
//     route (detail, fare snapshot, passport reveal + audit, assign / unassign,
//     start booking, under process, done, hold, cancel, attachment, proposal
//     queue / by-request / draft / edit / submit / record-decision / booking
//     start-done-cancel / read) refuses anyone else's case or an unassigned
//     one, and works on their own
//   - TEAM / WORKSPACE / ALL and HOUSE ADMIN oversight: every case
//   - reassigning a case away removes it from the OWN agent's queue at once
//   - queue-access reports the scope; a grant added later is live on the next
//     call (no re-login)
//
// Real: approvals + proposals routers, Travel Desk, readCapability,
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
const OWN = person("Chirag", ["EMPLOYEE"]); // Admin Queue FULL, scope OWN
const ALL = person("Second", ["EMPLOYEE"]); // Admin Queue FULL, scope ALL
const TEAM = person("Teamer", ["EMPLOYEE"]); // Admin Queue WRITE, scope TEAM
const ADMIN = person("Admin", ["ADMIN"]); // HOUSE ADMIN oversight, no grant
const LATE = person("Late", ["EMPLOYEE"]); // granted mid-session
const REQUESTER = person("Requester", ["EMPLOYEE"], WS);
const APPROVER_USER: Who = { ...person("Approver", ["EMPLOYEE"], WS), email: APPROVER };

const as = (r: request.Test, who: Who) =>
  r.set("x-test-user", JSON.stringify({ sub: who.sub, email: who.email, name: who.name, roles: who.roles })).set("x-test-ws", String(who.ws));

const grant = (who: Who, access: string, scope: string) =>
  col("userpermissions").insertOne({
    userId: who.sub, email: who.email, workspaceId: String(HOUSE), universe: "STAFF", status: "active", source: "manual",
    level: { code: "L1", name: "Employee", designation: "" }, modules: { adminQueue: { access, scope } },
  } as any);

async function approvedRequest() {
  const created = await as(request(app).post("/api/approvals/requests"), REQUESTER).send({
    customerId: String(CUSTOMER_ID),
    cartItems: [{ type: "flight", title: "BLR → DEL", qty: 1, price: 0, meta: { origin: "BLR", destination: "DEL", tripType: "oneway", departDate: "2026-11-02", travelScope: "domestic", travellers: [{ kind: "manual", firstName: "Asha", lastName: "Guest", passportNumber: "K1234567", nationality: "Indian", passportExpiry: "2030-01-01" }] } }],
  });
  expect(created.status).toBe(200);
  const id = String(created.body.request._id);
  expect((await as(request(app).put(`/api/approvals/requests/${id}/action`), APPROVER_USER).send({ action: "approved" })).status).toBe(200);
  return id;
}
const assign = async (id: string, to: Who) =>
  expect((await as(request(app).put(`/api/approvals/admin/${id}/assign`), ADMIN).send({ agentUserId: to.sub })).status).toBe(200);
const queueIds = async (who: Who, qs = "") => {
  const r = await as(request(app).get(`/api/approvals/admin/approved${qs}`), who);
  expect(r.status).toBe(200);
  return r.body.rows.map((x: any) => String(x._id));
};
const option = { optionNo: 1, title: "6E-201", currency: "INR", totalAmount: 0, attachments: [], lineItems: [{ itemIndex: 1, category: "flight", title: "6E-201", qty: 1, unitPrice: 5000, totalPrice: 5000, currency: "INR" }] };
async function submittedProposal(requestId: string, by: Who) {
  const d = await as(request(app).post(`/api/proposals/by-request/${requestId}/draft`), by).send({});
  expect(d.status).toBe(200);
  const pid = String(d.body.proposal._id);
  expect((await as(request(app).put(`/api/proposals/${pid}`), by).send({ options: [option] })).status).toBe(200);
  expect((await as(request(app).post(`/api/proposals/${pid}/submit`), by).send({})).status).toBe(200);
  return pid;
}

/** Every per-case staff route, as [label, call]. */
function caseRoutes(id: string, pid: string): Array<[string, (who: Who) => request.Test]> {
  return [
    ["GET /requests/:id", (w) => as(request(app).get(`/api/approvals/requests/${id}`), w)],
    ["GET /admin/requests/:id", (w) => as(request(app).get(`/api/approvals/admin/requests/${id}`), w)],
    ["GET selection-snapshot", (w) => as(request(app).get(`/api/approvals/admin/requests/${id}/selection-snapshot`), w)],
    ["POST passport-reveal", (w) => as(request(app).post(`/api/approvals/admin/requests/${id}/passport-reveal`), w).send({ itemIndex: 0, travellerIndex: 0 })],
    ["GET passport-reveals", (w) => as(request(app).get(`/api/approvals/admin/requests/${id}/passport-reveals`), w)],
    ["PUT assign", (w) => as(request(app).put(`/api/approvals/admin/${id}/assign`), w).send({ agentUserId: OWN.sub })],
    ["PUT unassign", (w) => as(request(app).put(`/api/approvals/admin/${id}/unassign`), w).send({})],
    ["PUT start-booking", (w) => as(request(app).put(`/api/approvals/admin/${id}/start-booking`), w).send({})],
    ["PUT under-process", (w) => as(request(app).put(`/api/approvals/admin/${id}/under-process`), w).send({})],
    ["PUT done", (w) => as(request(app).put(`/api/approvals/admin/${id}/done`), w).send({})],
    ["PUT on-hold", (w) => as(request(app).put(`/api/approvals/admin/${id}/on-hold`), w).send({})],
    ["PUT cancel", (w) => as(request(app).put(`/api/approvals/admin/${id}/cancel`), w).send({})],
    ["POST attachment", (w) => as(request(app).post(`/api/approvals/admin/${id}/attachment`), w).attach("file", Buffer.from("%PDF-1.4 x"), { filename: "t.pdf", contentType: "application/pdf" })],
    ["GET proposals/by-request", (w) => as(request(app).get(`/api/proposals/by-request/${id}`), w)],
    ["POST proposals draft", (w) => as(request(app).post(`/api/proposals/by-request/${id}/draft`), w).send({})],
    ["GET proposals/:id", (w) => as(request(app).get(`/api/proposals/${pid}`), w)],
    ["PUT proposals/:id", (w) => as(request(app).put(`/api/proposals/${pid}`), w).send({ options: [option] })],
    ["POST proposals submit", (w) => as(request(app).post(`/api/proposals/${pid}/submit`), w).send({})],
    ["POST record-decision", (w) => as(request(app).post(`/api/proposals/${pid}/record-decision`), w).send({ decision: "APPROVED", note: "phone" })],
    ["POST booking/start", (w) => as(request(app).post(`/api/proposals/${pid}/booking/start`), w).send({})],
    ["POST booking/done", (w) => as(request(app).post(`/api/proposals/${pid}/booking/done`), w).send({})],
    ["POST booking/cancel", (w) => as(request(app).post(`/api/proposals/${pid}/booking/cancel`), w).send({})],
  ];
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-queue-scope-test"));
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
  await col("users").insertMany(
    [OWN, ALL, TEAM, ADMIN, LATE].map((u) => ({ _id: new mongoose.Types.ObjectId(u.sub), workspaceId: HOUSE, email: u.email, name: u.name, roles: u.roles, status: "ACTIVE", passwordHash: "x" })) as any[],
  );
  await grant(OWN, "FULL", "OWN");
  await grant(ALL, "FULL", "ALL");
  await grant(TEAM, "WRITE", "TEAM");
  await as(request(app).put("/api/approvals/travel-desk/settings"), ADMIN).send({ mode: "off", agents: [{ userId: OWN.sub }, { userId: ALL.sub }] });
});

describe("queue-access reports the scope", () => {
  it("OWN grant → scope own; ALL / TEAM grants and HOUSE ADMIN → all", async () => {
    const qa = async (who: Who) => (await as(request(app).get("/api/approvals/queue-access"), who)).body;
    expect(await qa(OWN)).toMatchObject({ view: true, work: true, via: "permission", scope: "own" });
    expect(await qa(ALL)).toMatchObject({ view: true, work: true, scope: "all" });
    expect(await qa(TEAM)).toMatchObject({ view: true, work: true, scope: "all" });
    expect(await qa(ADMIN)).toMatchObject({ view: true, work: true, via: "admin-role", scope: "all" });
  });

  it("a grant added mid-session is live on the next call — no re-login", async () => {
    expect((await as(request(app).get("/api/approvals/queue-access"), LATE)).body.view).toBe(false);
    await grant(LATE, "READ", "OWN");
    expect((await as(request(app).get("/api/approvals/queue-access"), LATE)).body).toMatchObject({ view: true, work: false, scope: "own" });
  });
});

describe("OWN scope", () => {
  it("lists only the caller's cases — every list, filter and search; ALL / TEAM / ADMIN see everything", async () => {
    const mine = await approvedRequest();
    const theirs = await approvedRequest();
    const unassigned = await approvedRequest();
    await assign(mine, OWN);
    await assign(theirs, ALL);

    expect(await queueIds(OWN)).toEqual([mine]);
    expect(await queueIds(OWN, "?includeClosed=1")).toEqual([mine]);
    expect(await queueIds(OWN, "?adminState=assigned")).toEqual([mine]);
    expect(await queueIds(OWN, "?adminState=pending")).toEqual([]);
    const ticket = ((await col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(theirs) })) as any).ticketId;
    expect(await queueIds(OWN, `?q=${encodeURIComponent(ticket)}`)).toEqual([]); // search cannot reach past scope
    expect((await as(request(app).get("/api/approvals/admin/pending"), OWN)).body.rows).toEqual([]);

    for (const who of [ALL, TEAM, ADMIN]) {
      expect((await queueIds(who)).sort(), who.name).toEqual([mine, theirs, unassigned].sort());
    }
    expect((await as(request(app).get("/api/approvals/admin/pending"), ALL)).body.rows.map((r: any) => String(r._id))).toEqual([unassigned]);
  });

  it("refuses every per-case route on another agent's case and on an unassigned case", async () => {
    const theirs = await approvedRequest();
    const unassigned = await approvedRequest();
    await assign(theirs, ALL);
    const pTheirs = await submittedProposal(theirs, ALL);
    const pUnassigned = await submittedProposal(unassigned, ADMIN);

    for (const [id, pid] of [[theirs, pTheirs], [unassigned, pUnassigned]]) {
      for (const [label, call] of caseRoutes(id, pid)) {
        const r = await call(OWN);
        expect([403, 404], `${label} on ${id === theirs ? "another agent's" : "an unassigned"} case → ${r.status}`).toContain(r.status);
      }
    }
    // Nothing moved: still assigned to ALL / still unassigned, no reveal written.
    const t: any = await col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(theirs) });
    expect([t.meta.adminAssigned.userId, t.passportReveals ?? []]).toEqual([ALL.sub, []]);
    const u: any = await col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(unassigned) });
    expect([u.meta?.adminAssigned, u.adminState]).toEqual([undefined, "pending"]);

    // The proposals list holds only proposals on the caller's cases.
    const pq = await as(request(app).get("/api/proposals/queue"), OWN);
    expect([pq.status, pq.body.items]).toEqual([200, []]);
    const pqAll = await as(request(app).get("/api/proposals/queue"), ALL);
    expect(pqAll.body.items.map((p: any) => String(p._id)).sort()).toEqual([pTheirs, pUnassigned].sort());
  });

  it("works on the caller's own case end to end", async () => {
    const mine = await approvedRequest();
    await assign(mine, OWN);
    const ok = async (r: request.Test, label: string) => {
      const res = await r;
      expect(res.status, `${label}: ${JSON.stringify(res.body)}`).toBe(200);
      return res;
    };

    await ok(as(request(app).get(`/api/approvals/requests/${mine}`), OWN), "detail");
    await ok(as(request(app).get(`/api/approvals/admin/requests/${mine}`), OWN), "admin detail");
    await ok(as(request(app).get(`/api/approvals/admin/requests/${mine}/selection-snapshot`), OWN), "snapshot");
    const rev = await ok(as(request(app).post(`/api/approvals/admin/requests/${mine}/passport-reveal`), OWN).send({ itemIndex: 0, travellerIndex: 0 }), "reveal");
    expect(rev.body.passportNumber).toBe("K1234567");
    await ok(as(request(app).get(`/api/approvals/admin/requests/${mine}/passport-reveals`), OWN), "reveals");

    const pid = await submittedProposal(mine, OWN);
    await ok(as(request(app).get(`/api/proposals/by-request/${mine}`), OWN), "by-request");
    await ok(as(request(app).get(`/api/proposals/${pid}`), OWN), "proposal read");
    await ok(as(request(app).post(`/api/proposals/${pid}/record-decision`), OWN).send({ decision: "APPROVED", note: "approved on the phone" }), "record-decision");
    expect((await as(request(app).get("/api/proposals/queue"), OWN)).body.items.map((p: any) => String(p._id))).toEqual([pid]);

    await ok(as(request(app).put(`/api/approvals/admin/${mine}/on-hold`), OWN).send({ comment: "waiting" }), "hold");
    await ok(as(request(app).put(`/api/approvals/admin/${mine}/under-process`), OWN).send({}), "under-process");
    await ok(as(request(app).put(`/api/approvals/admin/${mine}/start-booking`), OWN).send({}), "start-booking");
    await ok(as(request(app).put(`/api/approvals/admin/${mine}/done`), OWN).send({ comment: "Ticketed" }), "done");
    expect(((await col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(mine) })) as any).adminState).toBe("done");
  });

  it("can reassign their own case — and it leaves their queue immediately", async () => {
    const mine = await approvedRequest();
    await assign(mine, OWN);
    expect(await queueIds(OWN)).toEqual([mine]);

    const r = await as(request(app).put(`/api/approvals/admin/${mine}/assign`), OWN).send({ agentUserId: ALL.sub });
    expect(r.status).toBe(200);
    expect(await queueIds(OWN)).toEqual([]);
    expect((await as(request(app).get(`/api/approvals/admin/requests/${mine}`), OWN)).status).toBe(404);
    expect((await as(request(app).put(`/api/approvals/admin/${mine}/assign`), OWN).send({ agentUserId: OWN.sub })).status).toBe(404);
  });

  it("a case reassigned away by someone else drops out of the OWN agent's queue at once", async () => {
    const mine = await approvedRequest();
    await assign(mine, OWN);
    const pid = await submittedProposal(mine, OWN);
    expect(await queueIds(OWN)).toEqual([mine]);

    await assign(mine, ALL);
    expect(await queueIds(OWN)).toEqual([]);
    expect((await as(request(app).get(`/api/proposals/${pid}`), OWN)).status).toBe(404);
    expect((await as(request(app).post(`/api/proposals/${pid}/booking/start`), OWN).send({})).status).toBe(404);
    // ALL still works it.
    expect((await as(request(app).get(`/api/approvals/admin/requests/${mine}`), ALL)).status).toBe(200);
  });
});
