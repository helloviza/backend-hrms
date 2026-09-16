// Approval-engine sub-step 2 — the complete, append-only audit trail + actor
// plumbing. Real Mongo (memory server), real routers, real middleware chain;
// nothing mocked. Where the test needs time to pass between steps it edits
// the PERSISTED timestamps (submittedAt / routedAt / the previous activity's
// createdAt) through the raw collection — never through the model, which is
// append-only — and then asserts the writer computed the clock from them.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-connected";
process.env.JWT_SECRET = "audit-test-secret";
process.env.JWT_REFRESH_SECRET = "audit-test-refresh";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET = "test-bucket";
process.env.GEMINI_API_KEY = "test";
process.env.DISABLE_EMAILS = "1";
process.env.NODE_ENV = "test";
delete process.env.EXCHANGERATE_API_KEY;

const { requireAuth } = await import("../middleware/auth.js");
const { requireWorkspace } = await import("../middleware/requireWorkspace.js");
const { requireFeature, requireExpenseAdvancesFeature } = await import("../middleware/requireFeature.js");
const { attachExpenseGrant, upsertGrant } = await import("../services/expenseGrants.service.js");
const { signToken } = await import("../utils/jwt.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: User } = await import("../models/User.js");
const { default: Report } = await import("../models/Report.js");
const { default: ExpenseActivity } = await import("../models/ExpenseActivity.js");
const { default: expensesRouter } = await import("./expenses.js");
const { default: reportsRouter } = await import("./expenseReports.js");
const { default: advancesRouter } = await import("./expenseAdvances.js");
const { default: activityRouter } = await import("./expenseActivity.js");

let mongod: MongoMemoryServer;
let app: express.Express;
const HOUR = 3600_000;
const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());
  const gate = [requireAuth, requireWorkspace, attachExpenseGrant, requireFeature("expensesEnabled")] as any[];
  app.use("/api/expenses", ...gate, expensesRouter);
  app.use("/api/reports", ...gate, reportsRouter);
  app.use("/api/expense-activity", ...gate, activityRouter);
  app.use("/api/expense-advances", requireAuth, requireWorkspace, attachExpenseGrant, requireExpenseAdvancesFeature, advancesRouter);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

type Actor = { id: string; email: string; roles: string[]; workspaceId: string; name: string };
function as(a: Actor) {
  const t = signToken({ sub: a.id, roles: a.roles, email: a.email, workspaceId: a.workspaceId } as any);
  const h = (r: request.Test) => r.set("Authorization", `Bearer ${t}`);
  return {
    get: (p: string) => h(request(app).get(p)),
    post: (p: string, body?: any) => h(request(app).post(p)).send(body ?? {}),
    patch: (p: string, body?: any) => h(request(app).patch(p)).send(body ?? {}),
  };
}
let seq = 0;
async function makeUser(workspaceId: string, roles: string[], first: string, extra: Record<string, any> = {}): Promise<Actor> {
  seq++;
  const email = `a-${seq}-${Date.now()}@test.local`;
  const u = await User.create({ email, passwordHash: "x", firstName: first, lastName: "T", roles, workspaceId, status: "ACTIVE", ...extra });
  return { id: String(u._id), email, roles, workspaceId, name: `${first} T` };
}
async function makeTeam(wsConfig: Record<string, any> = {}) {
  seq++;
  const ws = await CustomerWorkspace.create({
    customerId: `cust-a-${seq}-${Date.now()}`, name: `Audit WS ${seq}`, status: "ACTIVE",
    config: { features: { expensesEnabled: true, advancesEnabled: true }, ...wsConfig },
  });
  const wsId = String(ws._id);
  const manager = await makeUser(wsId, ["MANAGER"], "Meera");
  const employee = await makeUser(wsId, ["EMPLOYEE"], "Arjun", { managerId: manager.id });
  const finance = await makeUser(wsId, ["EMPLOYEE"], "Farah");
  await upsertGrant({ workspaceId: wsId, userId: finance.id, patch: { finance: true } });
  const admin = await makeUser(wsId, ["EMPLOYEE"], "Asha");
  await upsertGrant({ workspaceId: wsId, userId: admin.id, patch: { expenseAdmin: true } });
  return { wsId, employee, manager, finance, admin };
}
/** Raw-collection time travel: shift EVERY existing entry on a claim back in
 *  time by N hours, so "the previous entry" is genuinely N hours old. */
async function backdateTrail(reportId: any, hoursAgo: number) {
  const rows = await ExpenseActivity.find({ reportId: new mongoose.Types.ObjectId(String(reportId)) }).select("_id createdAt").lean();
  for (const r of rows) {
    await ExpenseActivity.collection.updateOne({ _id: r._id }, { $set: { createdAt: new Date(new Date(r.createdAt as any).getTime() - hoursAgo * HOUR) } });
  }
}
async function backdateReport(id: any, set: Record<string, Date>) {
  await Report.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(id)) }, { $set: set });
}
const trailOf = async (actor: Actor, claimId: string) => (await as(actor).get(`/api/reports/${claimId}`)).body.activity as any[];

/* ── 1. Full life of a claim ───────────────────────────────────────── */
describe("1 · a claim's full trail reconstructs who / when / how / elapsed", () => {
  it("submit → routed → approved → paid, with both amounts on the lines and the clock at every step", async () => {
    const t = await makeTeam();
    const E = as(t.employee);
    const inr = (await E.post("/api/expenses", { amount: 1200, currency: "INR", merchant: "Taxi", date: TODAY })).body.expense;
    const usd = (await E.post("/api/expenses", { amount: 40, currency: "USD", merchant: "Uber", date: TODAY })).body.expense;
    await E.patch(`/api/expenses/${usd._id}/rate`, { exchangeRate: 83.5 });
    const claim = (await E.post("/api/reports", { name: "SF trip" })).body.report;
    await E.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [inr._id, usd._id] });

    // Pretend the draft sat for 2h before submit.
    await backdateTrail(claim._id, 2);

    const subRes = await E.post(`/api/reports/${claim._id}/submit`);
    expect(subRes.status).toBe(200);
    let trail = await trailOf(t.employee, claim._id);
    const submitted = trail.find((a) => a.event === "submitted");
    const routed = trail.find((a) => a.event === "routed");

    // WHO / WHAT / WHEN / HOW LONG on the submit.
    expect(submitted.actorType).toBe("user");
    expect(submitted.actorId).toBe(t.employee.id);
    expect(submitted.actorName).toBe(t.employee.name);
    expect(submitted.elapsedMs).toBeGreaterThanOrEqual(2 * HOUR - 5000);
    expect(submitted.elapsedMs).toBeLessThan(2 * HOUR + 60_000);
    // The claim total at submit, in base, and EVERY line's original + converted.
    expect(submitted.details.totalBase).toBe(4540);
    expect(submitted.details.baseCurrency).toBe("INR");
    expect(submitted.details.lineCount).toBe(2);
    expect(submitted.details.submissionNumber).toBe(1);
    expect(submitted.details.afterWithdraw).toBe(false);
    const usdLine = submitted.details.lines.find((l: any) => l.ref === usd.ref);
    expect(usdLine).toMatchObject({ amount: 40, currency: "USD", amountBase: 3340, baseCurrency: "INR", exchangeRate: 83.5, rateSource: "manual" });
    const inrLine = submitted.details.lines.find((l: any) => l.ref === inr.ref);
    expect(inrLine).toMatchObject({ amount: 1200, currency: "INR", amountBase: 1200, rateSource: "base" });

    // The ROUTING decision: a system actor, structured, says what today's
    // resolver did and leaves the engine's fields explicitly empty.
    expect(routed.actorType).toBe("system");
    expect(routed.actorName).toBe("Routing");
    expect(routed.actorId).toBeNull();
    expect(routed.details.mode).toBe("legacy_manager_admin");
    expect(routed.details.amountBase).toBe(4540);
    expect(routed.details.bot).toMatchObject({ evaluated: false, underThreshold: null });
    expect(routed.details.rule).toMatchObject({ kind: "single_approver", overThreshold: false, thresholdBase: null });
    expect(routed.details.requiredLimitBase).toBeNull();
    expect(routed.details.climbed).toBe(false);
    expect(routed.details.overLimit).toBe(false);
    expect(routed.details.fourEyes).toBe(false);
    expect(routed.details.chosen).toEqual([{ level: 1, userId: t.manager.id, name: t.manager.name, via: "manager" }]);
    expect(routed.details.trace[0]).toMatchObject({ step: "manager", outcome: "chosen", userId: t.manager.id });
    expect(routed.note).toContain(`L1 → ${t.manager.name} (manager)`);
    // Same snapshot on the claim itself, and routedAt stamped on the chain level.
    const doc: any = await Report.findById(claim._id).lean();
    expect(doc.routing.chosen[0].userId).toBe(t.manager.id);
    expect(doc.approvalChain[0]).toMatchObject({ via: "manager", actorType: "user" });
    expect(doc.approvalChain[0].routedAt).toBeTruthy();

    // The manager sits on it for 5h, then approves with a comment.
    await backdateReport(claim._id, { submittedAt: new Date(Date.now() - 5 * HOUR), "approvalChain.0.routedAt": new Date(Date.now() - 5 * HOUR) });
    await backdateTrail(claim._id, 5);
    const apRes = await as(t.manager).post(`/api/reports/${claim._id}/approve`, { decisionNote: "Looks right" });
    expect(apRes.status, JSON.stringify(apRes.body)).toBe(200);
    trail = await trailOf(t.employee, claim._id);
    const approved = trail.find((a) => a.event === "approved");
    expect(approved.actorType).toBe("user");
    expect(approved.actorId).toBe(t.manager.id);
    expect(approved.heldMs).toBeGreaterThanOrEqual(5 * HOUR - 5000);
    expect(approved.heldMs).toBeLessThan(5 * HOUR + 60_000);
    expect(approved.elapsedMs).toBeGreaterThanOrEqual(5 * HOUR - 5000);
    expect(approved.details).toMatchObject({ level: 1, ofLevels: 1, via: "manager", note: "Looks right", final: true, selfApproved: false, adminOverride: false });
    expect(approved.note).toMatch(/held 5h 00m/);
    const doc2: any = await Report.findById(claim._id).lean();
    expect(doc2.approvalChain[0].heldMs).toBe(approved.heldMs); // chain and trail agree

    // Finance pays 26h later.
    await backdateReport(claim._id, { approvedAt: new Date(Date.now() - 26 * HOUR) });
    await backdateTrail(claim._id, 26);
    expect((await as(t.finance).post(`/api/reports/${claim._id}/reimburse`)).status).toBe(200);
    trail = await trailOf(t.employee, claim._id);
    const paid = trail.find((a) => a.event === "reimbursed");
    expect(paid.actorType).toBe("user");
    expect(paid.actorId).toBe(t.finance.id);
    expect(paid.heldMs).toBeGreaterThanOrEqual(26 * HOUR - 5000);
    expect(paid.details).toMatchObject({ claimTotal: 4540, advancesApplied: 0, sodOverride: false, payerIsAdmin: false });
    expect(paid.details.netPayout).toBeNull(); // no advances → reimbursedAmount stays null (unchanged behaviour)

    // The whole clock, in order, is reconstructable from the rows alone.
    const order = trail.map((a) => a.event);
    expect(order).toEqual(expect.arrayContaining(["created", "expense_added", "submitted", "routed", "approved", "reimbursed"]));
    expect(order.indexOf("submitted")).toBeLessThan(order.indexOf("routed"));
    expect(order.indexOf("routed")).toBeLessThan(order.indexOf("approved"));
    expect(order.indexOf("approved")).toBeLessThan(order.indexOf("reimbursed"));
    for (let i = 1; i < trail.length; i++) {
      // every entry knows its predecessor
      expect(trail[i].elapsedMs).not.toBeNull();
    }
    expect(trail[0].elapsedMs).toBeNull();
    const total = trail.reduce((s, a) => s + (a.elapsedMs || 0), 0);
    expect(total).toBeGreaterThanOrEqual(33 * HOUR - 15_000); // 2h + 5h + 26h

    // The Activity Logs report carries actor type + both clocks.
    const rep = await as(t.finance).get(`/api/expense-activity?entity=claim`);
    expect(rep.status).toBe(200);
    expect(rep.body.columns.map((c: any) => c.key)).toEqual(expect.arrayContaining(["actorType", "elapsed", "held"]));
    const routedRow = rep.body.rows.find((r: any) => r.action === "Routed for approval" && r.ref === claim.ref);
    expect(routedRow.actorType).toBe("system");
    const paidRow = rep.body.rows.find((r: any) => r.action === "Marked it reimbursed" && r.ref === claim.ref);
    expect(paidRow.held).toMatch(/^1d 2h$/);
  });
});

/* ── 2. Bot vs person, distinctly ──────────────────────────────────── */
describe("2 · bot and person are distinct actors", () => {
  it("Policy Bot entries carry actorType bot; a person's carry user; pre-sub-step-2 rows normalise by name", async () => {
    const t = await makeTeam();
    const E = as(t.employee);
    const line = (await E.post("/api/expenses", { amount: 10, date: TODAY })).body.expense; // no receipt, no category → 2 warnings
    const claim = (await E.post("/api/reports", { name: "Bot" })).body.report;
    await E.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [line._id] });
    await E.post(`/api/reports/${claim._id}/submit`);
    // A legacy row written the OLD way (no actorType), by name "Policy Bot".
    await ExpenseActivity.collection.insertOne({
      workspaceId: new mongoose.Types.ObjectId(t.wsId), reportId: new mongoose.Types.ObjectId(claim._id),
      event: "policy_check", actorId: null, actorName: "Policy Bot", note: "legacy row", createdAt: new Date(),
    });
    const trail = await trailOf(t.employee, claim._id);
    const bots = trail.filter((a) => a.event === "policy_check");
    expect(bots.length).toBe(3);
    expect(bots.every((a) => a.actorType === "bot" && a.actorId === null)).toBe(true);
    expect(trail.find((a) => a.event === "submitted").actorType).toBe("user");
    expect(trail.find((a) => a.event === "routed").actorType).toBe("system");
    // Stored, not just presented: the new rows persisted actorType.
    const stored = await ExpenseActivity.find({ reportId: claim._id, event: "policy_check" }).lean();
    expect(stored.filter((s: any) => s.actorType === "bot").length).toBe(2);
  });
});

/* ── 3. Finance cannot pay their own claim ─────────────────────────── */
describe("3 · nobody pays their own claim", () => {
  it("finance, an expense admin and a structural admin are all refused on their own claim; someone else can pay", async () => {
    const t = await makeTeam();
    // Finance user files a claim; the manager approves it.
    const F = as(t.finance);
    const lineRes = await F.post("/api/expenses", { amount: 900, date: TODAY });
    expect(lineRes.status).toBe(201);
    const line = lineRes.body.expense;
    const claimRes = await F.post("/api/reports", { name: "Finance's own" });
    expect(claimRes.status).toBe(201);
    const claim = claimRes.body.report;
    await F.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [line._id] });
    // finance has no manager → routes to the admin-grant holder
    expect((await F.post(`/api/reports/${claim._id}/submit`)).status).toBe(200);
    expect((await as(t.admin).post(`/api/reports/${claim._id}/approve`)).status).toBe(200);

    const det = await F.get(`/api/reports/${claim._id}`);
    expect(det.body.report.canReimburse).toBe(false); // UI affordance hidden
    const own = await F.post(`/api/reports/${claim._id}/reimburse`);
    expect(own.status).toBe(403);
    expect(own.body.code).toBe("OWN_CLAIM_PAYOUT_DENIED");
    expect((await Report.findById(claim._id).lean())!.status).toBe("approved");

    // An admin's own claim: also refused, even for a structural admin.
    const leader = await makeUser(t.wsId, ["HR"], "Lena"); // structural expense admin (HR)
    const L = as(leader);
    const l2 = (await L.post("/api/expenses", { amount: 50, date: TODAY })).body.expense;
    const c2 = (await L.post("/api/reports", { name: "Leader's own" })).body.report;
    await L.post(`/api/reports/${c2._id}/expenses`, { expenseIds: [l2._id] });
    expect((await L.post(`/api/reports/${c2._id}/submit`)).status).toBe(200);
    expect((await as(t.admin).post(`/api/reports/${c2._id}/approve`)).status).toBe(200);
    expect((await L.post(`/api/reports/${c2._id}/reimburse`)).body.code).toBe("OWN_CLAIM_PAYOUT_DENIED");

    // A different finance user pays both.
    const finance2 = await makeUser(t.wsId, ["EMPLOYEE"], "Fenil");
    await upsertGrant({ workspaceId: t.wsId, userId: finance2.id, patch: { finance: true } });
    expect((await as(finance2).post(`/api/reports/${claim._id}/reimburse`)).status).toBe(200);
    expect((await as(finance2).post(`/api/reports/${c2._id}/reimburse`)).status).toBe(200);

    // Same rule on advances.
    const advRes = await F.post("/api/expense-advances", { amount: 500, purpose: "x" });
    expect(advRes.status).toBe(201);
    const adv = advRes.body.advance;
    expect((await as(t.admin).post(`/api/expense-advances/${adv._id}/approve`)).status).toBe(200);
    const ownAdv = await F.post(`/api/expense-advances/${adv._id}/disburse`);
    expect(ownAdv.status).toBe(403);
    expect(ownAdv.body.code).toBe("OWN_ADVANCE_PAYOUT_DENIED");
    expect((await as(finance2).post(`/api/expense-advances/${adv._id}/disburse`)).status).toBe(200);
  });

  it("an admin paying a claim they approved is allowed but permanently marked as an SoD override (F-18)", async () => {
    const t = await makeTeam();
    const E = as(t.employee);
    const line = (await E.post("/api/expenses", { amount: 300, date: TODAY })).body.expense;
    const claim = (await E.post("/api/reports", { name: "Override" })).body.report;
    await E.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [line._id] });
    await E.post(`/api/reports/${claim._id}/submit`);
    const A = as(t.admin);
    expect((await A.post(`/api/reports/${claim._id}/approve`)).status).toBe(200); // admin override of the routed manager
    expect((await A.post(`/api/reports/${claim._id}/reimburse`)).status).toBe(200);
    const trail = await trailOf(t.employee, claim._id);
    expect(trail.find((a) => a.event === "approved").details.adminOverride).toBe(true);
    const paid = trail.find((a) => a.event === "reimbursed");
    expect(paid.details.sodOverride).toBe(true);
    expect(paid.details.payerIsAdmin).toBe(true);
    expect(paid.note).toMatch(/Admin SoD override/);
  });
});

/* ── 4. Append-only: corrections append, history never changes ─────── */
describe("4 · append-only", () => {
  it("a rate correction is a NEW entry carrying old → new; the model refuses edits and deletes", async () => {
    const t = await makeTeam();
    const E = as(t.employee);
    const usd = (await E.post("/api/expenses", { amount: 40, currency: "USD", date: TODAY })).body.expense;
    await E.patch(`/api/expenses/${usd._id}/rate`, { exchangeRate: 8.35 }); // wrong, loose → on-doc history only
    const claim = (await E.post("/api/reports", { name: "Fix" })).body.report;
    await E.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [usd._id] });
    await E.post(`/api/reports/${claim._id}/submit`);
    const before = await trailOf(t.employee, claim._id);
    const submittedBefore = before.find((a) => a.event === "submitted");
    expect(submittedBefore.details.totalBase).toBe(334);

    expect((await as(t.finance).patch(`/api/expenses/${usd._id}/rate`, { exchangeRate: 83.5, reason: "statement" })).status).toBe(200);
    const after = await trailOf(t.employee, claim._id);
    // Nothing earlier changed — same ids, same payloads; the submit still says 334.
    expect(after.slice(0, before.length).map((a) => a._id)).toEqual(before.map((a) => a._id));
    expect(after.find((a) => a.event === "submitted").details.totalBase).toBe(334);
    // One new row, with old → new.
    expect(after.length).toBe(before.length + 1);
    const fix = after[after.length - 1];
    expect(fix.event).toBe("fx_rate_set");
    expect(fix.actorId).toBe(t.finance.id);
    expect(fix.details).toMatchObject({
      kind: "correction",
      from: { exchangeRate: 8.35, amountBase: 334, rateSource: "manual" },
      to: { exchangeRate: 83.5, amountBase: 3340, rateSource: "manual" },
      byFinance: true,
      reason: "statement",
    });
    expect(fix.elapsedMs).not.toBeNull();

    // The model itself refuses in-place edits and deletes.
    const row: any = await ExpenseActivity.findById(fix._id);
    row.note = "tampered";
    await expect(row.save()).rejects.toThrow(/append-only/);
    await expect(ExpenseActivity.updateOne({ _id: fix._id }, { $set: { note: "tampered" } })).rejects.toThrow(/append-only/);
    await expect(ExpenseActivity.findOneAndUpdate({ _id: fix._id }, { $set: { note: "x" } })).rejects.toThrow(/append-only/);
    await expect(ExpenseActivity.deleteOne({ _id: fix._id })).rejects.toThrow(/append-only/);
    await expect(ExpenseActivity.deleteMany({ reportId: claim._id })).rejects.toThrow(/append-only/);
    expect(((await ExpenseActivity.findById(fix._id).lean()) as any).note).not.toBe("tampered");
    expect(await ExpenseActivity.countDocuments({ reportId: claim._id })).toBe(after.length);
  });

  it("a withdraw + resubmit round-trip is on the record with its own clock", async () => {
    const t = await makeTeam();
    const E = as(t.employee);
    const line = (await E.post("/api/expenses", { amount: 100, date: TODAY })).body.expense;
    const claim = (await E.post("/api/reports", { name: "W" })).body.report;
    await E.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [line._id] });
    await E.post(`/api/reports/${claim._id}/submit`);
    await backdateReport(claim._id, { submittedAt: new Date(Date.now() - 3 * HOUR) });
    expect((await E.post(`/api/reports/${claim._id}/withdraw`)).status).toBe(200);
    expect((await E.post(`/api/reports/${claim._id}/submit`)).status).toBe(200);
    const trail = await trailOf(t.employee, claim._id);
    const w = trail.find((a) => a.event === "withdrawn");
    expect(w.heldMs).toBeGreaterThanOrEqual(3 * HOUR - 5000);
    expect(w.details.inReviewMs).toBe(w.heldMs);
    expect(w.details.previousApproverId).toBe(t.manager.id);
    const submits = trail.filter((a) => a.event === "submitted");
    expect(submits).toHaveLength(2);
    expect(submits[0].details).toMatchObject({ submissionNumber: 1, afterWithdraw: false });
    expect(submits[1].details).toMatchObject({ submissionNumber: 2, afterWithdraw: true });
    expect(trail.filter((a) => a.event === "routed")).toHaveLength(2); // re-routed fresh
  });
});

/* ── 5. Multi-approver claim ───────────────────────────────────────── */
describe("5 · each approver on a multi-level claim is recorded the same way", () => {
  it("L1 and L2 each carry their own who / when / held; L2's clock starts when L1 approves", async () => {
    const t = await makeTeam({ expenseEscalationThreshold: 1000, seniorApproverId: null });
    await CustomerWorkspace.updateOne({ _id: new mongoose.Types.ObjectId(t.wsId) }, { $set: { "config.seniorApproverId": new mongoose.Types.ObjectId(t.admin.id) } });
    const E = as(t.employee);
    const line = (await E.post("/api/expenses", { amount: 5000, date: TODAY })).body.expense;
    const claim = (await E.post("/api/reports", { name: "Two levels" })).body.report;
    await E.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [line._id] });
    expect((await E.post(`/api/reports/${claim._id}/submit`)).status).toBe(200);

    let trail = await trailOf(t.employee, claim._id);
    const routed = trail.find((a) => a.event === "routed");
    expect(routed.details.rule).toMatchObject({ kind: "workspace_escalation_threshold", thresholdBase: 1000, overThreshold: true });
    expect(routed.details.climbed).toBe(true);
    expect(routed.details.chosen).toEqual([
      { level: 1, userId: t.manager.id, name: t.manager.name, via: "manager" },
      { level: 2, userId: t.admin.id, name: t.admin.name, via: "senior_approver" },
    ]);
    const doc0: any = await Report.findById(claim._id).lean();
    expect(doc0.approvalChain[0].routedAt).toBeTruthy();
    expect(doc0.approvalChain[1].routedAt).toBeNull(); // L2's clock has not started

    // L1 holds it 4h then approves.
    await backdateReport(claim._id, { "approvalChain.0.routedAt": new Date(Date.now() - 4 * HOUR), submittedAt: new Date(Date.now() - 4 * HOUR) });
    expect((await as(t.manager).post(`/api/reports/${claim._id}/approve`)).status).toBe(200);
    const doc1: any = await Report.findById(claim._id).lean();
    expect(doc1.status).toBe("submitted");
    expect(doc1.currentLevel).toBe(2);
    expect(doc1.approvalChain[1].routedAt).toBeTruthy(); // started at L1's approval
    expect(doc1.approvalChain[0].heldMs).toBeGreaterThanOrEqual(4 * HOUR - 5000);

    // L2 holds it 30h then approves.
    await backdateReport(claim._id, { "approvalChain.1.routedAt": new Date(Date.now() - 30 * HOUR) });
    expect((await as(t.admin).post(`/api/reports/${claim._id}/approve`, { decisionNote: "ok" })).status).toBe(200);
    trail = await trailOf(t.employee, claim._id);
    const approvals = trail.filter((a) => a.event === "approved");
    expect(approvals).toHaveLength(2);
    expect(approvals[0]).toMatchObject({ actorId: t.manager.id, actorType: "user" });
    expect(approvals[0].details).toMatchObject({ level: 1, ofLevels: 2, via: "manager", nextLevel: 2, nextApproverId: t.admin.id });
    expect(approvals[0].heldMs).toBeGreaterThanOrEqual(4 * HOUR - 5000);
    expect(approvals[1]).toMatchObject({ actorId: t.admin.id, actorType: "user" });
    expect(approvals[1].details).toMatchObject({ level: 2, ofLevels: 2, via: "senior_approver", final: true, note: "ok" });
    expect(approvals[1].heldMs).toBeGreaterThanOrEqual(30 * HOUR - 5000);
    expect(approvals[1].heldMs).toBeLessThan(31 * HOUR);
    expect((await Report.findById(claim._id).lean())!.status).toBe("approved");
  });

  it("a decline and a send-back record the approver, level, comment and held time the same way", async () => {
    const t = await makeTeam();
    const E = as(t.employee);
    for (const [action, evt, statusAfter] of [
      ["decline", "declined", "declined"],
      ["request-clarification", "clarification_requested", "clarification_required"],
    ] as const) {
      const line = (await E.post("/api/expenses", { amount: 100, date: TODAY })).body.expense;
      const claim = (await E.post("/api/reports", { name: action })).body.report;
      await E.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [line._id] });
      await E.post(`/api/reports/${claim._id}/submit`);
      await backdateReport(claim._id, { "approvalChain.0.routedAt": new Date(Date.now() - 90 * 60_000) });
      expect((await as(t.manager).post(`/api/reports/${claim._id}/${action}`, { decisionNote: "receipt missing" })).status).toBe(200);
      const row = (await trailOf(t.employee, claim._id)).find((a) => a.event === evt);
      expect(row).toMatchObject({ actorId: t.manager.id, actorType: "user" });
      expect(row.details).toMatchObject({ level: 1, ofLevels: 1, via: "manager", note: "receipt missing" });
      expect(row.heldMs).toBeGreaterThanOrEqual(90 * 60_000 - 5000);
      expect((await Report.findById(claim._id).lean())!.status).toBe(statusAfter);
    }
  });
});
