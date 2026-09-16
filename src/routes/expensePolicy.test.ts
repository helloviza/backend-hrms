// Approval-engine sub-step 4 — the rulebook (ExpenseApprovalPolicy) and the
// "test a claim" simulator built on the ONE pure routing walk (routeClaim).
// Part A: routeClaim() pure, every branch. Part B: real Mongo + real routers —
// policy stores/reads, defaults, guards, the simulator on a range of claims,
// the legacy Team-page contract still working off the policy document, and
// live submit still routing the old way (the engine is NOT wired yet).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-connected";
process.env.JWT_SECRET = "policy-test-secret";
process.env.JWT_REFRESH_SECRET = "policy-test-refresh";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET = "test-bucket";
process.env.GEMINI_API_KEY = "test";
process.env.DISABLE_EMAILS = "1";
process.env.NODE_ENV = "test";

const { requireAuth } = await import("../middleware/auth.js");
const { requireWorkspace } = await import("../middleware/requireWorkspace.js");
const { requireFeature } = await import("../middleware/requireFeature.js");
const { attachExpenseGrant, upsertGrant } = await import("../services/expenseGrants.service.js");
const { routeClaim } = await import("../services/expenseRouting.service.js");
const { defaultPolicyView, getPolicy } = await import("../services/expensePolicy.service.js");
const { signToken } = await import("../utils/jwt.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: User } = await import("../models/User.js");
const { default: Department } = await import("../models/Department.js");
const { default: ExpenseCategory } = await import("../models/ExpenseCategory.js");
const { default: ExpenseApprovalPolicy } = await import("../models/ExpenseApprovalPolicy.js");
const { default: Report } = await import("../models/Report.js");
const { default: ExpenseActivity } = await import("../models/ExpenseActivity.js");
const { default: expensesRouter } = await import("./expenses.js");
const { default: adminRouter } = await import("./expenseAdmin.js");
const { default: reportsRouter } = await import("./expenseReports.js");

let mongod: MongoMemoryServer;
let app: express.Express;
const TODAY = new Date().toISOString().slice(0, 10);

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

/* ── A. routeClaim(), pure ─────────────────────────────────────────── */
const P = (id: string, name: string, o: Partial<{ bandNumber: number | null; approver: boolean; personalLimitBase: number | null; departmentIds: string[]; active: boolean }> = {}) => ({
  id, name, active: true, bandNumber: null, approver: true, personalLimitBase: null, departmentIds: [], ...o,
});
const CLEAN = { receipt: true, category: true, noDuplicate: true, positiveAmounts: true };
const RANKS = [
  { bandNumber: 4, label: "Manager", defaultApprovalLimitBase: 50000 },
  { bandNumber: 8, label: "Director", defaultApprovalLimitBase: 500000 },
];
function pol(over: Record<string, any> = {}) {
  return { ...defaultPolicyView("ws"), exists: true, version: 3, ...over };
}
const sub = { id: "emp", name: "Arjun", departmentId: null as string | null, managerId: "mgr" as string | null };

describe("A · routeClaim — the pure walk", () => {
  const mgr = P("mgr", "Meera", { bandNumber: 4 }); // ₹50k via rank
  const lead = P("lead", "Lata", { personalLimitBase: 20000 }); // ₹20k personal
  const dir = P("dir", "Dev", { bandNumber: 8 }); // ₹5L via rank
  const cfo = P("cfo", "Chitra", { personalLimitBase: 2000000 }); // ₹20L personal
  const people = [mgr, lead, dir, cfo];

  it("bot auto-approves a clean claim under the threshold", () => {
    const d = routeClaim({ kind: "claim", amountBase: 1500, baseCurrency: "INR", categoryIds: [], submitter: sub, manager: mgr, candidates: people, checks: CLEAN, policy: pol({ bot: { enabled: true, thresholdBase: 2000, require: pol().bot.require } }), rankTable: RANKS });
    expect(d.outcome).toBe("BOT_AUTO_APPROVE");
    expect(d.bot).toMatchObject({ evaluated: true, underThreshold: true, blockedByCategory: false, checksPassed: true, wouldAutoApprove: true });
    expect(d.chain).toEqual([{ level: 1, actorType: "bot", approverId: null, name: "Approval Bot", via: "bot", limitBase: 2000, overLimit: false, final: true }]);
    expect(d.requiredLimitBase).toBe(1500);
    expect(d.explain.join(" ")).toMatch(/Approval Bot approves/);
  });
  it("bot is not evaluated when off; over threshold / failed pre-check / blocked category hand off to a human", () => {
    const off = routeClaim({ kind: "claim", amountBase: 1500, baseCurrency: "INR", categoryIds: [], submitter: sub, manager: mgr, candidates: people, checks: CLEAN, policy: pol(), rankTable: RANKS });
    expect(off.bot.evaluated).toBe(false);
    expect(off.outcome).toBe("MANAGER_FINAL");
    const botOn = { enabled: true, thresholdBase: 2000, require: pol().bot.require };
    const over = routeClaim({ kind: "claim", amountBase: 2500, baseCurrency: "INR", categoryIds: [], submitter: sub, manager: mgr, candidates: people, checks: CLEAN, policy: pol({ bot: botOn }), rankTable: RANKS });
    expect(over.bot).toMatchObject({ evaluated: true, underThreshold: false, wouldAutoApprove: false });
    expect(over.outcome).toBe("MANAGER_FINAL");
    const dirty = routeClaim({ kind: "claim", amountBase: 1500, baseCurrency: "INR", categoryIds: [], submitter: sub, manager: mgr, candidates: people, checks: { ...CLEAN, receipt: false }, policy: pol({ bot: botOn }), rankTable: RANKS });
    expect(dirty.bot).toMatchObject({ underThreshold: true, checksPassed: false, wouldAutoApprove: false });
    expect(dirty.bot.reason).toMatch(/pre-check failed: receipt/);
    const blocked = routeClaim({ kind: "claim", amountBase: 1500, baseCurrency: "INR", categoryIds: ["ent"], submitter: sub, manager: mgr, candidates: people, checks: CLEAN, policy: pol({ bot: botOn, categoryRules: [{ categoryId: "ent", neverAutoApprove: true, minApproverLimitBase: null, weight: null }] }), rankTable: RANKS });
    expect(blocked.bot).toMatchObject({ underThreshold: true, blockedByCategory: true, wouldAutoApprove: false });
    expect(blocked.outcome).toBe("MANAGER_FINAL");
  });
  it("category ×2 doubles the required limit; a category floor raises it; strictest wins on a mixed claim", () => {
    const rules = [
      { categoryId: "travel", neverAutoApprove: false, minApproverLimitBase: null, weight: 2 },
      { categoryId: "ent", neverAutoApprove: true, minApproverLimitBase: 400000, weight: 1.5 },
    ];
    const x2 = routeClaim({ kind: "claim", amountBase: 30000, baseCurrency: "INR", categoryIds: ["travel"], submitter: sub, manager: mgr, candidates: people, checks: CLEAN, policy: pol({ categoryRules: rules }), rankTable: RANKS });
    expect(x2.rule.weight).toBe(2);
    expect(x2.requiredLimitBase).toBe(60000); // 30k × 2 → manager's 50k no longer covers
    expect(x2.outcome).toBe("MANAGER_THEN_LIMIT");
    expect(x2.chain.map((c) => c.approverId)).toEqual(["mgr", "dir"]);
    const floor = routeClaim({ kind: "claim", amountBase: 1000, baseCurrency: "INR", categoryIds: ["ent"], submitter: sub, manager: mgr, candidates: people, checks: CLEAN, policy: pol({ categoryRules: rules }), rankTable: RANKS });
    expect(floor.requiredLimitBase).toBe(400000); // floor beats 1000 × 1.5
    expect(floor.chain.map((c) => c.approverId)).toEqual(["mgr", "dir"]);
    const mixed = routeClaim({ kind: "claim", amountBase: 30000, baseCurrency: "INR", categoryIds: ["travel", "ent"], submitter: sub, manager: mgr, candidates: people, checks: CLEAN, policy: pol({ categoryRules: rules }), rankTable: RANKS });
    expect(mixed.rule).toMatchObject({ weight: 2, categoryFloorBase: 400000, neverAutoApprove: true });
    expect(mixed.requiredLimitBase).toBe(400000); // max(30k×2, floor)
  });
  it("manager covers → manager is final; manager too small → endorses, then the LOWEST covering approver (climb)", () => {
    const small = routeClaim({ kind: "claim", amountBase: 40000, baseCurrency: "INR", categoryIds: [], submitter: sub, manager: mgr, candidates: people, checks: CLEAN, policy: pol(), rankTable: RANKS });
    expect(small.outcome).toBe("MANAGER_FINAL");
    expect(small.chain).toEqual([{ level: 1, actorType: "user", approverId: "mgr", name: "Meera", via: "manager", limitBase: 50000, overLimit: false, final: true }]);
    const big = routeClaim({ kind: "claim", amountBase: 120000, baseCurrency: "INR", categoryIds: [], submitter: sub, manager: mgr, candidates: people, checks: CLEAN, policy: pol(), rankTable: RANKS });
    expect(big.outcome).toBe("MANAGER_THEN_LIMIT");
    expect(big.chain.map((c) => [c.approverId, c.via, c.limitBase, c.final])).toEqual([["mgr", "manager", 50000, false], ["dir", "limit", 500000, true]]);
    expect(big.climbed).toBe(true); // Lata (20k) skipped
    const lata = big.trace.find((t) => t.userId === "lead");
    expect(lata).toMatchObject({ outcome: "skipped", covers: false });
    expect(lata!.reason).toMatch(/too small/);
    const chitra = big.trace.find((t) => t.userId === "cfo");
    expect(chitra).toMatchObject({ outcome: "considered", covers: true }); // covers, but Dev is lower
    expect(big.explain.join(" ")).toMatch(/Climbed past 1 approver/);
  });
  it("no manager → straight to the lowest covering approver; AUTHORITY_ONLY ignores the manager", () => {
    const noMgr = routeClaim({ kind: "claim", amountBase: 10000, baseCurrency: "INR", categoryIds: [], submitter: { ...sub, managerId: null }, manager: null, candidates: people, checks: CLEAN, policy: pol(), rankTable: RANKS });
    expect(noMgr.outcome).toBe("LIMIT");
    expect(noMgr.chain.map((c) => c.approverId)).toEqual(["lead"]); // 20k is the lowest that covers 10k
    expect(noMgr.trace[1]).toMatchObject({ step: "manager", outcome: "none" });
    const authOnly = routeClaim({ kind: "claim", amountBase: 10000, baseCurrency: "INR", categoryIds: [], submitter: sub, manager: mgr, candidates: people, checks: CLEAN, policy: pol({ firstStep: "AUTHORITY_ONLY" }), rankTable: RANKS });
    expect(authOnly.chain.map((c) => c.approverId)).toEqual(["lead"]);
  });
  it("manager with no limit: endorse-only by default; the D3 allowance lets them finalise small claims", () => {
    const limitless = P("mgr2", "Mohan"); // no rank, no personal
    const off = routeClaim({ kind: "claim", amountBase: 5000, baseCurrency: "INR", categoryIds: [], submitter: { ...sub, managerId: "mgr2" }, manager: limitless, candidates: [limitless, lead, dir], checks: CLEAN, policy: pol(), rankTable: RANKS });
    expect(off.outcome).toBe("MANAGER_THEN_LIMIT");
    expect(off.chain[0]).toMatchObject({ approverId: "mgr2", via: "manager", limitBase: 0, final: false });
    expect(off.chain[1]).toMatchObject({ approverId: "lead", final: true });
    const on = routeClaim({ kind: "claim", amountBase: 5000, baseCurrency: "INR", categoryIds: [], submitter: { ...sub, managerId: "mgr2" }, manager: limitless, candidates: [limitless, lead, dir], checks: CLEAN, policy: pol({ managerAllowance: { enabled: true, limitBase: 10000 } }), rankTable: RANKS });
    expect(on.outcome).toBe("MANAGER_FINAL");
    expect(on.chain).toEqual([{ level: 1, actorType: "user", approverId: "mgr2", name: "Mohan", via: "manager", limitBase: 10000, overLimit: false, final: true }]);
    const tooBig = routeClaim({ kind: "claim", amountBase: 15000, baseCurrency: "INR", categoryIds: [], submitter: { ...sub, managerId: "mgr2" }, manager: limitless, candidates: [limitless, lead, dir], checks: CLEAN, policy: pol({ managerAllowance: { enabled: true, limitBase: 10000 } }), rankTable: RANKS });
    expect(tooBig.outcome).toBe("MANAGER_THEN_LIMIT");
  });
  it("over everyone's limit → top approver flagged + second senior co-approver (four eyes); variants", () => {
    const huge = routeClaim({ kind: "claim", amountBase: 5000000, baseCurrency: "INR", categoryIds: [], submitter: sub, manager: mgr, candidates: people, checks: CLEAN, policy: pol(), rankTable: RANKS });
    expect(huge.outcome).toBe("TOP_FLAGGED_FOUR_EYES");
    expect(huge).toMatchObject({ overLimit: true, fourEyes: true, climbed: true });
    expect(huge.chain.map((c) => [c.approverId, c.via, c.overLimit, c.final])).toEqual([
      ["mgr", "manager", false, false],
      ["cfo", "top", true, false],
      ["dir", "four_eyes", true, true],
    ]);
    expect(huge.explain.join(" ")).toMatch(/flagged OVER LIMIT/);
    expect(huge.explain.join(" ")).toMatch(/Four eyes: Dev/);
    // Only one senior person → approves alone, flag stays.
    const lonely = routeClaim({ kind: "claim", amountBase: 5000000, baseCurrency: "INR", categoryIds: [], submitter: { ...sub, managerId: null }, manager: null, candidates: [cfo], checks: CLEAN, policy: pol(), rankTable: RANKS });
    expect(lonely.outcome).toBe("TOP_FLAGGED");
    expect(lonely.chain).toEqual([{ level: 1, actorType: "user", approverId: "cfo", name: "Chitra", via: "top", limitBase: 2000000, overLimit: true, final: true }]);
    expect(lonely.fourEyes).toBe(false);
    // Policy variants.
    const noFour = routeClaim({ kind: "claim", amountBase: 5000000, baseCurrency: "INR", categoryIds: [], submitter: sub, manager: mgr, candidates: people, checks: CLEAN, policy: pol({ topOfChain: "TOP_APPROVES_FLAGGED" }), rankTable: RANKS });
    expect(noFour.outcome).toBe("TOP_FLAGGED");
    expect(noFour.chain.map((c) => c.approverId)).toEqual(["mgr", "cfo"]);
    const refuse = routeClaim({ kind: "claim", amountBase: 5000000, baseCurrency: "INR", categoryIds: [], submitter: sub, manager: mgr, candidates: people, checks: CLEAN, policy: pol({ topOfChain: "REFUSE_SUBMIT" }), rankTable: RANKS });
    expect(refuse.outcome).toBe("REFUSE");
    expect(refuse.overLimit).toBe(true);
  });
  it("pool rules: submitter excluded, inactive excluded, non-approver excluded, department scope enforced only when switched on", () => {
    const eng = "dept-eng";
    const scopedSales = P("s1", "Sam", { personalLimitBase: 100000, departmentIds: ["dept-sales"] });
    const scopedEng = P("e1", "Esha", { personalLimitBase: 100000, departmentIds: [eng] });
    const unscoped = P("u1", "Uma", { personalLimitBase: 300000 });
    const inactive = P("i1", "Ira", { personalLimitBase: 60000, active: false });
    const nonApprover = P("n1", "Nia", { personalLimitBase: 60000, approver: false });
    const self = P("emp", "Arjun", { personalLimitBase: 60000 });
    const cands = [scopedSales, scopedEng, unscoped, inactive, nonApprover, self];
    const on = routeClaim({ kind: "claim", amountBase: 70000, baseCurrency: "INR", categoryIds: [], submitter: { ...sub, managerId: null, departmentId: eng }, manager: null, candidates: cands, checks: CLEAN, policy: pol({ departmentScopeEnforced: true }), rankTable: RANKS });
    expect(on.chain.map((c) => c.approverId)).toEqual(["e1"]); // Sam (sales scope) skipped, Esha chosen over Uma (lower limit)
    expect(on.trace.find((t) => t.userId === "s1")).toMatchObject({ outcome: "skipped" });
    expect(on.trace.find((t) => t.userId === "s1")!.reason).toMatch(/department scope/);
    expect(on.trace.some((t) => t.userId === "i1" || t.userId === "n1" || t.userId === "emp")).toBe(false);
    expect(on.candidatesConsidered).toBe(2);
    const offScope = routeClaim({ kind: "claim", amountBase: 70000, baseCurrency: "INR", categoryIds: [], submitter: { ...sub, managerId: null, departmentId: eng }, manager: null, candidates: cands, checks: CLEAN, policy: pol({ departmentScopeEnforced: false }), rankTable: RANKS });
    expect(offScope.candidatesConsidered).toBe(3); // Sam, Esha, Uma
  });
  it("nobody has a limit at all → NO_APPROVER (the engine's refusal; legacy falls back to admin)", () => {
    const d = routeClaim({ kind: "claim", amountBase: 100, baseCurrency: "INR", categoryIds: [], submitter: { ...sub, managerId: null }, manager: null, candidates: [P("x", "X")], checks: CLEAN, policy: pol(), rankTable: [] });
    expect(d.outcome).toBe("NO_APPROVER");
    expect(d.chain).toEqual([]);
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
async function makeUser(workspaceId: string, roles: string[], first: string, extra: Record<string, any> = {}): Promise<Actor> {
  seq++;
  const email = `pol-${seq}-${Date.now()}@test.local`;
  const u = await User.create({ email, passwordHash: "x", firstName: first, lastName: "T", roles, workspaceId, status: "ACTIVE", ...extra });
  return { id: String(u._id), email, roles, workspaceId, ...(extra.customerId ? { customerId: extra.customerId } : {}) };
}
async function makeWorkspace() {
  seq++;
  const customerId = `cust-pol-${seq}-${Date.now()}`;
  const ws = await CustomerWorkspace.create({ customerId, name: `Policy WS ${seq}`, status: "ACTIVE", config: { features: { expensesEnabled: true } } });
  const wsId = String(ws._id);
  const leader = await makeUser(wsId, ["CUSTOMER", "WORKSPACE_LEADER"], "Lena", { customerId });
  const employee = await makeUser(wsId, ["EMPLOYEE"], "Arjun");
  const travel = await ExpenseCategory.create({ workspaceId: wsId, name: "Travel", active: true });
  const ent = await ExpenseCategory.create({ workspaceId: wsId, name: "Entertainment", active: true });
  const eng = await Department.create({ workspaceId: wsId, name: "Engineering", isActive: true });
  return { wsId, customerId, leader, employee, travelId: String(travel._id), entId: String(ent._id), engId: String(eng._id) };
}

describe("B · policy endpoints, simulator, legacy contract, live submit untouched", () => {
  it("is EMPTY / OFF by default (no document created by reading), stores every setting, is guarded", async () => {
    const t = await makeWorkspace();
    const L = as(t.leader);

    const d = await L.get("/api/expense-admin/approval-policy");
    expect(d.status).toBe(200);
    expect(d.body.policy).toMatchObject({ exists: false, version: 0, engineEnabled: false, bot: { enabled: false, thresholdBase: null }, managerAllowance: { enabled: false, limitBase: null }, categoryRules: [], departmentScopeEnforced: false, topOfChain: "TOP_APPROVES_FLAGGED_FOUR_EYES", firstStep: "MANAGER_THEN_AUTHORITY" });
    expect(await ExpenseApprovalPolicy.countDocuments({ workspaceId: t.wsId })).toBe(0); // reading creates nothing
    expect(d.body.categories.map((c: any) => c.name).sort()).toEqual(["Entertainment", "Travel"]);

    // Guarded: an employee is refused.
    expect((await as(t.employee).get("/api/expense-admin/approval-policy")).status).toBe(403);
    expect((await as(t.employee).put("/api/expense-admin/approval-policy", { bot: { enabled: true } })).status).toBe(403);
    expect((await as(t.employee).post("/api/expense-admin/approval-policy/simulate", { amountBase: 1 })).status).toBe(403);

    // Every lever persists.
    const w = await L.put("/api/expense-admin/approval-policy", {
      bot: { enabled: true, thresholdBase: 2000, require: { receipt: true, category: false } },
      managerAllowance: { enabled: true, limitBase: 10000 },
      categoryRules: [
        { categoryId: t.entId, neverAutoApprove: true, minApproverLimitBase: 400000, weight: null },
        { categoryId: t.travelId, weight: 2 },
      ],
      departmentScopeEnforced: true,
      topOfChain: "TOP_APPROVES_FLAGGED",
    });
    expect(w.status).toBe(200);
    expect(w.body.policy).toMatchObject({
      exists: true, version: 1, engineEnabled: false,
      bot: { enabled: true, thresholdBase: 2000, require: { receipt: true, category: false, noDuplicate: true, positiveAmounts: true } },
      managerAllowance: { enabled: true, limitBase: 10000 },
      departmentScopeEnforced: true, topOfChain: "TOP_APPROVES_FLAGGED",
    });
    expect(w.body.policy.categoryRules).toEqual([
      { categoryId: t.entId, neverAutoApprove: true, minApproverLimitBase: 400000, weight: null },
      { categoryId: t.travelId, neverAutoApprove: false, minApproverLimitBase: null, weight: 2 },
    ]);
    const again = await L.get("/api/expense-admin/approval-policy");
    expect(again.body.policy.version).toBe(1);
    expect(again.body.policy.bot.thresholdBase).toBe(2000);

    // Partial update touches only what is sent; version bumps; history records it.
    const w2 = await L.put("/api/expense-admin/approval-policy", { topOfChain: "TOP_APPROVES_FLAGGED_FOUR_EYES" });
    expect(w2.body.policy.version).toBe(2);
    expect(w2.body.policy.bot.thresholdBase).toBe(2000);
    const doc: any = await ExpenseApprovalPolicy.findOne({ workspaceId: t.wsId }).lean();
    expect(doc.history).toHaveLength(2);
    expect(String(doc.history[1].by)).toBe(t.leader.id);
    expect(doc.history[1].change.topOfChain).toEqual({ from: "TOP_APPROVES_FLAGGED", to: "TOP_APPROVES_FLAGGED_FOUR_EYES" });

    // Validation against THIS workspace.
    const other = await makeWorkspace();
    expect((await L.put("/api/expense-admin/approval-policy", { categoryRules: [{ categoryId: other.travelId, weight: 2 }] })).status).toBe(400);
    expect((await L.put("/api/expense-admin/approval-policy", { categoryRules: [{ categoryId: t.travelId, weight: 0.5 }] })).status).toBe(400);
    expect((await L.put("/api/expense-admin/approval-policy", { bot: { thresholdBase: -1 } })).status).toBe(400);
    expect((await L.put("/api/expense-admin/approval-policy", { topOfChain: "WHATEVER" })).status).toBe(400);
    expect((await L.put("/api/expense-admin/approval-policy", { legacyEscalation: { seniorApproverId: other.employee.id } })).status).toBe(400);
    expect((await L.put("/api/expense-admin/approval-policy", { nothing: 1 })).status).toBe(400);
  });

  it("the simulator returns the full reasoning across a range of claims and creates NOTHING", async () => {
    const t = await makeWorkspace();
    const L = as(t.leader);
    // Authority: ranks + people.
    await L.put("/api/expense-admin/ranks", { ranks: [{ bandNumber: 4, label: "Manager", defaultApprovalLimitBase: 50000 }, { bandNumber: 8, label: "Director", defaultApprovalLimitBase: 500000 }] });
    const meera = await makeUser(t.wsId, ["MANAGER"], "Meera", { bandNumber: 4 });
    const lata = await makeUser(t.wsId, ["EMPLOYEE"], "Lata");
    const dev = await makeUser(t.wsId, ["EMPLOYEE"], "Dev", { bandNumber: 8 });
    const chitra = await makeUser(t.wsId, ["EMPLOYEE"], "Chitra");
    for (const [u, patch] of [
      [meera, { approver: true }],
      [lata, { approver: true, limitBase: 20000 }],
      [dev, { approver: true }],
      [chitra, { approver: true, limitBase: 2000000 }],
    ] as const) {
      expect((await L.patch(`/api/expense-admin/users/${u.id}/capabilities`, patch)).status).toBe(200);
    }
    const arjun = await makeUser(t.wsId, ["EMPLOYEE"], "Arjun", { managerId: meera.id, department: "Engineering" });
    await L.put("/api/expense-admin/approval-policy", {
      bot: { enabled: true, thresholdBase: 2000 },
      categoryRules: [{ categoryId: t.entId, neverAutoApprove: true }, { categoryId: t.travelId, weight: 2 }],
    });
    const reportsBefore = await Report.countDocuments({ workspaceId: t.wsId });
    const activityBefore = await ExpenseActivity.countDocuments({ workspaceId: t.wsId });
    const sim = async (body: any) => {
      const r = await L.post("/api/expense-admin/approval-policy/simulate", body);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.simulated).toBe(true);
      return r.body;
    };

    // Under the bot threshold, clean → the bot approves.
    let s = await sim({ submitterId: arjun.id, amountBase: 1500 });
    expect(s.decision.outcome).toBe("BOT_AUTO_APPROVE");
    expect(s.decision.bot.wouldAutoApprove).toBe(true);
    expect(s.input.departmentId).toBe(t.engId); // resolved from the free-text department name
    expect(s.input.approverPoolSize).toBe(4);
    // Same amount, Entertainment → bot blocked, manager covers.
    s = await sim({ submitterId: arjun.id, amountBase: 1500, categoryIds: [t.entId] });
    expect(s.decision.bot).toMatchObject({ underThreshold: true, blockedByCategory: true, wouldAutoApprove: false });
    expect(s.decision.outcome).toBe("MANAGER_FINAL");
    expect(s.decision.chain[0]).toMatchObject({ approverId: meera.id, name: "Meera T", via: "manager", limitBase: 50000 });
    // Dirty claim under threshold → bot hands off.
    s = await sim({ submitterId: arjun.id, amountBase: 1500, checks: { receipt: false } });
    expect(s.decision.bot.reason).toMatch(/pre-check failed: receipt/);
    expect(s.decision.outcome).toBe("MANAGER_FINAL");
    // Travel ×2: 30k counts as 60k → manager endorses, Dev (5L) is the lowest who covers; Lata skipped.
    s = await sim({ submitterId: arjun.id, amountBase: 30000, categoryIds: [t.travelId] });
    expect(s.decision.requiredLimitBase).toBe(60000);
    expect(s.decision.outcome).toBe("MANAGER_THEN_LIMIT");
    expect(s.decision.chain.map((c: any) => c.approverId)).toEqual([meera.id, dev.id]);
    expect(s.decision.climbed).toBe(true);
    expect(s.decision.trace.find((x: any) => x.userId === lata.id)).toMatchObject({ outcome: "skipped" });
    expect(s.decision.trace.find((x: any) => x.userId === chitra.id)).toMatchObject({ outcome: "considered" });
    // Over everyone → Chitra (top) flagged + Dev four-eyes.
    s = await sim({ submitterId: arjun.id, amountBase: 5000000 });
    expect(s.decision.outcome).toBe("TOP_FLAGGED_FOUR_EYES");
    expect(s.decision.chain.map((c: any) => [c.approverId, c.via, c.overLimit])).toEqual([[meera.id, "manager", false], [chitra.id, "top", true], [dev.id, "four_eyes", true]]);
    expect(s.decision.explain.length).toBeGreaterThan(2);

    // From an EXISTING claim: amount, categories and pre-checks come from its lines.
    const A = as(arjun);
    const l1 = (await A.post("/api/expenses", { amount: 800, date: TODAY, categoryId: t.travelId })).body.expense; // no receipt
    const claim = (await A.post("/api/reports", { name: "real" })).body.report;
    await A.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [l1._id] });
    s = await sim({ reportId: claim._id });
    expect(s.input.fromClaim).toMatchObject({ ref: claim.ref, status: "draft", lineCount: 1, pendingConversion: 0 });
    expect(s.input.amountBase).toBe(800);
    expect(s.input.checks).toMatchObject({ receipt: false, category: true, noDuplicate: true, positiveAmounts: true });
    expect(s.decision.requiredLimitBase).toBe(1600); // travel ×2
    expect(s.decision.bot.wouldAutoApprove).toBe(false); // receipt missing
    expect(s.decision.outcome).toBe("MANAGER_FINAL");

    // Nothing was created, submitted or routed.
    expect(await Report.countDocuments({ workspaceId: t.wsId })).toBe(reportsBefore + 1); // only the claim the test made
    expect((await Report.findById(claim._id).lean())!.status).toBe("draft");
    const acts = await ExpenseActivity.countDocuments({ workspaceId: t.wsId });
    expect(acts).toBe(activityBefore + 2); // created + expense_added, none from the simulator
    expect(await ExpenseActivity.countDocuments({ workspaceId: t.wsId, event: "routed" })).toBe(0);

    // Input errors.
    expect((await L.post("/api/expense-admin/approval-policy/simulate", {})).status).toBe(400);
    expect((await L.post("/api/expense-admin/approval-policy/simulate", { submitterId: arjun.id })).status).toBe(400);
    expect((await L.post("/api/expense-admin/approval-policy/simulate", { submitterId: new mongoose.Types.ObjectId().toString(), amountBase: 1 })).status).toBe(404);
    expect((await L.post("/api/expense-admin/approval-policy/simulate", { reportId: new mongoose.Types.ObjectId().toString() })).status).toBe(404);
  });

  it("master switch guardrail: cannot be switched ON with no usable approver; readiness explains; history names the actor", async () => {
    const t = await makeWorkspace();
    const L = as(t.leader);
    // Nothing configured → not ready, and the switch is BLOCKED (409), not warned.
    const r0 = await L.get("/api/expense-admin/approval-policy/readiness");
    expect(r0.status).toBe(200);
    expect(r0.body.readiness).toMatchObject({ ready: false, usableApprovers: [], ranksWithDefault: 0 });
    expect(r0.body.readiness.missing.join(" ")).toMatch(/No one is marked as an approver/);
    const on0 = await L.put("/api/expense-admin/approval-policy", { engineEnabled: true });
    expect(on0.status).toBe(409);
    expect(on0.body.code).toBe("ENGINE_NEEDS_APPROVER");
    expect(on0.body.error).toMatch(/can't be switched on yet/);
    expect((await getPolicy(t.wsId)).engineEnabled).toBe(false);

    // An approver flag with NO limit is still not enough.
    const ann = await makeUser(t.wsId, ["EMPLOYEE"], "Ann");
    await L.patch(`/api/expense-admin/users/${ann.id}/capabilities`, { approver: true });
    const r1 = await L.get("/api/expense-admin/approval-policy/readiness");
    expect(r1.body.readiness.ready).toBe(false);
    expect(r1.body.readiness.approversWithoutLimit.map((x: any) => x.id)).toEqual([ann.id]);
    expect(r1.body.readiness.missing.join(" ")).toMatch(/1 approver has no approval limit/);
    expect((await L.put("/api/expense-admin/approval-policy", { engineEnabled: true })).status).toBe(409);

    // A rank default that Ann holds makes her usable → the switch goes on.
    await L.put("/api/expense-admin/ranks/4", { label: "Manager", defaultApprovalLimitBase: 50000 });
    await L.patch(`/api/expense-admin/users/${ann.id}/rank`, { bandNumber: 4 });
    const r2 = await L.get("/api/expense-admin/approval-policy/readiness");
    expect(r2.body.readiness.ready).toBe(true);
    expect(r2.body.readiness.usableApprovers).toEqual([{ id: ann.id, name: "Ann T", effectiveLimitBase: 50000, limitSource: "rank" }]);
    const on1 = await L.put("/api/expense-admin/approval-policy", { engineEnabled: true });
    expect(on1.status).toBe(200);
    expect(on1.body.policy.engineEnabled).toBe(true);
    expect(on1.body.readiness.ready).toBe(true);

    // Other settings can still change while ON; turning OFF never needs readiness.
    expect((await L.put("/api/expense-admin/approval-policy", { bot: { enabled: true, thresholdBase: 1000 } })).status).toBe(200);
    expect((await L.put("/api/expense-admin/approval-policy", { engineEnabled: false })).status).toBe(200);

    // "Who changed what": the GET carries the last changes with the actor's name.
    const g = await L.get("/api/expense-admin/approval-policy");
    expect(g.body.history.length).toBeGreaterThanOrEqual(3);
    expect(g.body.history[0]).toMatchObject({ byName: "Lena T", changed: ["engineEnabled"] });
    expect(g.body.readiness.ready).toBe(true);
    // …and per person on the Team list.
    const team = await L.get("/api/expense-admin/users");
    const row = team.body.users.find((u: any) => u.id === ann.id);
    expect(row.lastGrantChange).toMatchObject({ byName: "Lena T", changed: ["approver"] });

    // Employees see none of it.
    expect((await as(t.employee).get("/api/expense-admin/approval-policy/readiness")).status).toBe(403);
  });

  it("legacy Team-page contract works off the policy document; live submit still routes the OLD way", async () => {
    const t = await makeWorkspace();
    const L = as(t.leader);
    const senior = await makeUser(t.wsId, ["EMPLOYEE"], "Sunil");
    const mgr = await makeUser(t.wsId, ["MANAGER"], "Meera");
    const emp = await makeUser(t.wsId, ["EMPLOYEE"], "Arjun", { managerId: mgr.id });

    // The old GET/PATCH /policy still answers with the same keys — from the policy doc.
    const g0 = await L.get("/api/expense-admin/policy");
    expect(g0.body.policy).toMatchObject({ baseCurrency: "INR", expenseEscalationThreshold: null, advanceEscalationThreshold: null, seniorApproverId: null, engineEnabled: false });
    const p1 = await L.patch("/api/expense-admin/policy", { expenseEscalationThreshold: 1000, seniorApproverId: senior.id });
    expect(p1.status).toBe(200);
    expect(p1.body.policy).toMatchObject({ expenseEscalationThreshold: 1000, seniorApproverId: senior.id, policyVersion: 1 });
    expect((await getPolicy(t.wsId)).legacyEscalation).toEqual({ claimThresholdBase: 1000, advanceThresholdBase: null, seniorApproverId: senior.id });
    // …and NOT on the workspace config any more.
    const raw: any = await CustomerWorkspace.collection.findOne({ _id: new mongoose.Types.ObjectId(t.wsId) });
    expect(raw.config.expenseEscalationThreshold).toBeUndefined();
    expect(raw.config.seniorApproverId).toBeUndefined();
    expect((await L.patch("/api/expense-admin/policy", { seniorApproverId: new mongoose.Types.ObjectId().toString() })).status).toBe(400);

    // Live submit: a policy with the engine OFF and the bot ON must still route the old way.
    await L.put("/api/expense-admin/approval-policy", { bot: { enabled: true, thresholdBase: 100000 } });
    const E = as(emp);
    const line = (await E.post("/api/expenses", { amount: 5000, date: TODAY })).body.expense;
    const claim = (await E.post("/api/reports", { name: "c" })).body.report;
    await E.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [line._id] });
    const sub = await E.post(`/api/reports/${claim._id}/submit`);
    expect(sub.status).toBe(200);
    expect(sub.body.report.status).toBe("submitted"); // NOT bot-approved — engine not wired
    expect(sub.body.report.routing.mode).toBe("legacy_manager_admin");
    // The legacy threshold (now read from the policy doc) still adds the senior approver as L2.
    expect(sub.body.report.approvalChain.map((l: any) => [l.approverId, l.via])).toEqual([[mgr.id, "manager"], [senior.id, "senior_approver"]]);
  });
});
