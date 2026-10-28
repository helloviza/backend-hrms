// apps/backend/src/server.platformAdminGates.test.ts
//
// 2026-10-28: requireAdmin and ~25 inline admin checks admitted a role NAME
// (ADMIN, HR, TENANT_ADMIN, WORKSPACE_ADMIN …) with no check that the caller is
// Plumtrips (HOUSE) staff, so a customer company's own admin reached platform
// routes: all-company reports and exports, session logs, TBO account, orphan
// refunds, other companies' users / allowlists / travel flow. And a tenant
// admin could hand itself SUPERADMIN through the employee / staff create
// routes. See docs/audits/admin-gates-classification.md.
//
// Same harness as server.adminMount.test.ts: the REAL app (server.ts, real
// middleware order) with REAL login tokens. Only Mongo is in-memory.
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
  JWT_SECRET: "test-jwt-secret-platform-gates",
  JWT_REFRESH_SECRET: "test-jwt-refresh-secret-platform-gates",
  FRONTEND_ORIGIN: "http://localhost:5173",
  AWS_REGION: "ap-south-1",
  S3_BUCKET: "test-bucket",
  GEMINI_API_KEY: "test",
  OPENAI_API_KEY: "test",
  CONSUMER_JWT_SECRET: "test-consumer-jwt-secret-platform-gates",
});

// No egress (server.ts import warms caches over the network).
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return realFetch(input, init);
  throw new Error(`egress blocked in test: ${url}`);
}) as typeof fetch;

const HOUSE = "69679a7628330a58d29f2254";
const TENANT = String(new mongoose.Types.ObjectId());
const OTHER = String(new mongoose.Types.ObjectId());
const HOUSE_CUST = String(new mongoose.Types.ObjectId());
const TENANT_CUST = String(new mongoose.Types.ObjectId());
const OTHER_CUST = String(new mongoose.Types.ObjectId());
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
  grants?: Record<string, string> | null;
  domain?: string;
}): Promise<Who> {
  const id = oid();
  const email = `p${++seq}-${id}@${opts.domain ?? "example.com"}`;
  await col("users").insertOne({
    _id: id,
    email,
    name: `Person ${seq}`,
    firstName: "Person",
    roles: opts.roles,
    status: "ACTIVE",
    passwordHash: await bcrypt.hash(PASSWORD, 4),
    ...(opts.workspaceId ? { workspaceId: new mongoose.Types.ObjectId(opts.workspaceId) } : {}),
    ...(opts.customerId ? { customerId: opts.customerId } : {}),
  } as any);
  if (opts.grants !== null) {
    const modules: any = {};
    for (const [k, v] of Object.entries(opts.grants || {})) modules[k] = { access: v, scope: "ALL" };
    await UserPermission.create({
      userId: String(id), email, workspaceId: opts.workspaceId || "global", universe: "STAFF",
      level: { code: "L6", name: "Admin" }, modules, grantedBy: "test",
    } as any);
  }
  const res = await request(app).post("/api/auth/login").send({ email, password: PASSWORD });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return { email, token: res.body.accessToken, id: String(id) };
}

const as = (w: Who, r: request.Test) => r.set("Authorization", `Bearer ${w.token}`);
const get = (w: Who, p: string) => as(w, request(app).get(p));
const post = (w: Who, p: string, body: unknown = {}) => as(w, request(app).post(p).send(body as any));
const patch = (w: Who, p: string, body: unknown = {}) => as(w, request(app).patch(p).send(body as any));
const put = (w: Who, p: string, body: unknown = {}) => as(w, request(app).put(p).send(body as any));

const ALL_FEATURES = {
  sbtEnabled: true, flightBookingEnabled: true, hotelBookingEnabled: true, invoicesEnabled: true, payrollEnabled: true,
};
const GRANTS = { companySettings: "FULL", reports: "FULL", invoices: "FULL", creditnotes: "FULL", onboarding: "FULL" };

// HOUSE side
let houseAdmin: Who, superAdmin: Who;
// Customer company "Tenant Co": its owner (TENANT_ADMIN + WORKSPACE_LEADER, as
// /api/signup creates it), a plain ADMIN inside it, and a WORKSPACE_ADMIN.
let tenantAdmin: Who, tenantPlainAdmin: Who, tenantHr: Who;
let customer: Who, tenantMember: Who;
let otherUserId: string;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  ({ default: app } = await import("./server.js"));
  ({ UserPermission } = await import("./models/UserPermission.js"));
  await mongoose.connect(mongod.getUri());

  await col("customerworkspaces").insertMany([
    { _id: new mongoose.Types.ObjectId(HOUSE), customerId: HOUSE_CUST, companyName: "Plumtrips", status: "ACTIVE", config: { features: {} } },
    { _id: new mongoose.Types.ObjectId(TENANT), customerId: TENANT_CUST, companyName: "Tenant Co", status: "ACTIVE",
      config: { features: ALL_FEATURES } },
    { _id: new mongoose.Types.ObjectId(OTHER), customerId: OTHER_CUST, companyName: "Other Co", status: "ACTIVE",
      travelFlow: "SBT", config: { features: ALL_FEATURES, travelFlow: "SBT" } },
  ] as any);

  houseAdmin = await person({ roles: ["ADMIN"], workspaceId: HOUSE, grants: GRANTS, domain: "plumtrips.com" });
  superAdmin = await person({ roles: ["SUPERADMIN"], workspaceId: HOUSE, grants: {}, domain: "plumtrips.com" });
  tenantAdmin = await person({ roles: ["TENANT_ADMIN", "WORKSPACE_LEADER"], workspaceId: TENANT, grants: GRANTS });
  tenantPlainAdmin = await person({ roles: ["ADMIN"], workspaceId: TENANT, grants: GRANTS });
  tenantHr = await person({ roles: ["HR"], workspaceId: TENANT, grants: GRANTS });
  customer = await person({ roles: ["CUSTOMER"], customerId: TENANT_CUST, grants: null });
  tenantMember = await person({ roles: ["EMPLOYEE"], workspaceId: TENANT, grants: {} });

  otherUserId = String(oid());
  await col("users").insertOne({
    _id: new mongoose.Types.ObjectId(otherUserId), email: "someone@other.example", name: "Other Person",
    roles: ["EMPLOYEE"], workspaceId: new mongoose.Types.ObjectId(OTHER), customerId: OTHER_CUST,
    passwordHash: "x", sbtEnabled: false,
  } as any);
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

const refusedAsTenant = (res: request.Response, label: string) => {
  expect([403, 404], `${label}: ${res.status} ${JSON.stringify(res.body)}`).toContain(res.status);
};

/* ── PLATFORM route groups: customer-company admins refused, HOUSE admin through ── */

const PLATFORM_GETS: Array<[string, string]> = [
  ["session logs", "/api/admin/sessions"],
  ["suspicious sessions", "/api/admin/sessions/suspicious"],
  ["payment orphans", "/api/admin/payment-orphans"],
  ["admin analytics", "/api/admin/analytics"],
  ["company settings", "/api/admin/company-settings"],
  ["all-company reports", "/api/admin/reports/summary"],
  ["report schedules", "/api/admin/reports/schedules"],
  ["vendors CSV", "/api/admin/reports/vendors.csv"],
  ["leaves CSV", "/api/admin/reports/leaves.csv"],
  ["attendance CSV", "/api/admin/reports/attendance.csv"],
  ["SBT platform config", "/api/admin/sbt/config"],
  ["SBT offers", "/api/admin/sbt/offers"],
  ["TBO token status", "/api/sbt/flights/token/status"],
  ["orphaned flight bookings", "/api/sbt/flights/bookings/orphaned"],
  ["hotel date-change requests", "/api/sbt/hotels/admin/date-change-requests"],
  ["every company's allowlists", "/api/customer/users/workspace/allowlists"],
];

describe("PLATFORM GET routes", () => {
  for (const [label, path] of PLATFORM_GETS) {
    it(`${label}: tenant admins refused, HOUSE admin and Super Admin through`, async () => {
      for (const w of [tenantAdmin, tenantPlainAdmin, tenantHr]) refusedAsTenant(await get(w, path), `${label} as tenant`);
      const h = await get(houseAdmin, path);
      expect(h.status, `${label} as HOUSE: ${JSON.stringify(h.body).slice(0, 300)}`).toBe(200);
      const s = await get(superAdmin, path);
      expect(s.status, `${label} as SA: ${JSON.stringify(s.body).slice(0, 300)}`).toBe(200);
    });
  }
});

describe("PLATFORM write routes", () => {
  it("POST /api/sbt/flights/bookings/refund-orphaned (Razorpay refunds): tenant refused, HOUSE reaches the handler", async () => {
    for (const w of [tenantAdmin, tenantPlainAdmin]) refusedAsTenant(await post(w, "/api/sbt/flights/bookings/refund-orphaned", {}), "refund as tenant");
    const h = await post(houseAdmin, "/api/sbt/flights/bookings/refund-orphaned", {});
    expect(h.status, JSON.stringify(h.body)).not.toBe(403);
  });

  it("POST /api/sbt/hotels/bookings/refund-orphaned: tenant refused, HOUSE reaches the handler", async () => {
    refusedAsTenant(await post(tenantPlainAdmin, "/api/sbt/hotels/bookings/refund-orphaned", {}), "hotel refund");
    const h = await post(houseAdmin, "/api/sbt/hotels/bookings/refund-orphaned", {});
    expect(h.status, JSON.stringify(h.body)).not.toBe(403);
  });

  it("POST /api/sbt/flights/token/clear (Plumtrips' TBO session): tenant refused, HOUSE 200", async () => {
    refusedAsTenant(await post(tenantAdmin, "/api/sbt/flights/token/clear"), "token clear");
    expect((await post(houseAdmin, "/api/sbt/flights/token/clear")).status).toBe(200);
  });

  it("PATCH /api/customers/:id (any company's record): tenant refused, HOUSE reaches the handler", async () => {
    const custId = oid();
    await col("customers").insertOne({ _id: custId, name: "Victim Co", email: "victim@other.example", workspaceId: new mongoose.Types.ObjectId(OTHER) } as any);
    for (const w of [tenantAdmin, tenantPlainAdmin, tenantHr]) {
      refusedAsTenant(await patch(w, `/api/customers/${custId}`, { name: "Hijacked" }), "customer patch");
    }
    const after: any = await col("customers").findOne({ _id: custId });
    expect(after.name).toBe("Victim Co");
    const h = await patch(houseAdmin, `/api/customers/${custId}`, { name: "Renamed by ops" });
    expect(h.status, JSON.stringify(h.body)).not.toBe(403);
  });

  it("POST /api/leaves/admin/run-accrual (every workspace): tenant ADMIN refused, HOUSE 200", async () => {
    refusedAsTenant(await post(tenantPlainAdmin, "/api/leaves/admin/run-accrual"), "accrual");
    expect((await post(houseAdmin, "/api/leaves/admin/run-accrual")).status).toBe(200);
  });

  it("PATCH /api/v1/workspace/config/travel-flow for another company: tenant ADMIN refused, HOUSE through", async () => {
    refusedAsTenant(await patch(tenantPlainAdmin, "/api/v1/workspace/config/travel-flow", { travelFlow: "APPROVAL_FLOW", customerId: OTHER_CUST }), "travel flow");
    const ws: any = await col("customerworkspaces").findOne({ _id: new mongoose.Types.ObjectId(OTHER) });
    expect(ws.config.travelFlow).toBe("SBT");
    const h = await patch(houseAdmin, "/api/v1/workspace/config/travel-flow", { travelFlow: "SBT", customerId: OTHER_CUST });
    expect(h.status, JSON.stringify(h.body)).toBe(200);
  });

  it("PATCH /api/users/admin/users/:id/sbt on another company's user: tenant ADMIN refused, HOUSE 200", async () => {
    refusedAsTenant(await patch(tenantPlainAdmin, `/api/users/admin/users/${otherUserId}/sbt`, { sbtEnabled: true }), "sbt toggle");
    expect(((await col("users").findOne({ _id: new mongoose.Types.ObjectId(otherUserId) })) as any).sbtEnabled).toBe(false);
    const h = await patch(houseAdmin, `/api/users/admin/users/${otherUserId}/sbt`, { sbtEnabled: false });
    expect(h.status, JSON.stringify(h.body)).toBe(200);
  });

  it("customer/users: a tenant ADMIN cannot list another company's members via ?customerId=", async () => {
    const res = await get(tenantPlainAdmin, `/api/customer/users?customerId=${OTHER_CUST}`);
    const emails = JSON.stringify(res.body);
    expect(emails).not.toContain("someone@other.example");
    const h = await get(houseAdmin, `/api/customer/users?customerId=${OTHER_CUST}`);
    expect(h.status, JSON.stringify(h.body)).not.toBe(403);
  });

  it("promote-vendor / promote-customer: tenant ADMIN refused before any lookup", async () => {
    for (const p of ["promote-vendor", "promote-customer"]) {
      const res = await post(tenantPlainAdmin, `/api/master-data/${oid()}/${p}`, {});
      expect(res.status, `${p}: ${JSON.stringify(res.body)}`).toBe(403);
    }
  });

  it("GET /api/vendors/:id (any vendor, unscoped): customer and tenant refused, HOUSE reaches it", async () => {
    const vid = oid();
    await col("vendors").insertOne({ _id: vid, name: "Some Vendor", email: "v@vendor.example" } as any);
    refusedAsTenant(await get(customer, `/api/vendors/${vid}`), "vendor read as customer");
    refusedAsTenant(await get(tenantPlainAdmin, `/api/vendors/${vid}`), "vendor read as tenant admin");
    expect((await get(houseAdmin, `/api/vendors/${vid}`)).status).toBe(200);
  });
});

/* ── Role minting: a customer company's admin cannot create Plumtrips roles ── */

describe("role assignment", () => {
  it("POST /api/users/create-staff with SUPERADMIN → 403; EMPLOYEE → 201", async () => {
    const bad = await post(tenantPlainAdmin, "/api/users/create-staff", { name: "X", email: `x${oid()}@tenant.example`, password: "secret123", role: "SUPERADMIN" });
    expect(bad.status, JSON.stringify(bad.body)).toBe(403);
    const ok = await post(tenantPlainAdmin, "/api/users/create-staff", { name: "Y", email: `y${oid()}@tenant.example`, password: "secret123", role: "EMPLOYEE" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("POST /api/users/admin/grant-access with role SUPERADMIN on itself → 403, roles untouched", async () => {
    const res = await post(tenantPlainAdmin, "/api/users/admin/grant-access", { userId: tenantPlainAdmin.id, role: "SUPERADMIN" });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    const me: any = await col("users").findOne({ _id: new mongoose.Types.ObjectId(tenantPlainAdmin.id) });
    expect(me.roles).toEqual(["ADMIN"]);
  });

  it("POST /api/employees with roles [SUPERADMIN] → 403, no user created", async () => {
    const email = `mint${oid()}@tenant.example`;
    const res = await post(tenantAdmin, "/api/employees", { officialEmail: email, firstName: "Mint", roles: ["SUPERADMIN"] });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await col("users").findOne({ email })).toBeNull();
  });

  it("PUT /api/employees/:id cannot move a user into HOUSE or set hrmsAccessRole SUPERADMIN", async () => {
    const uid = oid();
    await col("users").insertOne({ _id: uid, email: `emp${uid}@tenant.example`, name: "Emp", roles: ["EMPLOYEE"],
      workspaceId: new mongoose.Types.ObjectId(TENANT), passwordHash: "x" } as any);
    const move = await put(tenantAdmin, `/api/employees/${uid}`, { workspaceId: HOUSE, customerId: HOUSE_CUST });
    expect(move.status, JSON.stringify(move.body)).toBe(200);
    const after: any = await col("users").findOne({ _id: uid });
    expect(String(after.workspaceId)).toBe(TENANT);
    expect(after.customerId).toBeUndefined();
    const sa = await put(tenantAdmin, `/api/employees/${uid}`, { hrmsAccessRole: "SUPERADMIN" });
    expect(sa.status, JSON.stringify(sa.body)).toBe(403);
    expect(((await col("users").findOne({ _id: uid })) as any).roles).toEqual(["EMPLOYEE"]);
    // a tenant role is still fine
    const mgr = await put(tenantAdmin, `/api/employees/${uid}`, { hrmsAccessRole: "MANAGER" });
    expect(mgr.status, JSON.stringify(mgr.body)).toBe(200);
  });

  it("HOUSE admin is unchanged: create-staff with ADMIN → 201", async () => {
    const res = await post(houseAdmin, "/api/users/create-staff", { name: "Ops", email: `ops${oid()}@plumtrips.com`, password: "secret123", role: "ADMIN" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  });
});

/* ── TENANT routes keep working, and stay inside the caller's workspace ── */

describe("TENANT routes", () => {
  it("leave calendar shows only the caller's own workspace", async () => {
    const mine = oid(), theirs = oid();
    const base = { status: "APPROVED", type: "CL", from: new Date("2026-03-10"), to: new Date("2026-03-11"), days: 2, reason: "x" };
    await col("leaverequests").insertMany([
      { ...base, _id: mine, workspaceId: new mongoose.Types.ObjectId(TENANT), userId: new mongoose.Types.ObjectId(tenantHr.id) },
      { ...base, _id: theirs, workspaceId: new mongoose.Types.ObjectId(OTHER), userId: new mongoose.Types.ObjectId(otherUserId) },
    ] as any);
    const res = await get(tenantHr, "/api/leaves/calendar?month=2026-03");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(String(theirs));
    expect(body).not.toContain("someone@other.example");
  });

  it("hr policy written by a tenant admin with another company's customerId lands on its own company", async () => {
    const res = await post(tenantAdmin, "/api/hr/policies", { title: "Leave rules", url: "https://example.com/p", scope: "GLOBAL", customerId: OTHER_CUST });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    const doc: any = await col("policies").findOne({ title: "Leave rules" });
    expect(doc.customerId).toBe(TENANT_CUST);
    expect(doc.scope).not.toBe("GLOBAL");
  });

  it("leave balance adjust refuses a user from another workspace", async () => {
    const res = await post(tenantPlainAdmin, "/api/leaves/admin/adjust", {
      adjustments: [{ userId: otherUserId, leaveType: "CL", days: 5, reason: "plant" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(500);
    expect(JSON.stringify(res.body.failed)).toContain(otherUserId);
    const planted = await col("leavebalances").findOne({
      userId: { $in: [otherUserId, new mongoose.Types.ObjectId(otherUserId)] },
      workspaceId: { $in: [TENANT, new mongoose.Types.ObjectId(TENANT)] },
    });
    expect(planted).toBeNull();
  });

  it("tenant admin keeps its own-workspace pages: customers list, notifications, HR dashboard, holidays", async () => {
    expect((await get(tenantPlainAdmin, "/api/customers")).status).toBe(200);
    expect((await get(tenantPlainAdmin, "/api/admin/notifications/unread-count")).status).toBe(200);
    expect((await get(tenantAdmin, "/api/dashboard/hr-admin")).status).toBe(200);
    const h = await post(tenantAdmin, "/api/holidays", { name: "Founders Day", date: "2026-12-01" });
    expect(h.status, JSON.stringify(h.body)).toBeLessThan(300);
  });
});

/* ── Helper-level checks ── */

/* ── 2026-10-29 follow-ups: salary list, master-data list, business services ── */

describe("GET /api/payroll/salary/structures (everyone's CTC)", () => {
  it("an ordinary member → 403; tenant HR → 200 with its own workspace only", async () => {
    await col("salarystructures").insertOne({
      workspaceId: new mongoose.Types.ObjectId(OTHER), userId: new mongoose.Types.ObjectId(otherUserId),
      isActive: true, ctcAnnual: 9_999_999, effectiveFrom: new Date(),
    } as any);
    const m = await get(tenantMember, "/api/payroll/salary/structures");
    expect(m.status, JSON.stringify(m.body)).toBe(403);
    const hr = await get(tenantHr, "/api/payroll/salary/structures");
    expect(hr.status, JSON.stringify(hr.body)).toBe(200);
    const body = JSON.stringify(hr.body);
    expect(body).not.toContain("someone@other.example");
    expect(body).not.toContain("9999999");
    expect(body).toContain(tenantMember.email);
  });
});

describe("GET /api/master-data", () => {
  it("needs the grant; never returns onboarding tokens; own workspace only", async () => {
    const mine = oid(), theirs = oid();
    await col("onboardings").insertMany([
      { _id: mine, token: "secret-invite-token-mine", workspaceId: new mongoose.Types.ObjectId(TENANT), type: "vendor",
        status: "approved", email: "vendor@mine.example", name: "Mine Vendor", updatedAt: new Date() },
      { _id: theirs, token: "secret-invite-token-theirs", workspaceId: new mongoose.Types.ObjectId(OTHER), type: "vendor",
        status: "approved", email: "vendor@theirs.example", name: "Their Vendor", updatedAt: new Date() },
    ] as any);
    expect((await get(tenantMember, "/api/master-data")).status).toBe(403);
    expect((await get(customer, "/api/master-data")).status).toBe(403);
    const res = await get(tenantHr, "/api/master-data?type=All&status=All");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain(String(mine));
    expect(body).not.toContain(String(theirs));
    expect(body).not.toContain("secret-invite-token");
    expect(res.body.items.every((i: any) => !("token" in i))).toBe(true);
    const h = await get(houseAdmin, "/api/master-data");
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    expect(JSON.stringify(h.body)).not.toContain("secret-invite-token");
  });

  it("business services saved under the old token key are still found by the onboarding id", async () => {
    const ob = oid();
    await col("onboardings").insertOne({ _id: ob, token: "legacy-biz-token", workspaceId: new mongoose.Types.ObjectId(HOUSE),
      type: "business", status: "approved", email: "biz@legacy.example" } as any);
    await col("servicecapabilities").insertOne({ ownerType: "BUSINESS", ownerId: "legacy-biz-token", kind: "FLIGHT", enabled: true } as any);
    const g = await get(houseAdmin, `/api/business-services/${ob}`);
    expect(g.status).toBe(200);
    expect(g.body.items.map((i: any) => i.kind)).toEqual(["FLIGHT"]);
    const p = await post(houseAdmin, `/api/business-services/${ob}`, { kind: "FLIGHT", enabled: false });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(await col("servicecapabilities").countDocuments({ ownerType: "BUSINESS", kind: "FLIGHT" })).toBe(1);
  });
});

describe("inline helpers", () => {
  it("approvals.security isStaffAdmin: HOUSE ADMIN yes, customer-workspace ADMIN no, Super Admin yes", async () => {
    const { isStaffAdmin } = await import("./routes/approvals.security.js");
    expect(isStaffAdmin({ roles: ["ADMIN"], workspaceId: HOUSE })).toBe(true);
    expect(isStaffAdmin({ roles: ["ADMIN"], workspaceId: TENANT })).toBe(false);
    expect(isStaffAdmin({ roles: ["OPS"], customerId: TENANT_CUST })).toBe(false);
    expect(isStaffAdmin({ roles: ["SUPERADMIN"] })).toBe(true);
    expect(isStaffAdmin({ roles: ["SUPERADMIN"], _demoImpersonation: true })).toBe(false);
  });

  it("customerUsers isStaffPrivileged: role names alone no longer make a customer admin staff", async () => {
    const { isStaffPrivileged } = await import("./routes/customerUsers.js");
    expect(isStaffPrivileged({ roles: ["ADMIN"], workspaceId: TENANT })).toBe(false);
    expect(isStaffPrivileged({ roles: ["HR"], workspaceId: TENANT })).toBe(false);
    expect(isStaffPrivileged({ roles: ["ADMIN"], workspaceId: HOUSE })).toBe(true);
    expect(isStaffPrivileged({ roles: ["EMPLOYEE"], workspaceId: HOUSE })).toBe(true);
    expect(isStaffPrivileged({ roles: ["ADMIN"], email: "old@plumtrips.com" })).toBe(true); // legacy HOUSE login, no workspace
    expect(isStaffPrivileged({ roles: ["SUPERADMIN"] })).toBe(true);
  });
});
