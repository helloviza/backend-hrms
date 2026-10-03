// apps/backend/src/routes/approvals.deskAndHistory.test.ts
//
// Travel Desk settings and Booking History follow the Admin Queue grant:
//   - desk settings (read/change team, mode, Account Manager first, anyone
//     else's Available/Away) need queue WRITE+ with scope TEAM / WORKSPACE /
//     ALL, or SUPERADMIN / HOUSE ADMIN oversight; an OWN agent is refused but
//     may set their OWN Available/Away and still use the Assign picker
//   - Booking History staff view = queue access, held to the grant's scope
//     (OWN → only requests assigned to them; TEAM/ALL → every tenant); roles
//     alone (a customer ADMIN / L2) no longer unlock it; requester history is
//     unchanged
//
// Real: approvals, proposals and bookingHistory routers, Travel Desk,
// readCapability, UserPermission, requireWorkspace resolver, in-memory Mongo.
// Stubbed: requireAuth (user from a header), requireWorkspace middleware
// (workspace from a header), mail, email tokens, TBO.
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
const { default: bookingHistoryRouter } = await import("./bookingHistory.js");

const app = express();
app.use(express.json());
app.use("/api/approvals", approvalsRouter);
app.use("/api/booking-history", bookingHistoryRouter);

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
const REQUESTER = person("Requester", ["EMPLOYEE"], WS);
const TENANT_ADMIN = person("Tenant", ["ADMIN", "L2"], WS); // customer ADMIN + L2 role, no grant
const APPROVER_USER: Who = { ...person("Approver", ["EMPLOYEE"], WS), email: APPROVER };

// The token carries workspaceId, and customerId = workspaceId as middleware/auth normalizeWorkspaceIds
// sets on every real token — Booking History resolves the workspace and the customer view from them.
const as = (r: request.Test, who: Who) =>
  r
    .set("x-test-user", JSON.stringify({ sub: who.sub, email: who.email, name: who.name, roles: who.roles, workspaceId: String(who.ws), customerId: String(who.ws) }))
    .set("x-test-ws", String(who.ws));

const grant = (who: Who, access: string, scope: string) =>
  col("userpermissions").insertOne({
    userId: who.sub, email: who.email, workspaceId: String(HOUSE), universe: "STAFF", status: "active", source: "manual",
    level: { code: "L1", name: "Employee", designation: "" }, modules: { adminQueue: { access, scope } },
  } as any);

async function approvedRequest() {
  const created = await as(request(app).post("/api/approvals/requests"), REQUESTER).send({
    customerId: String(CUSTOMER_ID),
    cartItems: [{ type: "flight", title: "BLR → DEL", qty: 1, price: 0, meta: { origin: "BLR", destination: "DEL", tripType: "oneway", departDate: "2026-11-02", travelScope: "domestic", travellers: [{ kind: "manual", firstName: "Asha", lastName: "Guest" }] } }],
  });
  expect(created.status).toBe(200);
  const id = String(created.body.request._id);
  expect((await as(request(app).put(`/api/approvals/requests/${id}/action`), APPROVER_USER).send({ action: "approved" })).status).toBe(200);
  return id;
}
const assign = async (id: string, to: Who) =>
  expect((await as(request(app).put(`/api/approvals/admin/${id}/assign`), ADMIN).send({ agentUserId: to.sub })).status).toBe(200);
const markDone = (id: string) => col("approvalrequests").updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { adminState: "done" } });
const historyIds = async (who: Who, path = "/api/booking-history/history") => {
  const r = await as(request(app).get(path), who);
  expect(r.status, `${who.name} ${path}`).toBe(200);
  return r.body.rows.map((x: any) => String(x._id)).sort();
};
const isAway = async (who: Who) =>
  ((await col("traveldesksettings").findOne({ key: "default" })) as any).agents.find((a: any) => String(a.userId) === who.sub).available === false;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-desk-history-test"));
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
    [OWN, ALL, TEAM, ADMIN].map((u) => ({ _id: new mongoose.Types.ObjectId(u.sub), workspaceId: HOUSE, email: u.email, name: u.name, roles: u.roles, status: "ACTIVE", passwordHash: "x" })) as any[],
  );
  await grant(OWN, "FULL", "OWN");
  await grant(ALL, "FULL", "ALL");
  await grant(TEAM, "WRITE", "TEAM");
  await as(request(app).put("/api/approvals/travel-desk/settings"), ADMIN).send({ mode: "off", agents: [{ userId: OWN.sub }, { userId: ALL.sub }, { userId: TEAM.sub }] });
});

describe("Travel Desk settings need a scope wider than OWN", () => {
  it("an OWN agent cannot read or change settings, nor anyone else's availability — but keeps the Assign picker", async () => {
    expect((await as(request(app).get("/api/approvals/travel-desk/settings"), OWN)).status).toBe(403);
    const put = await as(request(app).put("/api/approvals/travel-desk/settings"), OWN).send({ mode: "round_robin", agents: [{ userId: OWN.sub }] });
    expect([put.status, put.body.code]).toEqual([403, "DESK_SCOPE_REQUIRED"]);
    expect((await as(request(app).patch(`/api/approvals/travel-desk/agents/${ALL.sub}`), OWN).send({ available: false })).status).toBe(403);
    expect(await isAway(ALL)).toBe(false);
    const desk: any = await col("traveldesksettings").findOne({ key: "default" });
    expect([desk.mode, desk.agents.length]).toEqual(["off", 3]); // nothing changed

    expect((await as(request(app).get("/api/approvals/travel-desk/agents"), OWN)).status).toBe(200);
  });

  it("an OWN agent can set their OWN Available / Away", async () => {
    const away = await as(request(app).patch(`/api/approvals/travel-desk/agents/${OWN.sub}`), OWN).send({ available: false });
    expect(away.status).toBe(200);
    expect(await isAway(OWN)).toBe(true);
    expect((await as(request(app).patch(`/api/approvals/travel-desk/agents/${OWN.sub}`), OWN).send({ available: true })).status).toBe(200);
    expect(await isAway(OWN)).toBe(false);
  });

  it("TEAM and ALL agents, and HOUSE ADMIN oversight, manage the desk", async () => {
    for (const who of [TEAM, ALL, ADMIN]) {
      expect((await as(request(app).get("/api/approvals/travel-desk/settings"), who)).status, who.name).toBe(200);
    }
    expect((await as(request(app).put("/api/approvals/travel-desk/settings"), TEAM).send({ mode: "least_busy" })).status).toBe(200);
    expect(((await col("traveldesksettings").findOne({ key: "default" })) as any).mode).toBe("least_busy");
    expect((await as(request(app).patch(`/api/approvals/travel-desk/agents/${OWN.sub}`), ALL).send({ available: false })).status).toBe(200);
    expect(await isAway(OWN)).toBe(true);
  });
});

describe("Booking History follows the Admin Queue grant and scope", () => {
  it("OWN → only their assigned requests; TEAM / ALL / HOUSE ADMIN → all; on both staff endpoints", async () => {
    const mine = await approvedRequest();
    const theirs = await approvedRequest();
    const unassigned = await approvedRequest();
    await assign(mine, OWN);
    await assign(theirs, ALL);
    for (const id of [mine, theirs, unassigned]) await markDone(id);

    for (const path of ["/api/booking-history/history", "/api/booking-history/admin/history"]) {
      expect(await historyIds(OWN, path), path).toEqual([mine]);
      for (const who of [TEAM, ALL, ADMIN]) {
        expect(await historyIds(who, path), `${who.name} ${path}`).toEqual([mine, theirs, unassigned].sort());
      }
    }

    // Reassigned away → gone from the OWN agent's history too.
    await col("approvalrequests").updateOne({ _id: new mongoose.Types.ObjectId(mine) }, { $set: { "meta.adminAssigned.userId": ALL.sub } });
    expect(await historyIds(OWN)).toEqual([]);
  });

  it("roles alone no longer unlock the all-tenant view; requester history is unchanged", async () => {
    const otherWs = oid();
    await col("customerworkspaces").insertOne({ _id: otherWs, customerId: "OTHER", name: "Other Co", status: "ACTIVE", config: {} } as any);
    const mine = await approvedRequest();
    await markDone(mine);
    const foreign = oid();
    await col("approvalrequests").insertOne({
      _id: foreign, workspaceId: otherWs, customerId: "OTHER", frontlinerEmail: "someone@other.test", status: "approved", adminState: "done", cartItems: [], history: [],
    } as any);

    // A customer ADMIN carrying L2: no Admin Queue grant, so no staff endpoint and no other tenant's rows.
    expect((await as(request(app).get("/api/booking-history/admin/history"), TENANT_ADMIN)).status).toBe(403);
    const tenantView = await historyIds(TENANT_ADMIN);
    expect(tenantView).not.toContain(String(foreign));

    // The requester still sees their own history, and only theirs.
    expect(await historyIds(REQUESTER)).toEqual([mine]);
    expect((await as(request(app).get("/api/booking-history/admin/history"), REQUESTER)).status).toBe(403);
  });
});
