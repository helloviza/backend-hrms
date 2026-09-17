// Approval-engine sub-step 5 — the engine switched ON at live submit. Real
// Mongo (memory server), real routers, real middleware chain; nothing mocked.
// Engine OFF is covered by every earlier suite (unchanged); this file proves
// what changes when a workspace flips the switch.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-connected";
process.env.JWT_SECRET = "engine-test-secret";
process.env.JWT_REFRESH_SECRET = "engine-test-refresh";
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
const { default: ExpenseCategory } = await import("../models/ExpenseCategory.js");
const { default: Report } = await import("../models/Report.js");
const { default: Expense } = await import("../models/Expense.js");
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

type Actor = { id: string; email: string; roles: string[]; workspaceId: string; customerId?: string; name: string };
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
  const email = `eng-${seq}-${Date.now()}@test.local`;
  const u = await User.create({ email, passwordHash: "x", firstName: first, lastName: "T", roles, workspaceId, status: "ACTIVE", ...extra });
  return { id: String(u._id), email, roles, workspaceId, name: `${first} T`, ...(extra.customerId ? { customerId: extra.customerId } : {}) };
}

/**
 * A workspace with the sub-step 3/4 authority + rulebook set up, engine OFF:
 *   ranks: L4 Manager ₹50k, L8 Director ₹5L
 *   Meera (manager of Arjun) L4 → ₹50k · Lata personal ₹20k · Dev L8 → ₹5L · Chitra personal ₹20L
 *   bot: on, mixed-category limit ₹2,000; Travel and Entertainment each carry a
 *   ₹2,000 category bot limit · Entertainment never-bot · Travel ×2
 *   finance: Farah
 */
async function makeEngineWorkspace() {
  seq++;
  const customerId = `cust-eng-${seq}-${Date.now()}`;
  const ws = await CustomerWorkspace.create({ customerId, name: `Engine WS ${seq}`, status: "ACTIVE", config: { features: { expensesEnabled: true } } });
  const wsId = String(ws._id);
  const leader = await makeUser(wsId, ["CUSTOMER", "WORKSPACE_LEADER"], "Lena", { customerId });
  const L = as(leader);
  await L.put("/api/expense-admin/ranks", { ranks: [{ bandNumber: 4, label: "Manager", defaultApprovalLimitBase: 50000 }, { bandNumber: 8, label: "Director", defaultApprovalLimitBase: 500000 }] });
  const meera = await makeUser(wsId, ["MANAGER"], "Meera", { bandNumber: 4 });
  const lata = await makeUser(wsId, ["EMPLOYEE"], "Lata");
  const dev = await makeUser(wsId, ["EMPLOYEE"], "Dev", { bandNumber: 8 });
  const chitra = await makeUser(wsId, ["EMPLOYEE"], "Chitra");
  const farah = await makeUser(wsId, ["EMPLOYEE"], "Farah");
  await upsertGrant({ workspaceId: wsId, userId: meera.id, patch: { approver: true } });
  await upsertGrant({ workspaceId: wsId, userId: lata.id, patch: { approver: true, limitBase: 20000 } });
  await upsertGrant({ workspaceId: wsId, userId: dev.id, patch: { approver: true } });
  await upsertGrant({ workspaceId: wsId, userId: chitra.id, patch: { approver: true, limitBase: 2000000 } });
  await upsertGrant({ workspaceId: wsId, userId: farah.id, patch: { finance: true } });
  const arjun = await makeUser(wsId, ["EMPLOYEE"], "Arjun", { managerId: meera.id });
  // Per-category bot limits (Part A): both are set to the SAME ₹2,000 as the
  // workspace-wide mixed-category limit below, so every expectation in this
  // suite — which predates per-category limits — keeps testing exactly what it
  // was written to test. Entertainment stays blocked by its never-auto-approve
  // rule, not by an absent limit.
  const travel = String((await ExpenseCategory.create({ workspaceId: wsId, name: "Travel", active: true, botLimitMode: "amount", botLimitBase: 2000 }))._id);
  const ent = String((await ExpenseCategory.create({ workspaceId: wsId, name: "Entertainment", active: true, botLimitMode: "amount", botLimitBase: 2000 }))._id);
  await L.put("/api/expense-admin/approval-policy", {
    bot: { enabled: true, thresholdBase: 2000 },
    categoryRules: [{ categoryId: ent, neverAutoApprove: true }, { categoryId: travel, weight: 2 }],
  });
  return { wsId, leader, L, meera, lata, dev, chitra, farah, arjun, travel, ent };
}
const engineOn = (wsId: string, on = true) => updatePolicy({ workspaceId: wsId, patch: { engineEnabled: on } });

/** Capture a claim with the given lines (amount, categoryId?, receipt?) as `who`. */
async function claimWith(who: Actor, wsId: string, name: string, lines: { amount: number; categoryId?: string; receipt?: boolean; currency?: string }[]) {
  const W = as(who);
  const ids: string[] = [];
  for (const l of lines) {
    const r = await W.post("/api/expenses", {
      amount: l.amount, currency: l.currency, date: TODAY, merchant: name, categoryId: l.categoryId,
      ...(l.receipt ? { imageKey: `hrms/expenses/${wsId}/${who.id}/${name}-${ids.length}-${Date.now()}.jpg` } : {}),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    ids.push(r.body.expense._id);
  }
  const c = (await W.post("/api/reports", { name })).body.report;
  await W.post(`/api/reports/${c._id}/expenses`, { expenseIds: ids });
  return { id: String(c._id), ref: c.ref as string, expenseIds: ids };
}
const trail = async (who: Actor, id: string) => (await as(who).get(`/api/reports/${id}`)).body;

describe("engine OFF (default) — untouched", () => {
  it("routes manager → admin exactly as before even with a fully configured rulebook, and never bot-approves", async () => {
    const t = await makeEngineWorkspace(); // engine off, bot ON in the policy
    const c = await claimWith(t.arjun, t.wsId, "tiny", [{ amount: 500, receipt: true, categoryId: t.travel }]);
    const sub = await as(t.arjun).post(`/api/reports/${c.id}/submit`);
    expect(sub.status).toBe(200);
    expect(sub.body.report.status).toBe("submitted");
    expect(sub.body.report.routing.mode).toBe("legacy_manager_admin");
    expect(String(sub.body.report.approverId)).toBe(t.meera.id);
    expect(await ExpenseActivity.countDocuments({ reportId: c.id, event: "auto_approved" })).toBe(0);
  });
});

describe("engine ON — live routing through routeClaim()", () => {
  it("a small clean claim auto-approves via the bot, lands at finance with the bot actor on record", async () => {
    const t = await makeEngineWorkspace();
    await engineOn(t.wsId);
    const c = await claimWith(t.arjun, t.wsId, "coffee", [{ amount: 1200, receipt: true, categoryId: t.travel }]); // ×2 → 2400 required, but the bot keys on the AMOUNT (1200 ≤ 2000)
    const sub = await as(t.arjun).post(`/api/reports/${c.id}/submit`);
    expect(sub.status).toBe(200);
    expect(sub.body.report.status).toBe("approved"); // straight through
    expect(sub.body.report.approverId).toBeNull();
    expect(sub.body.report.routing).toMatchObject({ mode: "engine", outcome: "BOT_AUTO_APPROVE" });
    expect(sub.body.report.routing.bot).toMatchObject({ evaluated: true, underThreshold: true, checksPassed: true, wouldAutoApprove: true });
    expect(sub.body.report.approvalChain).toHaveLength(1);
    expect(sub.body.report.approvalChain[0]).toMatchObject({ actorType: "bot", via: "bot", status: "approved", approverId: null, limitBase: 2000 });

    // Lines follow: approved. Trail: submitted → routed (system) → auto_approved (bot).
    const lines = await Expense.find({ reportId: c.id }).lean();
    expect(lines.every((l: any) => l.lifecycleStatus === "approved")).toBe(true);
    const d = await trail(t.arjun, c.id);
    const events = d.activity.map((a: any) => a.event);
    expect(events).toEqual(expect.arrayContaining(["submitted", "routed", "auto_approved"]));
    const auto = d.activity.find((a: any) => a.event === "auto_approved");
    expect(auto).toMatchObject({ actorType: "bot", actorName: "Approval Bot", actorId: null, heldMs: 0 });
    expect(auto.details).toMatchObject({ thresholdBase: 2000, amountBase: 1200, final: true });
    expect(d.report.approvalChain[0].approverName).toBe("Approval Bot");
    // Not in anyone's approval queue; in finance's reimburse queue; not withdrawable; finance can pay.
    expect((await as(t.meera).get("/api/reports?queue=approvals")).body.docs.map((r: any) => r._id)).not.toContain(c.id);
    expect((await as(t.farah).get("/api/reports?queue=reimburse")).body.docs.map((r: any) => r._id)).toContain(c.id);
    expect((await as(t.arjun).post(`/api/reports/${c.id}/withdraw`)).status).toBe(409);
    expect((await as(t.farah).post(`/api/reports/${c.id}/reimburse`)).status).toBe(200);
  });

  it("bot hands off when a pre-check fails (no receipt) or the category is never-bot", async () => {
    const t = await makeEngineWorkspace();
    await engineOn(t.wsId);
    const noReceipt = await claimWith(t.arjun, t.wsId, "noreceipt", [{ amount: 500, categoryId: t.travel }]);
    const s1 = await as(t.arjun).post(`/api/reports/${noReceipt.id}/submit`);
    expect(s1.body.report.status).toBe("submitted");
    expect(s1.body.report.routing.bot).toMatchObject({ underThreshold: true, checksPassed: false, wouldAutoApprove: false });
    expect(s1.body.report.routing.outcome).toBe("MANAGER_FINAL");
    expect(String(s1.body.report.approverId)).toBe(t.meera.id);
    const ent = await claimWith(t.arjun, t.wsId, "dinner", [{ amount: 500, receipt: true, categoryId: t.ent }]);
    const s2 = await as(t.arjun).post(`/api/reports/${ent.id}/submit`);
    expect(s2.body.report.routing.bot).toMatchObject({ underThreshold: true, blockedByCategory: true, wouldAutoApprove: false });
    expect(s2.body.report.status).toBe("submitted");
  });

  it("an over-threshold claim routes to the LOWEST covering approver with the full why-trail written; the chain then works normally", async () => {
    const t = await makeEngineWorkspace();
    await engineOn(t.wsId);
    // ₹30k Travel ×2 → ₹60k required: Meera (₹50k) endorses, Lata (₹20k) skipped, Dev (₹5L) chosen, Chitra considered.
    const c = await claimWith(t.arjun, t.wsId, "travel", [{ amount: 30000, receipt: true, categoryId: t.travel }]);
    const sub = await as(t.arjun).post(`/api/reports/${c.id}/submit`);
    expect(sub.status).toBe(200);
    const r = sub.body.report;
    expect(r.status).toBe("submitted");
    expect(r.routing).toMatchObject({ mode: "engine", outcome: "MANAGER_THEN_LIMIT", requiredLimitBase: 60000, climbed: true, overLimit: false, fourEyes: false });
    expect(r.routing.rule).toMatchObject({ weight: 2, categoryIds: [t.travel] });
    expect(r.approvalChain.map((l: any) => [l.approverId, l.via, l.limitBase, l.status])).toEqual([
      [t.meera.id, "manager", 50000, "pending"],
      [t.dev.id, "limit", 500000, "pending"],
    ]);
    expect(r.approvalChain[0].routedAt).toBeTruthy();
    expect(r.approvalChain[1].routedAt).toBeNull();
    expect(String(r.approverId)).toBe(t.meera.id);

    // The why-trail on the timeline is the engine's decision, verbatim.
    const d = await trail(t.arjun, c.id);
    const routed = d.activity.find((a: any) => a.event === "routed");
    expect(routed.actorType).toBe("system");
    expect(routed.details.mode).toBe("engine");
    expect(routed.details.trace.find((x: any) => x.userId === t.lata.id)).toMatchObject({ outcome: "skipped" });
    expect(routed.details.trace.find((x: any) => x.userId === t.lata.id).reason).toMatch(/too small/);
    expect(routed.details.trace.find((x: any) => x.userId === t.chitra.id)).toMatchObject({ outcome: "considered" });
    expect(routed.details.trace.find((x: any) => x.userId === t.dev.id)).toMatchObject({ outcome: "chosen" });
    expect(routed.note).toMatch(/Climbed past 1 approver/);
    expect(routed.details.explain.length).toBeGreaterThan(1);

    // Queues + decisions: Meera sees it, Dev not yet; Meera approves → Dev; Dev approves → approved.
    expect((await as(t.meera).get("/api/reports?queue=approvals")).body.docs.map((x: any) => x._id)).toContain(c.id);
    expect((await as(t.dev).get("/api/reports?queue=approvals")).body.docs.map((x: any) => x._id)).not.toContain(c.id);
    expect((await as(t.dev).post(`/api/reports/${c.id}/approve`)).status).toBe(403);
    expect((await as(t.meera).post(`/api/reports/${c.id}/approve`)).status).toBe(200);
    const mid: any = await Report.findById(c.id).lean();
    expect(mid.status).toBe("submitted");
    expect(String(mid.approverId)).toBe(t.dev.id);
    expect(mid.approvalChain[1].routedAt).toBeTruthy();
    expect((await as(t.dev).post(`/api/reports/${c.id}/approve`)).status).toBe(200);
    expect(((await Report.findById(c.id).lean()) as any).status).toBe("approved");
  });

  it("over everyone's limit → the two-approver flagged four-eyes chain", async () => {
    const t = await makeEngineWorkspace();
    await engineOn(t.wsId);
    const c = await claimWith(t.arjun, t.wsId, "huge", [{ amount: 5000000, receipt: true }]);
    const sub = await as(t.arjun).post(`/api/reports/${c.id}/submit`);
    expect(sub.status).toBe(200);
    const r = sub.body.report;
    expect(r.routing).toMatchObject({ outcome: "TOP_FLAGGED_FOUR_EYES", overLimit: true, fourEyes: true });
    expect(r.approvalChain.map((l: any) => [l.approverId, l.via, l.overLimit])).toEqual([
      [t.meera.id, "manager", false],
      [t.chitra.id, "top", true],
      [t.dev.id, "four_eyes", true],
    ]);
    // All three must approve, in order; the record keeps the flags.
    expect((await as(t.meera).post(`/api/reports/${c.id}/approve`)).status).toBe(200);
    expect((await as(t.chitra).post(`/api/reports/${c.id}/approve`)).status).toBe(200);
    expect(((await Report.findById(c.id).lean()) as any).status).toBe("submitted");
    expect((await as(t.dev).post(`/api/reports/${c.id}/approve`)).status).toBe(200);
    const done: any = await Report.findById(c.id).lean();
    expect(done.status).toBe("approved");
    expect(done.approvalChain.filter((l: any) => l.overLimit).length).toBe(2);
    expect(done.routing.overLimit).toBe(true);
    const approvals = (await trail(t.arjun, c.id)).activity.filter((a: any) => a.event === "approved");
    expect(approvals.map((a: any) => a.actorId)).toEqual([t.meera.id, t.chitra.id, t.dev.id]);
  });

  it("NO_APPROVER is refused with a clear message (never silently lost); REFUSE_SUBMIT likewise", async () => {
    seq++;
    const customerId = `cust-eng-empty-${seq}-${Date.now()}`;
    const ws = await CustomerWorkspace.create({ customerId, name: "Empty pool", status: "ACTIVE", config: { features: { expensesEnabled: true } } });
    const wsId = String(ws._id);
    const mgr = await makeUser(wsId, ["MANAGER"], "Mo"); // manager exists but has no limit and there is no approver pool
    const emp = await makeUser(wsId, ["EMPLOYEE"], "Eve", { managerId: mgr.id });
    const hr = await makeUser(wsId, ["HR"], "Hana"); // a structural admin exists — legacy would have used them
    await engineOn(wsId);
    const c = await claimWith(emp, wsId, "orphan", [{ amount: 100, receipt: true }]);
    const sub = await as(emp).post(`/api/reports/${c.id}/submit`);
    expect(sub.status).toBe(409);
    expect(sub.body.blocking[0]).toMatch(/No approver is configured who can approve this amount — contact your admin/);
    const doc: any = await Report.findById(c.id).lean();
    expect(doc.status).toBe("draft"); // stays with the employee, editable
    expect(doc.approverId).toBeNull();
    expect(await ExpenseActivity.countDocuments({ reportId: c.id, event: "routed" })).toBe(0);
    void hr;

    // REFUSE_SUBMIT with a pool that cannot cover.
    const t = await makeEngineWorkspace();
    await engineOn(t.wsId);
    await updatePolicy({ workspaceId: t.wsId, patch: { topOfChain: "REFUSE_SUBMIT" } });
    const big = await claimWith(t.arjun, t.wsId, "refused", [{ amount: 5000000, receipt: true }]);
    const s2 = await as(t.arjun).post(`/api/reports/${big.id}/submit`);
    expect(s2.status).toBe(409);
    expect(s2.body.blocking[0]).toContain("No approver is configured who can approve this amount (INR 5000000)");
    expect(((await Report.findById(big.id).lean()) as any).status).toBe("draft");
  });

  it("an in-flight claim submitted BEFORE the switch keeps its legacy chain after the switch flips", async () => {
    const t = await makeEngineWorkspace(); // engine off
    const c = await claimWith(t.arjun, t.wsId, "before", [{ amount: 1200, receipt: true, categoryId: t.travel }]); // would be BOT-approved under the engine
    expect((await as(t.arjun).post(`/api/reports/${c.id}/submit`)).status).toBe(200);
    const before: any = await Report.findById(c.id).lean();
    expect(before.routing.mode).toBe("legacy_manager_admin");

    await engineOn(t.wsId); // flip
    const after: any = await Report.findById(c.id).lean();
    expect(after.status).toBe("submitted");
    expect(after.routing.mode).toBe("legacy_manager_admin");
    expect(after.approvalChain).toEqual(before.approvalChain);
    expect(String(after.approverId)).toBe(t.meera.id);
    expect((await as(t.meera).get("/api/reports?queue=approvals")).body.docs.map((x: any) => x._id)).toContain(c.id);
    // …and it finishes under that chain.
    expect((await as(t.meera).post(`/api/reports/${c.id}/approve`)).status).toBe(200);
    expect(((await Report.findById(c.id).lean()) as any).status).toBe("approved");
    // A NEW claim submitted now goes through the engine (and the bot).
    const c2 = await claimWith(t.arjun, t.wsId, "after", [{ amount: 1200, receipt: true, categoryId: t.travel }]);
    const s2 = await as(t.arjun).post(`/api/reports/${c2.id}/submit`);
    expect(s2.body.report.status).toBe("approved");
    expect(s2.body.report.routing.mode).toBe("engine");
  });

  it("simulator == engine: the live routed record matches the simulator's prediction for the same claim", async () => {
    const t = await makeEngineWorkspace();
    await engineOn(t.wsId);
    const c = await claimWith(t.arjun, t.wsId, "same", [{ amount: 30000, receipt: true, categoryId: t.travel }, { amount: 100, receipt: true, categoryId: t.ent }]);
    const sim = await t.L.post("/api/expense-admin/approval-policy/simulate", { reportId: c.id });
    expect(sim.status).toBe(200);
    const predicted = sim.body.decision;
    expect(((await Report.findById(c.id).lean()) as any).status).toBe("draft"); // simulator changed nothing

    const sub = await as(t.arjun).post(`/api/reports/${c.id}/submit`);
    expect(sub.status).toBe(200);
    const live = sub.body.report.routing;
    const strip = (d: any) => {
      const { decidedAt, ...rest } = d;
      return JSON.parse(JSON.stringify(rest));
    };
    expect(strip(live)).toEqual(strip(predicted));
    expect(live.outcome).toBe("MANAGER_THEN_LIMIT");
    expect(live.requiredLimitBase).toBe(60200); // (30000 + 100) × 2
    expect(live.rule.neverAutoApprove).toBe(true);
    expect(sub.body.report.approvalChain.map((l: any) => l.approverId)).toEqual(predicted.chain.map((l: any) => l.approverId));
    const routed = (await trail(t.arjun, c.id)).activity.find((a: any) => a.event === "routed");
    expect(strip(routed.details)).toEqual(strip(predicted));
  });

  it("a pending currency conversion still blocks submit AHEAD of routing", async () => {
    const t = await makeEngineWorkspace();
    await engineOn(t.wsId);
    const c = await claimWith(t.arjun, t.wsId, "fx", [{ amount: 40, currency: "USD", receipt: true, categoryId: t.travel }]); // no API key → pending
    const sub = await as(t.arjun).post(`/api/reports/${c.id}/submit`);
    expect(sub.status).toBe(409);
    expect(sub.body.blocking.join(" ")).toMatch(/exchange rate/);
    expect(await ExpenseActivity.countDocuments({ reportId: c.id, event: "routed" })).toBe(0);
    // Resolve → routes (₹3,340 → bot? no: 3340 > 2000 → manager).
    await as(t.arjun).patch(`/api/expenses/${c.expenseIds[0]}/rate`, { exchangeRate: 83.5 });
    const s2 = await as(t.arjun).post(`/api/reports/${c.id}/submit`);
    expect(s2.status).toBe(200);
    expect(s2.body.report.routing).toMatchObject({ mode: "engine", amountBase: 3340 });
  });
});
