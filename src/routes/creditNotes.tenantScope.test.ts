// apps/backend/src/routes/creditNotes.tenantScope.test.ts
//
// Credit notes are tenant-scoped by the SAME rule as invoices
// (invoiceTenantClause): Super Admin and Plumtrips (HOUSE) staff see every
// workspace; a tenant user sees only credit notes of its own workspace — in
// either id-space (CustomerWorkspace._id or legacy Customer._id) — and another
// workspace's credit note answers 404 on every by-id route.
//
// Real: creditNotes + invoices routers, requireBillingStaff, requireAdmin,
//   requirePermission, invoiceTenantClause, models, in-memory Mongo.
// Stubbed: requireAuth (x-test-user), the workspace resolver (x-test-ws /
//   x-test-cust, as requireWorkspace sets req.workspaceObjectId +
//   req.workspace.customerId), S3, the PDF renderer, task automation.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../utils/creditNotePdf.js", () => ({ generateCreditNotePdf: vi.fn(async () => Buffer.from("%PDF")) }));
vi.mock("../utils/s3Upload.js", () => ({ uploadAndPresign: vi.fn(async (k: string) => `https://s3.test/${k}`) }));
vi.mock("../services/taskAutomation.js", () => ({ triggerTaskAutomation: vi.fn(async () => undefined) }));

const { default: creditNotesRouter } = await import("./creditNotes.js");
const { default: invoicesRouter } = await import("./invoices.js");
const { UserPermission } = await import("../models/UserPermission.js");

const oid = (s?: string) => new mongoose.Types.ObjectId(s);
const col = (n: string) => mongoose.connection.db!.collection(n);

const HOUSE = "69679a7628330a58d29f2254";
const WS_A = oid(); const CUST_A = oid();   // tenant A: workspace + its Customer
const WS_B = oid(); const CUST_B = oid();   // tenant B
const INV_A = oid(); const INV_A_LEGACY = oid(); const INV_B = oid();
const REASON = oid();

// requireWorkspace stand-in: workspace id + its customerId.
const withWs = (req: any, _res: any, next: any) => {
  const ws = String(req.headers["x-test-ws"] || "");
  const cust = String(req.headers["x-test-cust"] || "");
  req.workspaceObjectId = ws ? oid(ws) : undefined;
  req.workspace = cust ? { customerId: cust } : undefined;
  next();
};
const app = express();
app.use(express.json());
app.use("/api/admin/credit-notes", withWs, creditNotesRouter);
app.use("/api/admin/invoices", withWs, invoicesRouter);

type Who = { user: Record<string, unknown>; ws: string; cust?: string };
const call = (who: Who, r: request.Test) => {
  r.set("x-test-user", JSON.stringify(who.user)).set("x-test-ws", who.ws);
  if (who.cust) r.set("x-test-cust", who.cust);
  return r;
};

async function person(roles: string[], ws: string, grants: Record<string, string>, cust?: string): Promise<Who> {
  const id = oid();
  await col("users").insertOne({ _id: id, email: `${id}@t.local`, name: "T", roles, workspaceId: ws } as any);
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

const invoice = (_id: mongoose.Types.ObjectId, workspaceId: mongoose.Types.ObjectId, invoiceNo: string) => ({
  _id, invoiceNo, workspaceId, status: "SENT",
  invoiceDate: new Date(Date.now() - 20 * 86400000), generatedAt: new Date(Date.now() - 20 * 86400000),
  grandTotal: 11800, supplyType: "IGST", issuerDetails: { gstin: "" }, clientDetails: { companyName: invoiceNo },
  lineItems: [{ bookingRef: "B1", rowType: "COST", description: "Flight", qty: 1, rate: 10000, igst: 1800, amount: 11800 }],
});

let sa: Who;
let tenantA: Who;       // TENANT_ADMIN of A with FULL on both
let cn: { a: any; aLegacy: any; b: any };

const draftFor = async (inv: mongoose.Types.ObjectId) => {
  const r = await call(sa, request(app).post("/api/admin/credit-notes"))
    .send({ originalInvoiceId: String(inv), reasonId: String(REASON), isFullCredit: true });
  expect(r.status).toBe(201);
  return r.body.creditNote;
};
const numbers = (items: any[]) => items.map((c) => c.creditNoteNo).sort();

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("credit-notes-tenant-scope-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

beforeEach(async () => {
  for (const c of ["invoices", "creditnotes", "creditnotereasons", "users", "userpermissions", "counters", "customerworkspaces"]) {
    await col(c).deleteMany({});
  }
  await col("creditnotereasons").insertOne({
    _id: REASON, category: "FLIGHT", reason: "Flight cancelled", code: "FLT_CANCEL",
    gstReasonCode: "01", gstReasonText: "Sales Return", isActive: true, displayOrder: 1,
  } as any);
  await col("customerworkspaces").insertMany([
    { _id: WS_A, customerId: String(CUST_A), companyName: "Tenant A" },
    { _id: WS_B, customerId: String(CUST_B), companyName: "Tenant B" },
  ] as any[]);
  await col("invoices").insertMany([
    invoice(INV_A, WS_A, "INV-A"),
    invoice(INV_A_LEGACY, CUST_A, "INV-A-LEGACY"),   // legacy Customer._id space
    invoice(INV_B, WS_B, "INV-B"),
  ] as any[]);
  sa = await person(["SUPERADMIN"], HOUSE, {});
  tenantA = await person(["TENANT_ADMIN"], String(WS_A), { creditnotes: "FULL", invoices: "FULL" }, String(CUST_A));
  cn = { a: await draftFor(INV_A), aLegacy: await draftFor(INV_A_LEGACY), b: await draftFor(INV_B) };
});

describe("tenant admin (FULL) — own workspace only", () => {
  it("list shows only own credit notes (both id-spaces); ?workspaceId=<other> cannot widen it", async () => {
    const own = await call(tenantA, request(app).get("/api/admin/credit-notes"));
    expect(own.status).toBe(200);
    expect(numbers(own.body.items)).toEqual(numbers([cn.a, cn.aLegacy]));
    expect(own.body.total).toBe(2);
    const widen = await call(tenantA, request(app).get(`/api/admin/credit-notes?workspaceId=${WS_B}`));
    expect(widen.body.items).toEqual([]);
  });

  it("another workspace's credit note → 404 on detail, PDF, edit, issue, cancel; nothing changes", async () => {
    const id = cn.b._id;
    expect((await call(tenantA, request(app).get(`/api/admin/credit-notes/${id}`))).status).toBe(404);
    expect((await call(tenantA, request(app).get(`/api/admin/credit-notes/${id}/pdf`))).status).toBe(404);
    expect((await call(tenantA, request(app).patch(`/api/admin/credit-notes/${id}`)).send({ notes: "x" })).status).toBe(404);
    expect((await call(tenantA, request(app).post(`/api/admin/credit-notes/${id}/issue`))).status).toBe(404);
    // issue it as Super Admin, then the tenant still cannot cancel it
    expect((await call(sa, request(app).post(`/api/admin/credit-notes/${id}/issue`))).status).toBe(200);
    expect((await call(tenantA, request(app).post(`/api/admin/credit-notes/${id}/cancel`)).send({ reason: "x" })).status).toBe(404);
    const doc = await col("creditnotes").findOne({ _id: oid(id) });
    expect(doc!.status).toBe("ISSUED");
    expect(doc!.notes).toBeUndefined();
    expect((await col("invoices").findOne({ _id: INV_B }))!.creditedAmount).toBe(11800);
  });

  it("own credit notes: detail, PDF, edit, issue, cancel all work", async () => {
    const id = cn.a._id;
    expect((await call(tenantA, request(app).get(`/api/admin/credit-notes/${id}`))).status).toBe(200);
    expect((await call(tenantA, request(app).get(`/api/admin/credit-notes/${id}/pdf`))).status).toBe(200);
    expect((await call(tenantA, request(app).patch(`/api/admin/credit-notes/${id}`)).send({ notes: "ok" })).status).toBe(200);
    expect((await call(tenantA, request(app).post(`/api/admin/credit-notes/${id}/issue`))).status).toBe(200);
    expect((await call(tenantA, request(app).post(`/api/admin/credit-notes/${id}/cancel`)).send({ reason: "x" })).status).toBe(200);
    expect((await call(tenantA, request(app).get(`/api/admin/credit-notes/${cn.aLegacy._id}`))).status).toBe(200);
  });

  it("cannot create or preview a credit note against another workspace's invoice (404)", async () => {
    const body = (inv: mongoose.Types.ObjectId) => ({ originalInvoiceId: String(inv), reasonId: String(REASON), isFullCredit: false, lineItems: [{ bookingRef: "B1", rowType: "COST", description: "Flight", creditedAmount: 100 }] });
    expect((await call(tenantA, request(app).post("/api/admin/credit-notes")).send(body(INV_B))).status).toBe(404);
    expect((await call(tenantA, request(app).post("/api/admin/credit-notes/preview")).send(body(INV_B))).status).toBe(404);
    expect((await call(tenantA, request(app).post("/api/admin/credit-notes")).send(body(INV_A))).status).toBe(201);
    expect(await col("creditnotes").countDocuments({ originalInvoiceId: INV_B })).toBe(1);
  });

  it("export, activity and insight contain only own rows", async () => {
    for (const c of [cn.a, cn.b]) await call(sa, request(app).post(`/api/admin/credit-notes/${c._id}/issue`));
    const csv = await call(tenantA, request(app).get("/api/admin/credit-notes/export?format=csv"));
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(cn.a.creditNoteNo);
    expect(csv.text).toContain(cn.aLegacy.creditNoteNo);
    expect(csv.text).not.toContain(cn.b.creditNoteNo);
    const act = await call(tenantA, request(app).get("/api/admin/credit-notes/activity"));
    expect(numbers(act.body)).toEqual(numbers([cn.a, cn.aLegacy]));
    const ins = await call(tenantA, request(app).get("/api/admin/credit-notes/insight"));
    expect(ins.body.totalIssued).toBe(1);
    expect(ins.body.totalCreditAmount).toBe(11800);
  });

  it("invoice's credit-note list (/api/admin/invoices/:id/credit-notes) never shows another workspace's", async () => {
    const other = await call(tenantA, request(app).get(`/api/admin/invoices/${INV_B}/credit-notes`));
    expect(other.status).toBe(200);
    expect(other.body.creditNotes).toEqual([]);
    const own = await call(tenantA, request(app).get(`/api/admin/invoices/${INV_A}/credit-notes`));
    expect(own.body.creditNotes.map((c: any) => c.creditNoteNo)).toEqual([cn.a.creditNoteNo]);
  });

  it("a tenant caller whose workspace resolves to nothing sees nothing (fails closed)", async () => {
    const lost = await person(["TENANT_ADMIN"], "", { creditnotes: "FULL" });
    const r = await call(lost, request(app).get("/api/admin/credit-notes"));
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
  });
});

describe("Plumtrips staff and Super Admin — every workspace", () => {
  it.each([["EMPLOYEE"], ["MANAGER"]])("HOUSE %s with creditnotes READ sees all and opens any", async (role) => {
    const staff = await person([role], HOUSE, { creditnotes: "READ" });
    const list = await call(staff, request(app).get("/api/admin/credit-notes"));
    expect(list.body.total).toBe(3);
    expect((await call(staff, request(app).get(`/api/admin/credit-notes/${cn.b._id}`))).status).toBe(200);
    const csv = await call(staff, request(app).get("/api/admin/credit-notes/export?format=csv"));
    for (const c of [cn.a, cn.aLegacy, cn.b]) expect(csv.text).toContain(c.creditNoteNo);
  });

  it("HOUSE staff with FULL acts on any tenant's credit note", async () => {
    const staff = await person(["EMPLOYEE"], HOUSE, { creditnotes: "FULL" });
    expect((await call(staff, request(app).post(`/api/admin/credit-notes/${cn.b._id}/issue`))).status).toBe(200);
  });

  it("Super Admin sees all", async () => {
    const list = await call(sa, request(app).get("/api/admin/credit-notes"));
    expect(list.body.total).toBe(3);
    expect((await call(sa, request(app).get("/api/admin/credit-notes/activity"))).body).toHaveLength(3);
  });

  it("a malformed id is a 404, not a 500", async () => {
    expect((await call(sa, request(app).get("/api/admin/credit-notes/not-an-id"))).status).toBe(404);
  });
});
