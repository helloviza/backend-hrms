// Approval-engine sub-step 8 — re-route waiting claims/advances when an
// approver leaves. Real Mongo (memory server), real routers, real middleware;
// the departures go through the SAME production entry points the product uses
// (setUserActiveStatus for deactivation, upsertGrant/revokeGrant for approver
// rights), never by calling the re-route service directly.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-connected";
process.env.JWT_SECRET = "reroute-test-secret";
process.env.JWT_REFRESH_SECRET = "reroute-test-refresh";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET = "test-bucket";
process.env.GEMINI_API_KEY = "test";
process.env.DISABLE_EMAILS = "1";
process.env.NODE_ENV = "test";
delete process.env.EXCHANGERATE_API_KEY;

const { requireAuth } = await import("../middleware/auth.js");
const { requireWorkspace } = await import("../middleware/requireWorkspace.js");
const { requireFeature } = await import("../middleware/requireFeature.js");
const { attachExpenseGrant, upsertGrant, revokeGrant } = await import("../services/expenseGrants.service.js");
const { updatePolicy } = await import("../services/expensePolicy.service.js");
const { setUserActiveStatus } = await import("../utils/userActiveStatus.js");
const { collectPendingWork, summarizePendingWork } = await import("../services/pendingWork.service.js");
const { signToken } = await import("../utils/jwt.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: User } = await import("../models/User.js");
const { default: ExpenseCategory } = await import("../models/ExpenseCategory.js");
const { default: Report } = await import("../models/Report.js");
const { default: ExpenseAdvance } = await import("../models/ExpenseAdvance.js");
const { default: ExpenseActivity } = await import("../models/ExpenseActivity.js");
const { default: expensesRouter } = await import("./expenses.js");
const { default: adminRouter } = await import("./expenseAdmin.js");
const { default: reportsRouter } = await import("./expenseReports.js");
const { default: advancesRouter } = await import("./expenseAdvances.js");

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
  app.use("/api/expense-advances", ...gate, advancesRouter);
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
  const email = `rr-${seq}-${Date.now()}@test.local`;
  const u = await User.create({ email, passwordHash: "x", firstName: first, lastName: "T", roles, workspaceId, status: "ACTIVE", ...extra });
  return { id: String(u._id), email, roles, workspaceId, name: `${first} T`, ...(extra.customerId ? { customerId: extra.customerId } : {}) };
}

/**
 * Engine ON, bot OFF (every claim here must reach a person).
 *   Meera  — Arjun's line manager, approver, ₹50,000
 *   Dev    — approver, ₹5,00,000 (the natural fallback when Meera goes)
 *   Priya  — approver, ₹80,000
 *   Farah  — finance only, never an approver
 *   Travel — category with a bot limit that is irrelevant while the bot is off
 */
async function makeWorkspace() {
  seq++;
  const customerId = `cust-rr-${seq}-${Date.now()}`;
  const ws = await CustomerWorkspace.create({ customerId, name: `RR WS ${seq}`, status: "ACTIVE", config: { features: { expensesEnabled: true } } });
  const wsId = String(ws._id);
  const leader = await makeUser(wsId, ["CUSTOMER", "WORKSPACE_LEADER"], "Lena", { customerId });
  const L = as(leader);
  const meera = await makeUser(wsId, ["MANAGER"], "Meera");
  const dev = await makeUser(wsId, ["EMPLOYEE"], "Dev");
  const priya = await makeUser(wsId, ["EMPLOYEE"], "Priya");
  const farah = await makeUser(wsId, ["EMPLOYEE"], "Farah");
  await upsertGrant({ workspaceId: wsId, userId: meera.id, patch: { approver: true, limitBase: 50000 } });
  await upsertGrant({ workspaceId: wsId, userId: dev.id, patch: { approver: true, limitBase: 500000 } });
  await upsertGrant({ workspaceId: wsId, userId: priya.id, patch: { approver: true, limitBase: 80000 } });
  await upsertGrant({ workspaceId: wsId, userId: farah.id, patch: { finance: true } });
  const arjun = await makeUser(wsId, ["EMPLOYEE"], "Arjun", { managerId: meera.id });
  const travel = String((await ExpenseCategory.create({ workspaceId: wsId, name: "Travel", active: true, botLimitMode: "amount", botLimitBase: 100 }))._id);
  await updatePolicy({ workspaceId: wsId, patch: { engineEnabled: true, bot: { enabled: false, thresholdBase: null } } });
  return { wsId, leader, L, meera, dev, priya, farah, arjun, travel };
}

/** A submitted claim of `amount`, routed by the live engine. */
async function submittedClaim(who: Actor, wsId: string, name: string, amount: number, categoryId?: string) {
  const W = as(who);
  const e = await W.post("/api/expenses", {
    amount, date: TODAY, merchant: name, categoryId,
    imageKey: `hrms/expenses/${wsId}/${who.id}/${name}-${Date.now()}.jpg`,
  });
  expect(e.status, JSON.stringify(e.body)).toBe(201);
  const c = (await W.post("/api/reports", { name })).body.report;
  await W.post(`/api/reports/${c._id}/expenses`, { expenseIds: [e.body.expense._id] });
  const sub = await W.post(`/api/reports/${c._id}/submit`);
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  return { id: String(c._id), ref: String(c.ref), submit: sub.body.report };
}

const deactivate = (userId: string, workspaceId: string) =>
  setUserActiveStatus({ userId, workspaceId, status: "INACTIVE", audit: { trigger: "explicit" } as any });

const trail = (id: string) => ExpenseActivity.find({ reportId: new mongoose.Types.ObjectId(id) }).sort({ createdAt: 1 }).lean();

/* ═════════════════ PART 1 — re-route on departure ═════════════════ */

describe("PART 1 — deactivating an approver re-routes what was waiting on them", () => {
  it("moves the claim to a covering approver and records why on the trail", async () => {
    const t = await makeWorkspace();
    const c = await submittedClaim(t.arjun, t.wsId, "waiting on meera", 20000, t.travel);
    expect(String(c.submit.approverId)).toBe(t.meera.id);

    await deactivate(t.meera.id, t.wsId);

    const after: any = await Report.findById(c.id).lean();
    expect(after.status).toBe("submitted");                 // still open, not stranded
    expect(String(after.approverId)).not.toBe(t.meera.id);  // not with the departed person
    expect([t.dev.id, t.priya.id]).toContain(String(after.approverId));
    expect(after.needsAttention).toBeNull();

    const entries = await trail(c.id);
    const re = entries.find((a: any) => a.event === "re_routed") as any;
    expect(re, "a re_routed entry must exist").toBeTruthy();
    expect(re.actorType).toBe("system");
    expect(re.actorName).toBe("System");
    expect(re.note).toMatch(/^Re-routed — Meera T was deactivated; re-assigned to /);
    expect(re.details).toMatchObject({ trigger: "deactivated", formerApproverId: t.meera.id, formerApproverName: "Meera T" });
    expect(re.details.routing).toMatchObject({ mode: "engine" });   // the reasoning is on the entry
    expect(re.createdAt).toBeInstanceOf(Date);
  });

  it("leaves a claim waiting on SOMEBODY ELSE completely untouched", async () => {
    const t = await makeWorkspace();
    // Kavya reports to Priya, so her claim sits with Priya, not Meera.
    const kavya = await makeUser(t.wsId, ["EMPLOYEE"], "Kavya", { managerId: t.priya.id });
    const mine = await submittedClaim(t.arjun, t.wsId, "mine", 20000, t.travel);
    const theirs = await submittedClaim(kavya, t.wsId, "theirs", 20000, t.travel);
    expect(String(theirs.submit.approverId)).toBe(t.priya.id);
    const beforeChain = JSON.stringify((await Report.findById(theirs.id).lean() as any).approvalChain);

    await deactivate(t.meera.id, t.wsId);

    const untouched: any = await Report.findById(theirs.id).lean();
    expect(String(untouched.approverId)).toBe(t.priya.id);
    expect(JSON.stringify(untouched.approvalChain)).toBe(beforeChain);
    expect((await trail(theirs.id)).some((a: any) => a.event === "re_routed")).toBe(false);
    // …while the one that WAS waiting on Meera did move.
    expect(String((await Report.findById(mine.id).lean() as any).approverId)).not.toBe(t.meera.id);
  });

  it("leaves an already-approved claim alone — no re-route, no new chain", async () => {
    const t = await makeWorkspace();
    const c = await submittedClaim(t.arjun, t.wsId, "already approved", 20000, t.travel);
    const ok = await as(t.meera).post(`/api/reports/${c.id}/approve`);
    expect(ok.status).toBe(200);
    expect((await Report.findById(c.id).lean() as any).status).toBe("approved");

    await deactivate(t.meera.id, t.wsId);

    const after: any = await Report.findById(c.id).lean();
    expect(after.status).toBe("approved");
    expect(String(after.approvalChain[0].approverId)).toBe(t.meera.id); // history intact
    expect(after.approvalChain[0].status).toBe("approved");
    expect((await trail(c.id)).some((a: any) => a.event === "re_routed")).toBe(false);
  });

  it("keeps a level the departing person had ALREADY approved, and re-resolves only what was pending", async () => {
    const t = await makeWorkspace();
    // A two-level chain: Meera endorses (₹50k < required), Dev finalises.
    const c = await submittedClaim(t.arjun, t.wsId, "two level", 120000, t.travel);
    const chain0: any = (await Report.findById(c.id).lean() as any).approvalChain;
    expect(chain0).toHaveLength(2);
    expect(String(chain0[0].approverId)).toBe(t.meera.id);
    expect(String(chain0[1].approverId)).toBe(t.dev.id);

    // Meera approves her level; it is now pending on Dev.
    expect((await as(t.meera).post(`/api/reports/${c.id}/approve`)).status).toBe(200);
    const mid: any = await Report.findById(c.id).lean();
    expect(mid.approvalChain[0].status).toBe("approved");
    expect(String(mid.approverId)).toBe(t.dev.id);

    // Now DEV leaves. Meera's approval must survive; only Dev's level moves.
    await deactivate(t.dev.id, t.wsId);

    const after: any = await Report.findById(c.id).lean();
    expect(after.approvalChain[0]).toMatchObject({ status: "approved" });
    expect(String(after.approvalChain[0].approverId)).toBe(t.meera.id);
    expect(after.currentLevel).toBe(2);
    expect(String(after.approverId)).not.toBe(t.dev.id);
    const re = (await trail(c.id)).find((a: any) => a.event === "re_routed") as any;
    expect(re.details.keptDecidedLevels).toBe(1);
  });

  it("re-routes an advance that was awaiting the departing approver", async () => {
    const t = await makeWorkspace();
    const A = as(t.arjun);
    // POST / creates AND routes it — an advance goes straight to awaiting_approval.
    const created = await A.post("/api/expense-advances", { amount: 20000, purpose: "Site visit float" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const advId = String(created.body.advance._id);
    expect(created.body.advance.status).toBe("awaiting_approval");
    expect(String(created.body.advance.approverId)).toBe(t.meera.id);

    await deactivate(t.meera.id, t.wsId);

    const after: any = await ExpenseAdvance.findById(advId).lean();
    expect(after.status).toBe("awaiting_approval");
    expect(String(after.approverId)).not.toBe(t.meera.id);
    const entries = await ExpenseActivity.find({ advanceId: new mongoose.Types.ObjectId(advId) }).lean();
    expect(entries.some((a: any) => a.event === "re_routed")).toBe(true);
  });
});

describe("PART 1 — losing the approver GRANT triggers the same re-route", () => {
  it("switching the approver flag off moves the claim", async () => {
    const t = await makeWorkspace();
    const c = await submittedClaim(t.arjun, t.wsId, "grant off", 20000, t.travel);
    expect(String(c.submit.approverId)).toBe(t.meera.id);

    await upsertGrant({ workspaceId: t.wsId, userId: t.meera.id, patch: { approver: false } });

    const after: any = await Report.findById(c.id).lean();
    expect(String(after.approverId)).not.toBe(t.meera.id);
    const re = (await trail(c.id)).find((a: any) => a.event === "re_routed") as any;
    expect(re.note).toMatch(/Meera T lost approver rights; re-assigned to /);
    expect(re.details.trigger).toBe("grant_removed");
  });

  it("revoking the whole grant moves it too", async () => {
    const t = await makeWorkspace();
    const c = await submittedClaim(t.arjun, t.wsId, "grant revoked", 20000, t.travel);
    await revokeGrant({ workspaceId: t.wsId, userId: t.meera.id, reason: "left the team" });
    const after: any = await Report.findById(c.id).lean();
    expect(String(after.approverId)).not.toBe(t.meera.id);
    expect((await trail(c.id)).some((a: any) => a.event === "re_routed")).toBe(true);
  });

  it("an unrelated grant edit (limit change) re-routes nothing", async () => {
    const t = await makeWorkspace();
    const c = await submittedClaim(t.arjun, t.wsId, "limit edit", 20000, t.travel);
    await upsertGrant({ workspaceId: t.wsId, userId: t.meera.id, patch: { limitBase: 60000 } });
    const after: any = await Report.findById(c.id).lean();
    expect(String(after.approverId)).toBe(t.meera.id);
    expect((await trail(c.id)).some((a: any) => a.event === "re_routed")).toBe(false);
  });
});

describe("PART 1 — when nobody can cover it, it is flagged, not stranded", () => {
  it("flags the claim for an admin with a reason and an audit entry", async () => {
    const t = await makeWorkspace();
    // A claim only Dev's ₹5L can cover; then everyone else loses the rights, so
    // when Dev goes there is nobody left with a big enough limit.
    const c = await submittedClaim(t.arjun, t.wsId, "only dev covers", 300000, t.travel);
    expect(String(c.submit.approverId)).toBe(t.meera.id); // manager endorses first
    expect((await as(t.meera).post(`/api/reports/${c.id}/approve`)).status).toBe(200);
    expect(String((await Report.findById(c.id).lean() as any).approverId)).toBe(t.dev.id);

    await upsertGrant({ workspaceId: t.wsId, userId: t.priya.id, patch: { approver: false } });
    await deactivate(t.dev.id, t.wsId);

    const after: any = await Report.findById(c.id).lean();
    expect(after.status).toBe("submitted");            // NOT silently closed
    expect(after.approverId).toBeNull();               // not parked with the departed person
    expect(after.needsAttention).toBeTruthy();
    expect(after.needsAttention.reason).toMatch(/Needs admin attention — no approver left can cover it after Dev T was deactivated\./);
    expect(String(after.needsAttention.formerApproverId)).toBe(t.dev.id);
    expect(after.needsAttention.since).toBeInstanceOf(Date);
    expect(after.approvalChain[0].status).toBe("approved"); // Meera's approval still stands

    const flagged = (await trail(c.id)).find((a: any) => a.event === "needs_attention") as any;
    expect(flagged).toBeTruthy();
    expect(flagged.actorType).toBe("system");
    expect(flagged.note).toMatch(/Needs admin attention/);
    expect(flagged.details).toMatchObject({ trigger: "deactivated", formerApproverName: "Dev T", why: "no approver left can cover it" });
  });

  it("an admin sees the flagged claim in the approvals queue", async () => {
    const t = await makeWorkspace();
    const c = await submittedClaim(t.arjun, t.wsId, "flagged visible", 300000, t.travel);
    await as(t.meera).post(`/api/reports/${c.id}/approve`);
    await upsertGrant({ workspaceId: t.wsId, userId: t.priya.id, patch: { approver: false } });
    await deactivate(t.dev.id, t.wsId);

    const queue = (await t.L.get("/api/reports?queue=approvals")).body.docs;
    const row = queue.find((r: any) => r._id === c.id);
    expect(row, "the flagged claim must still be in the admin queue").toBeTruthy();
    expect(row.needsAttention.reason).toMatch(/Needs admin attention/);

    // And the detail view carries it for the banner.
    const detail = (await t.L.get(`/api/reports/${c.id}`)).body;
    expect(detail.report.needsAttention.reason).toMatch(/Needs admin attention/);
  });

  it("a later successful re-route clears the flag", async () => {
    const t = await makeWorkspace();
    const c = await submittedClaim(t.arjun, t.wsId, "flag then clear", 300000, t.travel);
    await as(t.meera).post(`/api/reports/${c.id}/approve`);
    await upsertGrant({ workspaceId: t.wsId, userId: t.priya.id, patch: { approver: false } });
    await deactivate(t.dev.id, t.wsId);
    expect((await Report.findById(c.id).lean() as any).needsAttention).toBeTruthy();

    // Give Priya the authority back and take the rights off a nobody: the next
    // re-route pass (triggered by any departure) can now place it.
    await upsertGrant({ workspaceId: t.wsId, userId: t.priya.id, patch: { approver: true, limitBase: 400000 } });
    await upsertGrant({ workspaceId: t.wsId, userId: t.meera.id, patch: { approver: false } });

    const after: any = await Report.findById(c.id).lean();
    expect(after.needsAttention).toBeNull();
    expect(String(after.approverId)).toBe(t.priya.id);
  });
});

describe("PART 1 — the existing pending-work guard still fires", () => {
  it("counts the claim waiting on the approver BEFORE deactivation, as it always did", async () => {
    const t = await makeWorkspace();
    const c = await submittedClaim(t.arjun, t.wsId, "guard still warns", 20000, t.travel);
    expect(String(c.submit.approverId)).toBe(t.meera.id);

    const report = await collectPendingWork({ userId: t.meera.id, workspaceId: t.wsId });
    const claims = report.awaitingAction.find((s: any) => s.key === "expenseClaimsToApprove") as any;
    expect(claims.count).toBe(1);
    expect(claims.items[0].id).toBe(c.id);
    // The snapshot the deactivation audit stores sees it too.
    expect(summarizePendingWork(report).awaitingAction.expenseClaimsToApprove).toBe(1);
    expect(report.totals.awaitingAction).toBeGreaterThanOrEqual(1);

    // …and after the deactivation the same guard reads zero, because the work moved.
    await deactivate(t.meera.id, t.wsId);
    const post = await collectPendingWork({ userId: t.meera.id, workspaceId: t.wsId });
    expect((post.awaitingAction.find((s: any) => s.key === "expenseClaimsToApprove") as any).count).toBe(0);
  });
});
