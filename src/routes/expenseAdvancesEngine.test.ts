// Approval-engine sub-step 6 — advances requested through the SAME routeClaim()
// engine as claims, behind the same per-workspace switch, with ADVANCE-shaped
// bot pre-checks (amount / purpose / dates — never receipts / categories /
// duplicate bills). Real Mongo, real routers, real middleware chain.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-connected";
process.env.JWT_SECRET = "adv-engine-test-secret";
process.env.JWT_REFRESH_SECRET = "adv-engine-test-refresh";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET = "test-bucket";
process.env.GEMINI_API_KEY = "test";
process.env.DISABLE_EMAILS = "1";
process.env.NODE_ENV = "test";

const { requireAuth } = await import("../middleware/auth.js");
const { requireWorkspace } = await import("../middleware/requireWorkspace.js");
const { requireFeature, requireExpenseAdvancesFeature } = await import("../middleware/requireFeature.js");
const { attachExpenseGrant, upsertGrant } = await import("../services/expenseGrants.service.js");
const { updatePolicy } = await import("../services/expensePolicy.service.js");
const { checksForAdvance } = await import("../services/expenseRoutingInput.service.js");
const { signToken } = await import("../utils/jwt.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: User } = await import("../models/User.js");
const { default: ExpenseAdvance } = await import("../models/ExpenseAdvance.js");
const { default: ExpenseActivity } = await import("../models/ExpenseActivity.js");
const { default: expensesRouter } = await import("./expenses.js");
const { default: adminRouter } = await import("./expenseAdmin.js");
const { default: reportsRouter } = await import("./expenseReports.js");
const { default: advancesRouter } = await import("./expenseAdvances.js");

let mongod: MongoMemoryServer;
let app: express.Express;
const TODAY = new Date().toISOString().slice(0, 10);
const NEXT_WEEK = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);

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
  app.use("/api/expense-advances", requireAuth, requireWorkspace, attachExpenseGrant, requireExpenseAdvancesFeature, advancesRouter);
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
  const email = `adv-${seq}-${Date.now()}@test.local`;
  const u = await User.create({ email, passwordHash: "x", firstName: first, lastName: "T", roles, workspaceId, status: "ACTIVE", ...extra });
  return { id: String(u._id), email, roles, workspaceId, name: `${first} T`, ...(extra.customerId ? { customerId: extra.customerId } : {}) };
}
/** Same shape as the claim-engine suite: L4 ₹50k, L8 ₹5L; Meera(L4, Arjun's manager), Lata ₹20k, Dev(L8), Chitra ₹20L; Farah finance; bot ₹2,000. */
async function makeEngineWorkspace() {
  seq++;
  const customerId = `cust-adv-${seq}-${Date.now()}`;
  const ws = await CustomerWorkspace.create({ customerId, name: `Advance engine WS ${seq}`, status: "ACTIVE", config: { features: { expensesEnabled: true, advancesEnabled: true } } });
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
  await L.put("/api/expense-admin/approval-policy", { bot: { enabled: true, thresholdBase: 2000 } });
  return { wsId, leader, L, meera, lata, dev, chitra, farah, arjun };
}
const engineOn = (wsId: string) => updatePolicy({ workspaceId: wsId, patch: { engineEnabled: true } });
const advTrail = async (who: Actor, id: string) => (await as(who).get(`/api/expense-advances/${id}`)).body;

describe("advance-appropriate bot pre-checks (pure)", () => {
  it("checks amount / purpose / dates — never receipts, categories or duplicates", () => {
    const clean = checksForAdvance({ amount: 1500, purpose: "Vendor visit", neededBy: NEXT_WEEK });
    expect(clean).toEqual({ positiveAmount: true, purposePresent: true, validDates: true });
    expect(Object.keys(clean)).not.toContain("receipt");
    expect(checksForAdvance({ amount: 1500, purpose: "x" })).toEqual({ positiveAmount: true, purposePresent: true, validDates: true }); // neededBy optional
    expect(checksForAdvance({ amount: 0, purpose: "x" }).positiveAmount).toBe(false);
    expect(checksForAdvance({ amount: "abc", purpose: "x" }).positiveAmount).toBe(false);
    expect(checksForAdvance({ amount: 10, purpose: "   " }).purposePresent).toBe(false);
    expect(checksForAdvance({ amount: 10, purpose: "x", neededBy: "not-a-date" }).validDates).toBe(false);
    expect(checksForAdvance({ amount: 10, purpose: "x", neededBy: "2020-01-01" }).validDates).toBe(false); // in the past
    expect(checksForAdvance({ amount: 10, purpose: "x", neededBy: TODAY }).validDates).toBe(true);
  });
});

describe("engine OFF (default) — advances untouched", () => {
  it("routes manager → admin exactly as before with a fully configured rulebook; never bot-approves", async () => {
    const t = await makeEngineWorkspace();
    const r = await as(t.arjun).post("/api/expense-advances", { amount: 500, purpose: "taxi float", neededBy: NEXT_WEEK });
    expect(r.status).toBe(201);
    expect(r.body.advance.status).toBe("awaiting_approval");
    expect(r.body.advance.routing.mode).toBe("legacy_manager_admin");
    expect(String(r.body.advance.approverId)).toBe(t.meera.id);
    expect(await ExpenseActivity.countDocuments({ advanceId: r.body.advance._id, event: "auto_approved" })).toBe(0);
  });
});

describe("engine ON — advances through routeClaim()", () => {
  it("a small clean advance auto-approves via the bot with advance checks (no receipt check), then disburses normally", async () => {
    const t = await makeEngineWorkspace();
    await engineOn(t.wsId);
    const r = await as(t.arjun).post("/api/expense-advances", { amount: 1500, purpose: "Vendor visit float", neededBy: NEXT_WEEK });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const a = r.body.advance;
    expect(a.status).toBe("approved");
    expect(a.approverId).toBeNull();
    expect(a.approvedAt).toBeTruthy();
    expect(a.routing).toMatchObject({ mode: "engine", kind: "advance", outcome: "BOT_AUTO_APPROVE" });
    expect(a.routing.bot.checks).toEqual({ positiveAmount: true, purposePresent: true, validDates: true }); // advance checks, not claim checks
    expect(Object.keys(a.routing.bot.checks)).not.toContain("receipt");
    expect(a.approvalChain).toHaveLength(1);
    expect(a.approvalChain[0]).toMatchObject({ actorType: "bot", via: "bot", status: "approved", limitBase: 2000 });

    // Trail: requested (user) → routed (system) → auto_approved (bot).
    const d = await advTrail(t.arjun, a._id);
    const events = d.activity.map((x: any) => x.event);
    expect(events).toEqual(["requested", "routed", "auto_approved"]);
    const auto = d.activity.find((x: any) => x.event === "auto_approved");
    expect(auto).toMatchObject({ actorType: "bot", actorName: "Approval Bot", actorId: null, heldMs: 0 });
    expect(d.activity.find((x: any) => x.event === "routed").actorType).toBe("system");

    // Not in the approve queue; in the disburse queue; finance disburses it as always.
    expect((await as(t.meera).get("/api/expense-advances?queue=approve")).body.docs.map((x: any) => x._id)).not.toContain(a._id);
    expect((await as(t.farah).get("/api/expense-advances?queue=disburse")).body.docs.map((x: any) => x._id)).toContain(a._id);
    expect((await as(t.arjun).post(`/api/expense-advances/${a._id}/disburse`)).body.code).toBe("OWN_ADVANCE_PAYOUT_DENIED"); // sub-step 2 rule intact
    const disb = await as(t.farah).post(`/api/expense-advances/${a._id}/disburse`, { disbursementMode: "upi", disbursementRef: "UPI-1" });
    expect(disb.status).toBe(200);
    expect(disb.body.advance.status).toBe("disbursed");
    expect(disb.body.advance.outstandingBalance).toBe(1500);
  });

  it("an advance with no purpose or a bad needed-by date is handed to a human, not bot-approved", async () => {
    const t = await makeEngineWorkspace();
    await engineOn(t.wsId);
    // No purpose is already a 400 at the route (unchanged) — the bot never sees it.
    expect((await as(t.arjun).post("/api/expense-advances", { amount: 500, purpose: "" })).status).toBe(400);
    // A needed-by date in the past → validDates false → human.
    const r = await as(t.arjun).post("/api/expense-advances", { amount: 500, purpose: "late", neededBy: "2020-01-01" });
    expect(r.status).toBe(201);
    expect(r.body.advance.status).toBe("awaiting_approval");
    expect(r.body.advance.routing.bot).toMatchObject({ underThreshold: true, checksPassed: false, wouldAutoApprove: false });
    expect(r.body.advance.routing.bot.reason).toMatch(/pre-check failed: validDates/);
    expect(r.body.advance.routing.outcome).toBe("MANAGER_FINAL");
    expect(String(r.body.advance.approverId)).toBe(t.meera.id);
  });

  it("an over-threshold advance climbs to the lowest covering approver with the why-trail; the chain then runs", async () => {
    const t = await makeEngineWorkspace();
    await engineOn(t.wsId);
    // ₹1.2L: Meera (₹50k) endorses, Lata (₹20k) skipped, Dev (₹5L) chosen, Chitra considered.
    const r = await as(t.arjun).post("/api/expense-advances", { amount: 120000, purpose: "Site trip", neededBy: NEXT_WEEK });
    expect(r.status).toBe(201);
    const a = r.body.advance;
    expect(a.status).toBe("awaiting_approval");
    expect(a.routing).toMatchObject({ mode: "engine", kind: "advance", outcome: "MANAGER_THEN_LIMIT", requiredLimitBase: 120000, climbed: true });
    expect(a.approvalChain.map((l: any) => [l.approverId, l.via, l.limitBase, l.status])).toEqual([
      [t.meera.id, "manager", 50000, "pending"],
      [t.dev.id, "limit", 500000, "pending"],
    ]);
    const routed = (await advTrail(t.arjun, a._id)).activity.find((x: any) => x.event === "routed");
    expect(routed.details.trace.find((x: any) => x.userId === t.lata.id)).toMatchObject({ outcome: "skipped" });
    expect(routed.details.trace.find((x: any) => x.userId === t.chitra.id)).toMatchObject({ outcome: "considered" });
    expect(routed.note).toMatch(/Climbed past 1 approver/);
    // Meera → Dev → approved.
    expect((await as(t.dev).post(`/api/expense-advances/${a._id}/approve`)).status).toBe(403);
    expect((await as(t.meera).post(`/api/expense-advances/${a._id}/approve`)).status).toBe(200);
    const mid: any = await ExpenseAdvance.findById(a._id).lean();
    expect(mid.status).toBe("awaiting_approval");
    expect(String(mid.approverId)).toBe(t.dev.id);
    expect(mid.approvalChain[1].routedAt).toBeTruthy();
    expect((await as(t.dev).post(`/api/expense-advances/${a._id}/approve`)).status).toBe(200);
    expect(((await ExpenseAdvance.findById(a._id).lean()) as any).status).toBe("approved");
  });

  it("a large advance triggers the flagged four-eyes chain", async () => {
    const t = await makeEngineWorkspace();
    await engineOn(t.wsId);
    const r = await as(t.arjun).post("/api/expense-advances", { amount: 5000000, purpose: "Conference block booking" });
    expect(r.status).toBe(201);
    const a = r.body.advance;
    expect(a.routing).toMatchObject({ outcome: "TOP_FLAGGED_FOUR_EYES", overLimit: true, fourEyes: true });
    expect(a.approvalChain.map((l: any) => [l.approverId, l.via, l.overLimit])).toEqual([
      [t.meera.id, "manager", false],
      [t.chitra.id, "top", true],
      [t.dev.id, "four_eyes", true],
    ]);
    for (const who of [t.meera, t.chitra, t.dev]) expect((await as(who).post(`/api/expense-advances/${a._id}/approve`)).status).toBe(200);
    expect(((await ExpenseAdvance.findById(a._id).lean()) as any).status).toBe("approved");
  });

  it("NO_APPROVER / REFUSE_SUBMIT → the request is refused with the message; nothing persisted", async () => {
    seq++;
    const customerId = `cust-adv-empty-${seq}-${Date.now()}`;
    const ws = await CustomerWorkspace.create({ customerId, name: "Empty pool", status: "ACTIVE", config: { features: { expensesEnabled: true, advancesEnabled: true } } });
    const wsId = String(ws._id);
    const mgr = await makeUser(wsId, ["MANAGER"], "Mo");
    const emp = await makeUser(wsId, ["EMPLOYEE"], "Eve", { managerId: mgr.id });
    await makeUser(wsId, ["HR"], "Hana"); // legacy would have fallen back to HR
    await engineOn(wsId);
    const before = await ExpenseAdvance.countDocuments({ workspaceId: wsId });
    const r = await as(emp).post("/api/expense-advances", { amount: 100, purpose: "x" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/No approver is configured who can approve this amount — contact your admin/);
    expect(r.body.code).toBe("NO_APPROVER");
    expect(await ExpenseAdvance.countDocuments({ workspaceId: wsId })).toBe(before); // nothing persisted or routed
    expect(await ExpenseActivity.countDocuments({ workspaceId: wsId })).toBe(0);

    const t = await makeEngineWorkspace();
    await engineOn(t.wsId);
    await updatePolicy({ workspaceId: t.wsId, patch: { topOfChain: "REFUSE_SUBMIT" } });
    const r2 = await as(t.arjun).post("/api/expense-advances", { amount: 5000000, purpose: "too big" });
    expect(r2.status).toBe(409);
    expect(r2.body.code).toBe("REFUSE");
    expect(r2.body.error).toContain("(INR 5000000)");
  });

  it("an in-flight advance requested BEFORE the switch keeps its legacy chain after the flip", async () => {
    const t = await makeEngineWorkspace();
    const r = await as(t.arjun).post("/api/expense-advances", { amount: 1500, purpose: "before", neededBy: NEXT_WEEK }); // would be bot-approved under the engine
    expect(r.body.advance.routing.mode).toBe("legacy_manager_admin");
    const before: any = await ExpenseAdvance.findById(r.body.advance._id).lean();
    await engineOn(t.wsId);
    const after: any = await ExpenseAdvance.findById(r.body.advance._id).lean();
    expect(after.status).toBe("awaiting_approval");
    expect(after.approvalChain).toEqual(before.approvalChain);
    expect(after.routing.mode).toBe("legacy_manager_admin");
    expect((await as(t.meera).post(`/api/expense-advances/${after._id}/approve`)).status).toBe(200);
    const r2 = await as(t.arjun).post("/api/expense-advances", { amount: 1500, purpose: "after", neededBy: NEXT_WEEK });
    expect(r2.body.advance.status).toBe("approved");
    expect(r2.body.advance.routing.mode).toBe("engine");
  });

  it("simulator == engine for an advance (hypothetical and existing), and base currency is enforced ahead of routing", async () => {
    const t = await makeEngineWorkspace();
    await engineOn(t.wsId);
    // Hypothetical advance through the simulator…
    const sim = await t.L.post("/api/expense-admin/approval-policy/simulate", {
      kind: "advance", submitterId: t.arjun.id, amountBase: 120000, advance: { purpose: "Site trip", neededBy: NEXT_WEEK },
    });
    expect(sim.status, JSON.stringify(sim.body)).toBe(200);
    expect(sim.body.input.kind).toBe("advance");
    expect(sim.body.input.checks).toEqual({ positiveAmount: true, purposePresent: true, validDates: true });
    const predicted = sim.body.decision;
    // …then the real request.
    const r = await as(t.arjun).post("/api/expense-advances", { amount: 120000, purpose: "Site trip", neededBy: NEXT_WEEK });
    expect(r.status).toBe(201);
    const strip = (d: any) => { const { decidedAt, ...rest } = d; return JSON.parse(JSON.stringify(rest)); };
    expect(strip(r.body.advance.routing)).toEqual(strip(predicted));
    // The simulator can also read the EXISTING advance back and agrees with its record.
    const sim2 = await t.L.post("/api/expense-admin/approval-policy/simulate", { advanceId: r.body.advance._id });
    expect(sim2.status).toBe(200);
    expect(sim2.body.input.fromAdvance).toMatchObject({ ref: r.body.advance.ref, status: "awaiting_approval", purpose: "Site trip" });
    expect(strip(sim2.body.decision)).toEqual(strip(r.body.advance.routing));
    expect(((await ExpenseAdvance.findById(r.body.advance._id).lean()) as any).status).toBe("awaiting_approval"); // simulator changed nothing
    // Base currency: a non-base advance is refused before any routing (FX slice 0 rule, confirmed).
    const usd = await as(t.arjun).post("/api/expense-advances", { amount: 100, currency: "USD", purpose: "x" });
    expect(usd.status).toBe(400);
    expect(usd.body.code).toBe("ADVANCE_CURRENCY_NOT_BASE");
  });

  it("downstream lifecycle unchanged: an engine-approved advance settles against a claim and recovers cash as before", async () => {
    const t = await makeEngineWorkspace();
    await engineOn(t.wsId);
    const A = as(t.arjun);
    const adv = (await A.post("/api/expense-advances", { amount: 1500, purpose: "float", neededBy: NEXT_WEEK })).body.advance; // bot-approved
    expect((await as(t.farah).post(`/api/expense-advances/${adv._id}/disburse`)).status).toBe(200);
    // Apply to a claim, submit (engine: ₹1,000 clean → bot), reimburse → settles.
    const line = (await A.post("/api/expenses", { amount: 1000, date: TODAY, imageKey: `hrms/expenses/${t.wsId}/${t.arjun.id}/r.jpg` })).body.expense;
    const claim = (await A.post("/api/reports", { name: "settle" })).body.report;
    await A.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [line._id] });
    expect((await A.post(`/api/expense-advances/${adv._id}/apply`, { reportId: claim._id, amountApplied: 1000 })).status).toBe(200);
    // Line has no category → claim bot pre-check fails → manager approves.
    const sub = await A.post(`/api/reports/${claim._id}/submit`);
    expect(sub.status).toBe(200);
    if (sub.body.report.status !== "approved") expect((await as(t.meera).post(`/api/reports/${claim._id}/approve`)).status).toBe(200);
    expect((await as(t.farah).post(`/api/reports/${claim._id}/reimburse`)).status).toBe(200);
    const settled: any = await ExpenseAdvance.findById(adv._id).lean();
    expect(settled.status).toBe("partially_settled");
    expect(settled.outstandingBalance).toBe(500);
    // Recover the rest.
    expect((await as(t.farah).post(`/api/expense-advances/${adv._id}/recover`, { amount: 500 })).status).toBe(200);
    const done: any = await ExpenseAdvance.findById(adv._id).lean();
    expect(done.status).toBe("settled");
    expect(done.outstandingBalance).toBe(0);
  });
});
