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

type Who = { email: string; token: string };
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
  return { email, token: res.body.accessToken };
}

const as = (w: Who, r: request.Test) => r.set("Authorization", `Bearer ${w.token}`);
const get = (w: Who, p: string) => as(w, request(app).get(p));
const post = (w: Who, p: string, body: unknown = {}) => as(w, request(app).post(p).send(body as any));
const isAdminWall = (res: request.Response) =>
  res.status === 403 && /Admin access required/.test(JSON.stringify(res.body));

const CHIRAG_GRANTS = { invoices: "FULL", creditnotes: "FULL" };
let chirag: Who, chiragMb: Who, noGrant: Who, vendorInHouse: Who, customer: Who, tenantStaff: Who, superAdmin: Who;

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
    for (const p of ["/api/admin/analytics", "/api/admin/company-settings", "/api/admin/reports/summary", "/api/admin/sessions", "/api/admin/tasks"]) {
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
