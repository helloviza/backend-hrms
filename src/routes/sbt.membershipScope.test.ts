// apps/backend/src/routes/sbt.membershipScope.test.ts
//
// Company switcher Phase 3a — SBT reads the company from the session
// (docs/audits/multi-workspace-login-audit.md §7.1 SBT rows, §7.2, §8.5).
//
// The PROOF, end to end through real requireAuth (signed JWTs) and real
// requireWorkspace on in-memory Mongo:
//
//   1. One-company users: every changed route gives the same answer with a
//      legacy token (no mid) and a membership token (wsid/mid/mver) — and the
//      same answer as before this change: this file imports nothing new, so it
//      also runs unchanged against origin/main, where block 1 passes as is.
//      Includes a user whose membership flags have drifted from the User
//      document: the User document still decides, as it always did.
//   2. A user in TWO companies (fixture only): in the second company they are
//      never refused WORKSPACE_MISMATCH, read their roles / SBT flags from that
//      membership, write that company's customerId, and see / cancel / book
//      only that company's requests; in their own company they no longer see
//      the second company's. (Fails on origin/main, by design.)
//   3. §7.2 id-space bug: concierge raise-request and the Pluto AI handoff
//      write SBTRequest.customerId = Customer._id (not the workspace _id) and
//      find the company's leader by it. HOUSE staff are unchanged.
//
// Stubbed: mail, TBO (TBO_ENV=mock search), loggers. Everything else is real.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { MongoMemoryServer } from "mongodb-memory-server";

vi.hoisted(() => {
  process.env.NODE_ENV = "test";
  for (const [k, v] of Object.entries({
    MONGO_URI: "mongodb://127.0.0.1:1/unused",
    JWT_SECRET: "jwt-secret-for-tests",
    JWT_REFRESH_SECRET: "refresh-secret-for-tests",
    FRONTEND_ORIGIN: "http://localhost:5173",
    AWS_REGION: "ap-south-1",
    S3_BUCKET: "test-bucket",
    GEMINI_API_KEY: "test",
    OPENAI_API_KEY: "test-key",
  })) process.env[k] ||= v;
  process.env.TBO_ENV = "mock";
  delete process.env.MEMBERSHIP_SESSION_DISABLED;
});

vi.mock("../utils/mailer.js", async (orig) => ({ ...(await orig<any>()), sendMail: vi.fn(async () => ({})) }));
vi.mock("../utils/tboFileLogger.js", () => ({ logTBOCall: () => {}, listTBOLogs: () => [], readTBOLog: () => null }));
vi.mock("../services/tbo.log.consolidator.js", () => ({ consolidateCertificationLogs: async () => {} }));
vi.mock("../jobs/static-data-refresh.js", () => ({
  resolveCityCodeAgainstCatalog: () => null,
  resolveCityCode: () => null,
  TBOHotelMaster: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));
vi.mock("../jobs/deferred-status-check.js", () => ({ runDeferredStatusCheck: async () => {} }));

const { requireAuth } = await import("../middleware/auth.js");
const { clearMembershipCache } = await import("../middleware/requireWorkspace.js");
const { syncMembershipFromUser } = await import("../services/workspaceMembership.service.js");
const { bookableRequest } = await import("../services/sbtRequestBooking.js");
const { sendHandoffPayload } = await import("../utils/plutoHandoffSink.js");
const { default: requestsRouter } = await import("./sbt.requests.js");
const { default: flightsRouter } = await import("./sbt.flights.js");
const { default: hotelsRouter } = await import("./sbt.hotels.js");
const { default: travelFormRouter } = await import("./travelForm.js");
const { default: copilotRouter } = await import("./copilot.travel.js");

const app = express();
app.use(express.json());
app.use("/api/sbt/requests", requestsRouter);
app.use("/api/sbt/flights", flightsRouter);
app.use("/api/sbt/hotels", hotelsRouter);
app.use("/api/travel-form", travelFormRouter);
app.use("/api/v1/copilot/travel", requireAuth, copilotRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const CUST_A = oid(); const WS_A = oid();
const CUST_B = oid(); const WS_B = oid();
const U = {
  l1: oid(), l2a: oid(), wla: oid(), drift: oid(), off: oid(), // company A, one company each
  l2b: oid(), wlb: oid(),                                      // company B, one company each
  dual: oid(),                                                 // A (User doc) + B (second membership)
  staff: oid(),                                                // HOUSE staff
};
const R = { l1A: oid(), dualA: oid(), dualB: oid(), assignedDualA: oid(), assignedDualB: oid() };
let MID_B: mongoose.Types.ObjectId;
// The workspaces run with travelFormEnabled, so raising a request names a form.
const TF = { A: oid(), B: oid() };

const FEATURES = { sbtEnabled: true, flightBookingEnabled: true, hotelBookingEnabled: true, travelFormEnabled: true };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sbt-membership-scope-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

beforeEach(async () => {
  clearMembershipCache();
  await mongoose.connection.db!.dropDatabase();
  await mongoose.model("WorkspaceMembership").init();
  await col("customerworkspaces").insertMany([
    { _id: HOUSE, customerId: String(HOUSE), companyName: "Plumtrips", status: "ACTIVE", tenantType: "HOUSE",
      defaultApproverEmails: ["desk@plumtrips.com"], config: { features: FEATURES } },
    { _id: WS_A, customerId: String(CUST_A), companyName: "Acme", status: "ACTIVE", tenantType: "CORPORATE", config: { features: FEATURES } },
    { _id: WS_B, customerId: String(CUST_B), companyName: "Beta", status: "ACTIVE", tenantType: "CORPORATE", config: { features: FEATURES } },
  ] as any[]);
  await col("customers").insertMany([{ _id: CUST_A, name: "Acme" }, { _id: CUST_B, name: "Beta" }] as any[]);
  const at = new Date("2026-01-01T00:00:00Z");
  const a = { customerId: String(CUST_A), businessId: String(CUST_A), status: "ACTIVE", createdAt: at, updatedAt: at };
  const b = { customerId: String(CUST_B), businessId: String(CUST_B), status: "ACTIVE", createdAt: at, updatedAt: at };
  await col("users").insertMany([
    { _id: U.l1, email: "l1@acme.test", name: "Lata", roles: ["CUSTOMER"], sbtEnabled: true, sbtRole: "L1", sbtBookingType: "both", sbtAssignedBookerId: U.l2a, ...a },
    { _id: U.l2a, email: "l2@acme.test", name: "Ravi", roles: ["CUSTOMER"], sbtEnabled: true, sbtRole: "L2", ...a },
    { _id: U.wla, email: "wl@acme.test", name: "Asha", roles: ["WORKSPACE_LEADER"], sbtEnabled: true, ...a },
    { _id: U.drift, email: "drift@acme.test", name: "Dev", roles: ["CUSTOMER"], sbtEnabled: true, sbtRole: "L1", sbtBookingType: "both", sbtAssignedBookerId: U.l2a, ...a },
    { _id: U.off, email: "off@acme.test", name: "Omar", roles: ["CUSTOMER"], sbtEnabled: false, sbtRole: "L1", ...a },
    { _id: U.l2b, email: "l2@beta.test", name: "Bina", roles: ["CUSTOMER"], sbtEnabled: true, sbtRole: "L2", ...b },
    { _id: U.wlb, email: "wl@beta.test", name: "Bala", roles: ["WORKSPACE_LEADER"], sbtEnabled: true, ...b },
    // The User document describes company A only.
    { _id: U.dual, email: "dual@acme.test", name: "Dia", roles: ["CUSTOMER"], sbtEnabled: true, sbtRole: "L1", sbtBookingType: "both", sbtAssignedBookerId: U.l2a, ...a },
    { _id: U.staff, email: "ops.person@plumtrips.com", name: "Ops", roles: ["EMPLOYEE"], workspaceId: HOUSE, status: "ACTIVE", createdAt: at, updatedAt: at },
    { email: "desk@plumtrips.com", name: "Desk", roles: ["EMPLOYEE"], workspaceId: HOUSE, status: "ACTIVE", createdAt: at, updatedAt: at },
  ] as any[]);
  // The live state: one default membership per user, written by Phase 1/2.
  for (const id of Object.values(U)) await syncMembershipFromUser(id, { source: "test" });
  // Drift: the membership copy says "no SBT" — the User document must still decide.
  await col("workspacememberships").updateOne({ userId: U.drift }, { $set: { flags: { sbtEnabled: false, sbtRole: null, sbtBookingType: "hotel" } } });
  // Fixture only: Dia's SECOND company — B, as an SBT BOTH user booking flights only.
  MID_B = oid();
  await col("workspacememberships").insertOne({
    _id: MID_B, userId: U.dual, workspaceId: WS_B, customerId: String(CUST_B), kind: "CUSTOMER",
    roles: ["CUSTOMER"], memberRole: "REQUESTER", customerMemberId: null, levelCode: null,
    flags: { sbtEnabled: true, sbtRole: "BOTH", sbtBookingType: "flight", sbtAssignedBookerId: U.l2b, canRaiseRequest: true },
    status: "ACTIVE", isDefault: false, tokenVersion: 0, createdAt: at, updatedAt: at,
  } as any);
  await col("travelforms").insertMany([{ _id: TF.A, workspaceId: WS_A }, { _id: TF.B, workspaceId: WS_B }] as any[]);
  const base = { type: "flight", searchParams: { origin: "DEL", destination: "BOM" }, selectedOption: { ResultIndex: "RI" }, status: "PENDING", requestedAt: at };
  await col("sbtrequests").insertMany([
    { _id: R.l1A, workspaceId: WS_A, customerId: CUST_A, requesterId: U.l1, assignedBookerId: U.l2a, ...base },
    { _id: R.dualA, workspaceId: WS_A, customerId: CUST_A, requesterId: U.dual, assignedBookerId: U.l2a, ...base },
    { _id: R.dualB, workspaceId: WS_B, customerId: CUST_B, requesterId: U.dual, assignedBookerId: U.l2b, ...base },
    { _id: R.assignedDualA, workspaceId: WS_A, customerId: CUST_A, requesterId: U.l1, assignedBookerId: U.dual, ...base },
    { _id: R.assignedDualB, workspaceId: WS_B, customerId: CUST_B, requesterId: U.l2b, assignedBookerId: U.dual, ...base },
  ] as any[]);
});

/* ── tokens: exactly what login mints ── */
async function membershipOf(userId: mongoose.Types.ObjectId, workspaceId?: mongoose.Types.ObjectId) {
  const q: any = { userId };
  if (workspaceId) q.workspaceId = workspaceId; else q.isDefault = true;
  return (await col("workspacememberships").findOne(q)) as any;
}
async function tokenFor(userId: mongoose.Types.ObjectId, opts: { legacy?: boolean; ws?: mongoose.Types.ObjectId } = {}) {
  const u: any = await col("users").findOne({ _id: userId });
  const m = await membershipOf(userId, opts.ws);
  const customerId = opts.ws ? String(m.customerId) : u.customerId;
  const claims: any = {
    sub: String(u._id), _id: String(u._id), id: String(u._id), email: u.email, name: u.name, roles: m?.roles?.length ? m.roles : u.roles,
    ...(customerId ? { customerId, businessId: customerId } : {}),
    ...(u.workspaceId && !customerId ? { workspaceId: String(u.workspaceId) } : {}),
  };
  if (!opts.legacy) Object.assign(claims, { wsid: String(m.workspaceId), mid: String(m._id), mver: Number(m.tokenVersion ?? 0) });
  return jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: "10m" });
}
const call = (r: request.Test, token: string) => r.set("Authorization", `Bearer ${token}`);
const ids = (rows: any[]) => rows.map((r) => String(r._id)).sort();
const sortIds = (...xs: mongoose.Types.ObjectId[]) => xs.map(String).sort();
const BOTH_TOKENS = [["legacy token", true], ["membership token", false]] as const;

/* ═══════════════ 1. one-company users: unchanged ═══════════════ */
describe.each(BOTH_TOKENS)("one-company users, %s — same answers as before", (_label, legacy) => {
  it("L1 raises a request: 201, own company's customerId, own assigned booker", async () => {
    const t = await tokenFor(U.l1, { legacy });
    const res = await call(request(app).post("/api/sbt/requests"), t).send({ type: "flight", searchParams: { origin: "DEL" }, selectedOption: { ResultIndex: "X" }, travelFormId: String(TF.A) });
    expect(res.status).toBe(201);
    const row: any = await col("sbtrequests").findOne({ _id: new mongoose.Types.ObjectId(res.body._id) });
    expect(String(row.customerId)).toBe(String(CUST_A));
    expect(String(row.workspaceId)).toBe(String(WS_A));
    expect(String(row.assignedBookerId)).toBe(String(U.l2a));
  });

  it("L1 with no booker falls back to the company's Workspace Leader", async () => {
    await col("users").updateOne({ _id: U.l1 }, { $set: { sbtAssignedBookerId: null } });
    const t = await tokenFor(U.l1, { legacy });
    const res = await call(request(app).post("/api/sbt/requests"), t).send({ type: "flight", searchParams: {}, selectedOption: {}, travelFormId: String(TF.A) });
    expect(res.status).toBe(201);
    expect(String(res.body.assignedBookerId)).toBe(String(U.wla));
  });

  it("GET /my lists the L1's own requests", async () => {
    const res = await call(request(app).get("/api/sbt/requests/my"), await tokenFor(U.l1, { legacy }));
    expect(res.status).toBe(200);
    expect(ids(res.body.requests)).toEqual(sortIds(R.l1A, R.assignedDualA)); // both raised by Lata
  });

  it("an L2 cannot use /my (NOT_L1); an L1 cannot use the inbox (NOT_L2)", async () => {
    expect((await call(request(app).get("/api/sbt/requests/my"), await tokenFor(U.l2a, { legacy }))).body.code).toBe("NOT_L1");
    expect((await call(request(app).get("/api/sbt/requests/inbox"), await tokenFor(U.l1, { legacy }))).body.code).toBe("NOT_L2");
  });

  it("L1 cancels their own PENDING request", async () => {
    const res = await call(request(app).delete(`/api/sbt/requests/${R.l1A}/cancel`), await tokenFor(U.l1, { legacy }));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");
  });

  it("L2 inbox: the requests assigned to them; WL inbox: the whole company", async () => {
    const l2 = await call(request(app).get("/api/sbt/requests/inbox?status=ALL"), await tokenFor(U.l2a, { legacy }));
    expect(l2.status).toBe(200);
    expect(ids(l2.body.requests)).toEqual(sortIds(R.l1A, R.dualA));
    const wl = await call(request(app).get("/api/sbt/requests/inbox?status=ALL"), await tokenFor(U.wla, { legacy }));
    expect(ids(wl.body.requests)).toEqual(sortIds(R.l1A, R.dualA, R.assignedDualA));
  });

  it("L2 rejects an assigned request; the WL may open any company request", async () => {
    const rej = await call(request(app).post(`/api/sbt/requests/${R.l1A}/reject`), await tokenFor(U.l2a, { legacy })).send({ rejectionReason: "full" });
    expect(rej.status).toBe(200);
    expect(rej.body.status).toBe("REJECTED");
    const det = await call(request(app).get(`/api/sbt/requests/${R.dualA}`), await tokenFor(U.wla, { legacy }));
    expect(det.status).toBe(200);
  });

  it("flights / hotels search and the travel form admit an SBT user; refuse sbtEnabled=false", async () => {
    const t = await tokenFor(U.l1, { legacy });
    expect((await call(request(app).post("/api/sbt/flights/search"), t).send({})).status).toBe(200);
    expect((await call(request(app).post("/api/sbt/hotels/search"), t).send({})).status).toBe(200);
    expect((await call(request(app).get("/api/travel-form/find-trip"), t)).status).toBe(400); // past the guards
    const off = await tokenFor(U.off, { legacy });
    for (const r of [request(app).post("/api/sbt/flights/search"), request(app).post("/api/sbt/hotels/search")]) {
      const res = await call(r, off).send({});
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("SBT access not enabled for this account");
    }
    expect((await call(request(app).get("/api/travel-form/find-trip"), off)).status).toBe(403);
  });

  it("sbtBookingType on the User still limits the product", async () => {
    await col("users").updateOne({ _id: U.l1 }, { $set: { sbtBookingType: "hotel" } });
    const t = await tokenFor(U.l1, { legacy });
    expect((await call(request(app).post("/api/sbt/flights/search"), t).send({})).body.code).toBe("FLIGHT_ACCESS_DENIED");
    expect((await call(request(app).post("/api/sbt/hotels/search"), t).send({})).status).toBe(200);
  });

  it("company travelMode (looked up by the company's customerId) still applies", async () => {
    await col("customerworkspaces").updateOne({ _id: WS_A }, { $set: { travelMode: "HOTELS_ONLY" } });
    const t = await tokenFor(U.l1, { legacy });
    expect((await call(request(app).post("/api/sbt/flights/search"), t).send({})).body.code).toBe("COMPANY_FLIGHT_ACCESS_DENIED");
  });

  it("drifted membership flags change nothing: the User document decides", async () => {
    const t = await tokenFor(U.drift, { legacy });
    expect((await call(request(app).post("/api/sbt/flights/search"), t).send({})).status).toBe(200);
    expect((await call(request(app).get("/api/sbt/requests/my"), t)).status).toBe(200);
    expect((await call(request(app).post("/api/sbt/requests"), t).send({ type: "flight", searchParams: {}, selectedOption: {}, travelFormId: String(TF.A) })).status).toBe(201);
  });

  it("bookableRequest: the assigned L2 and the WL may book, another company's user may not", async () => {
    const asReq = async (uid: mongoose.Types.ObjectId, ws: mongoose.Types.ObjectId) => {
      const t = jwt.decode(await tokenFor(uid, { legacy })) as any;
      const w: any = await col("customerworkspaces").findOne({ _id: ws });
      return { user: t, workspaceObjectId: ws, workspace: w };
    };
    expect(await bookableRequest(await asReq(U.l2a, WS_A), String(R.l1A), "flight")).toBeTruthy();
    expect(await bookableRequest(await asReq(U.wla, WS_A), String(R.l1A), "flight")).toBeTruthy();
    expect(await bookableRequest(await asReq(U.l1, WS_A), String(R.l1A), "flight")).toBeNull();
  });
});

/* ═══════════════ 2. a user in two companies ═══════════════ */
describe("a user in TWO companies acts only as the session's company", () => {
  it("in company B: never WORKSPACE_MISMATCH; the request is B's, booked by B's assigned L2", async () => {
    const t = await tokenFor(U.dual, { ws: WS_B });
    const res = await call(request(app).post("/api/sbt/requests"), t).send({ type: "flight", searchParams: {}, selectedOption: {}, travelFormId: String(TF.B) });
    expect(res.status).toBe(201);
    const row: any = await col("sbtrequests").findOne({ _id: new mongoose.Types.ObjectId(res.body._id) });
    expect(String(row.customerId)).toBe(String(CUST_B));
    expect(String(row.workspaceId)).toBe(String(WS_B));
    expect(String(row.assignedBookerId)).toBe(String(U.l2b)); // B's flag, not the User's (l2a)
  });

  it("in company B with no booker set: B's Workspace Leader, never A's", async () => {
    await col("workspacememberships").updateOne({ _id: MID_B }, { $set: { "flags.sbtAssignedBookerId": null } });
    await col("workspacememberships").updateOne({ userId: U.wlb }, { $set: { roles: ["WORKSPACE_LEADER"] } });
    const res = await call(request(app).post("/api/sbt/requests"), await tokenFor(U.dual, { ws: WS_B })).send({ type: "flight", searchParams: {}, selectedOption: {}, travelFormId: String(TF.B) });
    expect(res.status).toBe(201);
    expect(String(res.body.assignedBookerId)).toBe(String(U.wlb));
  });

  it("in company B: /my shows only B's requests; in A only A's", async () => {
    const inB = await call(request(app).get("/api/sbt/requests/my"), await tokenFor(U.dual, { ws: WS_B }));
    expect(inB.status).toBe(200);
    expect(ids(inB.body.requests)).toEqual([String(R.dualB)]);
    const inA = await call(request(app).get("/api/sbt/requests/my"), await tokenFor(U.dual));
    expect(inA.status).toBe(200);
    expect(ids(inA.body.requests)).toEqual([String(R.dualA)]);
  });

  it("cannot cancel the other company's request from this session", async () => {
    const fromB = await call(request(app).delete(`/api/sbt/requests/${R.dualA}/cancel`), await tokenFor(U.dual, { ws: WS_B }));
    expect(fromB.status).toBe(404);
    expect(((await col("sbtrequests").findOne({ _id: R.dualA })) as any).status).toBe("PENDING");
    const own = await call(request(app).delete(`/api/sbt/requests/${R.dualB}/cancel`), await tokenFor(U.dual, { ws: WS_B }));
    expect(own.status).toBe(200);
  });

  it("in company B the inbox follows B's sbtRole (BOTH) and lists only B's assignments", async () => {
    const inB = await call(request(app).get("/api/sbt/requests/inbox?status=ALL"), await tokenFor(U.dual, { ws: WS_B }));
    expect(inB.status).toBe(200);
    expect(ids(inB.body.requests)).toEqual([String(R.assignedDualB)]);
    // In A, Dia's User document says L1 → no inbox, exactly as before.
    expect((await call(request(app).get("/api/sbt/requests/inbox"), await tokenFor(U.dual))).body.code).toBe("NOT_L2");
  });

  it("in company B may reject B's assignment, not A's", async () => {
    const t = await tokenFor(U.dual, { ws: WS_B });
    expect((await call(request(app).post(`/api/sbt/requests/${R.assignedDualA}/reject`), t).send({ rejectionReason: "x" })).status).toBe(403);
    expect((await call(request(app).post(`/api/sbt/requests/${R.assignedDualB}/reject`), t).send({ rejectionReason: "x" })).status).toBe(200);
  });

  it("each company's Workspace Leader sees only its own company's requests", async () => {
    const wlb = await call(request(app).get("/api/sbt/requests/inbox?status=ALL"), await tokenFor(U.wlb));
    expect(ids(wlb.body.requests)).toEqual(sortIds(R.dualB, R.assignedDualB));
  });

  it("flights / hotels in company B follow B's flags (sbtBookingType=flight)", async () => {
    const t = await tokenFor(U.dual, { ws: WS_B });
    expect((await call(request(app).post("/api/sbt/flights/search"), t).send({})).status).toBe(200);
    expect((await call(request(app).post("/api/sbt/hotels/search"), t).send({})).body.code).toBe("HOTEL_ACCESS_DENIED");
    // …and in A the User document's "both" still applies.
    expect((await call(request(app).post("/api/sbt/hotels/search"), await tokenFor(U.dual)).send({})).status).toBe(200);
  });

  it("company B's travelMode applies in B, not A's", async () => {
    await col("customerworkspaces").updateOne({ _id: WS_B }, { $set: { travelMode: "HOTELS_ONLY" } });
    expect((await call(request(app).post("/api/sbt/flights/search"), await tokenFor(U.dual, { ws: WS_B })).send({})).body.code).toBe("COMPANY_FLIGHT_ACCESS_DENIED");
    expect((await call(request(app).post("/api/sbt/flights/search"), await tokenFor(U.dual)).send({})).status).toBe(200);
  });

  it("the travel form is open in B (sbtEnabled from B's membership)", async () => {
    expect((await call(request(app).get("/api/travel-form/find-trip"), await tokenFor(U.dual, { ws: WS_B }))).status).toBe(400);
  });

  it("checkout: may book B's assignment in B; A's request is out of reach", async () => {
    const t = jwt.decode(await tokenFor(U.dual, { ws: WS_B })) as any;
    const ws: any = await col("customerworkspaces").findOne({ _id: WS_B });
    const reqB = { user: t, workspaceObjectId: WS_B, workspace: ws };
    expect(await bookableRequest(reqB, String(R.assignedDualB), "flight")).toBeTruthy();
    expect(await bookableRequest({ ...reqB }, String(R.assignedDualA), "flight")).toBeNull();
  });

  it("rollback (MEMBERSHIP_SESSION_DISABLED=true): the User document again decides everywhere", async () => {
    process.env.MEMBERSHIP_SESSION_DISABLED = "true";
    try {
      const t = await tokenFor(U.dual, { ws: WS_B });
      const res = await call(request(app).post("/api/sbt/requests"), t).send({ type: "flight", searchParams: {}, selectedOption: {}, travelFormId: String(TF.B) });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("WORKSPACE_MISMATCH"); // exactly origin/main's answer
      const inA = await call(request(app).get("/api/sbt/requests/my"), await tokenFor(U.dual));
      expect(ids(inA.body.requests)).toEqual(sortIds(R.dualA, R.dualB)); // unscoped, as before
    } finally {
      delete process.env.MEMBERSHIP_SESSION_DISABLED;
    }
  });

  it("a suspended second membership is refused outright (MEMBERSHIP_REVOKED), never falls back to A", async () => {
    await col("workspacememberships").updateOne({ _id: MID_B }, { $set: { status: "SUSPENDED" } });
    const res = await call(request(app).get("/api/sbt/requests/my"), await tokenFor(U.dual, { ws: WS_B }));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("MEMBERSHIP_REVOKED");
  });
});

/* ═══════════════ 3. §7.2 concierge / Pluto id-space fix ═══════════════ */
describe("concierge raise-request and the Pluto handoff write the Customer._id", () => {
  const flightData = { ResultIndex: "OB1", TraceId: "T1", origin: { code: "DEL" }, destination: { code: "BOM" }, departure: { date: "2026-12-01" } };

  it("a customer's request is filed under their company (was: 400 'No workspace found')", async () => {
    const res = await call(request(app).post("/api/v1/copilot/travel/raise-request"), await tokenFor(U.l1)).send({ flightData });
    expect(res.status).toBe(201);
    const row: any = await col("sbtrequests").findOne({ _id: new mongoose.Types.ObjectId(res.body.requestId) });
    expect(String(row.customerId)).toBe(String(CUST_A));
    expect(String(row.workspaceId)).toBe(String(WS_A));
    expect(String(row.assignedBookerId)).toBe(String(U.wla)); // A's leader, found by Customer._id
    // …so A's Workspace Leader now sees it in the inbox.
    const wl = await call(request(app).get("/api/sbt/requests/inbox"), await tokenFor(U.wla));
    expect(ids(wl.body.requests)).toContain(String(row._id));
  });

  it("in a second company it is that company's request and leader", async () => {
    const res = await call(request(app).post("/api/v1/copilot/travel/raise-request"), await tokenFor(U.dual, { ws: WS_B })).send({ flightData });
    expect(res.status).toBe(201);
    const row: any = await col("sbtrequests").findOne({ _id: new mongoose.Types.ObjectId(res.body.requestId) });
    expect(String(row.customerId)).toBe(String(CUST_B));
    expect(String(row.assignedBookerId)).toBe(String(U.wlb));
  });

  it("HOUSE staff: unchanged (HOUSE's customerId is its own _id)", async () => {
    const res = await call(request(app).post("/api/v1/copilot/travel/raise-request"), await tokenFor(U.staff, { legacy: true })).send({ flightData });
    expect(res.status).toBe(201);
    const row: any = await col("sbtrequests").findOne({ _id: new mongoose.Types.ObjectId(res.body.requestId) });
    expect(String(row.customerId)).toBe(String(HOUSE));
    expect(String(row.workspaceId)).toBe(String(HOUSE));
  });

  it("the Pluto AI handoff finds the company's leader and files the Customer._id (was: no_booker)", async () => {
    const out = await sendHandoffPayload(
      { summary: "Trip", priority: "P2", targetSLA: "4h", slaReason: "x", destination: "BOM" } as any,
      { workspaceObjectId: WS_A, requesterId: U.l1, requesterEmail: "l1@acme.test" },
    );
    expect(out.delivered).toBe(true);
    const row: any = await col("sbtrequests").findOne({ _id: new mongoose.Types.ObjectId(out.requestId) });
    expect(String(row.customerId)).toBe(String(CUST_A));
    expect(String(row.assignedBookerId)).toBe(String(U.wla));
  });

  it("a workspace with no customerId never borrows another company's leader", async () => {
    await col("customerworkspaces").updateOne({ _id: WS_A }, { $unset: { customerId: "" } });
    const out = await sendHandoffPayload(
      { summary: "Trip", priority: "P2", targetSLA: "4h", slaReason: "x" } as any,
      { workspaceObjectId: WS_A, requesterId: U.l1 },
    );
    expect(out).toEqual({ delivered: false, error: "no_booker" });
  });
});
