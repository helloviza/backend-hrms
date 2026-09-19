// Employee side of the expense rebuild (Step 1): capture a bill → see it in
// the list with a clear status → group bills into a claim with a correct
// base-currency total → submit. Real Mongo (memory server), the real routers
// and the real middleware chain; nothing mocked. Same bootstrap as
// expenses.fx.test.ts.
//
// NOT covered here: the S3 upload + Gemini extraction leg of POST
// /expenses/upload (external services, no credentials in test). The persist
// half of capture — POST /expenses with the reviewed draft — is what every
// test below drives, and it is the path both the web reviewer and the
// WhatsApp worker share (createExpense).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-connected";
process.env.JWT_SECRET = "employee-step1-test-secret";
process.env.JWT_REFRESH_SECRET = "employee-step1-test-refresh";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET = "test-bucket";
process.env.GEMINI_API_KEY = "test";
process.env.DISABLE_EMAILS = "1";
process.env.NODE_ENV = "test";
// Deliberately NOT set: EXCHANGERATE_API_KEY → foreign lines land pending.
delete process.env.EXCHANGERATE_API_KEY;

const { requireAuth } = await import("../middleware/auth.js");
const { requireWorkspace } = await import("../middleware/requireWorkspace.js");
const { requireFeature, requireExpenseAdvancesFeature } = await import("../middleware/requireFeature.js");
const { signToken } = await import("../utils/jwt.js");
const { attachExpenseGrant, upsertGrant } = await import("../services/expenseGrants.service.js");
const { updatePolicy } = await import("../services/expensePolicy.service.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: User } = await import("../models/User.js");
const { default: Expense } = await import("../models/Expense.js");
const { default: Report } = await import("../models/Report.js");
const { default: ExpenseAdvance } = await import("../models/ExpenseAdvance.js");
const { default: ExpenseActivity } = await import("../models/ExpenseActivity.js");
const { default: expensesRouter } = await import("./expenses.js");
const { default: reportsRouter } = await import("./expenseReports.js");
const { default: advancesRouter } = await import("./expenseAdvances.js");

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
  app.use("/api/expense-advances", requireAuth, requireWorkspace, attachExpenseGrant, requireExpenseAdvancesFeature, advancesRouter);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

type Actor = { id: string; email: string; roles: string[]; workspaceId: string };
function as(a: Actor) {
  const t = signToken({ sub: a.id, roles: a.roles, email: a.email, workspaceId: a.workspaceId } as any);
  const h = (r: request.Test) => r.set("Authorization", `Bearer ${t}`);
  return {
    get: (p: string) => h(request(app).get(p)),
    post: (p: string, body?: any) => h(request(app).post(p)).send(body ?? {}),
    patch: (p: string, body?: any) => h(request(app).patch(p)).send(body ?? {}),
    delete: (p: string) => h(request(app).delete(p)),
  };
}

let seq = 0;
async function makeUser(workspaceId: string, roles: string[], extra: Record<string, any> = {}): Promise<Actor> {
  seq++;
  const email = `emp-${seq}-${Date.now()}@test.local`;
  const u = await User.create({
    email, passwordHash: "x", firstName: `U${seq}`, lastName: "Test", roles, workspaceId, status: "ACTIVE", ...extra,
  });
  return { id: String(u._id), email, roles, workspaceId };
}
async function makeTeam() {
  seq++;
  const ws = await CustomerWorkspace.create({
    customerId: `cust-emp-${seq}-${Date.now()}`,
    name: `Employee Step1 WS ${seq}`,
    status: "ACTIVE",
    config: { features: { expensesEnabled: true, advancesEnabled: true } },
  });
  const wsId = String(ws._id);
  const manager = await makeUser(wsId, ["MANAGER"]);
  const employee = await makeUser(wsId, ["EMPLOYEE"], { managerId: manager.id });
  const colleague = await makeUser(wsId, ["EMPLOYEE"], { managerId: manager.id });
  // Finance / expense-admin are GRANTS now (approval-engine sub-step 1), not role tokens.
  const finance = await makeUser(wsId, ["EMPLOYEE"]);
  await upsertGrant({ workspaceId: wsId, userId: finance.id, patch: { finance: true } });
  return { wsId, employee, colleague, manager, finance };
}
const TODAY = new Date().toISOString().slice(0, 10);

/* ── 1. Capture ────────────────────────────────────────────────────── */
describe("1 · capture a bill", () => {
  it("a base-currency bill is saved, converted (rate 1) and listed as Pending to submit", async () => {
    const { employee } = await makeTeam();
    const me = as(employee);
    const r = await me.post("/api/expenses", { amount: 850, currency: "INR", merchant: "Ola", date: TODAY });
    expect(r.status).toBe(201);
    expect(r.body.expense.amountBase).toBe(850);
    expect(r.body.expense.lifecycleStatus).toBe("pending_to_submit");

    const list = await me.get("/api/expenses");
    expect(list.body.docs).toHaveLength(1);
    expect(list.body.docs[0].lifecycleStatus).toBe("pending_to_submit");
    expect(list.body.docs[0].reportId).toBeNull(); // loose → the UI derives "Pending to submit", not "In claim"
    expect(list.body.docs[0].conversionPending).toBe(false);
  });

  it("a foreign bill carries BOTH amounts: the receipt and the base conversion (pending until a rate, then both)", async () => {
    const { employee } = await makeTeam();
    const me = as(employee);
    const r = await me.post("/api/expenses", { amount: 40, currency: "USD", merchant: "Uber", date: TODAY });
    expect(r.status).toBe(201);
    let e = (await me.get(`/api/expenses/${r.body.expense._id}`)).body.expense;
    expect(e.amount).toBe(40);
    expect(e.currency).toBe("USD");
    expect(e.baseCurrency).toBe("INR");
    expect(e.amountBase).toBeNull();
    expect(e.conversionPending).toBe(true);

    await me.patch(`/api/expenses/${e._id}/rate`, { exchangeRate: 83.5 });
    e = (await me.get(`/api/expenses/${e._id}`)).body.expense;
    expect(e.amount).toBe(40); // original, untouched
    expect(e.currency).toBe("USD");
    expect(e.amountBase).toBe(3340); // converted
    expect(e.conversionPending).toBe(false);
  });

  it("refuses a non-positive amount, an implausible amount, an unparseable or future date (F-11)", async () => {
    const { employee } = await makeTeam();
    const me = as(employee);
    expect((await me.post("/api/expenses", { amount: 0, date: TODAY })).status).toBe(400);
    expect((await me.post("/api/expenses", { amount: -5, date: TODAY })).status).toBe(400);
    expect((await me.post("/api/expenses", { amount: 99_999_999, date: TODAY })).status).toBe(400);
    expect((await me.post("/api/expenses", { amount: 10, date: "not-a-date" })).status).toBe(400);
    const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    expect((await me.post("/api/expenses", { amount: 10, date: future })).status).toBe(400);
    // …but a missing date is fine at capture (WhatsApp shape); the claim submit asks for it.
    expect((await me.post("/api/expenses", { amount: 10 })).status).toBe(201);
    expect(await Expense.countDocuments({ employeeId: new mongoose.Types.ObjectId(employee.id) })).toBe(1);
  });

  it("ignores a client-supplied s3Bucket — the stored bucket is ours (F-12); imageKey must be the caller's own prefix", async () => {
    const { wsId, employee } = await makeTeam();
    const me = as(employee);
    const ok = await me.post("/api/expenses", {
      amount: 10, date: TODAY,
      imageKey: `hrms/expenses/${wsId}/${employee.id}/receipt-1.jpg`,
      s3Bucket: "attacker-bucket",
    });
    expect(ok.status).toBe(201);
    const doc: any = await Expense.findById(ok.body.expense._id).lean();
    expect(doc.s3Bucket).toBe("test-bucket");
    const foreign = await me.post("/api/expenses", {
      amount: 10, date: TODAY, imageKey: `hrms/expenses/${wsId}/someone-else/receipt.jpg`,
    });
    expect(foreign.status).toBe(403);
    // Idempotent on the same upload: a re-submitted draft returns the existing row.
    const again = await me.post("/api/expenses", {
      amount: 10, date: TODAY, imageKey: `hrms/expenses/${wsId}/${employee.id}/receipt-1.jpg`,
    });
    expect(again.status).toBe(200);
    expect(again.body.deduped).toBe(true);
  });
});

/* ── 2. List with clear status ─────────────────────────────────────── */
describe("2 · my expenses list", () => {
  it("shows own bills only, with the derived status buckets, and a literal (escaped) search (F-13)", async () => {
    const { employee, colleague } = await makeTeam();
    const me = as(employee);
    await as(colleague).post("/api/expenses", { amount: 5, merchant: "Not mine", date: TODAY });
    const a = (await me.post("/api/expenses", { amount: 100, merchant: "A+B Cafe (Pune)", date: TODAY })).body.expense;
    const b = (await me.post("/api/expenses", { amount: 200, merchant: "Metro", date: TODAY })).body.expense;

    const all = await me.get("/api/expenses");
    expect(all.body.docs.map((d: any) => d._id).sort()).toEqual([a._id, b._id].sort()); // colleague's row absent

    // A regex-special search string is a literal, not a pattern, and never 500s.
    const s1 = await me.get(`/api/expenses?search=${encodeURIComponent("A+B Cafe (Pune)")}`);
    expect(s1.status).toBe(200);
    expect(s1.body.docs.map((d: any) => d._id)).toEqual([a._id]);
    const s2 = await me.get(`/api/expenses?search=${encodeURIComponent("(((")}`);
    expect(s2.status).toBe(200);
    expect(s2.body.docs).toHaveLength(0);

    // Status buckets: loose pending vs in a draft claim vs awaiting approval.
    const claim = (await me.post("/api/reports", { name: "Trip" })).body.report;
    await me.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [a._id] });
    expect((await me.get("/api/expenses?status=pending_to_submit")).body.docs.map((d: any) => d._id)).toEqual([b._id]);
    expect((await me.get("/api/expenses?status=in_claim")).body.docs.map((d: any) => d._id)).toEqual([a._id]);
    expect((await me.get("/api/expenses?unlinked=1")).body.docs.map((d: any) => d._id)).toEqual([b._id]);
    await me.post(`/api/reports/${claim._id}/submit`);
    expect((await me.get("/api/expenses?status=awaiting_approval")).body.docs.map((d: any) => d._id)).toEqual([a._id]);

    const sum = await me.get("/api/expenses/summary");
    expect(sum.body.summary.total).toEqual({ count: 2, amount: 300, pendingConversion: 0 });
  });
});

/* ── 3. Group into a claim, correct total ──────────────────────────── */
describe("3 · group bills into a claim", () => {
  it("adds own bills (a colleague's is skipped), totals in base currency, removes a line, deletes a draft", async () => {
    const { employee, colleague } = await makeTeam();
    const me = as(employee);
    const inr = (await me.post("/api/expenses", { amount: 1200, currency: "INR", merchant: "Taxi", date: TODAY })).body.expense;
    const usd = (await me.post("/api/expenses", { amount: 40, currency: "USD", merchant: "Uber", date: TODAY })).body.expense;
    await me.patch(`/api/expenses/${usd._id}/rate`, { exchangeRate: 83.5 });
    const theirs = (await as(colleague).post("/api/expenses", { amount: 999, date: TODAY })).body.expense;

    const claim = (await me.post("/api/reports", { name: "SF trip" })).body.report;
    expect(claim.status).toBe("draft");
    expect(claim.ref).toMatch(/^CLM-[0-9A-F]{6}$/);

    const add = await me.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [inr._id, usd._id, theirs._id] });
    expect(add.status).toBe(200);
    expect(add.body).toEqual({ ok: true, added: 2, skipped: 1 }); // the colleague's bill never links
    expect((await Expense.findById(theirs._id).lean())!.reportId).toBeNull();

    // Total = Σ amountBase = 1200 + 3340, NOT 1200 + 40.
    const det = await me.get(`/api/reports/${claim._id}`);
    expect(det.body.report.expenseCount).toBe(2);
    expect(det.body.report.totalAmount).toBe(4540);
    expect(det.body.report.baseCurrency).toBe("INR");
    const row = (await me.get("/api/reports")).body.docs.find((d: any) => d._id === claim._id);
    expect(row.totalAmount).toBe(4540);
    expect(row.expenseCount).toBe(2);

    // A third bill can be captured straight into the draft claim.
    const direct = await me.post("/api/expenses", { amount: 60, currency: "INR", merchant: "Snacks", date: TODAY, reportId: claim._id });
    expect(direct.status).toBe(201);
    expect(direct.body.expense.lifecycleStatus).toBe("pending_to_submit");
    expect((await me.get(`/api/reports/${claim._id}`)).body.report.totalAmount).toBe(4600);

    // Remove a line → back to loose; total follows.
    expect((await me.delete(`/api/reports/${claim._id}/expenses/${inr._id}`)).status).toBe(200);
    expect((await Expense.findById(inr._id).lean())!.reportId).toBeNull();
    expect((await me.get(`/api/reports/${claim._id}`)).body.report.totalAmount).toBe(3400);

    // Rename, then delete the draft: its lines return to loose, nothing is lost.
    expect((await me.patch(`/api/reports/${claim._id}`, { name: "SF trip (renamed)" })).status).toBe(200);
    expect((await me.delete(`/api/reports/${claim._id}`)).status).toBe(200);
    expect(await Report.findById(claim._id)).toBeNull();
    const loose = await me.get("/api/expenses?unlinked=1");
    expect(loose.body.docs).toHaveLength(3);
    expect(loose.body.docs.every((d: any) => d.lifecycleStatus === "pending_to_submit")).toBe(true);
  });

  it("deleting a draft claim releases any advance earmarked against it (F-05)", async () => {
    const { employee, manager, finance } = await makeTeam();
    const me = as(employee);
    const line = (await me.post("/api/expenses", { amount: 5000, date: TODAY })).body.expense;
    const claim = (await me.post("/api/reports", { name: "With advance" })).body.report;
    await me.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [line._id] });
    const adv = (await me.post("/api/expense-advances", { amount: 8000, purpose: "cash" })).body.advance;
    await as(manager).post(`/api/expense-advances/${adv._id}/approve`);
    await as(finance).post(`/api/expense-advances/${adv._id}/disburse`);
    expect((await me.post(`/api/expense-advances/${adv._id}/apply`, { reportId: claim._id, amountApplied: 3000 })).status).toBe(200);
    expect((await ExpenseAdvance.findById(adv._id).lean())!.settlements).toHaveLength(1);

    const del = await me.delete(`/api/reports/${claim._id}`);
    expect(del.status).toBe(200);
    expect(del.body.releasedEarmarks).toBe(1);
    const after: any = await ExpenseAdvance.findById(adv._id).lean();
    expect(after.settlements).toHaveLength(0); // no ghost earmark on a deleted claim
    expect(after.outstandingBalance).toBe(8000); // balance untouched (earmark ≠ drawdown)
  });
});

/* ── 4. Submit ─────────────────────────────────────────────────────── */
describe("4 · submit the claim", () => {
  it("moves the claim to submitted / awaiting approval, and is blocked while a conversion is pending", async () => {
    const { employee, manager } = await makeTeam();
    const me = as(employee);
    const inr = (await me.post("/api/expenses", { amount: 1200, currency: "INR", merchant: "Taxi", date: TODAY })).body.expense;
    const usd = (await me.post("/api/expenses", { amount: 40, currency: "USD", merchant: "Uber", date: TODAY })).body.expense;
    const claim = (await me.post("/api/reports", { name: "SF trip" })).body.report;
    await me.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [inr._id, usd._id] });

    // GATE (from the FX slice, still holding): pending conversion blocks submit.
    const blocked = await me.post(`/api/reports/${claim._id}/submit`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.blocking.join(" ")).toMatch(/awaiting a INR exchange rate/);
    expect((await Report.findById(claim._id).lean())!.status).toBe("draft");
    expect((await Expense.findById(usd._id).lean())!.lifecycleStatus).toBe("pending_to_submit");

    await me.patch(`/api/expenses/${usd._id}/rate`, { exchangeRate: 83.5 });
    const ok = await me.post(`/api/reports/${claim._id}/submit`);
    expect(ok.status).toBe(200);
    expect(ok.body.report.status).toBe("submitted");
    expect(ok.body.report.submittedAt).toBeTruthy();
    // Existing routing snapshot (manager) — the approval ENGINE replaces this later.
    expect(String(ok.body.report.approverId)).toBe(manager.id);

    // Lines follow the claim; the claim is now read-only for the employee.
    const lines = await Expense.find({ reportId: claim._id }).lean();
    expect(lines.every((l: any) => l.lifecycleStatus === "awaiting_approval")).toBe(true);
    expect((await me.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [inr._id] })).status).toBe(409);
    expect((await me.delete(`/api/reports/${claim._id}`)).status).toBe(409);
    expect((await me.post(`/api/reports/${claim._id}/submit`)).status).toBe(409); // not twice

    const det = await me.get(`/api/reports/${claim._id}`);
    expect(det.body.report.totalAmount).toBe(4540);
    expect(det.body.activity.map((a: any) => a.event)).toEqual(
      expect.arrayContaining(["created", "expense_added", "submitted"]),
    );
  });

  it("refuses an empty claim, and flags missing receipts / categories as warnings (not blockers)", async () => {
    const { employee } = await makeTeam();
    const me = as(employee);
    const claim = (await me.post("/api/reports", { name: "Empty" })).body.report;
    const empty = await me.post(`/api/reports/${claim._id}/submit`);
    expect(empty.status).toBe(409);
    expect(empty.body.blocking[0]).toMatch(/at least one expense/i);

    const line = (await me.post("/api/expenses", { amount: 10, date: TODAY })).body.expense; // no receipt, no category
    await me.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [line._id] });
    const ok = await me.post(`/api/reports/${claim._id}/submit`);
    expect(ok.status).toBe(200);
    expect(ok.body.warnings.join(" ")).toMatch(/no receipt/);
    expect(ok.body.warnings.join(" ")).toMatch(/no category/);
    const bot = await ExpenseActivity.find({ reportId: claim._id, event: "policy_check" }).lean();
    expect(bot.length).toBe(2);
  });
});

/* ── 6. Withdraw a submitted claim (F-14) ──────────────────────────── */
describe("6 · withdraw a submitted claim", () => {
  async function submittedClaim(team: Awaited<ReturnType<typeof makeTeam>>) {
    const me = as(team.employee);
    const a = (await me.post("/api/expenses", { amount: 100, merchant: "A", date: TODAY })).body.expense;
    const b = (await me.post("/api/expenses", { amount: 250, merchant: "B", date: TODAY })).body.expense;
    const claim = (await me.post("/api/reports", { name: "W" })).body.report;
    await me.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [a._id, b._id] });
    expect((await me.post(`/api/reports/${claim._id}/submit`)).status).toBe(200);
    return { me, claim, a, b };
  }

  it("owner withdraws an untouched submitted claim → draft, editable, lines intact, logged; then resubmits normally", async () => {
    const team = await makeTeam();
    const { me, claim, a, b } = await submittedClaim(team);

    const w = await me.post(`/api/reports/${claim._id}/withdraw`);
    expect(w.status).toBe(200);
    expect(w.body.report.status).toBe("draft");
    expect(w.body.report.approverId).toBeNull();
    expect(w.body.report.approvalChain).toEqual([]);
    expect(w.body.report.submittedAt).toBeNull();

    // Lines are still in the claim, back to pending_to_submit ("In claim").
    const lines = await Expense.find({ reportId: claim._id }).lean();
    expect(lines.map((l: any) => String(l._id)).sort()).toEqual([a._id, b._id].sort());
    expect(lines.every((l: any) => l.lifecycleStatus === "pending_to_submit")).toBe(true);
    expect((await me.get("/api/expenses?status=in_claim")).body.docs).toHaveLength(2);

    // Timeline.
    const log = await ExpenseActivity.find({ reportId: claim._id, event: "withdrawn" }).lean();
    expect(log).toHaveLength(1);
    expect(String(log[0].actorId)).toBe(team.employee.id);

    // Editable again: rename, drop a line, add one, resubmit.
    expect((await me.patch(`/api/reports/${claim._id}`, { name: "W (edited)" })).status).toBe(200);
    expect((await me.delete(`/api/reports/${claim._id}/expenses/${a._id}`)).status).toBe(200);
    const c = (await me.post("/api/expenses", { amount: 75, merchant: "C", date: TODAY, reportId: claim._id })).body.expense;
    expect(c.lifecycleStatus).toBe("pending_to_submit");
    const re = await me.post(`/api/reports/${claim._id}/submit`);
    expect(re.status).toBe(200);
    expect(re.body.report.status).toBe("submitted");
    expect(String(re.body.report.approverId)).toBe(team.manager.id); // chain re-resolved fresh
    expect((await me.get(`/api/reports/${claim._id}`)).body.report.totalAmount).toBe(325);
    const events = (await me.get(`/api/reports/${claim._id}`)).body.activity.map((x: any) => x.event);
    expect(events.filter((e: string) => e === "submitted")).toHaveLength(2);
    expect(events).toContain("withdrawn");

    // A second withdraw of the already-withdrawn (now resubmitted) claim works
    // again; a withdraw of a DRAFT is a no-op 409.
    expect((await me.post(`/api/reports/${claim._id}/withdraw`)).status).toBe(200);
    expect((await me.post(`/api/reports/${claim._id}/withdraw`)).status).toBe(409);
  });

  it("is refused (409, clear message) once anyone has acted: approved, declined, sent back, or L1 of a 2-level chain", async () => {
    // approved
    let team = await makeTeam();
    let { me, claim } = await submittedClaim(team);
    expect((await as(team.manager).post(`/api/reports/${claim._id}/approve`)).status).toBe(200);
    let r = await me.post(`/api/reports/${claim._id}/withdraw`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already being reviewed/);
    expect((await Report.findById(claim._id).lean())!.status).toBe("approved");

    // declined
    team = await makeTeam();
    ({ me, claim } = await submittedClaim(team));
    expect((await as(team.manager).post(`/api/reports/${claim._id}/decline`, { decisionNote: "no" })).status).toBe(200);
    expect((await me.post(`/api/reports/${claim._id}/withdraw`)).status).toBe(409);

    // sent back — already the owner's, nothing to withdraw (but it IS editable)
    team = await makeTeam();
    ({ me, claim } = await submittedClaim(team));
    expect((await as(team.manager).post(`/api/reports/${claim._id}/request-clarification`, { decisionNote: "receipt?" })).status).toBe(200);
    r = await me.post(`/api/reports/${claim._id}/withdraw`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already editable/);
    expect((await me.patch(`/api/reports/${claim._id}`, { name: "still mine" })).status).toBe(200);

    // 2-level chain: L1 approved → claim still `submitted` but under review
    team = await makeTeam();
    const admin = await makeUser(team.wsId, ["EMPLOYEE"]);
    await upsertGrant({ workspaceId: team.wsId, userId: admin.id, patch: { expenseAdmin: true } });
    // The legacy escalation settings live on the policy document (sub-step 4).
    await updatePolicy({ workspaceId: team.wsId, patch: { legacyEscalation: { claimThresholdBase: 100, seniorApproverId: admin.id } } });
    ({ me, claim } = await submittedClaim(team)); // total 350 > 100 → 2 levels
    expect((await Report.findById(claim._id).lean())!.approvalChain).toHaveLength(2);
    expect((await as(team.manager).post(`/api/reports/${claim._id}/approve`)).status).toBe(200);
    const mid: any = await Report.findById(claim._id).lean();
    expect(mid.status).toBe("submitted");
    expect(mid.currentLevel).toBe(2);
    r = await me.post(`/api/reports/${claim._id}/withdraw`);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already being reviewed/);
    expect((await Report.findById(claim._id).lean())!.currentLevel).toBe(2); // untouched
  });

  it("another employee cannot see or withdraw it (404), and the approver/admin cannot withdraw on the owner's behalf", async () => {
    const team = await makeTeam();
    const { claim } = await submittedClaim(team);
    expect((await as(team.colleague).post(`/api/reports/${claim._id}/withdraw`)).status).toBe(404);
    expect((await as(team.manager).post(`/api/reports/${claim._id}/withdraw`)).status).toBe(404);
    const admin = await makeUser(team.wsId, ["EMPLOYEE"]);
    await upsertGrant({ workspaceId: team.wsId, userId: admin.id, patch: { expenseAdmin: true } });
    expect((await as(admin).post(`/api/reports/${claim._id}/withdraw`)).status).toBe(404); // ownerOnly, even for admins
    expect((await Report.findById(claim._id).lean())!.status).toBe("submitted");
  });
});

/* ── 5. Delete a mis-captured bill (new) ───────────────────────────── */
describe("5 · delete a mis-captured bill", () => {
  it("owner can delete a never-submitted bill (loose or in own draft); anything submitted is refused; not others' bills", async () => {
    const { employee, colleague } = await makeTeam();
    const me = as(employee);
    const loose = (await me.post("/api/expenses", { amount: 10, date: TODAY })).body.expense;
    expect((await me.delete(`/api/expenses/${loose._id}`)).status).toBe(200);
    expect(await Expense.findById(loose._id)).toBeNull();

    const inDraft = (await me.post("/api/expenses", { amount: 20, merchant: "Dup", date: TODAY })).body.expense;
    const claim = (await me.post("/api/reports", { name: "C" })).body.report;
    await me.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [inDraft._id] });
    expect((await me.delete(`/api/expenses/${inDraft._id}`)).status).toBe(200);
    expect(await Expense.findById(inDraft._id)).toBeNull();
    const removed = await ExpenseActivity.findOne({ reportId: claim._id, event: "expense_removed" }).lean();
    expect(removed!.note).toMatch(/Deleted EXP-/);

    const submitted = (await me.post("/api/expenses", { amount: 30, date: TODAY })).body.expense;
    await me.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [submitted._id] });
    expect((await me.post(`/api/reports/${claim._id}/submit`)).status).toBe(200);
    expect((await me.delete(`/api/expenses/${submitted._id}`)).status).toBe(409);
    expect(await Expense.findById(submitted._id)).not.toBeNull();

    const theirs = (await as(colleague).post("/api/expenses", { amount: 5, date: TODAY })).body.expense;
    expect((await me.delete(`/api/expenses/${theirs._id}`)).status).toBe(404);
    expect(await Expense.findById(theirs._id)).not.toBeNull();
  });
});

/* ── 5. Filter + sort by RECEIPT date vs ENTERED date ───────────────────
 * The list has two dates: what the bill says (Expense.date) and when the
 * line was saved (Expense.createdAt). `dateField=receipt|entered` picks which
 * one the dateFrom/dateTo range applies to (default receipt — the behaviour
 * the list always had); `sort=` orders by either. Both server-side, both on
 * the IST calendar day via parseISTStart/End. createdAt is backdated through
 * the raw collection (Mongoose timestamps ignore it on an update). */
describe("5 · filter + sort by receipt date vs entered date", () => {
  /** A bill dated `receipt` (YYYY-MM-DD), saved at `enteredUtc` (ISO). */
  async function bill(who: Actor, merchant: string, receipt: string, enteredUtc: string) {
    const e = (await as(who).post("/api/expenses", { amount: 100, merchant, date: receipt })).body.expense;
    await Expense.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(e._id)) }, { $set: { createdAt: new Date(enteredUtc) } });
    return String(e._id);
  }
  const ids = (r: request.Response) => r.body.docs.map((d: any) => String(d._id));
  const merchants = (r: request.Response) => r.body.docs.map((d: any) => d.merchant);

  it("the diagnosis case: a bill dated 1 Sept but entered 3 Sept (03:46 IST) shows under entered=3 Sept, not under receipt=3 Sept", async () => {
    const { employee } = await makeTeam();
    const me = as(employee);
    // 2026-09-02T22:16Z = 3 Sept 2026, 03:46 IST — the server's UTC clock still says the 2nd.
    const a = await bill(employee, "Random Cafe", "2026-09-01", "2026-09-02T22:16:00.000Z");

    const entered3 = await me.get("/api/expenses?dateField=entered&dateFrom=2026-09-03&dateTo=2026-09-03");
    expect(entered3.status).toBe(200);
    expect(ids(entered3)).toEqual([a]);

    const receipt3 = await me.get("/api/expenses?dateField=receipt&dateFrom=2026-09-03&dateTo=2026-09-03");
    expect(ids(receipt3)).toEqual([]);

    const receipt1 = await me.get("/api/expenses?dateField=receipt&dateFrom=2026-09-01&dateTo=2026-09-01");
    expect(ids(receipt1)).toEqual([a]);
    // …and by entered, 1 Sept is empty: nothing was SAVED that day
    expect(ids(await me.get("/api/expenses?dateField=entered&dateFrom=2026-09-01&dateTo=2026-09-01"))).toEqual([]);
  });

  it("the entered range is an inclusive IST calendar day on createdAt (00:10 IST is in; 23:50 IST the night before is not)", async () => {
    const { employee } = await makeTeam();
    const me = as(employee);
    const night = await bill(employee, "23:50 on 2 Sept", "2026-08-30", "2026-09-02T18:20:00.000Z"); // 23:50 IST 2 Sept
    const early = await bill(employee, "00:10 on 3 Sept", "2026-08-30", "2026-09-02T18:40:00.000Z"); // 00:10 IST 3 Sept
    const late = await bill(employee, "23:59:59 on 3 Sept", "2026-08-30", "2026-09-03T18:29:59.000Z"); // last second of 3 Sept IST
    const next = await bill(employee, "00:00 on 4 Sept", "2026-08-30", "2026-09-03T18:30:00.000Z"); // first instant of 4 Sept IST

    const day3 = ids(await me.get("/api/expenses?dateField=entered&dateFrom=2026-09-03&dateTo=2026-09-03&sort=entered_asc"));
    expect(day3).toEqual([early, late]);
    expect(day3).not.toContain(night);
    expect(day3).not.toContain(next);
    expect(ids(await me.get("/api/expenses?dateField=entered&dateFrom=2026-09-02&dateTo=2026-09-02"))).toEqual([night]);
    expect(ids(await me.get("/api/expenses?dateField=entered&dateFrom=2026-09-04&dateTo=2026-09-04"))).toEqual([next]);
    // open-ended: from only / to only
    expect(ids(await me.get("/api/expenses?dateField=entered&dateFrom=2026-09-04&sort=entered_asc"))).toEqual([next]);
    expect(ids(await me.get("/api/expenses?dateField=entered&dateTo=2026-09-02&sort=entered_asc"))).toEqual([night]);
    // by RECEIPT date all four are 30 Aug — the entered window never leaks into it
    expect(ids(await me.get("/api/expenses?dateFrom=2026-08-30&dateTo=2026-08-30&sort=entered_asc"))).toEqual([night, early, late, next]);
  });

  it("no dateField (and junk) still filters the receipt date — the list's original behaviour", async () => {
    const { employee } = await makeTeam();
    const me = as(employee);
    const a = await bill(employee, "A", "2026-09-01", "2026-09-05T10:00:00.000Z");
    const b = await bill(employee, "B", "2026-09-05", "2026-09-01T10:00:00.000Z");
    expect(ids(await me.get("/api/expenses?dateFrom=2026-09-01&dateTo=2026-09-01"))).toEqual([a]);
    expect(ids(await me.get("/api/expenses?dateField=whatever&dateFrom=2026-09-01&dateTo=2026-09-01"))).toEqual([a]);
    expect(ids(await me.get("/api/expenses?dateField=receipt&dateFrom=2026-09-05&dateTo=2026-09-05"))).toEqual([b]);
    expect(ids(await me.get("/api/expenses?dateField=entered&dateFrom=2026-09-05&dateTo=2026-09-05"))).toEqual([a]);
  });

  it("sort: default is receipt date desc (createdAt tie-break); entered_desc / entered_asc order by createdAt; receipt_asc; junk → default", async () => {
    const { employee } = await makeTeam();
    const me = as(employee);
    // receipt order: C (3rd) > B (2nd) > A (1st); entered order is the REVERSE: A newest, C oldest
    const a = await bill(employee, "A", "2026-09-01", "2026-09-10T10:00:00.000Z");
    const b = await bill(employee, "B", "2026-09-02", "2026-09-09T10:00:00.000Z");
    const c = await bill(employee, "C", "2026-09-03", "2026-09-08T10:00:00.000Z");
    // same receipt date as C, saved later → tie broken by createdAt desc under the default
    const c2 = await bill(employee, "C2", "2026-09-03", "2026-09-08T12:00:00.000Z");

    expect(ids(await me.get("/api/expenses"))).toEqual([c2, c, b, a]); // default
    expect(ids(await me.get("/api/expenses?sort=receipt_desc"))).toEqual([c2, c, b, a]);
    expect(ids(await me.get("/api/expenses?sort=receipt_asc"))).toEqual([a, b, c, c2]);
    expect(ids(await me.get("/api/expenses?sort=entered_desc"))).toEqual([a, b, c2, c]); // most recently entered first
    expect(ids(await me.get("/api/expenses?sort=entered_asc"))).toEqual([c, c2, b, a]);
    expect(ids(await me.get("/api/expenses?sort=garbage"))).toEqual([c2, c, b, a]);
    // sort + entered filter compose
    expect(merchants(await me.get("/api/expenses?dateField=entered&dateFrom=2026-09-08&dateTo=2026-09-09&sort=entered_desc"))).toEqual(["B", "C2", "C"]);
  });

  it("export inherits dateField + sort (same builder): JSON echoes the field, CSV carries only the entered-window rows", async () => {
    const { employee } = await makeTeam();
    const me = as(employee);
    await bill(employee, "Entered Third", "2026-09-01", "2026-09-02T22:16:00.000Z"); // 3 Sept 03:46 IST
    await bill(employee, "Dated Third", "2026-09-03", "2026-09-10T10:00:00.000Z");

    const json = await me.get("/api/expenses/export?format=json&dateField=entered&dateFrom=2026-09-03&dateTo=2026-09-03");
    expect(json.status).toBe(200);
    expect(json.body.range).toEqual({ dateFrom: "2026-09-03", dateTo: "2026-09-03", dateField: "entered" });
    expect(json.body.rows.map((r: any) => r.merchant)).toEqual(["Entered Third"]);
    expect(json.body.total).toBe(1);

    const byReceipt = await me.get("/api/expenses/export?format=json&dateFrom=2026-09-03&dateTo=2026-09-03");
    expect(byReceipt.body.range.dateField).toBe("receipt");
    expect(byReceipt.body.rows.map((r: any) => r.merchant)).toEqual(["Dated Third"]);

    const csv = await me.get("/api/expenses/export?format=csv&dateField=entered&dateFrom=2026-09-03&dateTo=2026-09-03");
    expect(csv.status).toBe(200);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    const lines = csv.text.trim().split(/\r?\n/);
    expect(lines).toHaveLength(2); // header + the one row
    expect(lines[1]).toContain("Entered Third");
    expect(lines[1]).not.toContain("Dated Third");
  });
});
