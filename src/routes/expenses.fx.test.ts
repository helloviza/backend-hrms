// FX slice 0 — base-currency foundation (audit F-19), end to end against a
// REAL Mongo (mongodb-memory-server) through the REAL routers and the REAL
// middleware chain (requireAuth → requireWorkspace → requireFeature), exactly
// as server.ts mounts them. No model or middleware is mocked: the whole point
// of this slice is that persisted rows (including pre-slice rows with none of
// the new fields) sum correctly, so literal fixtures would test nothing.
//
// The ONE external dependency, ExchangeRate-API, is reached through
// utils/exchangeRate.ts and is not mocked either. Without EXCHANGERATE_API_KEY
// in the environment it returns null — which is precisely the "conversion
// pending" path this slice must survive. The live-rate ("api") path is
// exercised by the last describe, which runs only when the key is present.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

// Set BEFORE any import that reads them: dotenv never overrides an existing
// key, so these win over .env, and nothing here can reach the .env cluster.
process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-connected";
process.env.JWT_SECRET = "fx-slice-test-secret";
process.env.JWT_REFRESH_SECRET = "fx-slice-test-refresh";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET = "test-bucket";
process.env.GEMINI_API_KEY = "test";
process.env.DISABLE_EMAILS = "1";
process.env.NODE_ENV = "test";

const { requireAuth } = await import("../middleware/auth.js");
const { requireWorkspace } = await import("../middleware/requireWorkspace.js");
const { requireFeature, requireExpenseAdvancesFeature } = await import("../middleware/requireFeature.js");
const { signToken } = await import("../utils/jwt.js");
const { attachExpenseGrant, upsertGrant } = await import("../services/expenseGrants.service.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: User } = await import("../models/User.js");
const { default: Expense } = await import("../models/Expense.js");
const { default: Report } = await import("../models/Report.js");
const { default: ExpenseActivity } = await import("../models/ExpenseActivity.js");
const { default: expensesRouter } = await import("./expenses.js");
const { default: reportsRouter } = await import("./expenseReports.js");
const { default: adminRouter } = await import("./expenseAdmin.js");
const { default: advancesRouter } = await import("./expenseAdvances.js");
const { claimTotal } = await import("../services/advanceSettlement.service.js");

let mongod: MongoMemoryServer;
let app: express.Express;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());
  app.use("/api/expenses", requireAuth, requireWorkspace, attachExpenseGrant, requireFeature("expensesEnabled"), expensesRouter);
  app.use("/api/reports", requireAuth, requireWorkspace, attachExpenseGrant, requireFeature("expensesEnabled"), reportsRouter);
  app.use("/api/expense-admin", requireAuth, requireWorkspace, attachExpenseGrant, requireFeature("expensesEnabled"), adminRouter);
  app.use("/api/expense-advances", requireAuth, requireWorkspace, attachExpenseGrant, requireExpenseAdvancesFeature, advancesRouter);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

/* ── Fixtures ──────────────────────────────────────────────────────── */
type Actor = { id: string; email: string; roles: string[]; workspaceId: string };
function tokenFor(a: Actor) {
  return signToken({ sub: a.id, roles: a.roles, email: a.email, workspaceId: a.workspaceId } as any);
}
function as(a: Actor) {
  const t = tokenFor(a);
  return {
    get: (p: string) => request(app).get(p).set("Authorization", `Bearer ${t}`),
    post: (p: string, body?: any) => request(app).post(p).set("Authorization", `Bearer ${t}`).send(body ?? {}),
    patch: (p: string, body?: any) => request(app).patch(p).set("Authorization", `Bearer ${t}`).send(body ?? {}),
  };
}

let seq = 0;
async function makeWorkspace(overrides: Record<string, any> = {}) {
  seq++;
  const ws = await CustomerWorkspace.create({
    customerId: `cust-fx-${seq}-${Date.now()}`,
    name: `FX Test Workspace ${seq}`,
    status: "ACTIVE",
    config: {
      features: { expensesEnabled: true, advancesEnabled: true },
      ...overrides,
    },
  });
  return String(ws._id);
}

async function makeUser(workspaceId: string, roles: string[], extra: Record<string, any> = {}): Promise<Actor> {
  seq++;
  const email = `fx-${seq}-${Date.now()}@test.local`;
  const u = await User.create({
    email,
    passwordHash: "x",
    firstName: `U${seq}`,
    lastName: "Test",
    roles,
    workspaceId,
    status: "ACTIVE",
    ...extra,
  });
  return { id: String(u._id), email, roles, workspaceId };
}

/** employee (reports to manager), manager, finance — all in one workspace. */
async function makeTeam(wsOverrides: Record<string, any> = {}) {
  const wsId = await makeWorkspace(wsOverrides);
  const manager = await makeUser(wsId, ["MANAGER"]);
  const employee = await makeUser(wsId, ["EMPLOYEE"], { managerId: manager.id });
  // Finance / expense-admin are GRANTS now (approval-engine sub-step 1), not role tokens.
  const finance = await makeUser(wsId, ["EMPLOYEE"]);
  await upsertGrant({ workspaceId: wsId, userId: finance.id, patch: { finance: true } });
  const admin = await makeUser(wsId, ["EMPLOYEE"]);
  await upsertGrant({ workspaceId: wsId, userId: admin.id, patch: { expenseAdmin: true } });
  return { wsId, employee, manager, finance, admin };
}

const TODAY = new Date().toISOString().slice(0, 10);

/* ── 1. Freeze at entry ────────────────────────────────────────────── */
describe("freeze at entry", () => {
  it("same currency as the workspace base → rate 1, amountBase = amount, rateSource base", async () => {
    const { employee } = await makeTeam();
    const r = await as(employee).post("/api/expenses", {
      amount: 1200.5,
      currency: "INR",
      merchant: "Chai",
      date: TODAY,
    });
    expect(r.status).toBe(201);
    const e = r.body.expense;
    expect(e.currency).toBe("INR");
    expect(e.baseCurrency).toBe("INR");
    expect(e.exchangeRate).toBe(1);
    expect(e.rateSource).toBe("base");
    expect(e.amountBase).toBe(1200.5);
    expect(e.rateHistory).toHaveLength(1);
    expect(e.rateHistory[0].rateSource).toBe("base");

    // Persisted, not just echoed.
    const doc: any = await Expense.findById(e._id).lean();
    expect(doc.amountBase).toBe(1200.5);
    expect(doc.rateSource).toBe("base");
  });

  it("omitted currency → the workspace base (no longer a hard-coded INR)", async () => {
    const { employee } = await makeTeam({ baseCurrency: "USD" });
    const r = await as(employee).post("/api/expenses", { amount: 10, merchant: "x", date: TODAY });
    expect(r.status).toBe(201);
    expect(r.body.expense.currency).toBe("USD");
    expect(r.body.expense.baseCurrency).toBe("USD");
    expect(r.body.expense.amountBase).toBe(10);
  });

  it("a non-ISO currency string is refused (400), never silently read as base", async () => {
    const { employee } = await makeTeam();
    const r = await as(employee).post("/api/expenses", { amount: 10, currency: "US$", date: TODAY });
    expect(r.status).toBe(400);
  });

  it("legacy INR row with none of the FX fields reads as converted (identity), a legacy foreign row as pending", async () => {
    const { wsId, employee } = await makeTeam();
    // Raw inserts — exactly the shape every pre-slice prod row has.
    await Expense.collection.insertMany([
      {
        workspaceId: new mongoose.Types.ObjectId(wsId),
        employeeId: new mongoose.Types.ObjectId(employee.id),
        ref: "EXP-LEGACY1",
        sourceChannel: "whatsapp",
        amount: 402,
        currency: "INR",
        lifecycleStatus: "pending_to_submit",
        status: "submitted",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        workspaceId: new mongoose.Types.ObjectId(wsId),
        employeeId: new mongoose.Types.ObjectId(employee.id),
        ref: "EXP-LEGACY2",
        sourceChannel: "whatsapp",
        amount: 23.3,
        currency: "EUR",
        lifecycleStatus: "pending_to_submit",
        status: "submitted",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const list = await as(employee).get("/api/expenses");
    expect(list.status).toBe(200);
    expect(list.body.baseCurrency).toBe("INR");
    const byRef = Object.fromEntries(list.body.docs.map((d: any) => [d.ref, d]));
    expect(byRef["EXP-LEGACY1"].amountBase).toBe(402);
    expect(byRef["EXP-LEGACY1"].conversionPending).toBe(false);
    expect(byRef["EXP-LEGACY2"].amountBase).toBeNull();
    expect(byRef["EXP-LEGACY2"].conversionPending).toBe(true);

    // The summary sums the identity-converted INR row and EXCLUDES + counts the pending one
    // (this is the CLM-642339 shape from the audit: 402 INR + 23.30 EUR ≠ 425.30).
    const sum = await as(employee).get("/api/expenses/summary");
    expect(sum.body.summary.baseCurrency).toBe("INR");
    expect(sum.body.summary.total.amount).toBe(402);
    expect(sum.body.summary.total.pendingConversion).toBe(1);
  });
});

/* ── 2. Failure fallback + manual entry ────────────────────────────── */
describe.skipIf(!!process.env.EXCHANGERATE_API_KEY)(
  "foreign currency with the rates API unavailable (no EXCHANGERATE_API_KEY)",
  () => {
    it("saves the expense flagged conversion-pending, and a manual rate resolves it", async () => {
      const { employee } = await makeTeam();
      const r = await as(employee).post("/api/expenses", {
        amount: 40,
        currency: "usd",
        merchant: "Uber SFO",
        date: TODAY,
      });
      expect(r.status).toBe(201); // capture is never blocked by the API
      const e = r.body.expense;
      expect(e.currency).toBe("USD");
      expect(e.amountBase).toBeNull();
      expect(e.rateSource).toBeNull();
      expect(e.exchangeRate).toBeNull();
      expect(e.rateHistory).toHaveLength(0);

      const got = await as(employee).get(`/api/expenses/${e._id}`);
      expect(got.body.expense.conversionPending).toBe(true);
      expect(got.body.expense.baseCurrency).toBe("INR");

      // fx-rate pre-fill degrades to null, never errors.
      const fx = await as(employee).get("/api/expenses/fx-rate?currency=USD");
      expect(fx.status).toBe(200);
      expect(fx.body.rate).toBeNull();

      // Owner enters the rate manually.
      const bad = await as(employee).patch(`/api/expenses/${e._id}/rate`, { exchangeRate: 0 });
      expect(bad.status).toBe(400);
      const set = await as(employee).patch(`/api/expenses/${e._id}/rate`, {
        exchangeRate: 83.5,
        rateDate: "2026-09-15",
      });
      expect(set.status).toBe(200);
      const u = set.body.expense;
      expect(u.amount).toBe(40); // receipt untouched
      expect(u.currency).toBe("USD");
      expect(u.exchangeRate).toBe(83.5);
      expect(u.rateDate).toBe("2026-09-15");
      expect(u.rateSource).toBe("manual");
      expect(u.amountBase).toBe(3340);
      expect(u.conversionPending).toBe(false);
      expect(String(u.rateEnteredBy)).toBe(employee.id);
      expect(u.rateHistory).toHaveLength(1);
      expect(String(u.rateHistory[0].setBy)).toBe(employee.id);

      // The owner may NOT change it again — that is finance's correction path.
      const again = await as(employee).patch(`/api/expenses/${e._id}/rate`, { exchangeRate: 84 });
      expect(again.status).toBe(403);
    });

    it("a same-currency line has nothing to convert (400)", async () => {
      const { employee } = await makeTeam();
      const r = await as(employee).post("/api/expenses", { amount: 10, currency: "INR", date: TODAY });
      const set = await as(employee).patch(`/api/expenses/${r.body.expense._id}/rate`, { exchangeRate: 2 });
      expect(set.status).toBe(400);
    });
  },
);

/* ── 3. Submission gate + every switched sum ───────────────────────── */
describe.skipIf(!!process.env.EXCHANGERATE_API_KEY)("submission gate and base-currency sums", () => {
  it("a claim with a pending line cannot be submitted; once resolved every total is Σ amountBase", async () => {
    const { wsId, employee, manager, finance } = await makeTeam();
    const me = as(employee);

    const inr = (await me.post("/api/expenses", { amount: 1200, currency: "INR", merchant: "Taxi", date: TODAY }))
      .body.expense;
    const usd = (await me.post("/api/expenses", { amount: 40, currency: "USD", merchant: "Uber", date: TODAY }))
      .body.expense;
    expect(usd.amountBase).toBeNull();

    const claim = (await me.post("/api/reports", { name: "SF trip" })).body.report;
    const add = await me.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [inr._id, usd._id] });
    expect(add.status).toBe(200);

    // List + detail flag the pending line and EXCLUDE it from the total.
    const list1 = await me.get("/api/reports");
    const row1 = list1.body.docs.find((d: any) => d._id === claim._id);
    expect(row1.totalAmount).toBe(1200);
    expect(row1.pendingConversion).toBe(1);
    expect(row1.baseCurrency).toBe("INR");
    const det1 = await me.get(`/api/reports/${claim._id}`);
    expect(det1.body.report.totalAmount).toBe(1200);
    expect(det1.body.report.pendingConversion).toBe(1);
    expect(det1.body.expenses.find((e: any) => e._id === usd._id).conversionPending).toBe(true);

    // GATE: submit refused while the USD line has no rate.
    const blocked = await me.post(`/api/reports/${claim._id}/submit`);
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body.blocking)).toMatch(/exchange rate/i);
    expect((await Report.findById(claim._id).lean())!.status).toBe("draft");

    // Resolve → submit passes; total in base.
    const set = await me.patch(`/api/expenses/${usd._id}/rate`, { exchangeRate: 83.5 });
    expect(set.status).toBe(200);
    const submitted = await me.post(`/api/reports/${claim._id}/submit`);
    expect(submitted.status).toBe(200);
    expect(submitted.body.report.status).toBe("submitted");
    expect(String(submitted.body.report.approverId)).toBe(manager.id);

    // Every switched sum agrees on 4540.
    expect(await claimTotal(wsId, claim._id)).toBe(4540); // advanceSettlement.claimTotal
    const list2 = await me.get("/api/reports");
    expect(list2.body.docs.find((d: any) => d._id === claim._id).totalAmount).toBe(4540); // countsForReports
    const det2 = await me.get(`/api/reports/${claim._id}`);
    expect(det2.body.report.totalAmount).toBe(4540);
    expect(det2.body.report.netPayout).toBe(4540);
    expect(det2.body.report.pendingConversion).toBe(0);
    const line = det2.body.expenses.find((e: any) => e._id === usd._id);
    expect(line.amount).toBe(40); // display: original …
    expect(line.currency).toBe("USD");
    expect(line.amountBase).toBe(3340); // … AND converted
    expect(line.baseCurrency).toBe("INR");

    const sum = await me.get("/api/expenses/summary");
    expect(sum.body.summary.total.amount).toBe(4540); // /summary
    expect(sum.body.summary.total.pendingConversion).toBe(0);

    const fin = as(finance);
    const an = await fin.get(`/api/expenses/analytics?dateFrom=${TODAY}&dateTo=${TODAY}`);
    expect(an.status).toBe(200);
    expect(an.body.baseCurrency).toBe("INR");
    expect(an.body.kpis.totalSpend).toBe(4540); // /analytics block 1
    expect(an.body.categories.reduce((s: number, c: any) => s + c.amount, 0)).toBe(4540);

    // Approve → awaiting-reimbursement (analytics block 3) is the base total.
    const ap = await as(manager).post(`/api/reports/${claim._id}/approve`);
    expect(ap.status).toBe(200);
    const an2 = await fin.get(`/api/expenses/analytics?dateFrom=${TODAY}&dateTo=${TODAY}`);
    expect(an2.body.kpis.awaitingReimbursement).toEqual({ amount: 4540, count: 1 });

    // Exports carry the conversion (expenses) and the base total + currency (claims).
    const ex = await fin.get("/api/expenses/export");
    expect(ex.status).toBe(200);
    const usdRow = ex.body.rows.find((r: any) => r.ref === usd.ref);
    expect(usdRow.amount).toBe(40);
    expect(usdRow.currency).toBe("USD");
    expect(usdRow.amountBase).toBe(3340);
    expect(usdRow.baseCurrency).toBe("INR");
    expect(usdRow.exchangeRate).toBe(83.5);
    expect(usdRow.rateSource).toBe("manual");
    expect(ex.body.columns.map((c: any) => c.key)).toEqual(
      expect.arrayContaining(["amountBase", "baseCurrency", "exchangeRate", "rateDate", "rateSource"]),
    );
    const cx = await fin.get("/api/reports/export");
    const claimRow = cx.body.rows.find((r: any) => r.ref === claim.ref);
    expect(claimRow.total).toBe(4540);
    expect(claimRow.currency).toBe("INR");
    expect(claimRow.netPayout).toBe(4540);

    // Finance reimburses on the base figure; afterwards the rate is final.
    const reimb = await fin.post(`/api/reports/${claim._id}/reimburse`);
    expect(reimb.status).toBe(200);
    const late = await fin.patch(`/api/expenses/${usd._id}/rate`, { exchangeRate: 90, reason: "too late" });
    expect(late.status).toBe(409);
  });

  it("the L2 escalation threshold gates on the BASE total, not the raw sum", async () => {
    const { employee, manager, admin } = await makeTeam();
    // Threshold 4000: raw 1200+40 = 1240 would NOT escalate; base 4540 MUST.
    const pol = await as(admin).patch("/api/expense-admin/policy", {
      expenseEscalationThreshold: 4000,
      seniorApproverId: admin.id,
    });
    expect(pol.status).toBe(200);
    expect(pol.body.policy.baseCurrency).toBe("INR");

    const me = as(employee);
    const inr = (await me.post("/api/expenses", { amount: 1200, currency: "INR", date: TODAY })).body.expense;
    const usd = (await me.post("/api/expenses", { amount: 40, currency: "USD", date: TODAY })).body.expense;
    await me.patch(`/api/expenses/${usd._id}/rate`, { exchangeRate: 83.5 });
    const claim = (await me.post("/api/reports", { name: "Escalates" })).body.report;
    await me.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [inr._id, usd._id] });
    const sub = await me.post(`/api/reports/${claim._id}/submit`);
    expect(sub.status).toBe(200);
    const doc: any = await Report.findById(claim._id).lean();
    expect(doc.approvalChain).toHaveLength(2);
    expect(String(doc.approvalChain[0].approverId)).toBe(manager.id);
    expect(String(doc.approvalChain[1].approverId)).toBe(admin.id);
  });

  it("advance earmark cap uses the base claim total; a non-base advance is refused", async () => {
    const { employee, manager, finance } = await makeTeam();
    const me = as(employee);
    const inr = (await me.post("/api/expenses", { amount: 1200, currency: "INR", date: TODAY })).body.expense;
    const usd = (await me.post("/api/expenses", { amount: 40, currency: "USD", date: TODAY })).body.expense;
    await me.patch(`/api/expenses/${usd._id}/rate`, { exchangeRate: 83.5 });
    const claim = (await me.post("/api/reports", { name: "With advance" })).body.report;
    await me.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [inr._id, usd._id] });

    const foreignAdv = await me.post("/api/expense-advances", { amount: 100, currency: "USD", purpose: "x" });
    expect(foreignAdv.status).toBe(400);
    expect(foreignAdv.body.code).toBe("ADVANCE_CURRENCY_NOT_BASE");

    const adv = (await me.post("/api/expense-advances", { amount: 10000, purpose: "SF trip cash" })).body.advance;
    expect(adv.currency).toBe("INR");
    expect((await as(manager).post(`/api/expense-advances/${adv._id}/approve`)).status).toBe(200);
    expect((await as(finance).post(`/api/expense-advances/${adv._id}/disburse`)).status).toBe(200);

    // Cap = 4540 (base), not 1240 (raw): 4540 fits, 4541 does not.
    const over = await me.post(`/api/expense-advances/${adv._id}/apply`, { reportId: claim._id, amountApplied: 4541 });
    expect(over.status).toBe(422);
    expect(over.body.error).toMatch(/claim total/i);
    const ok = await me.post(`/api/expense-advances/${adv._id}/apply`, { reportId: claim._id, amountApplied: 4540 });
    expect(ok.status).toBe(200);
    const det = await me.get(`/api/reports/${claim._id}`);
    expect(det.body.report.advanceAppliedTotal).toBe(4540);
    expect(det.body.report.netPayout).toBe(0);
  });
});

/* ── 4. Finance correction ─────────────────────────────────────────── */
describe.skipIf(!!process.env.EXCHANGERATE_API_KEY)("finance correction of a frozen rate", () => {
  it("is a logged, deliberate edit: rateSource manual, actor recorded, claim timeline entry, receipt untouched", async () => {
    const { wsId, employee, finance } = await makeTeam();
    const me = as(employee);
    const usd = (await me.post("/api/expenses", { amount: 40, currency: "USD", merchant: "Uber", date: TODAY }))
      .body.expense;
    await me.patch(`/api/expenses/${usd._id}/rate`, { exchangeRate: 8.35 }); // captured wrong (10× off)
    const claim = (await me.post("/api/reports", { name: "Wrong rate" })).body.report;
    await me.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [usd._id] });
    expect((await me.post(`/api/reports/${claim._id}/submit`)).status).toBe(200);
    expect((await me.get(`/api/reports/${claim._id}`)).body.report.totalAmount).toBe(334);

    // Without a reason it is still accepted server-side (the UI requires one);
    // a wrong actor is refused.
    const notFinance = await me.patch(`/api/expenses/${usd._id}/rate`, { exchangeRate: 83.5 });
    expect(notFinance.status).toBe(403);

    const fix = await as(finance).patch(`/api/expenses/${usd._id}/rate`, {
      exchangeRate: 83.5,
      rateDate: "2026-09-15",
      reason: "Card statement shows 83.50",
    });
    expect(fix.status).toBe(200);
    const u = fix.body.expense;
    expect(u.amount).toBe(40);
    expect(u.currency).toBe("USD");
    expect(u.amountBase).toBe(3340);
    expect(u.rateSource).toBe("manual");
    expect(String(u.rateEnteredBy)).toBe(finance.id);
    expect(u.rateHistory).toHaveLength(2);
    expect(u.rateHistory[0].amountBase).toBe(334); // the wrong one is kept
    expect(u.rateHistory[1].amountBase).toBe(3340);
    expect(u.rateHistory[1].reason).toBe("Card statement shows 83.50");

    // Claim timeline entry with the actor and the before/after figures.
    const log: any[] = await ExpenseActivity.find({
      workspaceId: new mongoose.Types.ObjectId(wsId),
      reportId: claim._id,
      event: "fx_rate_set",
    }).lean();
    // Exactly one: the owner's manual set happened while the line was still
    // LOOSE (no claim), so it lives only in the on-document rateHistory above.
    expect(log).toHaveLength(1);
    const corr = log.find((l) => String(l.actorId) === finance.id)!;
    expect(corr.note).toMatch(/Exchange rate corrected/);
    expect(corr.note).toMatch(/3340/);
    expect(corr.note).toMatch(/Card statement shows 83.50/);
    expect(String(corr.expenseId)).toBe(usd._id);

    // Claim total follows the corrected figure (no automatic recompute needed —
    // totals are always Σ amountBase on read).
    const det = await me.get(`/api/reports/${claim._id}`);
    expect(det.body.report.totalAmount).toBe(3340);
    const tl = det.body.activity.filter((a: any) => a.event === "fx_rate_set");
    expect(tl).toHaveLength(1);
    expect(tl[0].actorId).toBe(finance.id);
  });
});

/* ── 5. Workspace base currency config ─────────────────────────────── */
describe("workspace base currency", () => {
  it("defaults to INR (also for a workspace whose config predates the field) and is exposed on the policy", async () => {
    const { wsId, admin } = await makeTeam();
    // Strip the field the way a pre-slice workspace looks.
    await CustomerWorkspace.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(wsId) },
      { $unset: { "config.baseCurrency": "" } },
    );
    const raw: any = await CustomerWorkspace.collection.findOne({ _id: new mongoose.Types.ObjectId(wsId) });
    expect(raw.config.baseCurrency).toBeUndefined();

    const pol = await as(admin).get("/api/expense-admin/policy");
    expect(pol.body.policy.baseCurrency).toBe("INR");
    expect(pol.body.policy.baseCurrencyLocked).toBe(false);
  });

  it("can be changed only while the workspace has no expenses", async () => {
    const { employee, admin } = await makeTeam();
    const a = as(admin);
    expect((await a.patch("/api/expense-admin/policy", { baseCurrency: "usd" })).body.policy.baseCurrency).toBe("USD");
    expect((await a.patch("/api/expense-admin/policy", { baseCurrency: "XX" })).status).toBe(400);

    // First expense: INR is now FOREIGN in this workspace → pending (no API key).
    const r = await as(employee).post("/api/expenses", { amount: 100, currency: "INR", date: TODAY });
    expect(r.status).toBe(201);
    expect(r.body.expense.baseCurrency).toBe("USD");
    if (!process.env.EXCHANGERATE_API_KEY) expect(r.body.expense.conversionPending ?? r.body.expense.amountBase == null).toBe(true);

    const locked = await a.patch("/api/expense-admin/policy", { baseCurrency: "INR" });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe("BASE_CURRENCY_LOCKED");
    expect((await a.get("/api/expense-admin/policy")).body.policy.baseCurrencyLocked).toBe(true);
    // Same value is a no-op, not a 409.
    expect((await a.patch("/api/expense-admin/policy", { baseCurrency: "USD" })).status).toBe(200);
  });
});

/* ── 6. Live-rate path — only with a real key ──────────────────────── */
describe.skipIf(!process.env.EXCHANGERATE_API_KEY)("foreign currency with the live rates API (EXCHANGERATE_API_KEY set)", () => {
  it("freezes the live rate at entry: rateSource api, amountBase = round2(amount × rate)", async () => {
    const { employee } = await makeTeam();
    const r = await as(employee).post("/api/expenses", { amount: 40, currency: "USD", merchant: "Uber", date: TODAY });
    expect(r.status).toBe(201);
    const e = r.body.expense;
    expect(e.rateSource).toBe("api");
    expect(e.exchangeRate).toBeGreaterThan(0);
    expect(e.rateDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(e.amountBase).toBe(Math.round(40 * e.exchangeRate * 100) / 100);
    expect(e.rateHistory[0].rateSource).toBe("api");
    // Frozen: a later read returns exactly the stored figure.
    const doc: any = await Expense.findById(e._id).lean();
    expect(doc.amountBase).toBe(e.amountBase);
    expect(doc.exchangeRate).toBe(e.exchangeRate);
  });
});
