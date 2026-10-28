// apps/backend/src/routes/invoices.byIdTenantScope.test.ts
//
// Invoices — the tenant gate on every single-invoice and bulk-by-id route, and
// on generation. Same rule as the invoice list (invoiceTenantClause): Super
// Admin and Plumtrips (HOUSE) staff act on every workspace; a tenant user only
// on its own workspace's invoices (CustomerWorkspace._id or legacy Customer._id
// space). Another workspace's invoice answers exactly like a missing one — 404
// — and is never touched.
//
// 2026-10-29: a tenant (customer-company) admin is READ-ONLY on this console.
// Every write — generate / bulk-generate (Plumtrips invoice series), edit,
// status, cancel, reverts, bulk marks, PDF — and document-settings are
// Plumtrips staff only (403); see docs/audits/admin-gates-classification.md.
//
// Real: invoices router, requireBillingStaff, requirePermission, models,
//   in-memory Mongo REPLICA SET (PATCH runs in a transaction).
// Stubbed: requireAuth (x-test-user), the workspace resolver (x-test-ws /
//   x-test-cust — as requireWorkspace sets them), the PDF renderer.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../utils/invoicePdf.js", () => ({
  generateInvoicePdf: vi.fn(async () => Buffer.from("%PDF")),
  prefetchInvoiceAssets: vi.fn(async () => ({})),
}));

const { default: invoicesRouter } = await import("./invoices.js");
const { UserPermission } = await import("../models/UserPermission.js");

const oid = (s?: string) => new mongoose.Types.ObjectId(s);
const col = (n: string) => mongoose.connection.db!.collection(n);

const HOUSE = "69679a7628330a58d29f2254";
const WS_A = oid(); const CUST_A = oid();
const WS_B = oid(); const CUST_B = oid();
// one invoice per route-state we need, per tenant
const A = { draft: oid(), sent: oid(), paid: oid(), legacy: oid() };
const B = { draft: oid(), sent: oid(), paid: oid() };
const BOOK_A = oid(); const BOOK_B = oid();

const withWs = (req: any, _res: any, next: any) => {
  const ws = String(req.headers["x-test-ws"] || "");
  const cust = String(req.headers["x-test-cust"] || "");
  req.workspaceObjectId = ws ? oid(ws) : undefined;
  req.workspace = cust ? { customerId: cust } : undefined;
  next();
};
const app = express();
app.use(express.json());
app.use("/api/admin/invoices", withWs, invoicesRouter);

type Who = { user: Record<string, unknown>; ws: string; cust?: string };
const call = (who: Who, r: request.Test) => {
  r.set("x-test-user", JSON.stringify(who.user)).set("x-test-ws", who.ws);
  if (who.cust) r.set("x-test-cust", who.cust);
  return r;
};
async function person(roles: string[], ws: string, grants: Record<string, string>, cust?: string): Promise<Who> {
  const id = oid();
  await col("users").insertOne({ _id: id, email: `${id}@t.local`, roles, workspaceId: ws } as any);
  if (Object.keys(grants).length) {
    const modules: any = {};
    for (const [k, v] of Object.entries(grants)) modules[k] = { access: v, scope: "ALL" };
    await UserPermission.create({
      userId: String(id), email: `${id}@t.local`, workspaceId: ws || "global", universe: "STAFF",
      level: { code: "L1", name: "Employee" }, modules, grantedBy: "test",
    } as any);
  }
  return { user: { _id: String(id), id: String(id), sub: String(id), roles, workspaceId: ws }, ws, cust };
}

const inv = (_id: mongoose.Types.ObjectId, workspaceId: mongoose.Types.ObjectId, status: string, no: string) => ({
  _id, invoiceNo: no, workspaceId, status, bookingIds: [], lineItems: [], grandTotal: 1000, subtotal: 1000,
  totalGST: 0, supplyType: "IGST", issuerDetails: {}, clientDetails: { companyName: no }, editHistory: [],
  invoiceDate: new Date(), generatedAt: new Date(), ...(status === "PAID" ? { paidAt: new Date() } : {}),
  ...(status === "SENT" ? { sentAt: new Date() } : {}),
});
const booking = (_id: mongoose.Types.ObjectId, workspaceId: mongoose.Types.ObjectId) => ({
  _id, workspaceId, bookingRef: `BK-${_id}`, status: "CONFIRMED", type: "FLIGHT",
  pricing: { actualPrice: 900, quotedPrice: 1000, grandTotal: 1000 }, createdAt: new Date(),
});
const statusOf = async (id: mongoose.Types.ObjectId) => (await col("invoices").findOne({ _id: id }))!.status;

let replSet: MongoMemoryReplSet;
let sa: Who;
let tenantA: Who;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri("invoices-byid-tenant-scope-test"));
}, 180_000);
afterAll(async () => { await mongoose.disconnect(); await replSet?.stop(); });

beforeEach(async () => {
  for (const c of ["invoices", "manualbookings", "users", "userpermissions", "customerworkspaces", "customers", "counters", "creditnotes"]) {
    await col(c).deleteMany({});
  }
  await col("customerworkspaces").insertMany([
    { _id: WS_A, customerId: String(CUST_A), companyName: "Tenant A" },
    { _id: WS_B, customerId: String(CUST_B), companyName: "Tenant B" },
  ] as any[]);
  await col("invoices").insertMany([
    inv(A.draft, WS_A, "DRAFT", "A-DRAFT"), inv(A.sent, WS_A, "SENT", "A-SENT"), inv(A.paid, WS_A, "PAID", "A-PAID"),
    inv(A.legacy, CUST_A, "SENT", "A-LEGACY"),
    inv(B.draft, WS_B, "DRAFT", "B-DRAFT"), inv(B.sent, WS_B, "SENT", "B-SENT"), inv(B.paid, WS_B, "PAID", "B-PAID"),
  ] as any[]);
  await col("manualbookings").insertMany([booking(BOOK_A, CUST_A), booking(BOOK_B, CUST_B)] as any[]);
  sa = await person(["SUPERADMIN"], HOUSE, {});
  tenantA = await person(["TENANT_ADMIN"], String(WS_A), { invoices: "FULL" }, String(CUST_A));
});

const writeRoutes: Array<[string, (id: string) => (w: Who) => request.Test, keyof typeof B]> = [
    ["POST /:id/pdf", (id) => (w) => call(w, request(app).post(`/api/admin/invoices/${id}/pdf`)), "sent"],
    ["PATCH /:id", (id) => (w) => call(w, request(app).patch(`/api/admin/invoices/${id}`)).send({ notes: "hijack" }), "draft"],
    ["POST /:id/cancel", (id) => (w) => call(w, request(app).post(`/api/admin/invoices/${id}/cancel`)).send({ reason: "x" }), "sent"],
    ["PUT /:id/status", (id) => (w) => call(w, request(app).put(`/api/admin/invoices/${id}/status`)).send({ status: "PAID", paidAt: new Date().toISOString() }), "sent"],
    ["POST /:id/revert-to-sent", (id) => (w) => call(w, request(app).post(`/api/admin/invoices/${id}/revert-to-sent`)).send({ reason: "x" }), "paid"],
    ["POST /:id/revert-to-draft", (id) => (w) => call(w, request(app).post(`/api/admin/invoices/${id}/revert-to-draft`)).send({ reason: "x" }), "sent"],
    ["POST /:id/add-bookings", (id) => (w) => call(w, request(app).post(`/api/admin/invoices/${id}/add-bookings`)).send({ bookingIds: [String(BOOK_B)] }), "draft"],
];

describe("tenant admin (FULL): another workspace's invoice is 404 on every by-id read", () => {
  const reads: Array<[string, (id: string) => (w: Who) => request.Test, keyof typeof B]> = [
    ["GET /:id", (id) => (w) => call(w, request(app).get(`/api/admin/invoices/${id}`)), "sent"],
    ["GET /:id/eligible-bookings", (id) => (w) => call(w, request(app).get(`/api/admin/invoices/${id}/eligible-bookings`)), "draft"],
  ];

  it.each(reads)("%s → 404", async (_name, make, state) => {
    expect((await make(String(B[state]))(tenantA)).status).toBe(404);
  });
});

describe("tenant admin (FULL) is read-only: every write is 403 and touches nothing", () => {
  it.each(writeRoutes)("%s on ANOTHER workspace's invoice → 403, untouched", async (_name, make, state) => {
    const id = B[state];
    const before = await col("invoices").findOne({ _id: id });
    const r = await make(String(id))(tenantA);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(await col("invoices").findOne({ _id: id })).toEqual(before);
    expect((await col("manualbookings").findOne({ _id: BOOK_B }))!.invoiceId).toBeUndefined();
  });

  it.each(writeRoutes)("%s on its OWN invoice → 403, untouched", async (_name, make, state) => {
    const id = A[state as keyof typeof A];
    const before = await col("invoices").findOne({ _id: id });
    const r = await make(String(id))(tenantA);
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(await col("invoices").findOne({ _id: id })).toEqual(before);
  });

  it("generate / bulk-generate (Plumtrips invoice series) → 403, nothing created, even for its own bookings", async () => {
    const before = await col("invoices").countDocuments();
    for (const path of ["generate", "bulk-generate"]) {
      for (const ids of [[String(BOOK_A)], [String(BOOK_B)]]) {
        const r = await call(tenantA, request(app).post(`/api/admin/invoices/${path}`)).send({ bookingIds: ids });
        expect(r.status, `${path} ${ids}`).toBe(403);
      }
    }
    expect(await col("invoices").countDocuments()).toBe(before);
    expect((await col("manualbookings").findOne({ _id: BOOK_A }))!.invoiceId).toBeUndefined();
  });

  it("bulk-mark-sent / bulk-mark-paid → 403, statuses unchanged", async () => {
    const s = await call(tenantA, request(app).post("/api/admin/invoices/bulk-mark-sent")).send({ ids: [String(A.draft), String(B.draft)] });
    expect(s.status).toBe(403);
    const p = await call(tenantA, request(app).post("/api/admin/invoices/bulk-mark-paid"))
      .send({ ids: [String(A.sent), String(B.sent)], paidAt: new Date().toISOString() });
    expect(p.status).toBe(403);
    expect(await statusOf(A.draft)).toBe("DRAFT");
    expect(await statusOf(B.draft)).toBe("DRAFT");
    expect(await statusOf(A.sent)).toBe("SENT");
  });

  it("GET /document-settings (Plumtrips bank / GST) → 403", async () => {
    expect((await call(tenantA, request(app).get("/api/admin/invoices/document-settings"))).status).toBe(403);
  });
});

describe("tenant admin (FULL): own invoices are readable, in both id-spaces", () => {
  it("detail, eligible-bookings, list (own workspace only)", async () => {
    expect((await call(tenantA, request(app).get(`/api/admin/invoices/${A.sent}`))).status).toBe(200);
    expect((await call(tenantA, request(app).get(`/api/admin/invoices/${A.legacy}`))).status).toBe(200);
    expect((await call(tenantA, request(app).get(`/api/admin/invoices/${A.draft}/eligible-bookings`))).status).toBe(200);
    const list = await call(tenantA, request(app).get("/api/admin/invoices"));
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain("A-SENT");
    expect(JSON.stringify(list.body)).not.toContain("B-SENT");
  });
});

describe("HOUSE staff keep every write", () => {
  it("edit, status, cancel, bulk marks and document-settings", async () => {
    const staff = await person(["EMPLOYEE"], HOUSE, { invoices: "FULL" });
    expect((await call(staff, request(app).patch(`/api/admin/invoices/${A.draft}`)).send({ notes: "ops" })).status).toBe(200);
    expect((await col("invoices").findOne({ _id: A.draft }))!.notes).toBe("ops");
    expect((await call(staff, request(app).put(`/api/admin/invoices/${A.legacy}/status`)).send({ status: "PAID", paidAt: new Date().toISOString() })).status).toBe(200);
    expect(await statusOf(A.legacy)).toBe("PAID");
    const bulk = await call(staff, request(app).post("/api/admin/invoices/bulk-mark-paid"))
      .send({ ids: [String(A.sent), String(B.sent)], paidAt: new Date().toISOString() });
    expect(bulk.body.updated.sort()).toEqual([String(A.sent), String(B.sent)].sort());
    expect((await call(staff, request(app).post(`/api/admin/invoices/${B.paid}/revert-to-sent`)).send({ reason: "x" })).status).toBe(200);
    expect((await call(staff, request(app).post(`/api/admin/invoices/${B.paid}/cancel`)).send({ reason: "x" })).status).toBe(200);
    expect((await call(staff, request(app).get("/api/admin/invoices/document-settings"))).status).toBe(200);
  });

  it("a malformed id is 404 on the raw-collection routes (was a 500)", async () => {
    const staff = await person(["EMPLOYEE"], HOUSE, { invoices: "FULL" });
    expect((await call(staff, request(app).post("/api/admin/invoices/not-an-id/pdf"))).status).toBe(404);
    expect((await call(staff, request(app).post("/api/admin/invoices/not-an-id/add-bookings")).send({ bookingIds: [String(BOOK_A)] })).status).toBe(404);
  });
});

describe("Plumtrips staff and Super Admin act on every workspace", () => {
  it.each([["EMPLOYEE"], ["MANAGER"]])("HOUSE %s with invoices FULL opens and acts on another tenant's invoice", async (role) => {
    const staff = await person([role], HOUSE, { invoices: "FULL" });
    expect((await call(staff, request(app).get(`/api/admin/invoices/${B.sent}`))).status).toBe(200);
    expect((await call(staff, request(app).post(`/api/admin/invoices/${B.paid}/revert-to-sent`)).send({ reason: "x" })).status).toBe(200);
    const bulk = await call(staff, request(app).post("/api/admin/invoices/bulk-mark-sent")).send({ ids: [String(A.draft), String(B.draft)] });
    expect(bulk.body.updated.sort()).toEqual([String(A.draft), String(B.draft)].sort());
    const gen = await call(staff, request(app).post("/api/admin/invoices/generate")).send({ bookingIds: [String(BOOK_B)] });
    expect(gen.status).not.toBe(404);
  });

  it("Super Admin (no grant) opens any invoice and edits another tenant's draft", async () => {
    expect((await call(sa, request(app).get(`/api/admin/invoices/${B.sent}`))).status).toBe(200);
    expect((await call(sa, request(app).patch(`/api/admin/invoices/${B.draft}`)).send({ notes: "sa" })).status).toBe(200);
  });

  it("a tenant caller whose workspace resolves to nothing can open nothing (fails closed)", async () => {
    const lost = await person(["TENANT_ADMIN"], "", { invoices: "FULL" });
    expect((await call(lost, request(app).get(`/api/admin/invoices/${A.sent}`))).status).toBe(404);
  });
});
