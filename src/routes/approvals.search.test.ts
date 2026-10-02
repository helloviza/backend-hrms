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
const mails = vi.hoisted(() => [] as Array<{ to: any; subject: string; html: string }>);
vi.mock("../utils/mailer.js", () => ({
  sendMail: async (m: any) => {
    mails.push({ to: m.to, subject: String(m.subject || ""), html: String(m.html || "") });
    return { messageId: "test" };
  },
}));
const tbo = vi.hoisted(() => ({ flights: null as any, hotels: null as any }));
vi.mock("../services/tbo.flight.service.js", async (orig) => {
  const { vi: v } = await import("vitest");
  tbo.flights = v.fn();
  return { ...(await orig<any>()), searchFlights: tbo.flights };
});
vi.mock("../services/tbo.hotel.search.service.js", async (orig) => {
  const { vi: v } = await import("vitest");
  tbo.hotels = v.fn();
  return { ...(await orig<any>()), searchHotels: tbo.hotels };
});
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

// Every request needs a traveller; a manual one keeps these tests about selections.
const TRAV = [{ kind: "manual", firstName: "Asha", lastName: "Rao" }];
const flightItem = (meta: any = {}) => ({
  type: "flight", title: "BLR → BOM", qty: 1, price: 0,
  meta: { origin: "BLR", destination: "BOM", departDate: "2026-10-12", travellers: TRAV, ...meta },
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

  // Past every gate, an empty body stops at the handler's own input check (400 BAD_REQUEST).
  it("an allowed requester reaches the handlers", async () => {
    for (const path of ["/flights", "/hotels"]) {
      const r = await as(request(app).post(`/api/approvals/search${path}`).send({}), U.req, WS);
      expect([r.status, r.body.code]).toEqual([400, "BAD_REQUEST"]);
    }
    const cities = await as(request(app).get("/api/approvals/search/hotel-cities"), U.req, WS);
    expect([cities.status, cities.body.code]).toEqual([501, "NOT_IMPLEMENTED"]);
    expect(tbo.flights).not.toHaveBeenCalled();
  });

  it("refuses an SBT user and a user with canRaiseRequest=false; a Workspace Leader bypasses both", async () => {
    expect((await as(search(), U.sbt, WS)).body.code).toBe("SBT_USER_CANNOT_RAISE_REQUEST");
    expect((await as(search(), U.noRaise, WS)).body.code).toBe("RAISE_REQUEST_DISABLED");
    expect((await as(search(), U.wl, WS, ["WORKSPACE_LEADER"])).status).toBe(400);
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
    expect((await as(search(), oid(), WS_DIRECT)).status).toBe(400);
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
      expect((await as(request(app).post("/api/approvals/search/flights"), a, wsId)).status).toBe(400);
    }
    const over = await as(request(app).post("/api/approvals/search/flights"), a, wsId);
    expect([over.status, over.body.code]).toEqual([429, "SEARCH_RATE_LIMITED_USER"]);
    expect((await as(request(app).post("/api/approvals/search/flights"), oid(), wsId)).status).toBe(400);
    // hotel budget is separate
    expect((await as(request(app).post("/api/approvals/search/hotels"), a, wsId)).status).toBe(400);
  });

  it("per user: 10 hotel searches", async () => {
    const wsId = oid();
    await col("customerworkspaces").insertOne(ws(wsId, "L2", "APPROVAL_FLOW") as any);
    const a = oid();
    for (let i = 0; i < SEARCH_LIMITS.hotel.perUser; i++) {
      expect((await as(request(app).post("/api/approvals/search/hotels"), a, wsId)).status).toBe(400);
    }
    expect((await as(request(app).post("/api/approvals/search/hotels"), a, wsId)).body.code).toBe("SEARCH_RATE_LIMITED_USER");
  });

  it("per workspace: 200 flight searches per hour across users, then 429 for everyone in it", async () => {
    const wsId = oid();
    await col("customerworkspaces").insertOne(ws(wsId, "L3", "APPROVAL_FLOW") as any);
    const users = Array.from({ length: SEARCH_LIMITS.flight.perWorkspace / SEARCH_LIMITS.flight.perUser }, oid);
    for (const u of users) {
      for (let i = 0; i < SEARCH_LIMITS.flight.perUser; i++) {
        expect((await as(request(app).post("/api/approvals/search/flights"), u, wsId)).status).toBe(400);
      }
    }
    const fresh = await as(request(app).post("/api/approvals/search/flights"), oid(), wsId);
    expect([fresh.status, fresh.body.code]).toEqual([429, "SEARCH_RATE_LIMITED_WORKSPACE"]);
    // a different workspace is unaffected
    expect((await as(request(app).post("/api/approvals/search/flights"), oid(), WS2)).status).toBe(400);
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
    const r = await createReq(U.req, WS, [{ type: "hotel", title: "Mumbai", qty: 1, meta: { travellers: TRAV, city: "Mumbai", optionRef: optionRefFor(h.sid, 0, 0) } }]);
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

/* ── live search (TBO stubbed) ───────────────────────────────────────────── */

const { isPriceKey } = await import("./approvals.security.js");

function priceKeyPaths(v: any, path = "$"): string[] {
  if (!v || typeof v !== "object") return [];
  const out: string[] = [];
  for (const k of Object.keys(v)) {
    const p = Array.isArray(v) ? `${path}[${k}]` : `${path}.${k}`;
    if (!Array.isArray(v) && isPriceKey(k)) out.push(p);
    out.push(...priceKeyPaths(v[k], p));
  }
  return out;
}
const CURRENCY = /(₹|&#8377;|\bINR\b|\bRs\.?)\s*\d|\d[\d,]*\s*(₹|\bINR\b)/i;
function expectNoPrices(body: any) {
  expect(priceKeyPaths(body)).toEqual([]);
  expect(JSON.stringify(body)).not.toMatch(CURRENCY);
  expect(JSON.stringify(body)).not.toMatch(/5432|28400|_net|_margin|_markup|_display|DayRates|TotalFare|PublishedFare/);
}

const money = {
  Fare: { Currency: "INR", BaseFare: 4632, Tax: 800, PublishedFare: 5432, OfferedFare: 5280, TotalFare: 5432, CommissionEarned: 120 },
  FareBreakdown: [{ PassengerType: 1, BaseFare: 4632, Tax: 800 }],
  MiniFareRules: [[{ Type: "Cancellation", Details: "INR 3,500" }]],
  _netPublishedFare: 5100, _marginPercent: 6, _marginAmount: 332,
};
const tboSeg = (no: string, from: string, to: string, dep: string, arr: string, seats = 9) => ({
  Airline: { AirlineCode: "6E", AirlineName: "IndiGo", FlightNumber: no },
  Origin: { Airport: { AirportCode: from, CityName: from, Terminal: "1" }, DepTime: dep },
  Destination: { Airport: { AirportCode: to, CityName: to, Terminal: "2" }, ArrTime: arr },
  Duration: 105, GroundTime: 0, Baggage: "15 Kg", CabinBaggage: "7 Kg", CabinClass: 2, NoOfSeatAvailable: seats,
});
const tboFlight = (idx: string, segs: any[][], extra: any = {}) => ({
  ResultIndex: idx, IsLCC: true, IsRefundable: true, FareClassification: { Type: "Saver" }, ...money, Segments: segs, ...extra,
});
const tboOk = (results: any[]) => ({ Response: { ResponseStatus: 1, TraceId: "trace-x", Results: results } });

const flightBody = (extra: any = {}) => ({
  origin: "blr", destination: "bom", departDate: "2026-10-12", tripType: "oneway", adults: 2, cabinClass: "Business", ...extra,
});
const searchFlightsAs = (sub: any, body: any) => as(request(app).post("/api/approvals/search/flights"), sub, WS).send(body);

describe("POST /search/flights", () => {
  beforeEach(() => {
    tbo.flights.mockReset();
    delete process.env.APPROVAL_SEARCH_TIMEOUT_MS;
  });

  it("one-way: calls the shared searchFlights, returns price-free options in departure order with optionRefs", async () => {
    // TBO order is by price; ours must not be.
    tbo.flights.mockResolvedValue(tboOk([[
      tboFlight("OB3", [[tboSeg("1101", "BLR", "BOM", "2026-10-12T13:45:00", "2026-10-12T15:30:00")]]),
      tboFlight("OB1", [[tboSeg("5321", "BLR", "BOM", "2026-10-12T06:10:00", "2026-10-12T07:55:00", 3)]], { FareClassification: { Type: "Flexi" } }),
      tboFlight("OB2", [[tboSeg("639", "BLR", "BOM", "2026-10-12T09:00:00", "2026-10-12T10:50:00")]], { IsRefundable: false }),
    ]]));
    const u = oid();
    const r = await searchFlightsAs(u, flightBody());
    expect(r.status).toBe(200);
    expect(tbo.flights).toHaveBeenCalledWith(expect.objectContaining({
      origin: "BLR", destination: "BOM", departDate: "2026-10-12", JourneyType: 1, adults: 2, cabinClass: 4,
    }));
    expect(r.body.tripKind).toBe("OW");
    expect(r.body.outbound.map((o: any) => o.legs[0].segments[0].flightNumber)).toEqual(["5321", "639", "1101"]);
    expect(r.body.outbound[0].legs[0]).toMatchObject({ productLabel: "Flexi", seatsLeft: 3, refundable: true });
    expect(r.body.outbound[1].legs[0].refundable).toBe(false);
    expect(r.body.inbound).toEqual([]);
    expectNoPrices(r.body);

    const session: any = await col("approvalsearchsessions").findOne({ userId: String(u) });
    expect(session.results[0].Fare.PublishedFare).toBe(5432);
    expect(session.results.map((x: any) => x.ResultIndex)).toEqual(["OB1", "OB2", "OB3"]);
    expect(r.body.outbound[0].optionRef).toBe(`${session.sid}.0`);
  });

  it("domestic return: both directions listed; attaching out + return builds a two-leg selection", async () => {
    tbo.flights.mockResolvedValue(tboOk([
      [tboFlight("OB1", [[tboSeg("5321", "BLR", "BOM", "2026-10-12T06:10:00", "2026-10-12T07:55:00")]])],
      [tboFlight("IB1", [[tboSeg("640", "BOM", "BLR", "2026-10-15T18:00:00", "2026-10-15T19:50:00")]], { IsRefundable: false })],
    ]));
    const r = await searchFlightsAs(U.req, flightBody({ tripType: "roundtrip", returnDate: "2026-10-15" }));
    expect(tbo.flights).toHaveBeenCalledWith(expect.objectContaining({ JourneyType: 2, returnDate: "2026-10-15" }));
    expect(r.body.tripKind).toBe("RT_DOM");
    expect(r.body.inbound[0].legs[0]).toMatchObject({ direction: "back", refundable: false });
    expectNoPrices(r.body);

    const created = await createReq(U.req, WS, [flightItem({
      optionRef: r.body.outbound[0].optionRef, returnOptionRef: r.body.inbound[0].optionRef, selection: r.body.outbound[0],
    })]);
    expect(created.status).toBe(200);
    const doc: any = await col("approvalrequests").findOne({});
    expect(doc.cartItems[0].meta.selection.tripKind).toBe("RT_DOM");
    expect(doc.cartItems[0].meta.selection.legs.map((l: any) => l.segments[0].flightNumber)).toEqual(["5321", "640"]);
    const snap: any = await col("approvalselectionsnapshots").findOne({});
    expect(snap.rawOption.back.Fare.PublishedFare).toBe(5432);
  });

  it("international return: one list, each option carries both legs", async () => {
    tbo.flights.mockResolvedValue(tboOk([[
      tboFlight("OB7", [
        [tboSeg("507", "BOM", "DXB", "2026-11-01T04:30:00", "2026-11-01T06:15:00")],
        [tboSeg("500", "DXB", "BOM", "2026-11-08T21:40:00", "2026-11-09T02:10:00")],
      ]),
    ]]));
    const r = await searchFlightsAs(U.req, flightBody({ origin: "BOM", destination: "DXB", departDate: "2026-11-01", tripType: "roundtrip", returnDate: "2026-11-08" }));
    expect(r.body.tripKind).toBe("RT_INTL");
    expect(r.body.outbound[0].legs.map((l: any) => l.direction)).toEqual(["out", "back"]);
    expect(r.body.inbound).toEqual([]);
    expectNoPrices(r.body);
  });

  it("a TBO failure is 503 'Live search unavailable', never 'no flights'; only a real empty result says 'No flights found'", async () => {
    tbo.flights.mockResolvedValueOnce({ Response: { ResponseStatus: 2, Error: { ErrorCode: 3, ErrorMessage: "Agency is not active" } } });
    let r = await searchFlightsAs(U.req, flightBody());
    expect([r.status, r.body.error, r.body.code]).toEqual([503, "Live search unavailable — enter details manually", "TBO_ERROR"]);

    tbo.flights.mockRejectedValueOnce(new Error("socket hang up"));
    r = await searchFlightsAs(U.req, flightBody());
    expect([r.status, r.body.code]).toEqual([503, "TBO_ERROR"]);

    tbo.flights.mockResolvedValueOnce("<html>gateway</html>");
    r = await searchFlightsAs(U.req, flightBody());
    expect(r.status).toBe(503);

    process.env.APPROVAL_SEARCH_TIMEOUT_MS = "50";
    tbo.flights.mockReturnValueOnce(new Promise(() => {}));
    r = await searchFlightsAs(U.req, flightBody());
    expect([r.status, r.body.code]).toEqual([503, "SEARCH_TIMEOUT"]);
    delete process.env.APPROVAL_SEARCH_TIMEOUT_MS;

    tbo.flights.mockResolvedValueOnce({ Response: { ResponseStatus: 2, Error: { ErrorCode: 25, ErrorMessage: "No Result Found" } } });
    r = await searchFlightsAs(U.req, flightBody());
    expect([r.status, r.body.message, r.body.outbound]).toEqual([200, "No flights found", []]);

    tbo.flights.mockResolvedValueOnce(tboOk([[]]));
    r = await searchFlightsAs(U.req, flightBody());
    expect([r.status, r.body.message]).toEqual([200, "No flights found"]);
  });

  it("bad input and multi-city are 400 before TBO is called", async () => {
    expect((await searchFlightsAs(U.req, flightBody({ tripType: "multicity" }))).body.code).toBe("MULTICITY_NOT_SUPPORTED");
    expect((await searchFlightsAs(U.req, flightBody({ destination: "BLR" }))).status).toBe(400);
    expect((await searchFlightsAs(U.req, flightBody({ tripType: "roundtrip", returnDate: "2026-10-01" }))).status).toBe(400);
    expect(tbo.flights).not.toHaveBeenCalled();
  });
});

describe("POST /search/hotels", () => {
  const CITY = "144306";
  const room = (name: string, meal: string, total: number, refundable: boolean) => ({
    Name: [name], MealType: meal, IsRefundable: refundable, Inclusion: "Free WiFi",
    TotalFare: total, TotalTax: 3000, DayRates: [[{ BasePrice: total / 2 }]], RecommendedSellingRate: total + 900,
    _displayTotalFare: total + 1700, _netAmount: total - 2000, _markupAmount: 1700, BookingCode: `BC-${name}`,
    CancelPolicies: refundable ? [{ FromDate: "11-10-2026 00:00:00", ChargeType: "Percentage", CancellationCharge: 100 }] : [],
    Supplements: [[{ Description: "City tax", Price: 300, Currency: "INR" }]],
  });

  beforeAll(async () => {
    await col("tbocities").insertMany([
      { code: CITY, name: "Mumbai", searchName: "mumbai", countryCode: "IN" },
      { code: "999", name: "Mumbai Suburban Extra", searchName: "mumbai suburban extra", countryCode: "IN" },
    ]);
    // 120 catalog hotels: 20 five-star, 100 three-star — only the top 100 by stars get priced.
    await col("tbohotelmasters").insertMany(
      Array.from({ length: 120 }, (_, i) => ({
        hotelCode: String(1000 + i), hotelName: `Hotel ${String(i).padStart(3, "0")}`, cityCode: CITY, countryCode: "IN",
        rating: i < 20 ? "FiveStar" : "ThreeStar", address: `Street ${i}, Mumbai`,
      })),
    );
  });
  beforeEach(() => tbo.hotels.mockReset());

  const hotelBody = (extra: any = {}) => ({ city: "mumbai", checkIn: "2026-10-12", checkOut: "2026-10-14", adults: 3, rooms: 2, ...extra });
  const searchHotelsAs = (sub: any, body: any) => as(request(app).post("/api/approvals/search/hotels"), sub, WS).send(body);

  it("resolves the city from the catalog, prices only the top 100 by stars, returns price-free hotels by stars then name", async () => {
    // service output: cheapest first, no names (TBO search returns codes + rooms)
    tbo.hotels.mockResolvedValue({
      ok: true,
      hotels: [
        { HotelCode: "1050", Rooms: [room("Standard", "Room_Only", 6000, false)] },
        { HotelCode: "1003", Rooms: [room("Luxury", "BreakFast", 28400, true), room("Deluxe", "Room_Only", 21000, false)] },
        { HotelCode: "1001", Rooms: [room("Suite", "BreakFast", 40000, true)] },
      ],
    });
    const r = await searchHotelsAs(U.req, hotelBody());
    expect(r.status).toBe(200);

    const call = tbo.hotels.mock.calls[0][0];
    expect(call.HotelCodes).toHaveLength(100);
    expect(call.HotelCodes.slice(0, 20).sort()).toEqual(Array.from({ length: 20 }, (_, i) => String(1000 + i)).sort());
    expect(call).toMatchObject({ CityCode: CITY, CountryCode: "IN", CheckIn: "2026-10-12", CheckOut: "2026-10-14" });
    expect(call.Rooms).toEqual([{ Adults: 2, Children: 0, ChildrenAges: null }, { Adults: 1, Children: 0, ChildrenAges: null }]);

    expect(r.body.city).toEqual({ name: "Mumbai", countryCode: "IN" });
    expect(r.body.hotels.map((h: any) => [h.name, h.stars])).toEqual([["Hotel 001", 5], ["Hotel 003", 5], ["Hotel 050", 3]]);
    const h3 = r.body.hotels[1];
    expect(h3.rooms.map((x: any) => [x.roomName, x.mealPlan, x.refundable, x.cancelBy])).toEqual([
      ["Deluxe", "Room only", false, null],
      ["Luxury", "Breakfast", true, "2026-10-11"],
    ]);
    expect(h3.address).toBe("Street 3, Mumbai");
    expectNoPrices(r.body);

    // attach a room: selection rebuilt server-side from the session
    const created = await createReq(U.req, WS, [{ type: "hotel", title: "Mumbai", qty: 1, meta: { travellers: TRAV, city: "Mumbai", optionRef: h3.rooms[1].optionRef } }]);
    expect(created.status).toBe(200);
    const doc: any = await col("approvalrequests").findOne({});
    expect(doc.cartItems[0].meta.selection).toMatchObject({ kind: "hotel", name: "Hotel 003", roomName: "Luxury", stars: 5, checkIn: "2026-10-12" });
    const snap: any = await col("approvalselectionsnapshots").findOne({});
    expect(snap.rawOption.room.TotalFare).toBe(28400);
  });

  it("unknown city is a clear 400 and TBO is not called", async () => {
    const r = await searchHotelsAs(U.req, hotelBody({ city: "Mumbaai" }));
    expect([r.status, r.body.error, r.body.code]).toEqual([400, "City not found — check spelling", "CITY_NOT_FOUND"]);
    expect(tbo.hotels).not.toHaveBeenCalled();
  });

  it("TBO failure → 503; a real empty result → 'No hotels found'", async () => {
    tbo.hotels.mockResolvedValueOnce({ ok: false, status: 502, code: "HOTEL_API_ERROR", message: "x" });
    let r = await searchHotelsAs(U.req, hotelBody());
    expect([r.status, r.body.error]).toEqual([503, "Live search unavailable — enter details manually"]);

    tbo.hotels.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect((await searchHotelsAs(U.req, hotelBody())).status).toBe(503);

    tbo.hotels.mockResolvedValueOnce({ ok: false, status: 404, code: "NO_HOTELS_FOUND", message: "x" });
    r = await searchHotelsAs(U.req, hotelBody());
    expect([r.status, r.body.message, r.body.hotels]).toEqual([200, "No hotels found", []]);
  });
});

/* ── emails + leader access ──────────────────────────────────────────────── */

describe("the picked option in emails, and no snapshot for a Workspace Leader", () => {
  beforeEach(() => {
    tbo.flights.mockReset();
    mails.length = 0;
  });

  it("approver email and leader FYI show the selected flight, with no price", async () => {
    tbo.flights.mockResolvedValue(tboOk([
      [tboFlight("OB1", [[tboSeg("5321", "BLR", "BOM", "2026-10-12T06:10:00", "2026-10-12T07:55:00")]])],
      [tboFlight("IB1", [[tboSeg("640", "BOM", "BLR", "2026-10-15T18:00:00", "2026-10-15T19:50:00")]], { IsRefundable: false })],
    ]));
    const r = await searchFlightsAs(U.req, flightBody({ tripType: "roundtrip", returnDate: "2026-10-15" }));
    const created = await createReq(U.req, WS, [flightItem({
      tripType: "roundtrip", returnDate: "2026-10-15",
      optionRef: r.body.outbound[0].optionRef, returnOptionRef: r.body.inbound[0].optionRef,
    })]);
    expect(created.status).toBe(200);

    const approver = mails.find((m) => String(m.to).includes("approver@cust.test"));
    expect(approver, mails.map((m) => m.subject).join(" | ")).toBeTruthy();
    expect(approver!.html).toContain("Outbound flight");
    expect(approver!.html).toContain("IndiGo 6E 5321");
    expect(approver!.html).toContain("Return flight");
    expect(approver!.html).toContain("6E 640");
    expect(approver!.html).toMatch(/BLR 06:10 → BOM 07:55 · 12 Oct 2026 · 1h 45m · Non-stop/);
    expect(approver!.html).toMatch(/Economy · 15 Kg \+ 7 Kg cabin · Saver · Refundable/);
    expect(approver!.html).toContain("Non-refundable");

    const fyi = mails.find((m) => /^FYI/.test(m.subject));
    expect(fyi, mails.map((m) => m.subject).join(" | ")).toBeTruthy();
    expect(fyi!.html).toContain("Selected: 6E 5321 BLR 06:10 → BOM 07:55");

    for (const m of [approver!, fyi!]) {
      expect(m.html).not.toMatch(/₹|&#8377;|\bINR\b|\bRs\.?\s*\d/);
      expect(m.html).not.toMatch(/5432|5280|4632|Fare|fare/);
    }
  });

  it("hotel selection in the approver email: name, stars, room, meal plan, cancel-by", async () => {
    const h = await createSearchSession({
      workspaceId: WS, userId: String(U.req), kind: "hotel", params: { CheckIn: "2026-10-12", CheckOut: "2026-10-14" },
      results: [{ ...hotelRaw, Rooms: [{ ...hotelRaw.Rooms[0], CancelPolicies: [{ FromDate: "10-10-2026 00:00:00", CancellationCharge: 100 }] }] }],
    });
    await createReq(U.req, WS, [{ type: "hotel", title: "Mumbai", qty: 1, meta: { travellers: TRAV, city: "Mumbai", checkIn: "2026-10-12", checkOut: "2026-10-14", optionRef: optionRefFor(h.sid, 0, 0) } }]);
    const approver = mails.find((m) => String(m.to).includes("approver@cust.test"));
    expect(approver!.html).toContain("Taj Lands End (5★)");
    expect(approver!.html).toContain("Luxury Room · Breakfast");
    expect(approver!.html).toContain("free cancellation before 10 Oct 2026");
    expect(approver!.html).not.toMatch(/₹|\bINR\b|28400|14200/);
  });

  it("a Workspace Leader cannot read the snapshot of a request in their own workspace", async () => {
    const sid = await flightSession(U.req, WS);
    await createReq(U.req, WS, [flightItem({ optionRef: optionRefFor(sid, 0) })]);
    const id = String((await col("approvalrequests").findOne({}))!._id);
    const r = await as(request(app).get(`/api/approvals/admin/requests/${id}/selection-snapshot`), U.wl, WS, ["WORKSPACE_LEADER"]);
    expect(r.status).toBe(403);
    expect(r.body.snapshots).toBeUndefined();
    // the same leader still reads the request itself, with the price-free selection only
    const detail = await as(request(app).get(`/api/approvals/admin/requests/${id}`), U.wl, WS, ["WORKSPACE_LEADER"]);
    expect(detail.status).toBe(200);
    expect(detail.body.cartItems[0].meta.selection.kind).toBe("flight");
    expect(JSON.stringify(detail.body)).not.toMatch(/5432|PublishedFare|rawOption/);
  });
});
