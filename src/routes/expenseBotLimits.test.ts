// Per-category bot limits (Part A), the F-22 pre-check fix + the single-vs-mixed
// bot rule (Part B), and the system-owned claim name prefix (Part C).
//
// Real Mongo (memory server), real routers, real middleware chain; nothing
// mocked — same harness as expenseEngine.test.ts. Every claim here goes in
// through POST /api/expenses → POST /api/reports → /expenses → /submit, so the
// engine is exercised exactly as the UI drives it.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-connected";
process.env.JWT_SECRET = "botlimit-test-secret";
process.env.JWT_REFRESH_SECRET = "botlimit-test-refresh";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET = "test-bucket";
process.env.GEMINI_API_KEY = "test";
process.env.DISABLE_EMAILS = "1";
process.env.NODE_ENV = "test";
delete process.env.EXCHANGERATE_API_KEY;

const { requireAuth } = await import("../middleware/auth.js");
const { requireWorkspace } = await import("../middleware/requireWorkspace.js");
const { requireFeature } = await import("../middleware/requireFeature.js");
const { attachExpenseGrant, upsertGrant } = await import("../services/expenseGrants.service.js");
const { updatePolicy } = await import("../services/expensePolicy.service.js");
const { signToken } = await import("../utils/jwt.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: User } = await import("../models/User.js");
const { default: ExpenseCategory, categoryBotLimit } = await import("../models/ExpenseCategory.js");
const { claimDisplayName, stripSystemPrefix } = await import("../services/expenseClaimNaming.js");
const { default: expensesRouter } = await import("./expenses.js");
const { default: adminRouter } = await import("./expenseAdmin.js");
const { default: reportsRouter } = await import("./expenseReports.js");
const { default: categoriesRouter } = await import("./expenseCategories.js");

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
  app.use("/api/expense-categories", ...gate, categoriesRouter);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

type Actor = { id: string; email: string; roles: string[]; workspaceId: string; customerId?: string; name: string };
function as(a: Actor) {
  const t = signToken({ sub: a.id, roles: a.roles, email: a.email, workspaceId: a.workspaceId, ...(a.customerId ? { customerId: a.customerId } : {}) } as any);
  const h = (r: request.Test) => r.set("Authorization", `Bearer ${t}`);
  return {
    get: (p: string) => h(request(app).get(p)),
    put: (p: string, body?: any) => h(request(app).put(p)).send(body ?? {}),
    patch: (p: string, body?: any) => h(request(app).patch(p)).send(body ?? {}),
    post: (p: string, body?: any) => h(request(app).post(p)).send(body ?? {}),
    delete: (p: string) => h(request(app).delete(p)),
  };
}

let seq = 0;
async function makeUser(workspaceId: string, roles: string[], first: string, extra: Record<string, any> = {}): Promise<Actor> {
  seq++;
  const email = `bot-${seq}-${Date.now()}@test.local`;
  const u = await User.create({ email, passwordHash: "x", firstName: first, lastName: "T", roles, workspaceId, status: "ACTIVE", ...extra });
  return { id: String(u._id), email, roles, workspaceId, name: `${first} T`, ...(extra.customerId ? { customerId: extra.customerId } : {}) };
}

/**
 * Engine ON, bot ON with a ₹2,000 MIXED-category limit.
 *   Meera (L4 ₹50k) is Arjun's manager · Chitra ₹20L is the deep pocket
 *   Meals  → category bot limit ₹1,000
 *   Travel → category bot limit ₹5,000
 *   Office → Not Applicable (never auto-approves)
 *   Legacy → created straight on the model with NO bot limit at all
 */
async function makeWorkspace() {
  seq++;
  const customerId = `cust-bot-${seq}-${Date.now()}`;
  const ws = await CustomerWorkspace.create({ customerId, name: `Bot WS ${seq}`, status: "ACTIVE", config: { features: { expensesEnabled: true } } });
  const wsId = String(ws._id);
  const leader = await makeUser(wsId, ["CUSTOMER", "WORKSPACE_LEADER"], "Lena", { customerId });
  const L = as(leader);
  await L.put("/api/expense-admin/ranks", { ranks: [{ bandNumber: 4, label: "Manager", defaultApprovalLimitBase: 50000 }] });
  const meera = await makeUser(wsId, ["MANAGER"], "Meera", { bandNumber: 4 });
  const chitra = await makeUser(wsId, ["EMPLOYEE"], "Chitra");
  await upsertGrant({ workspaceId: wsId, userId: meera.id, patch: { approver: true } });
  await upsertGrant({ workspaceId: wsId, userId: chitra.id, patch: { approver: true, limitBase: 2000000 } });
  const arjun = await makeUser(wsId, ["EMPLOYEE"], "Arjun", { managerId: meera.id });

  const mk = async (name: string, botLimitMode: "amount" | "na", botLimitBase: number | null) =>
    String((await ExpenseCategory.create({ workspaceId: wsId, name, active: true, botLimitMode, botLimitBase }))._id);
  const meals = await mk("Meals", "amount", 1000);
  const travel = await mk("Travel", "amount", 5000);
  const office = await mk("Office supplies", "na", null);
  // A category from before the field existed: no mode, no amount.
  const legacy = String((await ExpenseCategory.create({ workspaceId: wsId, name: "Legacy", active: true }))._id);

  await L.put("/api/expense-admin/approval-policy", { bot: { enabled: true, thresholdBase: 2000 }, engineEnabled: true });
  return { wsId, leader, L, meera, chitra, arjun, meals, travel, office, legacy };
}

/** Build a claim with the given lines and return its id/ref. */
async function claimWith(who: Actor, wsId: string, name: string, lines: { amount: number; categoryId?: string; receipt?: boolean }[]) {
  const W = as(who);
  const ids: string[] = [];
  for (const l of lines) {
    const r = await W.post("/api/expenses", {
      amount: l.amount, date: TODAY, merchant: `${name} ${ids.length + 1}`, categoryId: l.categoryId,
      ...(l.receipt ? { imageKey: `hrms/expenses/${wsId}/${who.id}/${name}-${ids.length}-${Date.now()}.jpg` } : {}),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    ids.push(r.body.expense._id);
  }
  const c = (await W.post("/api/reports", { name })).body.report;
  await W.post(`/api/reports/${c._id}/expenses`, { expenseIds: ids });
  return { id: String(c._id), ref: String(c.ref), expenseIds: ids };
}

const submit = (who: Actor, id: string) => as(who).post(`/api/reports/${id}/submit`);
const detail = async (who: Actor, id: string) => (await as(who).get(`/api/reports/${id}`)).body;

/* ═══════════════════════════ PART A ═══════════════════════════ */

describe("PART A — per-category bot limit is mandatory", () => {
  it("refuses a new category with no bot limit at all", async () => {
    const t = await makeWorkspace();
    const r = await t.L.post("/api/expense-categories", { name: "No limit given" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/bot approval limit is required/i);
    expect(await ExpenseCategory.countDocuments({ workspaceId: t.wsId, name: "No limit given" })).toBe(0);
  });

  it("refuses an amount below 1, a non-number, and an unknown mode", async () => {
    const t = await makeWorkspace();
    for (const body of [
      { name: "Zero", botLimitMode: "amount", botLimitBase: 0 },
      { name: "Negative", botLimitMode: "amount", botLimitBase: -5 },
      { name: "Words", botLimitMode: "amount", botLimitBase: "abc" },
      { name: "Missing amount", botLimitMode: "amount" },
      { name: "Bad mode", botLimitMode: "maybe", botLimitBase: 10 },
    ]) {
      const r = await t.L.post("/api/expense-categories", body);
      expect(r.status, `${body.name}: ${JSON.stringify(r.body)}`).toBe(400);
    }
    expect(await ExpenseCategory.countDocuments({ workspaceId: t.wsId, name: /Zero|Negative|Words|Missing|Bad/ })).toBe(0);
  });

  it("accepts an amount ≥ 1 and accepts Not Applicable, and stores each", async () => {
    const t = await makeWorkspace();
    const a = await t.L.post("/api/expense-categories", { name: "Client gifts", botLimitMode: "amount", botLimitBase: 2500 });
    expect(a.status).toBe(201);
    expect(a.body.category).toMatchObject({ botLimitMode: "amount", botLimitBase: 2500 });

    const b = await t.L.post("/api/expense-categories", { name: "Legal fees", botLimitMode: "na" });
    expect(b.status).toBe(201);
    expect(b.body.category).toMatchObject({ botLimitMode: "na", botLimitBase: null });
  });

  it("edit: rejects an invalid bot limit, accepts a valid change, and leaves other edits alone", async () => {
    const t = await makeWorkspace();
    const bad = await t.L.patch(`/api/expense-categories/${t.meals}`, { botLimitMode: "amount", botLimitBase: 0.5 });
    expect(bad.status).toBe(400);

    const good = await t.L.patch(`/api/expense-categories/${t.meals}`, { botLimitMode: "amount", botLimitBase: 1500 });
    expect(good.status).toBe(200);
    expect(good.body.category).toMatchObject({ botLimitMode: "amount", botLimitBase: 1500 });

    const toNa = await t.L.patch(`/api/expense-categories/${t.travel}`, { botLimitMode: "na" });
    expect(toNa.body.category).toMatchObject({ botLimitMode: "na", botLimitBase: null });

    // A rename that never mentions the bot limit must still work, and keep it.
    const rename = await t.L.patch(`/api/expense-categories/${t.meals}`, { name: "Meals & drinks" });
    expect(rename.status).toBe(200);
    expect(rename.body.category).toMatchObject({ name: "Meals & drinks", botLimitMode: "amount", botLimitBase: 1500 });
  });

  it("an existing category with no value set reads as Not Applicable", async () => {
    const t = await makeWorkspace();
    const legacy: any = await ExpenseCategory.findById(t.legacy).lean();
    expect(legacy.botLimitMode).toBeNull();
    expect(categoryBotLimit(legacy)).toEqual({ mode: "na", amountBase: null, set: false });
    // …and `set:false` is what the UI flags — an explicit N/A reads as set.
    const office: any = await ExpenseCategory.findById(t.office).lean();
    expect(categoryBotLimit(office)).toEqual({ mode: "na", amountBase: null, set: true });
  });

  it("the list carries the limit for every category so the page can show a column", async () => {
    const t = await makeWorkspace();
    const rows = (await t.L.get("/api/expense-categories?all=1")).body.categories as any[];
    const byName = Object.fromEntries(rows.map((c) => [c.name, c]));
    expect(byName["Meals"]).toMatchObject({ botLimitMode: "amount", botLimitBase: 1000 });
    expect(byName["Office supplies"]).toMatchObject({ botLimitMode: "na", botLimitBase: null });
    expect(byName["Legacy"].botLimitMode).toBeNull();
  });
});

/* ═══════════════════════════ PART B ═══════════════════════════ */

describe("PART B — F-22: the engine honours policy.bot.require", () => {
  it("turning the receipt pre-check OFF actually relaxes it (the bug is gone)", async () => {
    const t = await makeWorkspace();
    // ON (default): a no-receipt claim under the category limit goes to a human.
    const before = await claimWith(t.arjun, t.wsId, "no receipt on", [{ amount: 500, categoryId: t.meals }]);
    const s1 = await submit(t.arjun, before.id);
    expect(s1.body.report.status).toBe("submitted");
    expect(s1.body.report.routing.bot).toMatchObject({ checksPassed: false, wouldAutoApprove: false });
    expect(s1.body.report.routing.bot.reason).toMatch(/pre-check failed: receipt/);
    expect(String(s1.body.report.approverId)).toBe(t.meera.id);

    // OFF: the very same claim shape now auto-approves.
    await updatePolicy({ workspaceId: t.wsId, patch: { bot: { require: { receipt: false } } } });
    const after = await claimWith(t.arjun, t.wsId, "no receipt off", [{ amount: 500, categoryId: t.meals }]);
    const s2 = await submit(t.arjun, after.id);
    expect(s2.body.report.status).toBe("approved");
    expect(s2.body.report.routing.outcome).toBe("BOT_AUTO_APPROVE");
    expect(s2.body.report.routing.bot).toMatchObject({ checksPassed: true, wouldAutoApprove: true });
    expect(s2.body.report.routing.bot.checksEnforced).not.toContain("receipt");
    expect(s2.body.report.approverId).toBeNull();
  });

  it("a pre-check that is still ON keeps blocking, and only enforced checks are named", async () => {
    const t = await makeWorkspace();
    await updatePolicy({ workspaceId: t.wsId, patch: { bot: { require: { receipt: false } } } });
    // No receipt (relaxed) AND no category (still enforced) → still a human, and
    // the reason names the category check only.
    const c = await claimWith(t.arjun, t.wsId, "uncategorised", [{ amount: 400 }]);
    const s = await submit(t.arjun, c.id);
    expect(s.body.report.status).toBe("submitted");
    expect(s.body.report.routing.bot.reason).toMatch(/pre-check failed: category/);
    expect(s.body.report.routing.bot.reason).not.toMatch(/receipt/);
    expect(s.body.report.routing.bot.checksEnforced).toEqual(expect.arrayContaining(["category", "noDuplicate", "positiveAmounts"]));
  });
});

describe("PART B — single-category claims use their category's bot limit", () => {
  it("under the category limit + clean → the bot approves, and the trail names that limit", async () => {
    const t = await makeWorkspace();
    const c = await claimWith(t.arjun, t.wsId, "lunch", [{ amount: 900, categoryId: t.meals, receipt: true }]);
    const s = await submit(t.arjun, c.id);
    expect(s.body.report.status).toBe("approved");
    expect(s.body.report.routing.outcome).toBe("BOT_AUTO_APPROVE");
    expect(s.body.report.routing.bot).toMatchObject({
      thresholdBase: 1000,           // the Meals limit, NOT the ₹2,000 global
      limitSource: "category",
      categoryNotApplicable: false,
      globalThresholdBase: 2000,
      underThreshold: true,
    });
    expect(s.body.report.routing.bot.limitCategory).toMatchObject({ name: "Meals" });
    expect(s.body.report.approvalChain[0]).toMatchObject({ actorType: "bot", limitBase: 1000 });
  });

  it("over the category limit → a human, even though it is under the global limit", async () => {
    const t = await makeWorkspace();
    // ₹1,500: over Meals' ₹1,000, under the ₹2,000 mixed limit. The stricter
    // category limit governs — the global one must not rescue it.
    const c = await claimWith(t.arjun, t.wsId, "big lunch", [{ amount: 1500, categoryId: t.meals, receipt: true }]);
    const s = await submit(t.arjun, c.id);
    expect(s.body.report.status).toBe("submitted");
    expect(s.body.report.routing.bot).toMatchObject({ thresholdBase: 1000, limitSource: "category", underThreshold: false, wouldAutoApprove: false });
    expect(s.body.report.routing.bot.reason).toMatch(/over the bot limit .*Meals limit/);
    expect(String(s.body.report.approverId)).toBe(t.meera.id);
  });

  it("a category limit ABOVE the global one still governs (₹3,000 Travel > ₹2,000 global)", async () => {
    const t = await makeWorkspace();
    const c = await claimWith(t.arjun, t.wsId, "flight", [{ amount: 3000, categoryId: t.travel, receipt: true }]);
    const s = await submit(t.arjun, c.id);
    expect(s.body.report.status).toBe("approved");
    expect(s.body.report.routing.bot).toMatchObject({ thresholdBase: 5000, limitSource: "category", underThreshold: true });
  });

  it("a Not Applicable category NEVER auto-approves, however small", async () => {
    const t = await makeWorkspace();
    const c = await claimWith(t.arjun, t.wsId, "pens", [{ amount: 1, categoryId: t.office, receipt: true }]);
    const s = await submit(t.arjun, c.id);
    expect(s.body.report.status).toBe("submitted");
    expect(s.body.report.routing.bot).toMatchObject({
      categoryNotApplicable: true,
      thresholdBase: null,
      underThreshold: null,
      wouldAutoApprove: false,
      checksPassed: true, // nothing wrong with the claim — the category is simply out of scope
    });
    expect(s.body.report.routing.bot.reason).toMatch(/Office supplies never auto-approves/);
    expect(String(s.body.report.approverId)).toBe(t.meera.id);
  });

  it("a category whose limit was never set behaves exactly like Not Applicable", async () => {
    const t = await makeWorkspace();
    const c = await claimWith(t.arjun, t.wsId, "legacy line", [{ amount: 10, categoryId: t.legacy, receipt: true }]);
    const s = await submit(t.arjun, c.id);
    expect(s.body.report.status).toBe("submitted");
    expect(s.body.report.routing.bot).toMatchObject({ categoryNotApplicable: true, wouldAutoApprove: false });
  });
});

describe("PART B — mixed-category claims use the global threshold", () => {
  it("under the global limit + clean → the bot approves and says the limit was the mixed one", async () => {
    const t = await makeWorkspace();
    // ₹1,800 total across Meals + Travel. Over Meals' own ₹1,000 — irrelevant,
    // because a mixed claim is judged by the ₹2,000 workspace limit.
    const c = await claimWith(t.arjun, t.wsId, "trip", [
      { amount: 900, categoryId: t.meals, receipt: true },
      { amount: 900, categoryId: t.travel, receipt: true },
    ]);
    const s = await submit(t.arjun, c.id);
    expect(s.body.report.status).toBe("approved");
    expect(s.body.report.routing.bot).toMatchObject({ thresholdBase: 2000, limitSource: "global", limitCategory: null, underThreshold: true });
  });

  it("over the global limit → a human", async () => {
    const t = await makeWorkspace();
    const c = await claimWith(t.arjun, t.wsId, "big trip", [
      { amount: 1500, categoryId: t.meals, receipt: true },
      { amount: 1500, categoryId: t.travel, receipt: true },
    ]);
    const s = await submit(t.arjun, c.id);
    expect(s.body.report.status).toBe("submitted");
    expect(s.body.report.routing.bot).toMatchObject({ thresholdBase: 2000, limitSource: "global", underThreshold: false });
    expect(s.body.report.routing.bot.reason).toMatch(/mixed-category limit/);
  });

  it("a mixed claim that includes a Not Applicable category is judged by the global limit, not blocked outright", async () => {
    const t = await makeWorkspace();
    const c = await claimWith(t.arjun, t.wsId, "mixed with na", [
      { amount: 500, categoryId: t.office, receipt: true },
      { amount: 500, categoryId: t.meals, receipt: true },
    ]);
    const s = await submit(t.arjun, c.id);
    expect(s.body.report.status).toBe("approved");
    expect(s.body.report.routing.bot).toMatchObject({ limitSource: "global", categoryNotApplicable: false, thresholdBase: 2000 });
  });
});

/* ═══════════════════════════ PART C ═══════════════════════════ */

describe("PART C — the claim name carries a system-owned category prefix", () => {
  it("pure function: one category prefixes, many say Mixed, none leaves it alone", () => {
    expect(claimDisplayName("Dubai Sept Trip", ["Meals"])).toBe("Meals: Dubai Sept Trip");
    expect(claimDisplayName("Dubai Sept Trip", ["Travel"])).toBe("Travel: Dubai Sept Trip");
    expect(claimDisplayName("Dubai Sept Trip", ["Meals", "Travel"])).toBe("Mixed: Dubai Sept Trip");
    expect(claimDisplayName("Dubai Sept Trip", [])).toBe("Dubai Sept Trip");
    // Uncategorised bills contribute nothing.
    expect(claimDisplayName("Dubai Sept Trip", ["Meals", "", null, undefined])).toBe("Meals: Dubai Sept Trip");
  });

  it("pure function: prefixing is idempotent and never eats a descriptive colon", () => {
    expect(claimDisplayName("Meals: lunch run", ["Meals"])).toBe("Meals: lunch run");
    expect(claimDisplayName("Mixed: lunch run", ["Meals"])).toBe("Meals: lunch run");
    expect(stripSystemPrefix("Q3: final push", ["Meals"])).toBe("Q3: final push");
    expect(claimDisplayName("Q3: final push", ["Meals"])).toBe("Meals: Q3: final push");
  });

  it("a claim with no bills shows just what the employee typed", async () => {
    const t = await makeWorkspace();
    const created = (await as(t.arjun).post("/api/reports", { name: "Dubai Sept Trip" })).body.report;
    expect(created.displayName).toBe("Dubai Sept Trip");
  });

  it("follows the bills: one category → Mixed → back again, on both the detail and the list", async () => {
    const t = await makeWorkspace();
    const A = as(t.arjun);
    const c = await claimWith(t.arjun, t.wsId, "Dubai Sept Trip", [{ amount: 300, categoryId: t.meals, receipt: true }]);

    // 1 category
    expect((await detail(t.arjun, c.id)).report.displayName).toBe("Meals: Dubai Sept Trip");
    const listOne = (await A.get("/api/reports")).body.docs.find((r: any) => r._id === c.id);
    expect(listOne.displayName).toBe("Meals: Dubai Sept Trip");
    expect(listOne.name).toBe("Dubai Sept Trip"); // stored name never carries the prefix

    // + a second category → Mixed
    const extra = (await A.post("/api/expenses", { amount: 400, date: TODAY, merchant: "cab", categoryId: t.travel })).body.expense;
    await A.post(`/api/reports/${c.id}/expenses`, { expenseIds: [extra._id] });
    expect((await detail(t.arjun, c.id)).report.displayName).toBe("Mixed: Dubai Sept Trip");
    expect((await A.get("/api/reports")).body.docs.find((r: any) => r._id === c.id).displayName).toBe("Mixed: Dubai Sept Trip");

    // remove it → back to the single category
    await A.delete(`/api/reports/${c.id}/expenses/${extra._id}`);
    expect((await detail(t.arjun, c.id)).report.displayName).toBe("Meals: Dubai Sept Trip");

    // remove the last bill → bare descriptive name
    await A.delete(`/api/reports/${c.id}/expenses/${c.expenseIds[0]}`);
    expect((await detail(t.arjun, c.id)).report.displayName).toBe("Dubai Sept Trip");
  });

  it("renaming replaces the descriptive half only, and a pasted-back prefix is not doubled", async () => {
    const t = await makeWorkspace();
    const A = as(t.arjun);
    const c = await claimWith(t.arjun, t.wsId, "Dubai Sept Trip", [{ amount: 300, categoryId: t.travel, receipt: true }]);

    const r1 = await A.patch(`/api/reports/${c.id}`, { name: "Dubai Oct Trip" });
    expect(r1.status).toBe(200);
    expect(r1.body.report).toMatchObject({ name: "Dubai Oct Trip", displayName: "Travel: Dubai Oct Trip" });

    const r2 = await A.patch(`/api/reports/${c.id}`, { name: "Travel: Dubai Nov Trip" });
    expect(r2.body.report.displayName).toBe("Travel: Dubai Nov Trip");
    expect((await detail(t.arjun, c.id)).report.displayName).toBe("Travel: Dubai Nov Trip");
  });

  it("the prefix reflects the bills even on a claim that has already been submitted", async () => {
    const t = await makeWorkspace();
    const c = await claimWith(t.arjun, t.wsId, "Client dinner", [{ amount: 1500, categoryId: t.meals, receipt: true }]);
    await submit(t.arjun, c.id);
    expect((await detail(t.arjun, c.id)).report.displayName).toBe("Meals: Client dinner");
    expect((await detail(t.meera, c.id)).report.displayName).toBe("Meals: Client dinner"); // the approver sees the same
  });
});
