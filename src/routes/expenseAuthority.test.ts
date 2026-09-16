// Approval-engine sub-step 3 — rank defaults + per-person limits, and THE
// resolution rule effective = max(rank default, personal), raise-only.
// Part A tests the pure rule exhaustively; part B drives the real routers
// (real Mongo, real middleware chain incl. the grant loader) end to end.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-connected";
process.env.JWT_SECRET = "authority-test-secret";
process.env.JWT_REFRESH_SECRET = "authority-test-refresh";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET = "test-bucket";
process.env.GEMINI_API_KEY = "test";
process.env.DISABLE_EMAILS = "1";
process.env.NODE_ENV = "test";

const { requireAuth } = await import("../middleware/auth.js");
const { requireWorkspace } = await import("../middleware/requireWorkspace.js");
const { requireFeature } = await import("../middleware/requireFeature.js");
const { attachExpenseGrant, upsertGrant } = await import("../services/expenseGrants.service.js");
const { effectiveApprovalLimit, getEffectiveLimitForUser, getRankTable } = await import("../services/expenseAuthority.service.js");
const { signToken } = await import("../utils/jwt.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: User } = await import("../models/User.js");
const { default: CustomerMember } = await import("../models/CustomerMember.js");
const { default: ExpenseBand } = await import("../models/ExpenseBand.js");
const { default: expensesRouter } = await import("./expenses.js");
const { default: adminRouter } = await import("./expenseAdmin.js");
const { default: reportsRouter } = await import("./expenseReports.js");

let mongod: MongoMemoryServer;
let app: express.Express;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  const gate = [requireAuth, requireWorkspace, attachExpenseGrant, requireFeature("expensesEnabled")] as any[];
  app.use("/api/expenses", ...gate, expensesRouter);
  app.use("/api/expense-admin", ...gate, adminRouter);
  app.use("/api/reports", ...gate, reportsRouter);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

/* ── A. The rule, pure ─────────────────────────────────────────────── */
describe("A · effectiveApprovalLimit — the resolution rule", () => {
  const table = [
    { bandNumber: 4, label: "Manager", defaultApprovalLimitBase: 50000 },
    { bandNumber: 6, label: "Team Lead", defaultApprovalLimitBase: null }, // rank exists, no default set
    { bandNumber: 10, label: "VP", defaultApprovalLimitBase: 1_000_000 },
  ];

  it("rank default applies when there is no personal grant", () => {
    const r = effectiveApprovalLimit({ bandNumber: 4, rankTable: table, grant: null });
    expect(r).toEqual({ bandNumber: 4, rankLabel: "Manager", rankDefaultLimitBase: 50000, personalLimitBase: null, effectiveLimitBase: 50000, limitSource: "rank" });
  });
  it("personal grant overrides when HIGHER than the rank default", () => {
    const r = effectiveApprovalLimit({ bandNumber: 4, rankTable: table, grant: { limitBase: 200000 } });
    expect(r.effectiveLimitBase).toBe(200000);
    expect(r.limitSource).toBe("personal");
    expect(r.rankDefaultLimitBase).toBe(50000);
    expect(r.personalLimitBase).toBe(200000);
  });
  it("personal grant does NOT lower below the rank default (raise-only, D1)", () => {
    const r = effectiveApprovalLimit({ bandNumber: 4, rankTable: table, grant: { limitBase: 10000 } });
    expect(r.effectiveLimitBase).toBe(50000);
    expect(r.limitSource).toBe("rank");
    expect(r.personalLimitBase).toBe(10000); // still reported, just not winning
  });
  it("equal figures → rank wins the label (no change in number)", () => {
    const r = effectiveApprovalLimit({ bandNumber: 4, rankTable: table, grant: { limitBase: 50000 } });
    expect(r.effectiveLimitBase).toBe(50000);
    expect(r.limitSource).toBe("rank");
  });
  it("no rank AND no personal grant → zero / none", () => {
    const r = effectiveApprovalLimit({ bandNumber: null, rankTable: table, grant: null });
    expect(r).toEqual({ bandNumber: null, rankLabel: null, rankDefaultLimitBase: null, personalLimitBase: null, effectiveLimitBase: 0, limitSource: "none" });
    expect(effectiveApprovalLimit({ bandNumber: undefined, rankTable: table, grant: { limitBase: null } }).effectiveLimitBase).toBe(0);
  });
  it("rank set but no default configured for it → zero (label still resolves)", () => {
    const r = effectiveApprovalLimit({ bandNumber: 6, rankTable: table, grant: null });
    expect(r).toMatchObject({ bandNumber: 6, rankLabel: "Team Lead", rankDefaultLimitBase: null, effectiveLimitBase: 0, limitSource: "none" });
    // …and a rank with no row at all
    const r2 = effectiveApprovalLimit({ bandNumber: 2, rankTable: table, grant: null });
    expect(r2).toMatchObject({ bandNumber: 2, rankLabel: "L2", rankDefaultLimitBase: null, effectiveLimitBase: 0, limitSource: "none" });
  });
  it("personal grant but no rank → the personal figure", () => {
    const r = effectiveApprovalLimit({ bandNumber: null, rankTable: table, grant: { limitBase: 75000 } });
    expect(r).toMatchObject({ bandNumber: null, rankDefaultLimitBase: null, personalLimitBase: 75000, effectiveLimitBase: 75000, limitSource: "personal" });
  });
  it("personal grant with an unconfigured rank → the personal figure", () => {
    const r = effectiveApprovalLimit({ bandNumber: 6, rankTable: table, grant: { limitBase: 30000 } });
    expect(r).toMatchObject({ rankLabel: "Team Lead", rankDefaultLimitBase: null, effectiveLimitBase: 30000, limitSource: "personal" });
  });
  it("a zero or negative figure on either side counts as not set", () => {
    const zeroTable = [{ bandNumber: 3, label: "L3", defaultApprovalLimitBase: 0 }];
    expect(effectiveApprovalLimit({ bandNumber: 3, rankTable: zeroTable, grant: { limitBase: 0 } }).effectiveLimitBase).toBe(0);
    expect(effectiveApprovalLimit({ bandNumber: 3, rankTable: zeroTable, grant: { limitBase: 5 } })).toMatchObject({ effectiveLimitBase: 5, limitSource: "personal" });
  });
});

/* ── B. Through the real routers ───────────────────────────────────── */
type Actor = { id: string; email: string; roles: string[]; workspaceId: string; customerId?: string };
function as(a: Actor) {
  const t = signToken({ sub: a.id, roles: a.roles, email: a.email, workspaceId: a.workspaceId, ...(a.customerId ? { customerId: a.customerId } : {}) } as any);
  const h = (r: request.Test) => r.set("Authorization", `Bearer ${t}`);
  return {
    get: (p: string) => h(request(app).get(p)),
    put: (p: string, body?: any) => h(request(app).put(p)).send(body ?? {}),
    patch: (p: string, body?: any) => h(request(app).patch(p)).send(body ?? {}),
    post: (p: string, body?: any) => h(request(app).post(p)).send(body ?? {}),
  };
}
let seq = 0;
async function makeUser(workspaceId: string, roles: string[], extra: Record<string, any> = {}): Promise<Actor> {
  seq++;
  const email = `au-${seq}-${Date.now()}@test.local`;
  const u = await User.create({ email, passwordHash: "x", firstName: `U${seq}`, lastName: "T", roles, workspaceId, status: "ACTIVE", ...extra });
  return { id: String(u._id), email, roles, workspaceId, ...(extra.customerId ? { customerId: extra.customerId } : {}) };
}
async function makeWorkspace(baseCurrency = "INR") {
  seq++;
  const customerId = `cust-au-${seq}-${Date.now()}`;
  const ws = await CustomerWorkspace.create({
    customerId, name: `Authority WS ${seq}`, status: "ACTIVE",
    config: { baseCurrency, features: { expensesEnabled: true } },
  });
  const wsId = String(ws._id);
  const leader = await makeUser(wsId, ["CUSTOMER", "WORKSPACE_LEADER"], { customerId });
  const hr = await makeUser(wsId, ["HR"]);
  const employee = await makeUser(wsId, ["EMPLOYEE"]);
  const manager = await makeUser(wsId, ["MANAGER"]);
  return { wsId, customerId, leader, hr, employee, manager };
}

describe("B · rank table config, guards, per-person limits, exposure", () => {
  it("ships EMPTY; leadership sets labels and default limits; a normal user is refused", async () => {
    const t = await makeWorkspace();
    const L = as(t.leader);

    const empty = await L.get("/api/expense-admin/ranks");
    expect(empty.status).toBe(200);
    expect(empty.body.baseCurrency).toBe("INR");
    expect(empty.body.ranks).toHaveLength(10);
    expect(empty.body.ranks.every((r: any) => r.defaultApprovalLimitBase === null && r.configured === false)).toBe(true);
    expect(empty.body.ranks[5]).toMatchObject({ bandNumber: 6, label: "L6" });

    // A normal employee cannot read or write the table.
    expect((await as(t.employee).get("/api/expense-admin/ranks")).status).toBe(403);
    expect((await as(t.employee).put("/api/expense-admin/ranks/6", { defaultApprovalLimitBase: 99 })).status).toBe(403);
    expect((await as(t.manager).put("/api/expense-admin/ranks/6", { defaultApprovalLimitBase: 99 })).status).toBe(403);

    // Leadership (workspace leader) and a structural admin (HR) can.
    const r6 = await L.put("/api/expense-admin/ranks/6", { label: "Team Lead", defaultApprovalLimitBase: 25000 });
    expect(r6.status).toBe(200);
    expect(r6.body.rank).toEqual({ bandNumber: 6, label: "Team Lead", defaultApprovalLimitBase: 25000, configured: true });
    const r10 = await as(t.hr).put("/api/expense-admin/ranks/10", { label: "VP" }); // label only, no limit
    expect(r10.status).toBe(200);
    expect(r10.body.rank).toMatchObject({ label: "VP", defaultApprovalLimitBase: null });

    // Validation.
    expect((await L.put("/api/expense-admin/ranks/11", { defaultApprovalLimitBase: 1 })).status).toBe(400);
    expect((await L.put("/api/expense-admin/ranks/6", { defaultApprovalLimitBase: -5 })).status).toBe(400);
    expect((await L.put("/api/expense-admin/ranks/6", {})).status).toBe(400);
    expect((await L.put("/api/expense-admin/ranks", { ranks: [{ bandNumber: 4, defaultApprovalLimitBase: 50000 }, { bandNumber: 12 }] })).status).toBe(400);

    // Bulk write, all-or-nothing on validation.
    const bulk = await L.put("/api/expense-admin/ranks", {
      ranks: [{ bandNumber: 4, label: "Manager", defaultApprovalLimitBase: 50000 }, { bandNumber: 10, defaultApprovalLimitBase: 1000000 }],
    });
    expect(bulk.status).toBe(200);
    const byRank = Object.fromEntries(bulk.body.ranks.map((r: any) => [r.bandNumber, r]));
    expect(byRank[4]).toMatchObject({ label: "Manager", defaultApprovalLimitBase: 50000 });
    expect(byRank[6]).toMatchObject({ label: "Team Lead", defaultApprovalLimitBase: 25000 });
    expect(byRank[10]).toMatchObject({ label: "VP", defaultApprovalLimitBase: 1000000 }); // label kept from before
    expect(byRank[1]).toMatchObject({ label: "L1", defaultApprovalLimitBase: null, configured: false });

    // Labels are stored on the existing rank row (the travel-band row) — one table.
    const row: any = await ExpenseBand.findOne({ workspaceId: t.wsId, bandNumber: 6 }).lean();
    expect(row.bandName).toBe("Team Lead");
    expect(row.defaultApprovalLimitBase).toBe(25000);
    expect(row.maxFlightFarePerPerson).toBe(0); // travel caps untouched

    // Clearing a default.
    expect((await L.put("/api/expense-admin/ranks/6", { defaultApprovalLimitBase: null })).body.rank.defaultApprovalLimitBase).toBeNull();
  });

  it("resolves each person's effective limit from rank + personal grant, in base currency, and exposes it", async () => {
    const t = await makeWorkspace("INR");
    const L = as(t.leader);
    await L.put("/api/expense-admin/ranks", { ranks: [{ bandNumber: 4, label: "Manager", defaultApprovalLimitBase: 50000 }, { bandNumber: 6, label: "Team Lead" }] });

    // Four people, four cases.
    const rankOnly = await makeUser(t.wsId, ["EMPLOYEE"]);
    const rankPlusHigher = await makeUser(t.wsId, ["EMPLOYEE"]);
    const rankPlusLower = await makeUser(t.wsId, ["EMPLOYEE"]);
    const noRankGrant = await makeUser(t.wsId, ["EMPLOYEE"]);
    const unconfiguredRank = await makeUser(t.wsId, ["EMPLOYEE"]);
    const nothing = await makeUser(t.wsId, ["EMPLOYEE"]);

    // Rank via the admin endpoint (mirrors CustomerMember like the leader route does).
    for (const [u, n] of [[rankOnly, 4], [rankPlusHigher, 4], [rankPlusLower, 4], [unconfiguredRank, 6]] as const) {
      const r = await L.patch(`/api/expense-admin/users/${u.id}/rank`, { bandNumber: n });
      expect(r.status).toBe(200);
      expect(((await User.findById(u.id).lean()) as any).bandNumber).toBe(n);
    }
    expect((await L.patch(`/api/expense-admin/users/${nothing.id}/rank`, { bandNumber: 0 })).status).toBe(400);
    expect((await L.patch(`/api/expense-admin/users/${nothing.id}/rank`, { bandNumber: null })).status).toBe(200);
    expect((await as(t.employee).patch(`/api/expense-admin/users/${nothing.id}/rank`, { bandNumber: 3 })).status).toBe(403);

    // Personal limits via the grant (sub-step 1 endpoint).
    await L.patch(`/api/expense-admin/users/${rankPlusHigher.id}/capabilities`, { approver: true, limitBase: 200000 });
    await L.patch(`/api/expense-admin/users/${rankPlusLower.id}/capabilities`, { approver: true, limitBase: 10000 });
    await L.patch(`/api/expense-admin/users/${noRankGrant.id}/capabilities`, { approver: true, limitBase: 75000 });

    const auth = async (u: Actor) => (await L.get(`/api/expense-admin/users/${u.id}/authority`)).body;
    expect((await auth(rankOnly)).authority).toMatchObject({ bandNumber: 4, rankLabel: "Manager", rankDefaultLimitBase: 50000, personalLimitBase: null, effectiveLimitBase: 50000, limitSource: "rank" });
    expect((await auth(rankPlusHigher)).authority).toMatchObject({ effectiveLimitBase: 200000, limitSource: "personal" });
    expect((await auth(rankPlusLower)).authority).toMatchObject({ effectiveLimitBase: 50000, limitSource: "rank", personalLimitBase: 10000 }); // raise-only
    expect((await auth(noRankGrant)).authority).toMatchObject({ bandNumber: null, effectiveLimitBase: 75000, limitSource: "personal" });
    expect((await auth(unconfiguredRank)).authority).toMatchObject({ bandNumber: 6, rankLabel: "Team Lead", rankDefaultLimitBase: null, effectiveLimitBase: 0, limitSource: "none" });
    expect((await auth(nothing)).authority).toMatchObject({ bandNumber: null, effectiveLimitBase: 0, limitSource: "none" });
    expect((await auth(nothing)).baseCurrency).toBe("INR");
    expect((await L.get(`/api/expense-admin/users/${new mongoose.Types.ObjectId()}/authority`)).status).toBe(404);

    // The same numbers via the service (what the engine will call)…
    expect((await getEffectiveLimitForUser(t.wsId, rankPlusLower.id)).effectiveLimitBase).toBe(50000);
    // …on the Team list…
    const list = await L.get("/api/expense-admin/users");
    const row = list.body.users.find((u: any) => u.id === rankPlusHigher.id);
    expect(row).toMatchObject({ bandNumber: 4, rankLabel: "Manager", rankDefaultLimitBase: 50000, limitBase: 200000, effectiveLimitBase: 200000, limitSource: "personal" });
    expect(list.body.ranks).toHaveLength(10);
    expect(list.body.baseCurrency).toBe("INR");
    // …and to the person themselves.
    const caps = (await as(rankPlusLower).get("/api/expenses/capabilities")).body.capabilities;
    expect(caps).toMatchObject({ approver: true, limitBase: 10000, bandNumber: 4, rankLabel: "Manager", effectiveLimitBase: 50000, limitSource: "rank" });

    // Changing the rank default re-resolves everyone of that rank (nothing cached).
    await L.put("/api/expense-admin/ranks/4", { defaultApprovalLimitBase: 300000 });
    expect((await auth(rankPlusHigher)).authority).toMatchObject({ effectiveLimitBase: 300000, limitSource: "rank" }); // rank now beats the 2L personal
    expect((await auth(rankPlusLower)).authority.effectiveLimitBase).toBe(300000);
    // Clearing it drops back to the personal figures.
    await L.put("/api/expense-admin/ranks/4", { defaultApprovalLimitBase: null });
    expect((await auth(rankOnly)).authority).toMatchObject({ effectiveLimitBase: 0, limitSource: "none" });
    expect((await auth(rankPlusHigher)).authority).toMatchObject({ effectiveLimitBase: 200000, limitSource: "personal" });
  });

  it("limits are in the workspace base currency (a USD workspace reports USD) and are per workspace", async () => {
    const usd = await makeWorkspace("USD");
    const inr = await makeWorkspace("INR");
    await as(usd.leader).put("/api/expense-admin/ranks/4", { defaultApprovalLimitBase: 600 });
    await as(inr.leader).put("/api/expense-admin/ranks/4", { defaultApprovalLimitBase: 50000 });
    const u = await makeUser(usd.wsId, ["EMPLOYEE"], { bandNumber: 4 });
    const i = await makeUser(inr.wsId, ["EMPLOYEE"], { bandNumber: 4 });
    const ru = (await as(usd.leader).get(`/api/expense-admin/users/${u.id}/authority`)).body;
    expect(ru.baseCurrency).toBe("USD");
    expect(ru.authority.effectiveLimitBase).toBe(600);
    const ri = (await as(inr.leader).get(`/api/expense-admin/users/${i.id}/authority`)).body;
    expect(ri.baseCurrency).toBe("INR");
    expect(ri.authority.effectiveLimitBase).toBe(50000);
    // A leader cannot read another workspace's user.
    expect((await as(usd.leader).get(`/api/expense-admin/users/${i.id}/authority`)).status).toBe(404);
    // The rank tables are independent.
    expect((await getRankTable(usd.wsId))[3].defaultApprovalLimitBase).toBe(600);
    expect((await getRankTable(inr.wsId))[3].defaultApprovalLimitBase).toBe(50000);
  });

  it("with nothing configured, routing is unchanged: a claim still goes manager → admin", async () => {
    const t = await makeWorkspace();
    const emp = await makeUser(t.wsId, ["EMPLOYEE"], { managerId: t.manager.id });
    const E = as(emp);
    const line = (await E.post("/api/expenses", { amount: 100, date: new Date().toISOString().slice(0, 10) })).body.expense;
    const claim = (await E.post("/api/reports", { name: "c" })).body.report;
    await E.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [line._id] });
    const sub = await E.post(`/api/reports/${claim._id}/submit`);
    expect(sub.status).toBe(200);
    expect(String(sub.body.report.approverId)).toBe(t.manager.id);
    expect(sub.body.report.routing.mode).toBe("legacy_manager_admin");
    expect(sub.body.report.routing.requiredLimitBase).toBeNull(); // no limit routing yet (sub-step 5)
    // Mirror check: rank set via the admin route also mirrors CustomerMember (same key as the leader route).
    await CustomerMember.create({ customerId: t.customerId, email: emp.email, name: "E", role: "MEMBER", bandNumber: null } as any);
    await as(t.leader).patch(`/api/expense-admin/users/${emp.id}/rank`, { bandNumber: 7 });
    expect(((await CustomerMember.findOne({ customerId: t.customerId, email: emp.email }).lean()) as any).bandNumber).toBe(7);
  });
});
