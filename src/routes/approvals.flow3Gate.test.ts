// apps/backend/src/routes/approvals.flow3Gate.test.ts
//
// Flow 3 (APPROVAL_DIRECT) workspaces carry only features.approvalDirectEnabled.
// The approvals router used to demand approvalFlowEnabled, so every
// /api/approvals/* call — search included — was refused for them. The router
// gate now admits either flag:
//   - Flow-3-only workspace: search, create (pending approval), my requests,
//     inbox and booking history all work
//   - proposals stay Flow 2 only (requireTravelMode("APPROVAL_FLOW"))
//   - a workspace with neither flag is still refused; HOUSE still bypasses
//
// Real: approvals, bookingHistory and proposals routers, requireFeature,
// travelModeGuard. Stubbed: requireAuth (user from a header), requireWorkspace
// (workspace from a header), mail, email-action tokens, TBO.
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
vi.mock("../utils/mailer.js", () => ({
  sendMail: async () => ({ messageId: "test" }),
}));
vi.mock("../services/tbo.flight.service.js", async (orig) => {
  const { vi: v } = await import("vitest");
  return { ...(await orig<any>()), searchFlights: v.fn() };
});
vi.mock("../services/tbo.hotel.search.service.js", async (orig) => {
  const { vi: v } = await import("vitest");
  return { ...(await orig<any>()), searchHotels: v.fn() };
});
vi.mock("../utils/emailActionToken.js", () => ({
  signEmailActionToken: () => "tok",
  verifyEmailActionToken: () => null,
  hashToken: () => "hash",
}));

const { default: approvalsRouter } = await import("./approvals.js");
const { default: bookingHistory } = await import("./bookingHistory.js");
const { default: proposalsRouter } = await import("./proposals.js");

// Same mount order as server.ts.
const app = express();
app.use(express.json());
app.use("/api/proposals", proposalsRouter);
app.use("/api/approvals", approvalsRouter);
app.use("/api/approvals", bookingHistory);
app.use("/api/booking-history", bookingHistory);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const WS_DIRECT = oid(); // Flow 3: only approvalDirectEnabled
const WS_FLOW = oid(); // Flow 2: only approvalFlowEnabled
const WS_NONE = oid(); // neither flag
const WS_SBT = oid(); // SBT-only
const WS_HYBRID = oid(); // HYBRID, approvalFlowEnabled as FLOW_TO_FEATURES sets it

const ws = (_id: any, customerId: string, travelFlow: string, features: Record<string, boolean>) => ({
  _id, customerId, name: `WS ${customerId}`, status: "ACTIVE", tenantType: "CORPORATE",
  defaultApproverEmails: ["approver@cust.test"],
  config: { travelFlow, features },
});

const REQ = oid();
const reqEmail = `${String(REQ)}@cust.test`;

const as = (r: request.Test, sub: any, wsId: any, roles: string[] = ["EMPLOYEE"]) =>
  r
    .set("x-test-user", JSON.stringify({ sub: String(sub), email: `${String(sub)}@cust.test`, name: "Test User", roles }))
    .set("x-test-ws", String(wsId));

const flightItem = {
  type: "flight", title: "BLR → BOM", qty: 1, price: 0,
  meta: {
    origin: "BLR", destination: "BOM", departDate: "2027-03-12",
    travellers: [{ kind: "manual", firstName: "Asha", lastName: "Rao" }],
  },
};

const FEATURE_REFUSED = "Feature 'approvalFlowEnabled' or 'approvalDirectEnabled' not enabled for this workspace";

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-flow3-gate-test"));
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertMany([
    ws(WS_DIRECT, "D1", "APPROVAL_DIRECT", { approvalFlowEnabled: false, approvalDirectEnabled: true }),
    ws(WS_FLOW, "F1", "APPROVAL_FLOW", { approvalFlowEnabled: true, approvalDirectEnabled: false }),
    ws(WS_NONE, "N1", "APPROVAL_FLOW", { approvalFlowEnabled: false, approvalDirectEnabled: false }),
    ws(WS_SBT, "S1", "SBT", { sbtEnabled: true, approvalFlowEnabled: false, approvalDirectEnabled: false }),
    ws(WS_HYBRID, "H1", "HYBRID", { sbtEnabled: true, approvalFlowEnabled: true, approvalDirectEnabled: false }),
    ws(HOUSE, "HOUSE", "APPROVAL_FLOW", { approvalFlowEnabled: false, approvalDirectEnabled: false }),
  ] as any[]);
  await col("users").insertOne({ _id: REQ, email: reqEmail, workspaceId: WS_DIRECT, roles: ["EMPLOYEE"] } as any);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await col("approvalrequests").deleteMany({});
});

describe("Flow 3 workspace with ONLY approvalDirectEnabled", () => {
  it("can reach live search (past every gate, an empty body is the handler's 400)", async () => {
    for (const path of ["/flights", "/hotels"]) {
      const r = await as(request(app).post(`/api/approvals/search${path}`).send({}), REQ, WS_DIRECT);
      expect([r.status, r.body.code]).toEqual([400, "BAD_REQUEST"]);
    }
  });

  it("creates a request that waits for approval, sees it in My Requests, and the inbox loads", async () => {
    const created = await as(request(app).post("/api/approvals/requests"), REQ, WS_DIRECT).send({ customerId: "D1", cartItems: [flightItem] });
    expect(created.status).toBe(200);

    const doc: any = await col("approvalrequests").findOne({ workspaceId: WS_DIRECT });
    expect(doc.status).toBe("pending");
    expect(doc.stage).toBe("REQUEST_RAISED");
    expect(doc.meta?.travelFlow).toBe("APPROVAL_DIRECT");

    const mine = await as(request(app).get("/api/approvals/requests/mine"), REQ, WS_DIRECT);
    expect(mine.status).toBe(200);
    expect(mine.body.rows.map((r: any) => String(r._id))).toContain(String(doc._id));

    const inbox = await as(request(app).get("/api/approvals/requests/inbox"), REQ, WS_DIRECT);
    expect(inbox.status).toBe(200);
  });

  it("sees its booking history on both mounts", async () => {
    await as(request(app).post("/api/approvals/requests"), REQ, WS_DIRECT).send({ customerId: "D1", cartItems: [flightItem] });
    await col("approvalrequests").updateMany({ workspaceId: WS_DIRECT }, { $set: { status: "approved", adminState: "done" } });

    for (const path of ["/api/approvals/history", "/api/booking-history/history"]) {
      const r = await as(request(app).get(path), REQ, WS_DIRECT);
      expect(r.status, path).toBe(200);
      expect(r.body.rows.length, path).toBe(1);
    }
  });

  it("proposals stay Flow 2 only (staff are checked against the request's workspace flow)", async () => {
    const ar = await col("approvalrequests").insertOne({
      workspaceId: WS_DIRECT, customerId: "D1", frontlinerId: String(oid()), status: "approved", stage: "REQUEST_APPROVED",
      adminState: "pending", cartItems: [], meta: {}, history: [],
    } as any);
    // Plumtrips staff sign in to HOUSE (a HOUSE ADMIN has queue access for oversight).
    const r = await as(request(app).post(`/api/proposals/by-request/${String(ar.insertedId)}/draft`), oid(), HOUSE, ["ADMIN"]);
    expect([r.status, r.body.error]).toEqual([403, "This flow is not enabled for your workspace"]);
  });
});

describe("the router gate for everyone else", () => {
  it("a workspace with neither flag is refused on every approvals path", async () => {
    for (const [method, path] of [
      ["post", "/api/approvals/search/flights"],
      ["post", "/api/approvals/requests"],
      ["get", "/api/approvals/requests/mine"],
      ["get", "/api/approvals/requests/inbox"],
      ["get", "/api/approvals/history"],
    ] as const) {
      const r = await as((request(app) as any)[method](path).send({}), oid(), WS_NONE);
      expect([r.status, r.body.error], path).toEqual([403, FEATURE_REFUSED]);
    }
  });

  it("an SBT-only workspace is still refused at the feature gate", async () => {
    const r = await as(request(app).get("/api/approvals/requests/mine"), oid(), WS_SBT);
    expect([r.status, r.body.error]).toEqual([403, FEATURE_REFUSED]);
  });

  it("HYBRID passes the feature gate and is still refused by the travel-flow gate", async () => {
    const r = await as(request(app).get("/api/approvals/requests/mine"), oid(), WS_HYBRID);
    expect([r.status, r.body.error]).toEqual([403, "This flow is not enabled for your workspace"]);
  });

  it("a Flow 2 workspace (approvalFlowEnabled only) still passes", async () => {
    const r = await as(request(app).get("/api/approvals/requests/mine"), oid(), WS_FLOW);
    expect(r.status).toBe(200);
  });

  it("HOUSE and SUPERADMIN bypass the feature gate with no flags set", async () => {
    expect((await as(request(app).get("/api/approvals/requests/mine"), oid(), HOUSE)).status).toBe(200);
    expect((await as(request(app).get("/api/approvals/requests/mine"), oid(), WS_NONE, ["SUPERADMIN"])).status).toBe(200);
  });
});
