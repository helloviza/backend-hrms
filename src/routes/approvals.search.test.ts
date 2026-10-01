// apps/backend/src/routes/approvals.search.test.ts
//
// S0 plumbing for live search on the approval request form, end to end
// through the real approvals router on an in-memory Mongo:
//   - gates on /api/approvals/search/* (demo first, SaaS, travel flow,
//     who-can-raise) and that POST /requests keeps the same who-can-raise rules
//   - per-user and per-workspace search limits (Imran D8)
//   - optionRef scoping: same user + same workspace + unexpired only
//   - client-sent meta.selection is dropped; the server rebuilds it
//   - edit/resubmit keep a bound pick from the snapshot and prune dropped ones
//   - the selection snapshot is readable by staff only (403 for a Workspace
//     Leader and the requester)
//
// Real: models, travelModeGuard, requireFeature, blockTravelForSaas, rate
// limiters. Stubbed: requireAuth (user from a header), requireWorkspace
// (workspace from a header), mail, email-action tokens.
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
vi.mock("../utils/emailActionToken.js", () => ({
  signEmailActionToken: () => "tok",
  verifyEmailActionToken: () => null,
}));

const { default: approvalsRouter } = await import("./approvals.js");
const { createSearchSession, optionRefFor } = await import("../services/approvalSearch/optionRef.js");
const { SEARCH_LIMITS } = await import("./approvals.search.js");

const app = express();
app.use(express.json());
app.use("/api/approvals", approvalsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const WS = oid();
const WS2 = oid();
const WS_SAAS = oid();
const WS_HYBRID = oid();
const WS_SBT = oid();
const WS_DIRECT = oid();

const U = { req: oid(), other: oid(), sbt: oid(), noRaise: oid(), wl: oid(), approver: oid() };

const features = { approvalFlowEnabled: true, approvalDirectEnabled: false };
const ws = (_id: any, customerId: string, travelFlow: string, extra: any = {}) => ({
  _id, customerId, name: `WS ${customerId}`, status: "ACTIVE", tenantType: "CORPORATE",
  defaultApproverEmails: ["approver@cust.test"],
  config: { travelFlow, features: { ...features, ...(extra.features || {}) } },
  ...extra,
});

const user = (sub: any, roles: string[] = ["EMPLOYEE"], extra: any = {}) =>
  JSON.stringify({ sub: String(sub), email: `${String(sub)}@cust.test`, name: "Test User", roles, ...extra });

const as = (r: request.Test, sub: any, wsId: any, roles?: string[], extra?: any) =>
  r.set("x-test-user", user(sub, roles, extra)).set("x-test-ws", String(wsId));

/* ── TBO-shaped raw results (prices included) ─────────────────────────────── */

const flightRaw = (no: string) => ({
  ResultIndex: `OB-${no}`, IsLCC: true, IsRefundable: true,
  Fare: { PublishedFare: 5432, OfferedFare: 5280, TotalFare: 5432, Tax: 800 }, _netPublishedFare: 5100, _marginAmount: 332,
  Segments: [[{
    Airline: { AirlineCode: "6E", AirlineName: "IndiGo", FlightNumber: no },
    Origin: { Airport: { AirportCode: "BLR", CityName: "Bengaluru", Terminal: "1" }, DepTime: "2026-10-12T06:10:00" },
    Destination: { Airport: { AirportCode: "BOM", CityName: "Mumbai", Terminal: "2" }, ArrTime: "2026-10-12T07:55:00" },
    Duration: 105, GroundTime: 0, Baggage: "15 Kg", CabinBaggage: "7 Kg", CabinClass: 2,
  }]],
});
const hotelRaw = {
  HotelCode: "1001", HotelName: "Taj Lands End", HotelRating: "FiveStar", Address: "Bandra West", CityName: "Mumbai",
  Rooms: [{ Name: ["Luxury Room"], MealType: "BreakFast", IsRefundable: true, TotalFare: 28400, DayRates: [[{ BasePrice: 14200 }]], CancelPolicies: [] }],
};

async function flightSession(sub: any, wsId: any, opts: { expired?: boolean } = {}) {
  const s = await createSearchSession({
    workspaceId: wsId, userId: String(sub), kind: "flight",
    params: { origin: "BLR", destination: "BOM", departDate: "2026-10-12" },
    traceId: "trace-1", results: [flightRaw("5321"), flightRaw("6123")],
  });
  if (opts.expired) await col("approvalsearchsessions").updateOne({ sid: s.sid }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  return s.sid;
}

const flightItem = (meta: any = {}) => ({
  type: "flight", title: "BLR → BOM", qty: 1, price: 0,
  meta: { origin: "BLR", destination: "BOM", departDate: "2026-10-12", ...meta },
});

const createReq = (sub: any, wsId: any, cartItems: any[], roles?: string[]) =>
  as(request(app).post("/api/approvals/requests"), sub, wsId, roles).send({ customerId: wsId === WS2 ? "C2" : "C1", cartItems });

/* ── setup ───────────────────────────────────────────────────────────────── */

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approval-search-test"));
  await mongoose.connection.db!.dropDatabase();
  await col("customerworkspaces").insertMany([
    ws(WS, "C1", "APPROVAL_FLOW"),
    ws(WS2, "C2", "APPROVAL_FLOW"),
    ws(WS_SAAS, "C3", "APPROVAL_FLOW", { tenantType: "SAAS_HRMS" }),
    ws(WS_HYBRID, "C4", "HYBRID"),
    ws(WS_SBT, "C5", "SBT"),
    ws(WS_DIRECT, "C6", "APPROVAL_DIRECT", { features: { approvalDirectEnabled: true } }),
  ] as any[]);
  await col("users").insertMany([
    { _id: U.req, email: `${U.req}@cust.test`, workspaceId: WS, roles: ["EMPLOYEE"] },
    { _id: U.other, email: `${U.other}@cust.test`, workspaceId: WS, roles: ["EMPLOYEE"] },
    { _id: U.sbt, email: `${U.sbt}@cust.test`, workspaceId: WS, roles: ["EMPLOYEE"], sbtEnabled: true },
    { _id: U.noRaise, email: `${U.noRaise}@cust.test`, workspaceId: WS, roles: ["EMPLOYEE"], canRaiseRequest: false },
    { _id: U.wl, email: `${U.wl}@cust.test`, workspaceId: WS, roles: ["WORKSPACE_LEADER"], sbtEnabled: true },
    { _id: U.approver, email: "approver@cust.test", workspaceId: WS, name: "Approver", roles: ["EMPLOYEE"] },
  ] as any[]);
  await col("customermembers").insertOne({ customerId: "C1", email: `${U.wl}@cust.test`, role: "WORKSPACE_LEADER", isActive: true });
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await col("approvalrequests").deleteMany({});
  await col("approvalselectionsnapshots").deleteMany({});
});

/* ── gates ───────────────────────────────────────────────────────────────── */

describe("/api/approvals/search gates", () => {
  const search = (path = "/flights") => request(app).post(`/api/approvals/search${path}`).send({});

  it("an allowed requester reaches the (not yet built) handlers", async () => {
    for (const [method, path] of [["post", "/flights"], ["post", "/hotels"], ["get", "/hotel-cities"]] as const) {
      const r = await as((request(app) as any)[method](`/api/approvals/search${path}`), U.req, WS);
      expect(r.status).toBe(501);
      expect(r.body.code).toBe("NOT_IMPLEMENTED");
    }
  });

  it("refuses an SBT user and a user with canRaiseRequest=false; a Workspace Leader bypasses both", async () => {
    expect((await as(search(), U.sbt, WS)).body.code).toBe("SBT_USER_CANNOT_RAISE_REQUEST");
    expect((await as(search(), U.noRaise, WS)).body.code).toBe("RAISE_REQUEST_DISABLED");
    expect((await as(search(), U.wl, WS, ["WORKSPACE_LEADER"])).status).toBe(501);
  });

  it("demo sessions get 403 'contact sales' before any other gate", async () => {
    for (const extra of [{ isDemoUser: true }, { _demoImpersonation: true }]) {
      // even an SBT user in a SaaS workspace sees the demo answer first
      const r = await as(search(), U.sbt, WS_SAAS, ["EMPLOYEE"], extra);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe("DEMO_SEARCH_BLOCKED");
      expect(r.body.error).toMatch(/contact sales/i);
    }
  });

  it("SaaS HRMS tenants are blocked even with approval flow enabled", async () => {
    const r = await as(search(), oid(), WS_SAAS);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("TRAVEL_MODULE_BLOCKED");
  });

  it("HYBRID and SBT workspaces are refused by the travel-flow gate; APPROVAL_DIRECT passes", async () => {
    for (const wsId of [WS_HYBRID, WS_SBT]) {
      const r = await as(search(), oid(), wsId);
      expect([r.status, r.body.error]).toEqual([403, "This flow is not enabled for your workspace"]);
    }
    expect((await as(search(), oid(), WS_DIRECT)).status).toBe(501);
  });
});

describe("POST /requests keeps its who-can-raise rules (now the shared check)", () => {
  it("SBT user and canRaiseRequest=false are refused; requester and Workspace Leader may raise", async () => {
    const sbt = await createReq(U.sbt, WS, [flightItem()]);
    expect([sbt.status, sbt.body.code]).toEqual([403, "SBT_USER_CANNOT_RAISE_REQUEST"]);
    const off = await createReq(U.noRaise, WS, [flightItem()]);
    expect([off.status, off.body.code]).toEqual([403, "RAISE_REQUEST_DISABLED"]);
    expect((await createReq(U.req, WS, [flightItem()])).status).toBe(200);
    expect((await createReq(U.wl, WS, [flightItem()], ["WORKSPACE_LEADER"])).status).toBe(200);
  });
});

/* ── limits ──────────────────────────────────────────────────────────────── */

describe("search limits (D8)", () => {
  it("per user: 20 flight searches per 10 min, then 429; another user is unaffected", async () => {
    const wsId = oid();
    await col("customerworkspaces").insertOne(ws(wsId, "L1", "APPROVAL_FLOW") as any);
    const a = oid();
    for (let i = 0; i < SEARCH_LIMITS.flight.perUser; i++) {
      expect((await as(request(app).post("/api/approvals/search/flights"), a, wsId)).status).toBe(501);
    }
    const over = await as(request(app).post("/api/approvals/search/flights"), a, wsId);
    expect([over.status, over.body.code]).toEqual([429, "SEARCH_RATE_LIMITED_USER"]);
    expect((await as(request(app).post("/api/approvals/search/flights"), oid(), wsId)).status).toBe(501);
    // hotel budget is separate
    expect((await as(request(app).post("/api/approvals/search/hotels"), a, wsId)).status).toBe(501);
  });

  it("per user: 10 hotel searches", async () => {
    const wsId = oid();
    await col("customerworkspaces").insertOne(ws(wsId, "L2", "APPROVAL_FLOW") as any);
    const a = oid();
    for (let i = 0; i < SEARCH_LIMITS.hotel.perUser; i++) {
      expect((await as(request(app).post("/api/approvals/search/hotels"), a, wsId)).status).toBe(501);
    }
    expect((await as(request(app).post("/api/approvals/search/hotels"), a, wsId)).body.code).toBe("SEARCH_RATE_LIMITED_USER");
  });

  it("per workspace: 200 flight searches per hour across users, then 429 for everyone in it", async () => {
    const wsId = oid();
    await col("customerworkspaces").insertOne(ws(wsId, "L3", "APPROVAL_FLOW") as any);
    const users = Array.from({ length: SEARCH_LIMITS.flight.perWorkspace / SEARCH_LIMITS.flight.perUser }, oid);
    for (const u of users) {
      for (let i = 0; i < SEARCH_LIMITS.flight.perUser; i++) {
        expect((await as(request(app).post("/api/approvals/search/flights"), u, wsId)).status).toBe(501);
      }
    }
    const fresh = await as(request(app).post("/api/approvals/search/flights"), oid(), wsId);
    expect([fresh.status, fresh.body.code]).toEqual([429, "SEARCH_RATE_LIMITED_WORKSPACE"]);
    // a different workspace is unaffected
    expect((await as(request(app).post("/api/approvals/search/flights"), oid(), WS2)).status).toBe(501);
  }, 60_000);
});

/* ── optionRef + selection ───────────────────────────────────────────────── */

describe("optionRef → server-built selection", () => {
  it("resolves for the same user and workspace: price-free selection on the item, raw prices in the snapshot", async () => {
    const sid = await flightSession(U.req, WS);
    const r = await createReq(U.req, WS, [flightItem({ optionRef: optionRefFor(sid, 1) })]);
    expect(r.status).toBe(200);

    const doc: any = await col("approvalrequests").findOne({});
    const sel = doc.cartItems[0].meta.selection;
    expect(sel).toMatchObject({ kind: "flight", tripKind: "OW", optionRef: `${sid}.1` });
    expect(sel.legs[0].segments[0].flightNumber).toBe("6123");
    expect(JSON.stringify(doc.cartItems)).not.toMatch(/5432|5280|_net|_margin|Fare"/);

    const snaps = await col("approvalselectionsnapshots").find({}).toArray();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ optionRef: `${sid}.1`, kind: "flight", itemKey: "0", createdBy: String(U.req) });
    expect(snaps[0].rawOption.out.Fare.PublishedFare).toBe(5432);
    expect(String(snaps[0].workspaceId)).toBe(String(WS));
  });

  it("refuses another user's ref, the same user's ref from another workspace, an expired ref, a malformed ref, and a hotel ref on a flight item", async () => {
    const sid = await flightSession(U.req, WS);
    const ref = optionRefFor(sid, 0);

    const otherUser = await createReq(U.other, WS, [flightItem({ optionRef: ref })]);
    expect([otherUser.status, otherUser.body.code]).toEqual([400, "OPTION_REF_INVALID"]);

    const otherWs = await createReq(U.req, WS2, [flightItem({ optionRef: ref })]);
    expect([otherWs.status, otherWs.body.code]).toEqual([400, "OPTION_REF_INVALID"]);

    const expiredSid = await flightSession(U.req, WS, { expired: true });
    const expired = await createReq(U.req, WS, [flightItem({ optionRef: optionRefFor(expiredSid, 0) })]);
    expect([expired.status, expired.body.code]).toEqual([400, "OPTION_REF_EXPIRED"]);
    expect(expired.body.error).toMatch(/expired/);

    expect((await createReq(U.req, WS, [flightItem({ optionRef: "not-a-ref" })])).body.code).toBe("OPTION_REF_INVALID");
    expect((await createReq(U.req, WS, [flightItem({ optionRef: `${sid}.9` })])).body.code).toBe("OPTION_REF_INVALID");

    const h = await createSearchSession({ workspaceId: WS, userId: String(U.req), kind: "hotel", params: { CheckIn: "2026-10-12", CheckOut: "2026-10-14" }, results: [hotelRaw] });
    const wrongKind = await createReq(U.req, WS, [flightItem({ optionRef: optionRefFor(h.sid, 0, 0) })]);
    expect([wrongKind.status, wrongKind.body.itemIndex]).toEqual([400, 0]);

    // nothing written by any refusal
    expect(await col("approvalrequests").countDocuments()).toBe(0);
    expect(await col("approvalselectionsnapshots").countDocuments()).toBe(0);
  });

  it("hotel ref resolves to the chosen room", async () => {
    const h = await createSearchSession({ workspaceId: WS, userId: String(U.req), kind: "hotel", params: { CheckIn: "2026-10-12", CheckOut: "2026-10-14" }, results: [hotelRaw] });
    const r = await createReq(U.req, WS, [{ type: "hotel", title: "Mumbai", qty: 1, meta: { city: "Mumbai", optionRef: optionRefFor(h.sid, 0, 0) } }]);
    expect(r.status).toBe(200);
    const doc: any = await col("approvalrequests").findOne({});
    expect(doc.cartItems[0].meta.selection).toMatchObject({ kind: "hotel", name: "Taj Lands End", stars: 5, roomName: "Luxury Room", mealPlan: "Breakfast", checkOut: "2026-10-14" });
    const snap: any = await col("approvalselectionsnapshots").findOne({});
    expect(snap.rawOption.room.TotalFare).toBe(28400);
    expect(snap.rawOption.hotel.Rooms).toBeUndefined();
  });

  it("drops a client-sent selection, with or without an optionRef", async () => {
    const forged = { airline: "IndiGo", Fare: { PublishedFare: 1 }, note: "client made this up" };
    expect((await createReq(U.req, WS, [flightItem({ selection: forged })])).status).toBe(200);
    let doc: any = await col("approvalrequests").findOne({});
    expect(doc.cartItems[0].meta.selection).toBeUndefined();
    expect(doc.cartItems[0].meta.origin).toBe("BLR");

    await col("approvalrequests").deleteMany({});
    const sid = await flightSession(U.req, WS);
    await createReq(U.req, WS, [flightItem({ selection: forged, optionRef: optionRefFor(sid, 0) })]);
    doc = await col("approvalrequests").findOne({});
    expect(doc.cartItems[0].meta.selection.kind).toBe("flight");
    expect(doc.cartItems[0].meta.selection.note).toBeUndefined();
  });
});

describe("edit and resubmit", () => {
  it("edit keeps a bound pick after its session expired, staff can edit it too, and removing the pick prunes the snapshot", async () => {
    const sid = await flightSession(U.req, WS);
    const ref = optionRefFor(sid, 0);
    await createReq(U.req, WS, [flightItem({ optionRef: ref })]);
    const id = String((await col("approvalrequests").findOne({}))!._id);
    await col("approvalsearchsessions").updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });

    const forged = { kind: "flight", injected: true };
    const edit = await as(request(app).put(`/api/approvals/requests/${id}`), U.req, WS)
      .send({ cartItems: [flightItem({ optionRef: ref, selection: forged, notes: "window seat" })] });
    expect(edit.status).toBe(200);
    let doc: any = await col("approvalrequests").findOne({});
    expect(doc.cartItems[0].meta.selection.legs[0].segments[0].flightNumber).toBe("5321");
    expect(doc.cartItems[0].meta.selection.injected).toBeUndefined();

    const staffEdit = await as(request(app).put(`/api/approvals/requests/${id}`), oid(), WS, ["ADMIN"])
      .send({ cartItems: [flightItem({ optionRef: ref })] });
    expect(staffEdit.status).toBe(200);
    expect(await col("approvalselectionsnapshots").countDocuments()).toBe(1);

    await as(request(app).put(`/api/approvals/requests/${id}`), U.req, WS).send({ cartItems: [flightItem()] });
    doc = await col("approvalrequests").findOne({});
    expect(doc.cartItems[0].meta.selection).toBeUndefined();
    expect(await col("approvalselectionsnapshots").countDocuments()).toBe(0);
  });

  it("resubmit swaps the pick: new ref resolved from the requester's session, old snapshot pruned", async () => {
    const sid = await flightSession(U.req, WS);
    await createReq(U.req, WS, [flightItem({ optionRef: optionRefFor(sid, 0) })]);
    const id = String((await col("approvalrequests").findOne({}))!._id);
    await col("approvalrequests").updateOne({}, { $set: { status: "declined" } });

    const r = await as(request(app).put(`/api/approvals/requests/${id}/resubmit`), U.req, WS)
      .send({ cartItems: [flightItem({ optionRef: optionRefFor(sid, 1) })] });
    expect(r.status).toBe(200);
    const snaps = await col("approvalselectionsnapshots").find({}).toArray();
    expect(snaps.map((s) => s.optionRef)).toEqual([`${sid}.1`]);

    const bad = await as(request(app).put(`/api/approvals/requests/${id}/resubmit`), U.req, WS)
      .send({ cartItems: [flightItem({ optionRef: "nope" })] });
    expect(bad.status).toBe(400);
  });
});

/* ── staff-only snapshot read ────────────────────────────────────────────── */

describe("GET /admin/requests/:id/selection-snapshot", () => {
  it("staff get the raw option with prices; Workspace Leader and requester get 403; other workspace 404", async () => {
    const sid = await flightSession(U.req, WS);
    await createReq(U.req, WS, [flightItem({ optionRef: optionRefFor(sid, 0) })]);
    const id = String((await col("approvalrequests").findOne({}))!._id);
    const url = `/api/approvals/admin/requests/${id}/selection-snapshot`;

    const staff = await as(request(app).get(url), oid(), WS, ["ADMIN"]);
    expect(staff.status).toBe(200);
    expect(staff.body.snapshots).toHaveLength(1);
    expect(staff.body.snapshots[0].rawOption.out.Fare.PublishedFare).toBe(5432);

    const wl = await as(request(app).get(url), U.wl, WS, ["WORKSPACE_LEADER"]);
    expect([wl.status, wl.body.reason]).toEqual([403, "NOT_STAFF_ADMIN"]);
    expect(JSON.stringify(wl.body)).not.toMatch(/5432/);
    expect((await as(request(app).get(url), U.req, WS)).status).toBe(403);

    expect((await as(request(app).get(url), oid(), WS2, ["ADMIN"])).status).toBe(404);
  });
});
