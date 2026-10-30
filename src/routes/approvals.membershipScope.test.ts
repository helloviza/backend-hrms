// apps/backend/src/routes/approvals.membershipScope.test.ts
//
// Company switcher Phase 3b — approvals read the company from the session
// (docs/audits/multi-workspace-login-audit.md §1.2(2), §7.1 Approvals rows).
//
// The PROOF, end to end through real requireAuth (signed JWTs) and real
// requireWorkspace on in-memory Mongo:
//
//   1. One-company users: every changed route gives the same answer with a
//      legacy token (no mid) and a membership token (wsid/mid/mver) — and the
//      same answer as before this change: this file imports nothing new, so it
//      also runs unchanged against origin/main, where block 1 passes as is.
//   2. A Workspace Leader of TWO companies (fixture only) sees, in each
//      session, only that company's admin pending / approved / done /
//      rejected lists, booking history and booking documents.
//   3. The sbtEnabled / canRaiseRequest checks no longer fail open (no User
//      row matched {_id, workspaceId} → allowed): in a second company, and
//      for a one-company User row that lacks workspaceId. The own company
//      reads the User by _id; Workspace Leaders of the session's company are
//      exempt on /mine, /inbox and raising — so a leader whose User.workspaceId
//      is stale is allowed exactly as before (3a).
//   4. Auto-approve routing and the leader inbox use the second company's
//      membership roles, not the login's global WORKSPACE_LEADER.
//   5. A decider whose second-company membership is suspended is inactive
//      there; their own company still reads the User document only.
// Blocks 2–5 fail on origin/main, by design.
//
// Tokens carry the User's global roles, as login mints them today (Phase 2:
// roles are still derived exactly as before). Stubbed: mail, TBO search.
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

vi.mock("../utils/mailer.js", async (orig) => ({ ...(await orig<any>()), sendMail: vi.fn(async () => ({ messageId: "test" })) }));
vi.mock("../services/tbo.flight.service.js", async (orig) => ({ ...(await orig<any>()), searchFlights: vi.fn() }));
vi.mock("../services/tbo.hotel.search.service.js", async (orig) => ({ ...(await orig<any>()), searchHotels: vi.fn() }));

const { clearMembershipCache } = await import("../middleware/requireWorkspace.js");
const { syncMembershipFromUser } = await import("../services/workspaceMembership.service.js");
const { applyRequestDecision } = await import("../services/approvalDecisions.js");
const { default: approvalsRouter } = await import("./approvals.js");
const { default: bookingHistoryRouter } = await import("./bookingHistory.js");

const app = express();
app.use(express.json());
app.use("/api/approvals", approvalsRouter);
app.use("/api/booking-history", bookingHistoryRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();

const CUST_A = oid(); const WS_A = oid();
const CUST_B = oid(); const WS_B = oid();
const U = {
  wla: oid(), reqA: oid(), sbtA: oid(), noRaiseA: oid(), // company A, one company each
  wlb: oid(), apprB: oid(),                              // company B, one company each
  dual: oid(),  // WL of A (User doc) + WL of B (second membership + CustomerMember)
  mixed: oid(), // WL of A (User doc) + plain requester in B (second membership)
};
const MID = { dualB: oid(), mixedB: oid() };
const R = {
  pendA: oid(), apprA: oid(), doneA: oid(), rejA: oid(),
  pendB: oid(), apprB: oid(), doneB: oid(), rejB: oid(),
};

const config = { travelFlow: "APPROVAL_FLOW", features: { approvalFlowEnabled: true } };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("approvals-membership-scope-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

beforeEach(async () => {
  clearMembershipCache();
  await mongoose.connection.db!.dropDatabase();
  await mongoose.model("WorkspaceMembership").init();
  await col("customerworkspaces").insertMany([
    { _id: WS_A, customerId: String(CUST_A), name: "Acme", companyName: "Acme", status: "ACTIVE", tenantType: "CORPORATE",
      defaultApproverEmails: ["wl@acme.test"], config },
    { _id: WS_B, customerId: String(CUST_B), name: "Beta", companyName: "Beta", status: "ACTIVE", tenantType: "CORPORATE",
      defaultApproverEmails: ["approver@beta.test"], config },
  ] as any[]);
  await col("customers").insertMany([{ _id: CUST_A, name: "Acme" }, { _id: CUST_B, name: "Beta" }] as any[]);
  await col("customermembers").insertMany([
    { customerId: String(CUST_A), email: "wl@acme.test", role: "WORKSPACE_LEADER", isActive: true },
    { customerId: String(CUST_A), email: "dual@acme.test", role: "WORKSPACE_LEADER", isActive: true },
    { customerId: String(CUST_A), email: "mixed@acme.test", role: "WORKSPACE_LEADER", isActive: true },
    { customerId: String(CUST_B), email: "wl@beta.test", role: "WORKSPACE_LEADER", isActive: true },
    { customerId: String(CUST_B), email: "dual@acme.test", role: "WORKSPACE_LEADER", isActive: true },
    { customerId: String(CUST_B), email: "mixed@acme.test", role: "REQUESTER", isActive: true },
  ] as any[]);
  const at = new Date("2026-01-01T00:00:00Z");
  // workspaceId as customerUsers.ts writes it on create.
  const a = { customerId: String(CUST_A), businessId: String(CUST_A), workspaceId: WS_A, status: "ACTIVE", createdAt: at, updatedAt: at };
  const b = { customerId: String(CUST_B), businessId: String(CUST_B), workspaceId: WS_B, status: "ACTIVE", createdAt: at, updatedAt: at };
  await col("users").insertMany([
    { _id: U.wla, email: "wl@acme.test", name: "Asha Leader", roles: ["WORKSPACE_LEADER"], ...a },
    { _id: U.reqA, email: "req@acme.test", name: "Ravi Rao", roles: ["CUSTOMER"], ...a },
    { _id: U.sbtA, email: "sbt@acme.test", name: "Sana Sbt", roles: ["CUSTOMER"], sbtEnabled: true, ...a },
    { _id: U.noRaiseA, email: "noraise@acme.test", name: "Nina No", roles: ["CUSTOMER"], canRaiseRequest: false, ...a },
    { _id: U.wlb, email: "wl@beta.test", name: "Bala Leader", roles: ["WORKSPACE_LEADER"], ...b },
    { _id: U.apprB, email: "approver@beta.test", name: "Bina Approver", roles: ["CUSTOMER"], ...b },
    // Both User documents describe company A only.
    { _id: U.dual, email: "dual@acme.test", name: "Dia Dual", roles: ["WORKSPACE_LEADER"], ...a },
    { _id: U.mixed, email: "mixed@acme.test", name: "Mo Mixed", roles: ["WORKSPACE_LEADER"], ...a },
  ] as any[]);
  // The live state: one default membership per user, written by Phase 1/2.
  for (const id of Object.values(U)) await syncMembershipFromUser(id, { source: "test" });
  // Fixture only: the second companies.
  const second = { kind: "CUSTOMER", workspaceId: WS_B, customerId: String(CUST_B), customerMemberId: null, levelCode: null,
    status: "ACTIVE", isDefault: false, tokenVersion: 0, createdAt: at, updatedAt: at };
  await col("workspacememberships").insertMany([
    { _id: MID.dualB, userId: U.dual, roles: ["WORKSPACE_LEADER"], memberRole: "WORKSPACE_LEADER",
      flags: { sbtEnabled: false, canRaiseRequest: true }, ...second },
    { _id: MID.mixedB, userId: U.mixed, roles: ["CUSTOMER"], memberRole: "REQUESTER",
      flags: { sbtEnabled: false, canRaiseRequest: true }, ...second },
  ] as any[]);

  const rows: any[] = [];
  for (const [ws, cust, sfx, by] of [[WS_A, CUST_A, "A", "req@acme.test"], [WS_B, CUST_B, "B", "approver@beta.test"]] as const) {
    const base = { workspaceId: ws, customerId: String(cust), frontlinerId: String(sfx === "A" ? U.reqA : U.apprB), frontlinerEmail: by, frontlinerName: "Someone",
      managerEmail: sfx === "A" ? "wl@acme.test" : "approver@beta.test", cartItems: [], history: [], createdAt: at, updatedAt: at };
    rows.push(
      { _id: (R as any)[`pend${sfx}`], ...base, status: "pending", stage: "REQUEST_RAISED", frontlinerEmail: sfx === "A" ? "req@acme.test" : "someone@beta.test" },
      { _id: (R as any)[`appr${sfx}`], ...base, status: "approved", adminState: "pending" },
      { _id: (R as any)[`done${sfx}`], ...base, status: "approved", adminState: "done",
        meta: { attachments: [{ kind: "admin_pdf", path: `/uploads/approvals/doc-${sfx}.pdf`, filename: `doc-${sfx}.pdf` }] } },
      { _id: (R as any)[`rej${sfx}`], ...base, status: "declined" },
    );
  }
  await col("approvalrequests").insertMany(rows);
});

/* ── tokens: what login mints today (global roles, the User's claims) ── */
async function tokenFor(userId: mongoose.Types.ObjectId, opts: { legacy?: boolean; ws?: mongoose.Types.ObjectId } = {}) {
  const u: any = await col("users").findOne({ _id: userId });
  const m: any = await col("workspacememberships").findOne(opts.ws ? { userId, workspaceId: opts.ws } : { userId, isDefault: true });
  const customerId = opts.ws ? String(m.customerId) : u.customerId;
  const claims: any = {
    sub: String(u._id), _id: String(u._id), id: String(u._id), email: u.email, name: u.name, roles: u.roles,
    customerId, businessId: customerId,
  };
  if (!opts.legacy) Object.assign(claims, { wsid: String(m.workspaceId), mid: String(m._id), mver: Number(m.tokenVersion ?? 0) });
  return jwt.sign(claims, process.env.JWT_SECRET!, { expiresIn: "10m" });
}
const call = (r: request.Test, token: string) => r.set("Authorization", `Bearer ${token}`);
const ids = (rows: any[]) => rows.map((r) => String(r._id)).sort();
const sortIds = (...xs: mongoose.Types.ObjectId[]) => xs.map(String).sort();
const LISTS = [
  ["pending", (s: "A" | "B") => [(R as any)[`appr${s}`]]],
  ["approved", (s: "A" | "B") => [(R as any)[`appr${s}`]]], // done rows are not listed by default
  ["done", (s: "A" | "B") => [(R as any)[`done${s}`]]],
  ["rejected", (s: "A" | "B") => [(R as any)[`rej${s}`]]],
] as const;
const BOTH_TOKENS = [["legacy token", true], ["membership token", false]] as const;

async function adminList(token: string, kind: string) {
  return call(request(app).get(`/api/approvals/admin/${kind}`), token);
}
async function historyIds(token: string) {
  const res = await call(request(app).get("/api/booking-history/history?states=done"), token);
  expect(res.status).toBe(200);
  return ids(res.body.rows);
}
/** "visible" = the documents rule let the caller through (the file itself is not on disk here). */
async function docVisible(token: string, sfx: "A" | "B") {
  const res = await call(request(app).get(`/api/approvals/attachments/doc-${sfx}.pdf/download`), token);
  expect(res.status).toBe(404);
  return res.body.error === "File missing on server";
}
const flightItem = () => ({
  type: "flight", title: "BLR → BOM", qty: 1, price: 4321,
  meta: { origin: "BLR", destination: "BOM", departDate: new Date(Date.now() + 20 * 86400000).toISOString().slice(0, 10), fare: 4321,
    travellers: [{ kind: "manual", firstName: "Asha", lastName: "Rao" }] },
});

/* ═══════════════ 1. one-company users: unchanged ═══════════════ */
describe.each(BOTH_TOKENS)("one-company users, %s — same answers as before", (_label, legacy) => {
  it.each(LISTS)("WL sees their company's admin %s list", async (kind, want) => {
    const res = await adminList(await tokenFor(U.wla, { legacy }), kind);
    expect(res.status).toBe(200);
    expect(ids(res.body.rows)).toEqual(sortIds(...want("A")));
  });

  it("a requester (not a leader) is refused the admin lists", async () => {
    const res = await adminList(await tokenFor(U.reqA, { legacy }), "pending");
    expect(res.status).toBe(403);
  });

  it("WL booking history: their company's done rows; a requester: their own", async () => {
    expect(await historyIds(await tokenFor(U.wla, { legacy }))).toEqual(sortIds(R.doneA));
    expect(await historyIds(await tokenFor(U.reqA, { legacy }))).toEqual(sortIds(R.doneA)); // raised by req@acme
    expect(await historyIds(await tokenFor(U.wlb, { legacy }))).toEqual(sortIds(R.doneB));
  });

  it("booking documents: WL of the company yes, the other company's WL no", async () => {
    expect(await docVisible(await tokenFor(U.wla, { legacy }), "A")).toBe(true);
    expect(await docVisible(await tokenFor(U.wla, { legacy }), "B")).toBe(false);
    expect(await docVisible(await tokenFor(U.wlb, { legacy }), "B")).toBe(true);
  });

  it("/requests/mine and /requests/inbox: an SBT user is refused, others are not", async () => {
    const sbt = await tokenFor(U.sbtA, { legacy });
    expect((await call(request(app).get("/api/approvals/requests/mine"), sbt)).body.code).toBe("SBT_USER_CANNOT_ACCESS_APPROVALS");
    expect((await call(request(app).get("/api/approvals/requests/inbox"), sbt)).body.code).toBe("SBT_USER_CANNOT_ACCESS_APPROVALS");
    const req = await tokenFor(U.reqA, { legacy });
    expect((await call(request(app).get("/api/approvals/requests/mine"), req)).status).toBe(200);
    expect((await call(request(app).get("/api/approvals/requests/inbox"), req)).status).toBe(200);
  });

  it("raising: SBT and canRaiseRequest=false are refused; a requester goes to the approver; a WL is auto-approved", async () => {
    const raise = async (id: mongoose.Types.ObjectId) =>
      call(request(app).post("/api/approvals/requests"), await tokenFor(id, { legacy })).send({ cartItems: [flightItem()] });
    expect((await raise(U.sbtA)).body.code).toBe("SBT_USER_CANNOT_RAISE_REQUEST");
    expect((await raise(U.noRaiseA)).body.code).toBe("RAISE_REQUEST_DISABLED");
    const asReq = await raise(U.reqA);
    expect(asReq.status).toBe(200);
    expect(asReq.body.request.status).toBe("pending");
    expect(asReq.body.request.managerEmail).toBe("wl@acme.test");
    const asWl = await raise(U.wla);
    expect(asWl.status).toBe(200);
    expect(asWl.body.request.status).toBe("approved");
  });

  it("request-context: a WL is 'auto', a requester goes to their approver", async () => {
    const ctx = async (id: mongoose.Types.ObjectId) =>
      (await call(request(app).get("/api/approvals/request-context"), await tokenFor(id, { legacy }))).body.approver.status;
    expect(await ctx(U.wla)).toBe("auto");
    expect(await ctx(U.reqA)).toBe("ok");
  });

  it("WL inbox shows every pending request of the company but their own", async () => {
    const res = await call(request(app).get("/api/approvals/requests/inbox"), await tokenFor(U.wla, { legacy }));
    expect(res.status).toBe(200);
    expect(ids(res.body.rows)).toEqual(sortIds(R.pendA));
  });

  it("a deciding WL: allowed; INACTIVE User refused", async () => {
    await applyRequestDecision({ requestId: String(R.pendB), actor: { email: "wl@beta.test", via: "app" }, action: "approved" });
    expect((await col("approvalrequests").findOne({ _id: R.pendB }))!.status).toBe("approved");
    await col("users").updateOne({ _id: U.wla }, { $set: { status: "INACTIVE" } });
    await expect(
      applyRequestDecision({ requestId: String(R.pendA), actor: { email: "wl@acme.test", via: "app" }, action: "approved" }),
    ).rejects.toMatchObject({ status: 403, code: "NOT_AN_APPROVER" });
  });

  it("a drifted own-company membership (SUSPENDED, User ACTIVE) does not make the User inactive — the User document decides", async () => {
    await col("workspacememberships").updateOne({ userId: U.wla, isDefault: true }, { $set: { status: "SUSPENDED" } });
    await applyRequestDecision({ requestId: String(R.pendA), actor: { email: "wl@acme.test", via: "app" }, action: "approved" });
    expect((await col("approvalrequests").findOne({ _id: R.pendA }))!.status).toBe("approved");
  });
});

/* ═══════════════ 2. a WL of two companies sees only the session's ═══════════════ */
describe("a Workspace Leader of two companies", () => {
  it.each(LISTS)("admin %s: the active company's rows only, in each session", async (kind, want) => {
    for (const legacy of [true, false]) {
      const inA = await adminList(await tokenFor(U.dual, { legacy }), kind);
      expect(inA.status).toBe(200);
      expect(ids(inA.body.rows)).toEqual(sortIds(...want("A")));
    }
    const inB = await adminList(await tokenFor(U.dual, { ws: WS_B }), kind);
    expect(inB.status).toBe(200);
    expect(ids(inB.body.rows)).toEqual(sortIds(...want("B")));
  });

  it("admin request detail: the other company's request is 403/404", async () => {
    const inA = await tokenFor(U.dual);
    const res = await call(request(app).get(`/api/approvals/admin/requests/${R.apprB}`), inA);
    expect([403, 404]).toContain(res.status);
  });

  it("booking history: the active company's rows only", async () => {
    expect(await historyIds(await tokenFor(U.dual))).toEqual(sortIds(R.doneA));
    expect(await historyIds(await tokenFor(U.dual, { legacy: true }))).toEqual(sortIds(R.doneA));
    expect(await historyIds(await tokenFor(U.dual, { ws: WS_B }))).toEqual(sortIds(R.doneB));
  });

  it("booking documents: the active company's only", async () => {
    const inA = await tokenFor(U.dual);
    const inB = await tokenFor(U.dual, { ws: WS_B });
    expect([await docVisible(inA, "A"), await docVisible(inA, "B")]).toEqual([true, false]);
    expect([await docVisible(inB, "A"), await docVisible(inB, "B")]).toEqual([false, true]);
  });

  it("a WL of A who is only a requester in B is refused B's admin lists, and keeps A's", async () => {
    expect((await adminList(await tokenFor(U.mixed, { ws: WS_B }), "pending")).status).toBe(403);
    const inA = await adminList(await tokenFor(U.mixed), "pending");
    expect(ids(inA.body.rows)).toEqual(sortIds(R.apprA));
  });
});

/* ═══════════════ 3. fail-open closed in a second company ═══════════════ */
describe("sbtEnabled / canRaiseRequest in a second company", () => {
  it("SBT in B (membership flag): /mine, /inbox and raising are refused", async () => {
    await col("workspacememberships").updateOne({ _id: MID.mixedB }, { $set: { "flags.sbtEnabled": true } });
    const t = await tokenFor(U.mixed, { ws: WS_B });
    expect((await call(request(app).get("/api/approvals/requests/mine"), t)).body.code).toBe("SBT_USER_CANNOT_ACCESS_APPROVALS");
    expect((await call(request(app).get("/api/approvals/requests/inbox"), t)).body.code).toBe("SBT_USER_CANNOT_ACCESS_APPROVALS");
    const raise = await call(request(app).post("/api/approvals/requests"), t).send({ cartItems: [flightItem()] });
    expect(raise.body.code).toBe("SBT_USER_CANNOT_RAISE_REQUEST");
  });

  it("canRaiseRequest=false in B: raising is refused", async () => {
    await col("workspacememberships").updateOne({ _id: MID.mixedB }, { $set: { "flags.canRaiseRequest": false } });
    const raise = await call(request(app).post("/api/approvals/requests"), await tokenFor(U.mixed, { ws: WS_B })).send({ cartItems: [flightItem()] });
    expect(raise.body.code).toBe("RAISE_REQUEST_DISABLED");
  });

  it("one company, legacy User row with no workspaceId: an SBT user used to slip through (no row matched) — now refused", async () => {
    await col("users").updateOne({ _id: U.sbtA }, { $unset: { workspaceId: "" } });
    const t = await tokenFor(U.sbtA);
    expect((await call(request(app).get("/api/approvals/requests/mine"), t)).body.code).toBe("SBT_USER_CANNOT_ACCESS_APPROVALS");
    const raise = await call(request(app).post("/api/approvals/requests"), t).send({ cartItems: [flightItem()] });
    expect(raise.body.code).toBe("SBT_USER_CANNOT_RAISE_REQUEST");
  });

  it("the same user in A (User doc, no SBT) is unaffected", async () => {
    await col("workspacememberships").updateOne({ _id: MID.mixedB }, { $set: { "flags.sbtEnabled": true } });
    expect((await call(request(app).get("/api/approvals/requests/mine"), await tokenFor(U.mixed))).status).toBe(200);
  });
});

/* ═══════════════ 3a. own company: a leader with a stale User.workspaceId ═══════════════ */
// Prod (report-sbt-users-without-workspace): leaders with sbtEnabled whose
// User.workspaceId is stale or missing, session workspace resolved from
// customerId. Before 3b the {_id, workspaceId} lookup missed and they were
// let through; they must still be.
const STALE = [["stale (another company's)", WS_B], ["missing", null]] as const;
describe.each(STALE)("own company, Workspace Leader with sbtEnabled and a %s User.workspaceId", (_label, staleWs) => {
  beforeEach(async () => {
    await col("users").updateOne({ _id: U.wla }, staleWs
      ? { $set: { sbtEnabled: true, workspaceId: staleWs } }
      : { $set: { sbtEnabled: true }, $unset: { workspaceId: "" } });
  });

  it.each(BOTH_TOKENS)("%s: /mine, /inbox (whole company), request-context and raising work as before", async (_l, legacy) => {
    const t = await tokenFor(U.wla, { legacy });
    expect((await call(request(app).get("/api/approvals/requests/mine"), t)).status).toBe(200);
    const inbox = await call(request(app).get("/api/approvals/requests/inbox"), t);
    expect(inbox.status).toBe(200);
    expect(ids(inbox.body.rows)).toEqual(sortIds(R.pendA));
    expect((await call(request(app).get("/api/approvals/request-context"), t)).body.approver.status).toBe("auto");
    const raise = await call(request(app).post("/api/approvals/requests"), t).send({ cartItems: [flightItem()] });
    expect(raise.status).toBe(200);
    expect(raise.body.request.status).toBe("approved");
    expect(String(raise.body.request.workspaceId)).toBe(String(WS_A));
  });

  it.each(BOTH_TOKENS)("%s: a non-leader with the same stale row is still refused (the fail-open stays closed)", async (_l, legacy) => {
    await col("users").updateOne({ _id: U.sbtA }, staleWs ? { $set: { workspaceId: staleWs } } : { $unset: { workspaceId: "" } });
    const t = await tokenFor(U.sbtA, { legacy });
    expect((await call(request(app).get("/api/approvals/requests/mine"), t)).body.code).toBe("SBT_USER_CANNOT_ACCESS_APPROVALS");
    expect((await call(request(app).get("/api/approvals/requests/inbox"), t)).body.code).toBe("SBT_USER_CANNOT_ACCESS_APPROVALS");
    const raise = await call(request(app).post("/api/approvals/requests"), t).send({ cartItems: [flightItem()] });
    expect(raise.body.code).toBe("SBT_USER_CANNOT_RAISE_REQUEST");
  });
});

describe("Workspace Leader exemption follows the session's company", () => {
  it("a leader with sbtEnabled and a correct workspaceId: /mine and /inbox allowed (main refused these)", async () => {
    await col("users").updateOne({ _id: U.wla }, { $set: { sbtEnabled: true } });
    for (const legacy of [true, false]) {
      const t = await tokenFor(U.wla, { legacy });
      expect((await call(request(app).get("/api/approvals/requests/mine"), t)).status).toBe(200);
      expect((await call(request(app).get("/api/approvals/requests/inbox"), t)).status).toBe(200);
    }
  });

  it("WL of A with sbtEnabled on the User doc, plain requester in B: B reads B's flags (allowed)", async () => {
    await col("users").updateOne({ _id: U.mixed }, { $set: { sbtEnabled: true } });
    const t = await tokenFor(U.mixed, { ws: WS_B });
    expect((await call(request(app).get("/api/approvals/requests/mine"), t)).status).toBe(200);
  });

  it("WL of B by membership with the membership's sbtEnabled: exempt in B", async () => {
    await col("workspacememberships").updateOne({ _id: MID.dualB }, { $set: { "flags.sbtEnabled": true } });
    const t = await tokenFor(U.dual, { ws: WS_B });
    expect((await call(request(app).get("/api/approvals/requests/mine"), t)).status).toBe(200);
    expect(ids((await call(request(app).get("/api/approvals/requests/inbox"), t)).body.rows)).toEqual(sortIds(R.pendB));
  });

  it("a User row that can't be read is still refused", async () => {
    const t = await tokenFor(U.wla);
    await col("users").deleteOne({ _id: U.wla });
    expect((await call(request(app).get("/api/approvals/requests/mine"), t)).body.code).toBe("ACCOUNT_NOT_FOUND");
  });
});

/* ═══════════════ 4. routing reads the second company's roles ═══════════════ */
describe("auto-approve routing and the leader inbox in a second company", () => {
  it("a WL of A raising in B (a requester there) goes to B's approver, not auto-approved", async () => {
    const t = await tokenFor(U.mixed, { ws: WS_B });
    expect((await call(request(app).get("/api/approvals/request-context"), t)).body.approver).toEqual({ status: "ok", name: "Bina Approver" });
    const res = await call(request(app).post("/api/approvals/requests"), t).send({ cartItems: [flightItem()] });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe("pending");
    expect(res.body.request.managerEmail).toBe("approver@beta.test");
  });

  it("…and does not get B's whole-company inbox", async () => {
    const res = await call(request(app).get("/api/approvals/requests/inbox"), await tokenFor(U.mixed, { ws: WS_B }));
    expect(res.status).toBe(200);
    expect(ids(res.body.rows)).toEqual([]);
  });

  it("a WL in B by membership is auto-approved there and sees B's inbox", async () => {
    const t = await tokenFor(U.dual, { ws: WS_B });
    expect((await call(request(app).get("/api/approvals/request-context"), t)).body.approver.status).toBe("auto");
    expect(ids((await call(request(app).get("/api/approvals/requests/inbox"), t)).body.rows)).toEqual(sortIds(R.pendB));
  });
});

/* ═══════════════ 5. a suspended second-company membership is inactive there ═══════════════ */
describe("deciders: membership status of the request's company", () => {
  it("dual's B membership SUSPENDED: refused on B's request, still decides A's", async () => {
    await col("workspacememberships").updateOne({ _id: MID.dualB }, { $set: { status: "SUSPENDED" } });
    await expect(
      applyRequestDecision({ requestId: String(R.pendB), actor: { email: "dual@acme.test", via: "app" }, action: "approved" }),
    ).rejects.toMatchObject({ status: 403, code: "NOT_AN_APPROVER" });
    await applyRequestDecision({ requestId: String(R.pendA), actor: { email: "dual@acme.test", via: "app" }, action: "approved" });
    expect((await col("approvalrequests").findOne({ _id: R.pendA }))!.status).toBe("approved");
  });

  it("dual's B membership ACTIVE: decides B's request", async () => {
    await applyRequestDecision({ requestId: String(R.pendB), actor: { email: "dual@acme.test", via: "app" }, action: "approved" });
    expect((await col("approvalrequests").findOne({ _id: R.pendB }))!.status).toBe("approved");
  });
});
