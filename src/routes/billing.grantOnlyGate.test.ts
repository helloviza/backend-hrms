// apps/backend/src/routes/billing.grantOnlyGate.test.ts
//
// Invoices + Credit Notes (staff routers): for Plumtrips staff the /admin/access
// grant is the only gate. L1–L4 staff (role EMPLOYEE / MANAGER) used to be
// refused by requireAdmin ("Admin access required") even with the grant.
//
//   • HOUSE staff at any level pass at exactly their grant: READ views,
//     WRITE creates/edits drafts, FULL issues/cancels;
//   • without the grant they get 403;
//   • customer and vendor accounts never pass, grant or not, HOUSE or not;
//   • Super Admin passes with no grant at all;
//   • a non-HOUSE tenant EMPLOYEE is still refused (no tenant change).
//
// Real: invoices + creditNotes routers, requireBillingStaff, requireAdmin,
//   requirePermission, models, in-memory Mongo. Stubbed: requireAuth
//   (x-test-user), the workspace resolver (x-test-ws, as server.ts mounts
//   requireWorkspace in front), S3, the PDF renderer, task automation.
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

const { default: invoicesRouter } = await import("./invoices.js");
const { default: creditNotesRouter } = await import("./creditNotes.js");
const { isExternalAccount } = await import("../middleware/requireBillingStaff.js");
const { UserPermission } = await import("../models/UserPermission.js");

const oid = (s?: string) => new mongoose.Types.ObjectId(s);
const col = (n: string) => mongoose.connection.db!.collection(n);
const HOUSE = "69679a7628330a58d29f2254";
const TENANT = String(oid());
const INV = oid();
const REASON = oid();

const withWs = (req: any, _res: any, next: any) => {
  const ws = String(req.headers["x-test-ws"] || "");
  req.workspaceId = ws;
  req.workspaceObjectId = ws ? new mongoose.Types.ObjectId(ws) : undefined;
  next();
};
const app = express();
app.use(express.json());
app.use("/api/admin/invoices", withWs, invoicesRouter);
app.use("/api/admin/credit-notes", withWs, creditNotesRouter);

type Who = { user: Record<string, unknown>; ws: string };
const call = (who: Who, r: request.Test) =>
  r.set("x-test-user", JSON.stringify(who.user)).set("x-test-ws", who.ws);

type Access = "NONE" | "READ" | "WRITE" | "FULL";
async function person(roles: string[], ws: string, grants: { invoices?: Access; creditnotes?: Access }, extra: Record<string, unknown> = {}): Promise<Who> {
  const id = oid();
  const email = `${id}@test.local`;
  await col("users").insertOne({ _id: id, email, name: "Test", roles, workspaceId: ws } as any);
  if (Object.keys(grants).length) {
    const modules: any = {};
    for (const [k, v] of Object.entries(grants)) modules[k] = { access: v, scope: "ALL" };
    await UserPermission.create({
      userId: String(id), email, workspaceId: ws, universe: "STAFF",
      level: { code: "L1", name: "Employee" }, modules, grantedBy: "test",
    } as any);
  }
  return { user: { _id: String(id), id: String(id), sub: String(id), roles, workspaceId: ws, ...extra }, ws };
}

const cnBody = { originalInvoiceId: String(INV), reasonId: String(REASON), isFullCredit: true };
const newDraft = async () => {
  const sa = await person(["SUPERADMIN"], HOUSE, {});
  const r = await call(sa, request(app).post("/api/admin/credit-notes")).send(cnBody);
  expect(r.status).toBe(201);
  return r.body.creditNote._id as string;
};

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("billing-grant-only-gate-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

beforeEach(async () => {
  for (const c of ["invoices", "creditnotes", "creditnotereasons", "users", "userpermissions", "counters"]) await col(c).deleteMany({});
  await col("creditnotereasons").insertOne({
    _id: REASON, category: "FLIGHT", reason: "Flight cancelled", code: "FLT_CANCEL",
    gstReasonCode: "01", gstReasonText: "Sales Return", isActive: true, displayOrder: 1,
  } as any);
  await col("invoices").insertOne({
    _id: INV, invoiceNo: "INV-20260001", workspaceId: oid(TENANT), status: "SENT",
    invoiceDate: new Date(Date.now() - 20 * 86400000), generatedAt: new Date(Date.now() - 20 * 86400000),
    grandTotal: 11800, supplyType: "IGST", issuerDetails: { gstin: "" }, clientDetails: { companyName: "Acme" },
    lineItems: [{ bookingRef: "B1", rowType: "COST", description: "Flight", qty: 1, rate: 10000, igst: 1800, amount: 11800 }],
  } as any);
});

describe("L1–L4 Plumtrips staff: the grant is the only gate", () => {
  it.each([["EMPLOYEE"], ["MANAGER"]])("%s with invoices READ can view, not generate", async (role) => {
    const u = await person([role], HOUSE, { invoices: "READ" });
    const list = await call(u, request(app).get("/api/admin/invoices"));
    expect(list.status).toBe(200);
    expect(list.body.items?.length ?? list.body.invoices?.length ?? list.body.total).toBeTruthy();
    expect((await call(u, request(app).get(`/api/admin/invoices/${INV}`))).status).toBe(200);
    expect((await call(u, request(app).post("/api/admin/invoices/generate")).send({})).status).toBe(403);
  });

  it("EMPLOYEE with invoices WRITE gets past the gate on generate (validation, not 403)", async () => {
    const u = await person(["EMPLOYEE"], HOUSE, { invoices: "WRITE" });
    const r = await call(u, request(app).post("/api/admin/invoices/generate")).send({});
    expect(r.status).not.toBe(403);
    expect(r.status).toBe(400);
  });

  it("EMPLOYEE with creditnotes WRITE drafts and edits, cannot issue or cancel", async () => {
    const u = await person(["EMPLOYEE"], HOUSE, { creditnotes: "WRITE" });
    const created = await call(u, request(app).post("/api/admin/credit-notes")).send(cnBody);
    expect(created.status).toBe(201);
    const id = created.body.creditNote._id;
    expect((await call(u, request(app).patch(`/api/admin/credit-notes/${id}`)).send({ notes: "x" })).status).toBe(200);
    expect((await call(u, request(app).post(`/api/admin/credit-notes/${id}/issue`))).status).toBe(403);
  });

  it("MANAGER with creditnotes FULL issues and cancels", async () => {
    const u = await person(["MANAGER"], HOUSE, { creditnotes: "FULL" });
    const id = await newDraft();
    expect((await call(u, request(app).post(`/api/admin/credit-notes/${id}/issue`))).status).toBe(200);
    expect((await call(u, request(app).post(`/api/admin/credit-notes/${id}/cancel`)).send({ reason: "Wrong" })).status).toBe(200);
  });

  it("creditnotes READ views only", async () => {
    const u = await person(["EMPLOYEE"], HOUSE, { creditnotes: "READ" });
    const id = await newDraft();
    expect((await call(u, request(app).get(`/api/admin/credit-notes/${id}`))).status).toBe(200);
    expect((await call(u, request(app).post("/api/admin/credit-notes")).send(cnBody)).status).toBe(403);
  });

  it("without the grant: 403 on both", async () => {
    const u = await person(["EMPLOYEE"], HOUSE, {});
    expect((await call(u, request(app).get("/api/admin/invoices"))).status).toBe(403);
    expect((await call(u, request(app).get("/api/admin/credit-notes"))).status).toBe(403);
    const other = await person(["MANAGER"], HOUSE, { invoices: "FULL" }); // grant on invoices only
    expect((await call(other, request(app).get("/api/admin/credit-notes"))).status).toBe(403);
  });
});

describe("customers, vendors and tenants", () => {
  it("customer accounts never pass, even with FULL grants and even in HOUSE", async () => {
    const grants = { invoices: "FULL" as Access, creditnotes: "FULL" as Access };
    const people = [
      await person(["CUSTOMER"], HOUSE, grants),
      await person(["EMPLOYEE"], HOUSE, grants, { customerMemberRole: "WORKSPACE_LEADER" }),
      await person(["EMPLOYEE"], HOUSE, grants, { accountType: "CUSTOMER" }),
      await person(["CUSTOMER"], TENANT, grants, { customerMemberRole: "WORKSPACE_LEADER" }),
      await person(["VENDOR"], HOUSE, grants),
    ];
    for (const p of people) {
      expect((await call(p, request(app).get("/api/admin/invoices"))).status).toBe(403);
      expect((await call(p, request(app).get("/api/admin/credit-notes"))).status).toBe(403);
    }
  });

  it("a non-HOUSE tenant EMPLOYEE with the grant is still refused (unchanged)", async () => {
    const u = await person(["EMPLOYEE"], TENANT, { invoices: "FULL", creditnotes: "FULL" });
    expect((await call(u, request(app).get("/api/admin/invoices"))).status).toBe(403);
    expect((await call(u, request(app).get("/api/admin/credit-notes"))).status).toBe(403);
  });

  it("admin roles keep passing to the grant check as before", async () => {
    const withGrant = await person(["ADMIN"], TENANT, { invoices: "READ" });
    expect((await call(withGrant, request(app).get("/api/admin/invoices"))).status).toBe(200);
    const noGrant = await person(["HR"], HOUSE, {});
    expect((await call(noGrant, request(app).get("/api/admin/invoices"))).status).toBe(403);
  });

  it("Super Admin passes with no grant", async () => {
    const sa = await person(["SUPERADMIN"], HOUSE, {});
    expect((await call(sa, request(app).get("/api/admin/invoices"))).status).toBe(200);
    const id = await newDraft();
    expect((await call(sa, request(app).post(`/api/admin/credit-notes/${id}/issue`))).status).toBe(200);
  });

  it("isExternalAccount flags customer/vendor signals, not staff", () => {
    expect(isExternalAccount({ roles: ["EMPLOYEE"] })).toBe(false);
    expect(isExternalAccount({ roles: ["MANAGER", "HR"] })).toBe(false);
    expect(isExternalAccount({ roles: ["CUSTOMER"] })).toBe(true);
    expect(isExternalAccount({ roles: ["EMPLOYEE"], userType: "Business" })).toBe(true);
    expect(isExternalAccount({ roles: ["EMPLOYEE"], customerMemberRole: "REQUESTER" })).toBe(true);
    expect(isExternalAccount(null)).toBe(true);
  });
});
