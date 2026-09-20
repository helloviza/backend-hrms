// Advance queues — who sees what, and who is named as the disburser.
//   • GET /expense-advances?queue=approve is scoped SERVER-SIDE: a line-manager
//     approver sees only the advances whose current pending approver is them;
//     finance / expense admin (seesAll) see every awaiting advance; an approver
//     with nothing routed to them sees an empty list. Same rule as the claim
//     inbox — the frontend no longer locks non-seesAll users out of the page.
//   • Decisions stay bound to the routed approver (another approver gets 403).
//   • GET /:id and POST /:id/disburse expose disbursedByName — the FINANCE user
//     who paid it out, never the approver — and SoD on payout still holds.
// Real Mongo, real routers, real middleware chain (mirrors expenseAdvancesEngine.test.ts).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-connected";
process.env.JWT_SECRET = "adv-queue-test-secret";
process.env.JWT_REFRESH_SECRET = "adv-queue-test-refresh";
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
const { signToken } = await import("../utils/jwt.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: User } = await import("../models/User.js");
const { default: adminRouter } = await import("./expenseAdmin.js");
const { default: advancesRouter } = await import("./expenseAdvances.js");

let mongod: MongoMemoryServer;
let app: express.Express;
const NEXT_WEEK = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  app = express();
  app.use(express.json());
  app.use(cookieParser());
  const gate = [requireAuth, requireWorkspace, attachExpenseGrant, requireFeature("expensesEnabled")] as any[];
  app.use("/api/expense-admin", ...gate, adminRouter);
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
    post: (p: string, body?: any) => h(request(app).post(p)).send(body ?? {}),
  };
}
let seq = 0;
async function makeUser(workspaceId: string, roles: string[], first: string, extra: Record<string, any> = {}): Promise<Actor> {
  seq++;
  const email = `advq-${seq}-${Date.now()}@test.local`;
  const u = await User.create({ email, passwordHash: "x", firstName: first, lastName: "T", roles, workspaceId, status: "ACTIVE", ...extra });
  return { id: String(u._id), email, roles, workspaceId, name: `${first} T`, ...(extra.customerId ? { customerId: extra.customerId } : {}) };
}

/**
 * Two line managers with ₹50k (rank default), one employee under each, a
 * bystander approver nobody reports to, a finance user, a workspace leader.
 * Engine ON, bot at ₹2,000, so a ₹15,000 advance lands on the requester's
 * manager as the final approver.
 */
async function makeWorkspace() {
  seq++;
  const customerId = `cust-advq-${seq}-${Date.now()}`;
  const ws = await CustomerWorkspace.create({ customerId, name: `Advance queue WS ${seq}`, status: "ACTIVE", config: { features: { expensesEnabled: true, advancesEnabled: true } } });
  const wsId = String(ws._id);
  const leader = await makeUser(wsId, ["CUSTOMER", "WORKSPACE_LEADER"], "Lena", { customerId });
  const L = as(leader);
  await L.put("/api/expense-admin/ranks", { ranks: [{ bandNumber: 4, label: "Manager", defaultApprovalLimitBase: 50000 }] });
  const meera = await makeUser(wsId, ["MANAGER"], "Meera", { bandNumber: 4 });
  const priya = await makeUser(wsId, ["MANAGER"], "Priya", { bandNumber: 4 });
  const lata = await makeUser(wsId, ["EMPLOYEE"], "Lata");
  const farah = await makeUser(wsId, ["EMPLOYEE"], "Farah");
  await upsertGrant({ workspaceId: wsId, userId: meera.id, patch: { approver: true } });
  await upsertGrant({ workspaceId: wsId, userId: priya.id, patch: { approver: true } });
  await upsertGrant({ workspaceId: wsId, userId: lata.id, patch: { approver: true, limitBase: 20000 } });
  await upsertGrant({ workspaceId: wsId, userId: farah.id, patch: { finance: true } });
  const arjun = await makeUser(wsId, ["EMPLOYEE"], "Arjun", { managerId: meera.id });
  const kavya = await makeUser(wsId, ["EMPLOYEE"], "Kavya", { managerId: priya.id });
  await L.put("/api/expense-admin/approval-policy", { bot: { enabled: true, thresholdBase: 2000 } });
  await updatePolicy({ workspaceId: wsId, patch: { engineEnabled: true } });
  return { wsId, leader, meera, priya, lata, farah, arjun, kavya };
}
async function requestAdvance(who: Actor, purpose: string) {
  const r = await as(who).post("/api/expense-advances", { amount: 15000, purpose, neededBy: NEXT_WEEK });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  expect(r.body.advance.status).toBe("awaiting_approval");
  return r.body.advance as { _id: string; approverId: string };
}
const ids = (r: request.Response) => (r.body.docs as any[]).map((d) => String(d._id)).sort();

describe("GET ?queue=approve — scoped to the approver the engine routed to", () => {
  it("each line manager sees only the advances pending on them; a bystander approver sees none; finance/admin see all", async () => {
    const t = await makeWorkspace();
    const a1 = await requestAdvance(t.arjun, "Pune vendor visit");
    const a2 = await requestAdvance(t.kavya, "Client dinner float");
    expect(String(a1.approverId)).toBe(t.meera.id);
    expect(String(a2.approverId)).toBe(t.priya.id);

    const meera = await as(t.meera).get("/api/expense-advances?queue=approve");
    expect(meera.status).toBe(200);
    expect(ids(meera)).toEqual([a1._id]);
    expect(meera.body.docs[0].requesterName).toBe("Arjun T");

    const priya = await as(t.priya).get("/api/expense-advances?queue=approve");
    expect(ids(priya)).toEqual([a2._id]);

    // An approver with nothing routed to them gets an empty queue — not a 403, not everyone's.
    const lata = await as(t.lata).get("/api/expense-advances?queue=approve");
    expect(lata.status).toBe(200);
    expect(lata.body.docs).toEqual([]);

    // A plain employee (not an approver) also gets 200 + empty, like the claim inbox.
    const arjun = await as(t.arjun).get("/api/expense-advances?queue=approve");
    expect(arjun.status).toBe(200);
    expect(arjun.body.docs).toEqual([]);

    // Finance and the workspace leader (seesAll) get the whole awaiting queue.
    expect(ids(await as(t.farah).get("/api/expense-advances?queue=approve"))).toEqual([a1._id, a2._id].sort());
    expect(ids(await as(t.leader).get("/api/expense-advances?queue=approve"))).toEqual([a1._id, a2._id].sort());
  });

  it("the sidebar badge counts the same scope", async () => {
    const t = await makeWorkspace();
    await requestAdvance(t.arjun, "Pune vendor visit");
    await requestAdvance(t.kavya, "Client dinner float");
    expect((await as(t.meera).get("/api/expense-advances/pending-count")).body).toMatchObject({ approvals: 1, disburse: 0 });
    expect((await as(t.lata).get("/api/expense-advances/pending-count")).body).toMatchObject({ approvals: 0, disburse: 0 });
    expect((await as(t.farah).get("/api/expense-advances/pending-count")).body).toMatchObject({ approvals: 2, disburse: 0 });
  });

  it("the routed approver can approve from the queue; another approver cannot decide it", async () => {
    const t = await makeWorkspace();
    const a1 = await requestAdvance(t.arjun, "Pune vendor visit");
    const a2 = await requestAdvance(t.kavya, "Client dinner float");

    // Priya was not routed Arjun's advance: she can't approve it, and it isn't even visible to her.
    expect((await as(t.priya).post(`/api/expense-advances/${a1._id}/approve`)).status).toBe(403);
    expect((await as(t.priya).get(`/api/expense-advances/${a1._id}`)).status).toBe(404);

    const ok = await as(t.meera).post(`/api/expense-advances/${a1._id}/approve`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.advance.status).toBe("approved");

    // Meera's queue is now empty; Priya's still holds Kavya's.
    expect((await as(t.meera).get("/api/expense-advances?queue=approve")).body.docs).toEqual([]);
    expect(ids(await as(t.priya).get("/api/expense-advances?queue=approve"))).toEqual([a2._id]);
  });
});

describe("disbursedByName — the finance user who paid, never the approver", () => {
  it("is empty before disbursement, then names the disburser on the disburse response and on GET /:id", async () => {
    const t = await makeWorkspace();
    const a = await requestAdvance(t.arjun, "Pune vendor visit");
    expect((await as(t.meera).post(`/api/expense-advances/${a._id}/approve`)).status).toBe(200);

    const before = await as(t.farah).get(`/api/expense-advances/${a._id}`);
    expect(before.status).toBe(200);
    expect(before.body.advance.approverName).toBe("Meera T");
    expect(before.body.advance.disbursedByName).toBe("");
    expect(before.body.advance.canDisburse).toBe(true);

    const paid = await as(t.farah).post(`/api/expense-advances/${a._id}/disburse`, { disbursementMode: "bank_transfer", disbursementRef: "UTR 123" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    expect(paid.body.advance.status).toBe("disbursed");
    expect(String(paid.body.advance.disbursedBy)).toBe(t.farah.id);
    expect(paid.body.advance.disbursedByName).toBe("Farah T");

    const after = await as(t.arjun).get(`/api/expense-advances/${a._id}`);
    expect(after.body.advance.disbursedByName).toBe("Farah T");
    expect(after.body.advance.approverName).toBe("Meera T"); // the approver is still the approver
    expect(after.body.advance.disbursementRef).toBe("UTR 123");
    const disbursedEvent = (after.body.activity as any[]).find((e) => e.event === "disbursed");
    expect(disbursedEvent.actorName).toBe("Farah T");
  });

  it("segregation of duties still holds: the requester cannot pay themselves, and a non-finance approver cannot pay out", async () => {
    const t = await makeWorkspace();
    const a = await requestAdvance(t.arjun, "Pune vendor visit");
    expect((await as(t.meera).post(`/api/expense-advances/${a._id}/approve`)).status).toBe(200);

    const self = await as(t.arjun).post(`/api/expense-advances/${a._id}/disburse`, { disbursementMode: "cash" });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe("OWN_ADVANCE_PAYOUT_DENIED");

    const approver = await as(t.meera).post(`/api/expense-advances/${a._id}/disburse`, { disbursementMode: "cash" });
    expect(approver.status).toBe(403);

    // Untouched: still approved, nobody named as disburser.
    const still = await as(t.farah).get(`/api/expense-advances/${a._id}`);
    expect(still.body.advance.status).toBe("approved");
    expect(still.body.advance.disbursedByName).toBe("");
  });
});
