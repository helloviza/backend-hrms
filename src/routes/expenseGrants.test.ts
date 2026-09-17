// Approval-engine sub-step 1 — expense capabilities move OUT of User.roles[]
// into the per-person grant store (audit F-01 Red + F-21). Real Mongo (memory
// server), the REAL expense routers with the REAL chain server.ts mounts
// (requireAuth → requireWorkspace → attachExpenseGrant → requireFeature), the
// REAL platform requireAdmin (middleware/rbac.ts) on a probe route, and the
// REAL AccessConsole PATCH /permissions/update for the F-21 case. No mocks.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";

process.env.MONGO_URI = "mongodb://127.0.0.1:1/never-connected";
process.env.JWT_SECRET = "grants-test-secret";
process.env.JWT_REFRESH_SECRET = "grants-test-refresh";
process.env.FRONTEND_ORIGIN = "http://localhost:5173";
process.env.S3_BUCKET = "test-bucket";
process.env.GEMINI_API_KEY = "test";
process.env.DISABLE_EMAILS = "1";
process.env.NODE_ENV = "test";

const { requireAuth } = await import("../middleware/auth.js");
const { requireWorkspace } = await import("../middleware/requireWorkspace.js");
const { requireFeature, requireExpenseAdvancesFeature } = await import("../middleware/requireFeature.js");
const { requireAdmin } = await import("../middleware/rbac.js");
const { attachExpenseGrant } = await import("../services/expenseGrants.service.js");
const { signToken } = await import("../utils/jwt.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: User } = await import("../models/User.js");
const { default: Department } = await import("../models/Department.js");
const { default: ExpenseApproverGrant } = await import("../models/ExpenseApproverGrant.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { default: expensesRouter } = await import("./expenses.js");
const { default: reportsRouter } = await import("./expenseReports.js");
const { default: adminRouter } = await import("./expenseAdmin.js");
const { default: categoriesRouter } = await import("./expenseCategories.js");
const { default: advancesRouter } = await import("./expenseAdvances.js");
const { default: permissionsRouter } = await import("./permissions.js");

let mongod: MongoMemoryServer;
let app: express.Express;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());
  const gate = [requireAuth, requireWorkspace, attachExpenseGrant, requireFeature("expensesEnabled")] as any[];
  app.use("/api/expenses", ...gate, expensesRouter);
  app.use("/api/reports", ...gate, reportsRouter);
  app.use("/api/expense-admin", ...gate, adminRouter);
  app.use("/api/expense-categories", ...gate, categoriesRouter);
  app.use("/api/expense-advances", requireAuth, requireWorkspace, attachExpenseGrant, requireExpenseAdvancesFeature, advancesRouter);
  // A PLATFORM-admin surface: exactly what F-01 let a leader reach.
  app.get("/api/platform-admin-probe", requireAuth, requireAdmin, (_req, res) => res.json({ ok: true, platformAdmin: true }));
  // The real AccessConsole (F-21 vector).
  app.use("/api/permissions", requireAuth, permissionsRouter);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

type Actor = { id: string; email: string; roles: string[]; workspaceId: string; customerId?: string };
function as(a: Actor, extra: Record<string, any> = {}) {
  // Customer-type users resolve their workspace by customerId (requireWorkspace),
  // staff by workspaceId — the login token carries both when present.
  const t = signToken({
    sub: a.id, roles: a.roles, email: a.email, workspaceId: a.workspaceId,
    ...(a.customerId ? { customerId: a.customerId } : {}),
    ...extra,
  } as any);
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
  const email = `g-${seq}-${Date.now()}@test.local`;
  const u = await User.create({
    email, passwordHash: "x", firstName: `U${seq}`, lastName: "Test", roles, workspaceId, status: "ACTIVE", ...extra,
  });
  return { id: String(u._id), email, roles, workspaceId, ...(extra.customerId ? { customerId: extra.customerId } : {}) };
}
/** A CUSTOMER workspace led by a WORKSPACE_LEADER (the F-01 actor). */
async function makeCustomerWorkspace() {
  seq++;
  const customerId = `cust-g-${seq}-${Date.now()}`;
  const ws = await CustomerWorkspace.create({
    customerId, name: `Grants WS ${seq}`, status: "ACTIVE",
    config: { features: { expensesEnabled: true, advancesEnabled: true } },
  });
  const wsId = String(ws._id);
  const leader = await makeUser(wsId, ["CUSTOMER", "WORKSPACE_LEADER"], { customerId });
  const employee = await makeUser(wsId, ["CUSTOMER"], { customerId });
  const other = await makeUser(wsId, ["CUSTOMER"], { customerId });
  const eng = await Department.create({ workspaceId: wsId, name: "Engineering", isActive: true });
  const sales = await Department.create({ workspaceId: wsId, name: "Sales", isActive: true });
  return { wsId, customerId, leader, employee, other, engId: String(eng._id), salesId: String(sales._id) };
}
const rolesOf = async (id: string) => ((await User.findById(id).lean()) as any).roles as string[];

/* ── 1. F-01: "make admin" no longer mints platform ADMIN ──────────── */
describe("F-01 · Team-page admin grant no longer touches User.roles[]", () => {
  it("leader grants admin to an employee: roles unchanged, grant written, expense-admin powers work, platform admin refused", async () => {
    const { wsId, leader, employee } = await makeCustomerWorkspace();
    const L = as(leader);

    const before = await rolesOf(employee.id);
    const r = await L.patch(`/api/expense-admin/users/${employee.id}/capabilities`, { admin: true });
    expect(r.status).toBe(200);
    expect(r.body.user.admin).toBe(true);
    expect(r.body.user.effectiveAdmin).toBe(true);

    // roles[] untouched — no platform ADMIN minted.
    expect(await rolesOf(employee.id)).toEqual(before);
    expect((await rolesOf(employee.id)).map((x) => x.toUpperCase())).not.toContain("ADMIN");
    // The grant is the record.
    const g: any = await ExpenseApproverGrant.findOne({ workspaceId: wsId, userId: employee.id }).lean();
    expect(g.capabilities.expenseAdmin).toBe(true);
    expect(g.active).toBe(true);
    expect(String(g.grantedBy)).toBe(leader.id);
    expect(g.history).toHaveLength(1);

    // Same expense-admin capability as before, via the grant:
    const E = as(employee);
    expect((await E.get("/api/expense-admin/users")).status).toBe(200); // Team page
    expect((await E.post("/api/expense-categories", { name: "Travel-X", botLimitMode: "na" })).status).toBe(201); // configure
    expect((await E.get("/api/expenses/analytics")).status).toBe(200); // see-all
    const caps = (await E.get("/api/expenses/capabilities")).body.capabilities;
    expect(caps).toMatchObject({ admin: true, finance: true, seesAll: true, approver: false });

    // …but NOT platform admin: requireAdmin (middleware/rbac.ts) still refuses.
    expect((await E.get("/api/platform-admin-probe")).status).toBe(403);
  });

  it("leader grants admin to THEMSELVES: still no platform ADMIN; still refused by requireAdmin", async () => {
    const { leader } = await makeCustomerWorkspace();
    const L = as(leader);
    const r = await L.patch(`/api/expense-admin/users/${leader.id}/capabilities`, { admin: true });
    expect(r.status).toBe(200);
    expect((await rolesOf(leader.id)).map((x) => x.toUpperCase())).not.toContain("ADMIN");
    expect((await L.get("/api/platform-admin-probe")).status).toBe(403);
    // and the self-lockout guard still holds
    const demote = await L.patch(`/api/expense-admin/users/${leader.id}/capabilities`, { admin: false });
    expect(demote.status).toBe(403);
    expect(demote.body.code).toBe("SELF_DEMOTION_DENIED");
  });

  it("a bare ADMIN token in roles[] no longer confers expense admin (only structural roles or a grant do)", async () => {
    const { wsId } = await makeCustomerWorkspace();
    const tokenOnly = await makeUser(wsId, ["EMPLOYEE", "ADMIN"]);
    expect((await as(tokenOnly).get("/api/expense-admin/users")).status).toBe(403);
    expect((await as(tokenOnly).get("/api/expenses/capabilities")).body.capabilities.admin).toBe(false);
    // Structural roles keep working unchanged.
    const hr = await makeUser(wsId, ["HR"]);
    expect((await as(hr).get("/api/expense-admin/users")).status).toBe(200);
    const tenantAdmin = await makeUser(wsId, ["TENANT_ADMIN"]);
    expect((await as(tenantAdmin).get("/api/expense-admin/users")).status).toBe(200);
  });
});

/* ── 2. Finance / approver / limit / scope from the store ──────────── */
describe("finance, approver, limit and department scope read from the grant store", () => {
  it("finance grant → reimburse queue + reimburse; approver/limit/scope stored; foreign department refused", async () => {
    const { wsId, leader, employee, other, engId, salesId } = await makeCustomerWorkspace();
    const L = as(leader);

    // A FINANCE token on roles[] is no longer read…
    const tokenFinance = await makeUser(wsId, ["CUSTOMER", "FINANCE"]);
    expect((await as(tokenFinance).get("/api/reports?queue=reimburse")).status).toBe(403);

    // …the grant is.
    const r = await L.patch(`/api/expense-admin/users/${other.id}/capabilities`, {
      finance: true, approver: true, limitBase: 200000, departmentIds: [engId, salesId],
    });
    expect(r.status).toBe(200);
    expect(r.body.user).toMatchObject({ finance: true, admin: false, approver: true, limitBase: 200000 });
    expect(r.body.user.departmentIds.sort()).toEqual([engId, salesId].sort());
    expect((await rolesOf(other.id)).map((x) => x.toUpperCase())).not.toContain("FINANCE");

    const O = as(other);
    expect((await O.get("/api/reports?queue=reimburse")).status).toBe(200);
    expect((await O.get("/api/expenses/capabilities")).body.capabilities).toMatchObject({
      admin: false, finance: true, seesAll: true, approver: true, limitBase: 200000,
    });
    expect((await O.get("/api/expense-admin/users")).status).toBe(403); // finance ≠ admin

    // End-to-end money-out on the grant: employee submits, leader approves, `other` (finance) reimburses.
    const E = as(employee);
    const line = (await E.post("/api/expenses", { amount: 500, date: new Date().toISOString().slice(0, 10) })).body.expense;
    const claim = (await E.post("/api/reports", { name: "c" })).body.report;
    await E.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [line._id] });
    expect((await E.post(`/api/reports/${claim._id}/submit`)).status).toBe(200);
    expect((await L.post(`/api/reports/${claim._id}/approve`)).status).toBe(200);
    expect((await O.post(`/api/reports/${claim._id}/reimburse`)).status).toBe(200);

    // Department scope must reference THIS workspace's active Department rows.
    const { engId: foreignDept } = await makeCustomerWorkspace();
    const bad = await L.patch(`/api/expense-admin/users/${other.id}/capabilities`, { departmentIds: [foreignDept] });
    expect(bad.status).toBe(400);
    expect((await L.patch(`/api/expense-admin/users/${other.id}/capabilities`, { departmentIds: ["nope"] })).status).toBe(400);
    expect((await L.patch(`/api/expense-admin/users/${other.id}/capabilities`, { limitBase: -1 })).status).toBe(400);
    // Clearing scope + limit.
    const clr = await L.patch(`/api/expense-admin/users/${other.id}/capabilities`, { departmentIds: null, limitBase: null });
    expect(clr.body.user.departmentIds).toEqual([]);
    expect(clr.body.user.limitBase).toBeNull();

    // Team list reflects the store + offers the workspace's departments.
    const list = await L.get("/api/expense-admin/users");
    const row = list.body.users.find((u: any) => u.id === other.id);
    expect(row).toMatchObject({ finance: true, approver: true, effectiveFinance: true, effectiveAdmin: false });
    expect(list.body.departments.map((d: any) => d.id).sort()).toEqual([engId, salesId].sort());

    // History records every change with the actor.
    const g: any = await ExpenseApproverGrant.findOne({ workspaceId: wsId, userId: other.id }).lean();
    expect(g.history.length).toBeGreaterThanOrEqual(2);
    expect(g.history.every((h: any) => String(h.by) === leader.id)).toBe(true);
  });

  it("an expenseAdmin grant holder is a valid no-manager approver fallback (routing keeps working)", async () => {
    const { wsId, leader, employee } = await makeCustomerWorkspace();
    const admin2 = await makeUser(wsId, ["CUSTOMER"]);
    await as(leader).patch(`/api/expense-admin/users/${admin2.id}/capabilities`, { admin: true });
    // The leader is structural; make the leader the submitter so the ONLY other admin is the grant holder.
    const Lsub = as(leader);
    const line = (await Lsub.post("/api/expenses", { amount: 10, date: new Date().toISOString().slice(0, 10) })).body.expense;
    const claim = (await Lsub.post("/api/reports", { name: "leader's own" })).body.report;
    await Lsub.post(`/api/reports/${claim._id}/expenses`, { expenseIds: [line._id] });
    const sub = await Lsub.post(`/api/reports/${claim._id}/submit`);
    expect(sub.status).toBe(200);
    expect(String(sub.body.report.approverId)).toBe(admin2.id); // grant holder, not employee
    void employee;
  });
});

/* ── 3. F-21: AccessConsole level change no longer wipes capability ── */
describe("F-21 · AccessConsole level change keeps the expense capability", () => {
  it("PATCH /permissions/update rewrites roles[] (as it always did) — the grant survives", async () => {
    const { wsId, leader, employee } = await makeCustomerWorkspace();
    await as(leader).patch(`/api/expense-admin/users/${employee.id}/capabilities`, { admin: true, finance: true });

    // The AccessConsole row the real /update handler edits.
    await UserPermission.create({
      userId: employee.id, email: employee.email, workspaceId: wsId, universe: "STAFF", source: "manual",
      level: { code: "L1", name: "Employee", designation: "" }, status: "active", tier: 1,
      grantedModules: [], roleType: "EMPLOYEE", grantedBy: "test", modules: {},
    });
    const superadmin = await makeUser(wsId, ["SUPERADMIN"]);
    const upd = await as(superadmin).patch("/api/permissions/update", { userId: employee.id, levelCode: "L4" });
    expect(upd.status).toBe(200);

    // roles[] was REPLACED by the level sync (this is what used to wipe FINANCE/ADMIN)…
    expect(await rolesOf(employee.id)).toEqual(["MANAGER"]);
    // …and the capability is untouched, because it never lived there.
    const caps = (await as(employee, { roles: ["MANAGER"] }).get("/api/expenses/capabilities")).body.capabilities;
    expect(caps).toMatchObject({ admin: true, finance: true });
    expect((await as(employee, { roles: ["MANAGER"] }).get("/api/expense-admin/users")).status).toBe(200);
  });
});
