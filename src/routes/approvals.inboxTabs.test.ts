// apps/backend/src/routes/approvals.inboxTabs.test.ts
//
// GET /api/approvals/requests/inbox?view=all — the approver inbox's tabs, on
// a real database: pending (my decision), clarification (waiting on the
// requester), approved / declined BY ME. Revoked requests, other approvers'
// decisions and a leader's own request never show. Each row carries the
// requester's designation / department / cost centre only when the profile
// has them. Without ?view=all the inbox is unchanged (pending only).
//
// Stubbed: requireAuth (user from a header), requireWorkspace (workspace from
// a header), mail (recorded), TBO.
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
vi.mock("../utils/mailer.js", () => ({ sendMail: async () => ({ messageId: "test" }) }));
vi.mock("../services/tbo.flight.service.js", async (orig) => {
  const { vi: v } = await import("vitest");
  return { ...(await orig<any>()), searchFlights: v.fn() };
});
vi.mock("../services/tbo.hotel.search.service.js", async (orig) => {
  const { vi: v } = await import("vitest");
  return { ...(await orig<any>()), searchHotels: v.fn() };
});

const { default: approvalsRouter } = await import("./approvals.js");
const { inboxBucket } = await import("../services/approvalInbox.js");

const app = express();
app.use(express.json());
app.use("/api/approvals", approvalsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const WS = oid();
const CUSTOMER_ID = "F1";
const APPROVER = "approver@cust.test";
const LEADER = "leader@cust.test";

type Who = { email: string; sub: string; roles?: string[] };
const R1: Who = { email: "asha@cust.test", sub: String(oid()) };
const R2: Who = { email: "ravi@cust.test", sub: String(oid()) };
const A: Who = { email: APPROVER, sub: String(oid()) };
const L: Who = { email: LEADER, sub: String(oid()), roles: ["WORKSPACE_LEADER"] };

const as = (r: request.Test, who: Who) =>
  r
    .set("x-test-user", JSON.stringify({ sub: who.sub, email: who.email, name: who.email.split("@")[0], roles: who.roles || ["EMPLOYEE"] }))
    .set("x-test-ws", String(WS));

const addDays = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const flightItem = () => ({
  type: "flight", title: "BLR → BOM", qty: 1, price: 4321,
  meta: { origin: "BLR", destination: "BOM", departDate: addDays(20), fare: 4321, travellers: [{ kind: "manual", firstName: "Asha", lastName: "Rao" }] },
});

async function submit(who: Who) {
  const r = await as(request(app).post("/api/approvals/requests"), who).send({ customerId: CUSTOMER_ID, cartItems: [flightItem()] });
  expect(r.status).toBe(200);
  return String(r.body.request._id);
}
const act = (id: string, who: Who, action: string, comment?: string) =>
  as(request(app).put(`/api/approvals/requests/${id}/action`), who).send({ action, comment });

const inboxAll = async (who: Who) => {
  const r = await as(request(app).get("/api/approvals/requests/inbox?view=all"), who);
  expect(r.status).toBe(200);
  return r.body.rows as any[];
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-inbox-tabs-test"));
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertOne({
    _id: WS, customerId: CUSTOMER_ID, name: "WS F1", status: "ACTIVE", tenantType: "CORPORATE",
    defaultApproverEmails: [APPROVER],
    config: { travelFlow: "APPROVAL_FLOW", features: { approvalFlowEnabled: true } },
  } as any);
  await col("customermembers").insertOne({ customerId: CUSTOMER_ID, email: LEADER, role: "WORKSPACE_LEADER", isActive: true } as any);
  await col("users").insertMany([
    { _id: new mongoose.Types.ObjectId(A.sub), email: APPROVER, name: "Anil Approver", roles: ["CUSTOMER"], workspaceId: WS },
    { _id: new mongoose.Types.ObjectId(L.sub), email: LEADER, name: "Lata Leader", roles: ["CUSTOMER"], workspaceId: WS },
    { _id: new mongoose.Types.ObjectId(R1.sub), email: R1.email, name: "Asha Rao", roles: ["CUSTOMER"], workspaceId: WS },
    { _id: new mongoose.Types.ObjectId(R2.sub), email: R2.email, name: "Ravi Kumar", roles: ["CUSTOMER"], workspaceId: WS },
  ] as any[]);
});

describe("inbox tabs (?view=all)", () => {
  it("pending, clarification, approved-by-me and declined-by-me land in their own tab; revoked and others' decisions never show", async () => {
    const pending = await submit(R1);
    const clarify = await submit(R1);
    const approved = await submit(R1);
    const declined = await submit(R2);
    const revoked = await submit(R2);
    const byLeader = await submit(R2);

    expect((await act(clarify, A, "clarify", "Which client?")).status).toBe(200);
    expect((await act(approved, A, "approved", "Fine")).status).toBe(200);
    expect((await act(declined, A, "declined", "Not this quarter")).status).toBe(200);
    expect((await act(byLeader, L, "approved")).status).toBe(200);
    expect((await as(request(app).put(`/api/approvals/requests/${revoked}/revoke`), R2).send({})).status).toBe(200);

    const rows = await inboxAll(A);
    const bucketOf = Object.fromEntries(rows.map((r) => [String(r._id), r._bucket]));
    expect(bucketOf).toEqual({
      [pending]: "pending",
      [clarify]: "clarification",
      [approved]: "approved",
      [declined]: "declined",
    });

    // Customer-side payload: no prices anywhere.
    const json = JSON.stringify(rows);
    expect(json).not.toMatch(/4321|"price"|"fare"/);
  });

  it("the leader sees every open request in the workspace and only the ones they decided", async () => {
    const pending = await submit(R1);
    const mine = await submit(R1);
    const anil = await submit(R2);
    expect((await act(mine, L, "declined", "Duplicate")).status).toBe(200);
    expect((await act(anil, A, "approved")).status).toBe(200);
    const rows = await inboxAll(L);
    expect(Object.fromEntries(rows.map((r) => [String(r._id), r._bucket]))).toEqual({ [pending]: "pending", [mine]: "declined" });
  });

  it("the requester line shows designation and cost centre from the claimed profile; absent fields are left out", async () => {
    const DESIG = oid();
    await col("designations").insertOne({ _id: DESIG, workspaceId: WS, name: "Senior Consultant" } as any);
    await col("travellerprofiles").insertOne({
      workspaceId: WS, travelerId: "T-1", firstName: "Asha", lastName: "Rao", isActive: true,
      claimedBy: new mongoose.Types.ObjectId(R1.sub), designationId: DESIG, costCenterId: "CC-6021",
    } as any);
    const withProfile = await submit(R1);
    const without = await submit(R2);

    const rows = await inboxAll(A);
    const by = Object.fromEntries(rows.map((r) => [String(r._id), r]));
    expect(by[withProfile]._requester).toEqual({ designation: "Senior Consultant", costCentre: "CC-6021" });
    expect(by[without]._requester).toBeUndefined();
  });

  it("without ?view=all the inbox is unchanged: pending only, no tab tags", async () => {
    const pending = await submit(R1);
    const clarify = await submit(R1);
    expect((await act(clarify, A, "clarify", "Which client?")).status).toBe(200);
    const r = await as(request(app).get("/api/approvals/requests/inbox"), A);
    expect(r.body.rows.map((x: any) => String(x._id))).toEqual([pending]);
    expect(r.body.rows[0]._bucket).toBeUndefined();
  });
});

describe("inboxBucket", () => {
  it("revoked and someone else's decision are null; stage beats status for clarification", () => {
    expect(inboxBucket({ status: "pending", stage: "REQUEST_RAISED" }, "a@x")).toBe("pending");
    expect(inboxBucket({ status: "pending", stage: "REQUEST_NEEDS_CLARIFICATION" }, "a@x")).toBe("clarification");
    expect(inboxBucket({ status: "approved", stage: "BOOKING_DONE", approvedByEmail: "A@x" }, "a@x")).toBe("approved");
    expect(inboxBucket({ status: "approved", approvedByEmail: "b@x" }, "a@x")).toBeNull();
    expect(inboxBucket({ status: "declined", approvedByEmail: "a@x", meta: { revoked: true } }, "a@x")).toBeNull();
  });
});
