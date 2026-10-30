// apps/backend/src/routes/approvals.tenantRouting.test.ts
//
// A travel request is filed under the requester's OWN workspace — customer,
// approver, Workspace Leaders and company name all come from the login. A
// body (or query) customerId naming another company used to route the request,
// its traveller details and its no-login decision links to that company's
// approver and leaders.
//
// Real: approvals router, guards, models. Stubbed: requireAuth (user from a
// header), requireWorkspace (workspace from a header; SUPERADMIN skips the
// lookup as in production), mail (recorded), TBO.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";

const sent: Array<{ to: string; cc?: any; subject: string }> = [];

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireWorkspace.js", () => {
  const byId = async (id: any) => {
    const { default: mg } = await import("mongoose");
    if (!id || !mg.Types.ObjectId.isValid(String(id))) return null;
    return mg.connection.db!.collection("customerworkspaces").findOne({ _id: new mg.Types.ObjectId(String(id)) });
  };
  return {
    resolveWorkspaceForUser: async (user: any) => byId(user?.workspaceId),
    requireWorkspace: async (req: any, res: any, next: any) => {
      const { default: mg } = await import("mongoose");
      // Production SUPERADMIN bypass: no lookup, workspace id from body / token.
      if ((req.user?.roles || []).includes("SUPERADMIN")) {
        const explicit = req.body?.workspaceId || req.user?.workspaceId;
        if (explicit) {
          req.workspaceId = String(explicit);
          req.workspaceObjectId = new mg.Types.ObjectId(String(explicit));
        }
        return next();
      }
      const ws = await byId(req.headers["x-test-ws"]);
      if (!ws) return res.status(403).json({ error: "no workspace" });
      req.workspace = ws;
      req.workspaceObjectId = ws._id;
      req.workspaceId = String(ws._id);
      next();
    },
  };
});
vi.mock("../utils/mailer.js", () => ({
  sendMail: async (m: any) => {
    sent.push({ to: String(m.to), cc: m.cc, subject: String(m.subject) });
    return { ok: true };
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

const app = express();
app.use(express.json());
app.use("/api/approvals", approvalsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const WS_A = oid();
const WS_B = oid();
const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");

type Who = { email: string; roles?: string[]; sub?: string; ws?: any; workspaceId?: string };
const REQUESTER_A: Who = { email: "asha@a.test", sub: String(oid()), ws: WS_A };
const OPS_SUB = String(oid());
const OPS: Who = { email: "ops@plumtrips.test", roles: ["EMPLOYEE"], sub: OPS_SUB, ws: HOUSE };
const HOUSE_ADMIN: Who = { email: "admin@plumtrips.test", roles: ["ADMIN"], ws: HOUSE };
const SA: Who = { email: "sa@plumtrips.test", roles: ["SUPERADMIN"], workspaceId: String(HOUSE) };

const as = (r: request.Test, who: Who) =>
  r
    .set(
      "x-test-user",
      JSON.stringify({
        sub: who.sub || String(oid()),
        email: who.email,
        name: who.email.split("@")[0],
        roles: who.roles || ["EMPLOYEE"],
        ...(who.workspaceId ? { workspaceId: who.workspaceId } : {}),
      }),
    )
    .set("x-test-ws", String(who.ws || ""));

const flightItem = {
  type: "flight", title: "BLR → BOM", qty: 1, price: 0,
  meta: {
    origin: "BLR", destination: "BOM", departDate: "2027-04-12",
    travellers: [{ kind: "manual", firstName: "Asha", lastName: "Rao" }],
  },
};

const reqDoc = async (id: any): Promise<any> => col("approvalrequests").findOne({ _id: new mongoose.Types.ObjectId(String(id)) });
const recipients = () => sent.flatMap((m) => [m.to, ...(Array.isArray(m.cc) ? m.cc : m.cc ? [m.cc] : [])]).join(",");

function expectFiledUnderA(doc: any) {
  expect(String(doc.workspaceId)).toBe(String(WS_A));
  expect(doc.customerId).toBe("A1");
  expect(doc.customerName).toBe("Company A");
  expect(doc.managerEmail).toBe("approver@a.test");
  expect(doc.meta.ccLeaders).toEqual(["leader@a.test"]);
}

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-tenant-routing-test"));
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  sent.length = 0;
  await mongoose.connection.db!.dropDatabase();
  const flow = { travelFlow: "APPROVAL_FLOW", features: { approvalFlowEnabled: true } };
  await col("customerworkspaces").insertMany([
    { _id: WS_A, customerId: "A1", name: "Company A", status: "ACTIVE", tenantType: "CORPORATE", defaultApproverEmails: ["approver@a.test"], config: flow },
    { _id: WS_B, customerId: "B1", name: "Company B", status: "ACTIVE", tenantType: "CORPORATE", defaultApproverEmails: ["approver@b.test"], config: flow },
    // HOUSE on an approval flow too, so staff reach the on-behalf check (not the travel-mode gate).
    { _id: HOUSE, customerId: "PLUMTRIPS-HOUSE", name: "Plumtrips", status: "ACTIVE", config: flow },
  ] as any[]);
  await col("customermembers").insertMany([
    { customerId: "A1", email: "leader@a.test", role: "WORKSPACE_LEADER", isActive: true },
    { customerId: "B1", email: "leader@b.test", role: "WORKSPACE_LEADER", isActive: true },
  ] as any[]);
  await col("userpermissions").insertOne({
    userId: OPS_SUB, email: OPS.email, workspaceId: String(HOUSE), universe: "STAFF", status: "active", source: "manual",
    level: { code: "L1", name: "Employee", designation: "" }, modules: { adminQueue: { access: "WRITE", scope: "ALL" } },
  } as any);
});

describe("POST /requests — the customer comes from the login", () => {
  it.each([
    ["B's customerId", { customerId: "B1" }],
    ["B's workspace _id", { customerId: String(WS_B) }],
    ["no customerId at all", {}],
  ])("a user of A sending %s: filed under A, routed to A's approver, B never emailed", async (_label, extra) => {
    const r = await as(request(app).post("/api/approvals/requests"), REQUESTER_A).send({ ...extra, cartItems: [flightItem] });
    expect(r.status).toBe(200);
    expectFiledUnderA(await reqDoc(r.body.request._id));

    expect(sent.find((m) => m.to === "approver@a.test")?.subject).toMatch(/^Approval Needed — Company A/);
    expect(sent.find((m) => m.to === "leader@a.test")).toBeTruthy();
    expect(recipients()).not.toMatch(/@b\.test/);
  });

  it("a ?customerId= query override is ignored", async () => {
    const r = await as(request(app).post("/api/approvals/requests?customerId=B1"), REQUESTER_A).send({ cartItems: [flightItem] });
    expect(r.status).toBe(200);
    expectFiledUnderA(await reqDoc(r.body.request._id));
    expect(recipients()).not.toMatch(/@b\.test/);
  });

  it("editing or resubmitting with B's customerId keeps the request under A", async () => {
    const r = await as(request(app).post("/api/approvals/requests"), REQUESTER_A).send({ cartItems: [flightItem] });
    const id = String(r.body.request._id);
    const owner = REQUESTER_A;

    const e = await as(request(app).put(`/api/approvals/requests/${id}`), owner).send({ customerId: "B1", cartItems: [flightItem] });
    expect(e.status).toBe(200);
    expectFiledUnderA(await reqDoc(id));

    await col("approvalrequests").updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { status: "declined" } });
    sent.length = 0;
    const rs = await as(request(app).put(`/api/approvals/requests/${id}/resubmit`), owner).send({ customerId: "B1", cartItems: [flightItem] });
    expect(rs.status).toBe(200);
    expectFiledUnderA(await reqDoc(id));
    // A resubmit goes to everyone who may decide A's request now — never B's people.
    expect(sent.map((m) => m.to).sort()).toEqual(["approver@a.test", "leader@a.test"]);
  });
});

describe("POST /requests — staff have no raise-on-behalf path", () => {
  it.each([
    ["Admin Queue grant", OPS],
    ["HOUSE ADMIN", HOUSE_ADMIN],
  ])("%s naming a customer is refused; nothing filed, nobody emailed", async (_label, who) => {
    const r = await as(request(app).post("/api/approvals/requests"), who).send({ customerId: "B1", cartItems: [flightItem] });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("STAFF_ON_BEHALF_NOT_SUPPORTED");
    expect(await col("approvalrequests").countDocuments()).toBe(0);
    expect(sent).toEqual([]);
  });

  it("SUPERADMIN pointing at another workspace (body workspaceId) is refused", async () => {
    const r = await as(request(app).post("/api/approvals/requests"), SA).send({ workspaceId: String(WS_B), cartItems: [flightItem] });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe("STAFF_ON_BEHALF_NOT_SUPPORTED");
    expect(await col("approvalrequests").countDocuments()).toBe(0);
    expect(sent).toEqual([]);
  });

  it("a login with no workspace link gets 400 NO_CUSTOMER_WORKSPACE", async () => {
    const r = await as(request(app).post("/api/approvals/requests"), { email: "sa2@plumtrips.test", roles: ["SUPERADMIN"] })
      .send({ customerId: "B1", cartItems: [flightItem] });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("NO_CUSTOMER_WORKSPACE");
    expect(await col("approvalrequests").countDocuments()).toBe(0);
    expect(sent).toEqual([]);
  });
});
