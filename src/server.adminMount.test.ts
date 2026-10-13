// apps/backend/src/server.adminMount.test.ts
//
// 2026-10-07: chirag@ (roles [EMPLOYEE], HOUSE workspace, invoices + creditnotes
// FULL / scope OWN) still got 403 "Admin access required" on
// GET /api/admin/credit-notes and /api/admin/notifications/unread-count after
// requireBillingStaff was fixed. The refusal came from BEFORE that gate:
// adminAnalyticsRouter is mounted on all of /api/admin with
// router.use(requireAdmin), ahead of the invoices / credit-notes /
// notifications mounts. The billing suites mounted their routers on a bare
// express app with a stubbed requireAuth, so the server's mount order was
// never exercised.
//
// This suite goes through the REAL app (server.ts, real middleware order) with
// REAL login tokens from POST /api/auth/login. Only Mongo is in-memory.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { MongoMemoryServer } from "mongodb-memory-server";

// Dummies so config/env.ts loads without a .env (never point at a real DB).
Object.assign(process.env, {
  NODE_ENV: "test",
  DEPLOYMENT_MODE: "plumbox",
  MONGO_URI: "mongodb://127.0.0.1:1/never",
  JWT_SECRET: "test-jwt-secret-admin-mount",
  JWT_REFRESH_SECRET: "test-jwt-refresh-secret-admin-mount",
  FRONTEND_ORIGIN: "http://localhost:5173",
  AWS_REGION: "ap-south-1",
  S3_BUCKET: "test-bucket",
  GEMINI_API_KEY: "test",
  OPENAI_API_KEY: "test",
  CONSUMER_JWT_SECRET: "test-consumer-jwt-secret-admin-mount",
});

// No egress: importing server.ts pulls in modules that warm caches over the
// network at import time (e.g. tbo.hotel.shared's city-list preload).
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return realFetch(input, init);
  throw new Error(`egress blocked in test: ${url}`);
}) as typeof fetch;

const HOUSE = "69679a7628330a58d29f2254";
const PASSWORD = "Correct-Horse-9";
const oid = () => new mongoose.Types.ObjectId();

let mongod: MongoMemoryServer;
let app: any;
let UserPermission: any;
const col = (n: string) => mongoose.connection.db!.collection(n);

type Who = { email: string; token: string; id: string };
let seq = 0;

async function person(opts: {
  roles: string[];
  workspaceId?: string;
  customerId?: string;
  grants?: Record<string, string> | null; // null = no UserPermission row at all
}): Promise<Who> {
  const id = oid();
  const email = `u${++seq}-${id}@plumtrips.com`;
  await col("users").insertOne({
    _id: id,
    email,
    name: `User ${seq}`,
    firstName: "User",
    roles: opts.roles,
    passwordHash: await bcrypt.hash(PASSWORD, 4),
    ...(opts.workspaceId ? { workspaceId: new mongoose.Types.ObjectId(opts.workspaceId) } : {}),
    ...(opts.customerId ? { customerId: opts.customerId } : {}),
  } as any);
  if (opts.grants !== null) {
    const modules: any = {};
    for (const [k, v] of Object.entries(opts.grants || {})) modules[k] = { access: v, scope: "OWN" }; // Chirag's scope
    await UserPermission.create({
      userId: String(id), email, workspaceId: opts.workspaceId || "global", universe: "STAFF",
      level: { code: "L2", name: "Senior" }, modules, grantedBy: "test",
    } as any);
  }
  const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return { email, token: res.body.accessToken, id: String(id) };
}

const as = (w: Who, r: request.Test) => r.set("Authorization", `Bearer ${w.token}`);
const get = (w: Who, p: string) => as(w, request(app).get(p));
const post = (w: Who, p: string, body: unknown = {}) => as(w, request(app).post(p).send(body as any));
const isAdminWall = (res: request.Response) =>
  res.status === 403 && /Admin access required/.test(JSON.stringify(res.body));

const CHIRAG_GRANTS = { invoices: "FULL", creditnotes: "FULL" };
let chirag: Who, chiragMb: Who, noGrant: Who, vendorInHouse: Who, customer: Who, tenantStaff: Who, superAdmin: Who;
// 2026-10-13: CRM reps — the L1 template's tasks WRITE / OWN, and a READ-only one.
let rep: Who, repReader: Who;
// Scoping (same commit): a second rep, a FULL HOUSE user, a tenant rep.
let otherRep: Who, houseFull: Who, tenantRep: Who;
// Admins on either side of the HOUSE gate (task-automations).
let houseAdmin: Who, tenantAdmin: Who, tenantPlainAdmin: Who;
const patch = (w: Who, p: string, body: unknown = {}) => as(w, request(app).patch(p).send(body as any));
const del = (w: Who, p: string) => as(w, request(app).delete(p));

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  ({ default: app } = await import("./server.js"));
  ({ UserPermission } = await import("./models/UserPermission.js"));
  await mongoose.connect(mongod.getUri());

  const TENANT = String(oid());
  const CUST_WS = String(oid());
  await col("customerworkspaces").insertMany([
    { _id: new mongoose.Types.ObjectId(HOUSE), customerId: "house-cust", companyName: "Plumtrips", status: "ACTIVE", config: { features: {} } },
    { _id: new mongoose.Types.ObjectId(TENANT), customerId: "tenant-cust", companyName: "Tenant Co", status: "ACTIVE",
      config: { features: { invoicesEnabled: true, sbtEnabled: true } } },
    { _id: new mongoose.Types.ObjectId(CUST_WS), customerId: String(oid()), companyName: "Customer Co", status: "ACTIVE",
      config: { features: { invoicesEnabled: true, sbtEnabled: true } } },
  ] as any);
  const custWs: any = await col("customerworkspaces").findOne({ _id: new mongoose.Types.ObjectId(CUST_WS) });

  chirag = await person({ roles: ["EMPLOYEE"], workspaceId: HOUSE, grants: CHIRAG_GRANTS });
  chiragMb = await person({ roles: ["EMPLOYEE"], workspaceId: HOUSE, grants: { ...CHIRAG_GRANTS, manualBookings: "FULL" } });
  noGrant = await person({ roles: ["EMPLOYEE"], workspaceId: HOUSE, grants: {} });
  // A vendor account parked in the HOUSE workspace — must never pass as staff.
  vendorInHouse = await person({ roles: ["VENDOR"], workspaceId: HOUSE, grants: null });
  customer = await person({ roles: ["CUSTOMER"], customerId: custWs.customerId, grants: null });
  tenantStaff = await person({ roles: ["EMPLOYEE"], workspaceId: TENANT, grants: CHIRAG_GRANTS });
  superAdmin = await person({ roles: ["SUPERADMIN"], workspaceId: HOUSE, grants: {} });
  rep = await person({ roles: ["EMPLOYEE"], workspaceId: HOUSE, grants: { tasks: "WRITE", leads: "WRITE" } });
  repReader = await person({ roles: ["EMPLOYEE"], workspaceId: HOUSE, grants: { tasks: "READ" } });
  otherRep = await person({ roles: ["EMPLOYEE"], workspaceId: HOUSE, grants: { tasks: "WRITE", leads: "WRITE" } });
  houseFull = await person({ roles: ["EMPLOYEE"], workspaceId: HOUSE, grants: { tasks: "FULL" } }); // FULL/OWN, as 2 prod users
  tenantRep = await person({ roles: ["EMPLOYEE"], workspaceId: TENANT, grants: { tasks: "WRITE" } });
  houseAdmin = await person({ roles: ["ADMIN"], workspaceId: HOUSE, grants: {} });
  tenantAdmin = await person({ roles: ["TENANT_ADMIN"], workspaceId: TENANT, grants: {} });
  tenantPlainAdmin = await person({ roles: ["ADMIN"], workspaceId: TENANT, grants: {} });
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

describe("HOUSE staff shaped like Chirag reach the module routes through the real app", () => {
  it("GET /api/admin/credit-notes → 200", async () => {
    const res = await get(chirag, "/api/admin/credit-notes");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
  it("GET /api/admin/invoices → 200", async () => {
    const res = await get(chirag, "/api/admin/invoices");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
  it("GET /api/admin/notifications/unread-count and list → 200", async () => {
    const c = await get(chirag, "/api/admin/notifications/unread-count");
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const l = await get(chirag, "/api/admin/notifications");
    expect(l.status, JSON.stringify(l.body)).toBe(200);
  });
  it("POST /api/admin/invoices/generate reaches the handler (validation, not a gate)", async () => {
    const res = await post(chirag, "/api/admin/invoices/generate", {});
    expect(res.status, JSON.stringify(res.body)).not.toBe(403);
    expect(res.status).not.toBe(401);
  });
  it("manual bookings with the grant: list → 200, create reaches the handler", async () => {
    const l = await get(chiragMb, "/api/admin/manual-bookings");
    expect(l.status, JSON.stringify(l.body)).toBe(200);
    const c = await post(chiragMb, "/api/admin/manual-bookings", {});
    expect(c.status, JSON.stringify(c.body)).not.toBe(403);
    expect(c.status).not.toBe(401);
  });
});

describe("the module gate still decides", () => {
  it("same shape without grants → 403 from requirePermission, not the admin wall", async () => {
    for (const p of ["/api/admin/credit-notes", "/api/admin/invoices", "/api/admin/manual-bookings"]) {
      const res = await get(noGrant, p);
      expect(res.status, p).toBe(403);
      expect(isAdminWall(res), `${p}: ${JSON.stringify(res.body)}`).toBe(false);
    }
    const g = await post(noGrant, "/api/admin/invoices/generate", {});
    expect(g.status).toBe(403);
    expect(isAdminWall(g)).toBe(false);
  });
  it("Chirag (no manualBookings grant) → 403 from the module gate on manual bookings", async () => {
    const res = await get(chirag, "/api/admin/manual-bookings");
    expect(res.status).toBe(403);
    expect(isAdminWall(res)).toBe(false);
  });
});

describe("customer / vendor / tenant shapes stay refused", () => {
  const paths = ["/api/admin/credit-notes", "/api/admin/invoices", "/api/admin/notifications/unread-count"];
  it("vendor account sitting in HOUSE", async () => {
    for (const p of paths) expect((await get(vendorInHouse, p)).status, p).toBe(403);
  });
  it("customer account", async () => {
    for (const p of paths) expect((await get(customer, p)).status, p).toBe(403);
  });
  it("non-HOUSE tenant staff holding the same grants", async () => {
    for (const p of paths) expect((await get(tenantStaff, p)).status, p).toBe(403);
  });
  it("other /api/admin modules with no grant of their own stay admin-only for HOUSE staff", async () => {
    for (const p of ["/api/admin/analytics", "/api/admin/company-settings", "/api/admin/reports/summary", "/api/admin/sessions"]) {
      const res = await get(chirag, p);
      expect(res.status, `${p}: ${JSON.stringify(res.body)}`).toBe(403);
    }
  });
});

describe("Super Admin unchanged", () => {
  it("→ 200 on every route", async () => {
    for (const p of ["/api/admin/credit-notes", "/api/admin/invoices", "/api/admin/manual-bookings", "/api/admin/notifications/unread-count"]) {
      const res = await get(superAdmin, p);
      expect(res.status, `${p}: ${JSON.stringify(res.body)}`).toBe(200);
    }
  });
});

// 2026-10-13: tasks + task-automations were mounted after the broad
// /api/admin routers, so a CRM rep with the tasks grant hit the admin wall on
// the Tasks screen and on every lead/opportunity timeline fetch.
describe("tasks: the module grant decides, not the admin wall", () => {
  it("rep with tasks WRITE / OWN: list, counts, create, update → 2xx", async () => {
    const l = await get(rep, "/api/admin/tasks");
    expect(l.status, JSON.stringify(l.body)).toBe(200);
    const c = await get(rep, "/api/admin/tasks/counts");
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const linked = await get(rep, `/api/admin/tasks?linkedType=LEAD&linkedId=${oid()}&assignedTo=all&limit=50`);
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);

    const created = await post(rep, "/api/admin/tasks", { title: "Call back the lead", priority: "HIGH" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.task._id;
    const one = await get(rep, `/api/admin/tasks/${id}`);
    expect(one.status, JSON.stringify(one.body)).toBe(200);
    const upd = await patch(rep, `/api/admin/tasks/${id}`, { status: "IN_PROGRESS" });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(upd.body.task.status).toBe("IN_PROGRESS");
  });

  it("rep with WRITE cannot DELETE (needs FULL) — refused by requirePermission, not the admin wall", async () => {
    const created = await post(rep, "/api/admin/tasks", { title: "to delete" });
    const res = await del(rep, `/api/admin/tasks/${created.body.task._id}`);
    expect(res.status).toBe(403);
    expect(isAdminWall(res), JSON.stringify(res.body)).toBe(false);
    expect(res.body.message).toBe("Insufficient access level");
    // …and Super Admin still can.
    const sa = await del(superAdmin, `/api/admin/tasks/${created.body.task._id}`);
    expect(sa.status, JSON.stringify(sa.body)).toBe(200);
  });

  it("READ-only rep: can list, cannot create or update", async () => {
    expect((await get(repReader, "/api/admin/tasks")).status).toBe(200);
    const c = await post(repReader, "/api/admin/tasks", { title: "nope" });
    expect(c.status).toBe(403);
    expect(c.body.message).toBe("Insufficient access level");
    const own = await post(rep, "/api/admin/tasks", { title: "rep's" });
    const u = await patch(repReader, `/api/admin/tasks/${own.body.task._id}`, { status: "DONE" });
    expect(u.status).toBe(403);
    expect(isAdminWall(u)).toBe(false);
  });

  it("no tasks grant → 403 from requirePermission, not the admin wall", async () => {
    for (const r of [await get(noGrant, "/api/admin/tasks"), await get(chirag, "/api/admin/tasks/counts"), await post(noGrant, "/api/admin/tasks", { title: "x" })]) {
      expect(r.status).toBe(403);
      expect(isAdminWall(r), JSON.stringify(r.body)).toBe(false);
    }
  });

  it("task-automations stays admin-only (its own requireAdmin) — rep refused, Super Admin 200", async () => {
    const r = await get(rep, "/api/admin/task-automations");
    expect(isAdminWall(r), JSON.stringify(r.body)).toBe(true);
    const p = await post(rep, "/api/admin/task-automations/seed", {});
    expect(isAdminWall(p), JSON.stringify(p.body)).toBe(true);
    const sa = await get(superAdmin, "/api/admin/task-automations");
    expect(sa.status, JSON.stringify(sa.body)).toBe(200);
  });

  it("the broad admin wall still covers the admin-only modules for a rep", async () => {
    for (const p of ["/api/admin/analytics", "/api/admin/company-settings", "/api/admin/reports/summary", "/api/admin/sessions"]) {
      const res = await get(rep, p);
      expect(res.status, `${p}: ${JSON.stringify(res.body)}`).toBe(403);
    }
    expect(isAdminWall(await get(rep, "/api/admin/analytics"))).toBe(true);
  });

  it("customer / vendor shapes stay refused on tasks", async () => {
    for (const w of [customer, vendorInHouse]) expect((await get(w, "/api/admin/tasks")).status).toBe(403);
  });
});

// Same commit as the mount move: once reps reach the router, the router itself
// must scope rows — the mount had no workspace gate and GET ?assignedTo=all
// returned every task in the database to any grant holder.
describe("tasks: tenancy and row scope", () => {
  const ids = (res: request.Response) => (res.body.tasks || []).map((t: any) => String(t._id));
  let repOwn: string, assignedToRep: string, repMadeForOther: string, otherOwn: string;
  let leadRep: string, leadOther: string, onRepLead: string, onOtherLead: string;

  beforeAll(async () => {
    const mk = async (w: Who, body: any) => {
      const r = await post(w, "/api/admin/tasks", body);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return String(r.body.task._id);
    };
    leadRep = String(oid());
    leadOther = String(oid());
    await col("leads").insertMany([
      { _id: new mongoose.Types.ObjectId(leadRep), contactName: "Rep lead", assignedTo: new mongoose.Types.ObjectId(rep.id), isActive: true },
      { _id: new mongoose.Types.ObjectId(leadOther), contactName: "Other lead", assignedTo: new mongoose.Types.ObjectId(otherRep.id), isActive: true },
    ] as any);
    repOwn = await mk(rep, { title: "rep own" });
    assignedToRep = await mk(superAdmin, { title: "for rep", assignedTo: rep.id });
    repMadeForOther = await mk(rep, { title: "rep made for other", assignedTo: otherRep.id });
    otherOwn = await mk(otherRep, { title: "other own" });
    onRepLead = await mk(otherRep, { title: "other's task on rep's lead", linkedType: "LEAD", linkedId: leadRep });
    onOtherLead = await mk(otherRep, { title: "other's task on other's lead", linkedType: "LEAD", linkedId: leadOther });
  });

  it("(a) non-HOUSE user holding a tasks grant → 403 at the router (requireHouse)", async () => {
    for (const r of [
      await get(tenantRep, "/api/admin/tasks?assignedTo=all"),
      await get(tenantRep, "/api/admin/tasks/counts"),
      await post(tenantRep, "/api/admin/tasks", { title: "x" }),
      await patch(tenantRep, `/api/admin/tasks/${otherOwn}`, { status: "DONE" }),
    ]) {
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(JSON.stringify(r.body)).toMatch(/restricted to the Plumtrips workspace/);
    }
  });

  it("(b) rep asking assignedTo=all gets only own + created, never other reps' tasks", async () => {
    const r = await get(rep, "/api/admin/tasks?assignedTo=all&limit=100");
    expect(r.status).toBe(200);
    const got = ids(r);
    expect(got).toEqual(expect.arrayContaining([repOwn, assignedToRep, repMadeForOther]));
    expect(got).not.toContain(otherOwn);
    expect(got).not.toContain(onRepLead); // only via the record timeline, not the global list
    expect(got).not.toContain(onOtherLead);
    for (const t of r.body.tasks) {
      expect([String(t.assignedTo?._id), String(t.createdBy?._id)]).toContain(rep.id);
    }
    // a specific other assignee is ignored for non-FULL, as before
    const s = await get(rep, `/api/admin/tasks?assignedTo=${otherRep.id}&limit=100`);
    expect(ids(s)).not.toContain(otherOwn);
  });

  it("(b) /counts stays scoped to the caller", async () => {
    const r = await get(rep, "/api/admin/tasks/counts");
    expect(r.status).toBe(200);
    const mineOpen = await col("tasks").countDocuments({ isActive: true, assignedTo: new mongoose.Types.ObjectId(rep.id), status: { $in: ["OPEN", "IN_PROGRESS"] } });
    const allOpen = await col("tasks").countDocuments({ isActive: true, status: { $in: ["OPEN", "IN_PROGRESS"] } });
    expect(r.body.myOpen).toBe(mineOpen);
    expect(r.body.myOpen).toBeLessThan(allOpen);
    expect(r.body.unassigned).toBeUndefined();
  });

  it("(c) rep PATCHing another rep's task → 403; own / assigned / created → 200", async () => {
    for (const t of [otherOwn, onRepLead, onOtherLead]) {
      const r = await patch(rep, `/api/admin/tasks/${t}`, { status: "DONE" });
      expect(r.status, `${t}: ${JSON.stringify(r.body)}`).toBe(403);
    }
    expect((await col("tasks").findOne({ _id: new mongoose.Types.ObjectId(otherOwn) }))!.status).toBe("OPEN");
    for (const t of [repOwn, assignedToRep, repMadeForOther]) {
      const r = await patch(rep, `/api/admin/tasks/${t}`, { priority: "LOW" });
      expect(r.status, `${t}: ${JSON.stringify(r.body)}`).toBe(200);
    }
    // existing reassignment rule kept: assignee-but-not-creator cannot reassign
    const re = await patch(rep, `/api/admin/tasks/${assignedToRep}`, { assignedTo: otherRep.id });
    expect(re.status).toBe(403);
    expect(re.body.error).toMatch(/creator or a FULL-access user/);
  });

  it("(d) FULL caller still sees and edits every task within HOUSE", async () => {
    for (const w of [houseFull, superAdmin]) {
      const r = await get(w, "/api/admin/tasks?assignedTo=all&limit=100");
      expect(r.status).toBe(200);
      expect(ids(r)).toEqual(expect.arrayContaining([repOwn, otherOwn, onRepLead, onOtherLead, repMadeForOther]));
      const p = await patch(w, `/api/admin/tasks/${otherOwn}`, { priority: "HIGH" });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
    }
    const one = await get(houseFull, `/api/admin/tasks/${onOtherLead}`);
    expect(one.status).toBe(200);
  });

  it("(e) timeline returns every task on a record the caller can open, and nothing else", async () => {
    const r = await get(rep, `/api/admin/tasks?linkedType=LEAD&linkedId=${leadRep}&assignedTo=all&limit=50`);
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual([onRepLead]); // another rep's task on MY lead is on the timeline
    // a lead the rep cannot open: no one else's tasks leak (own/created only, none here)
    const o = await get(rep, `/api/admin/tasks?linkedType=LEAD&linkedId=${leadOther}&assignedTo=all&limit=50`);
    expect(o.status).toBe(200);
    expect(ids(o)).toEqual([]);
    // the owner of that lead does see it
    const own = await get(otherRep, `/api/admin/tasks?linkedType=LEAD&linkedId=${leadOther}&assignedTo=all&limit=50`);
    expect(ids(own)).toEqual([onOtherLead]);
    // the record view needs the CRM grant: a tasks-only READ rep sees no one else's
    const rd = await get(repReader, `/api/admin/tasks?linkedType=LEAD&linkedId=${leadRep}&assignedTo=all&limit=50`);
    expect(ids(rd)).toEqual([]);
  });
});

// requireAdmin alone admitted a tenant admin from another workspace to the
// SYSTEM task automations — they could switch Plumtrips' lead.next_followup off.
describe("task-automations: HOUSE admins only", () => {
  it("non-HOUSE admins are refused on GET and /seed; nothing is written", async () => {
    for (const w of [tenantAdmin, tenantPlainAdmin]) {
      for (const r of [await get(w, "/api/admin/task-automations"), await post(w, "/api/admin/task-automations/seed", {})]) {
        expect(r.status, JSON.stringify(r.body)).toBe(403);
        expect(JSON.stringify(r.body)).toMatch(/restricted to the Plumtrips workspace/);
      }
    }
    expect(await col("taskautomations").countDocuments({})).toBe(0);
  });

  it("HOUSE admin and Super Admin → 200 on GET and /seed", async () => {
    for (const w of [houseAdmin, superAdmin]) {
      const g = await get(w, "/api/admin/task-automations");
      expect(g.status, JSON.stringify(g.body)).toBe(200);
      const sd = await post(w, "/api/admin/task-automations/seed", {});
      expect(sd.status, JSON.stringify(sd.body)).toBe(200);
      expect(sd.body.count).toBeGreaterThan(0);
    }
  });
});
