// apps/backend/src/routes/billing.staffTravelRoles.test.ts
//
// 2026-10-07: chirag@ (HOUSE staff, invoices + creditnotes FULL / scope OWN) got
// "Admin access required". A staff access token copies User.roles verbatim, and
// Plumtrips staff carry travel roles (REQUESTER / APPROVER / TRAVELLER /
// WORKSPACE_LEADER) for the approval and booking flows; requireBillingStaff
// counted those as "external account" markers and sent the caller on to
// requireAdmin. Now:
//   • HOUSE staff with travel roles pass on the grant, at their level;
//   • without the grant: 403;
//   • customer / vendor accounts (role, accountType, customerMemberRole — even
//     with extra staff-looking roles) and non-HOUSE tenants: refused as before;
//   • Super Admin unchanged;
//   • GET /admin/invoices/document-settings gives grantees the read-only
//     letterhead / bank / seller-GSTIN subset the screens need, while
//     /admin/company-settings keeps its own gate.
//
// Real: invoices, creditNotes, companySettings routers; requireBillingStaff,
//   requireAdmin, requirePermission; models; in-memory Mongo.
// Stubbed: requireAuth (x-test-user), workspace resolver (x-test-ws), S3, PDF.
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
const { default: companySettingsRouter } = await import("./companySettings.js");
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
  req.workspaceObjectId = ws ? oid(ws) : undefined;
  next();
};
const app = express();
app.use(express.json());
app.use("/api/admin/invoices", withWs, invoicesRouter);
app.use("/api/admin/credit-notes", withWs, creditNotesRouter);
app.use("/api/admin/company-settings", withWs, companySettingsRouter);

type Who = { user: Record<string, unknown>; ws: string };
const call = (w: Who, r: request.Test) => r.set("x-test-user", JSON.stringify(w.user)).set("x-test-ws", w.ws);
async function person(roles: string[], ws: string, grants: Record<string, string>, extra: Record<string, unknown> = {}): Promise<Who> {
  const id = oid();
  await col("users").insertOne({ _id: id, email: `${id}@t.local`, roles, workspaceId: ws } as any);
  if (Object.keys(grants).length) {
    const modules: any = {};
    for (const [k, v] of Object.entries(grants)) modules[k] = { access: v, scope: "OWN" }; // Chirag's scope
    await UserPermission.create({ userId: String(id), email: `${id}@t.local`, workspaceId: ws || "global", universe: "STAFF",
      level: { code: "L2", name: "Senior" }, modules, grantedBy: "test" } as any);
  }
  return { user: { _id: String(id), id: String(id), sub: String(id), roles, workspaceId: ws, ...extra }, ws };
}

const get = (w: Who, path: string) => call(w, request(app).get(path));
const cnBody = { originalInvoiceId: String(INV), reasonId: String(REASON), isFullCredit: true };

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("billing-staff-travel-roles-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

beforeEach(async () => {
  for (const c of ["invoices", "creditnotes", "creditnotereasons", "users", "userpermissions", "counters", "companysettings"]) await col(c).deleteMany({});
  await col("creditnotereasons").insertOne({ _id: REASON, category: "FLIGHT", reason: "Flight cancelled", code: "FLT",
    gstReasonCode: "01", gstReasonText: "Sales Return", isActive: true, displayOrder: 1 } as any);
  await col("invoices").insertOne({
    _id: INV, invoiceNo: "INV-1", workspaceId: oid(TENANT), status: "SENT",
    invoiceDate: new Date(Date.now() - 10 * 86400000), generatedAt: new Date(Date.now() - 10 * 86400000),
    grandTotal: 11800, supplyType: "IGST", issuerDetails: { gstin: "" }, clientDetails: { companyName: "Acme" },
    lineItems: [{ bookingRef: "B1", rowType: "COST", description: "Flight", qty: 1, rate: 10000, igst: 1800, amount: 11800 }],
  } as any);
  await col("companysettings").insertOne({
    companyName: "Plumtrips", logoUrl: "https://x/logo.png", gstin: "29ABCDE1234F1Z5", bankName: "HDFC Bank",
    bankAccountNumber: "50200012345678", bankIfsc: "HDFC0001234", smtpPassword: "do-not-leak",
    gstProfiles: [{ gstin: "29ABCDE1234F1Z5", state: "Karnataka", active: true }, { gstin: "07ABCDE1234F1Z5", state: "Delhi", active: false }],
  } as any);
});

describe("HOUSE staff with travel roles: the grant decides", () => {
  it.each([["REQUESTER"], ["APPROVER"], ["TRAVELLER"], ["WORKSPACE_LEADER"]])(
    "EMPLOYEE + %s with invoices + creditnotes FULL (scope OWN) — every page call works",
    async (travelRole) => {
      const u = await person(["EMPLOYEE", travelRole], HOUSE, { invoices: "FULL", creditnotes: "FULL" });
      expect((await get(u, "/api/admin/invoices")).status).toBe(200);
      expect((await get(u, `/api/admin/invoices/${INV}`)).status).toBe(200);
      expect((await get(u, "/api/admin/invoices/activity")).status).toBe(200);
      expect((await get(u, "/api/admin/invoices/insight")).status).toBe(200);
      expect((await get(u, `/api/admin/invoices/${INV}/credit-notes`)).status).toBe(200);
      expect((await get(u, "/api/admin/invoices/document-settings")).status).toBe(200);
      expect((await get(u, "/api/admin/credit-notes")).status).toBe(200);
      expect((await get(u, "/api/admin/credit-notes/reasons")).status).toBe(200);
      const created = await call(u, request(app).post("/api/admin/credit-notes")).send(cnBody);
      expect(created.status).toBe(201);
      expect((await get(u, `/api/admin/credit-notes/${created.body.creditNote._id}`)).status).toBe(200);
      expect((await call(u, request(app).post(`/api/admin/credit-notes/${created.body.creditNote._id}/issue`))).status).toBe(200);
    },
  );

  it("READ grant: views and the settings lookup work; writes are 403", async () => {
    const u = await person(["MANAGER", "APPROVER"], HOUSE, { invoices: "READ", creditnotes: "READ" });
    expect((await get(u, "/api/admin/invoices")).status).toBe(200);
    expect((await get(u, "/api/admin/invoices/document-settings")).status).toBe(200);
    expect((await call(u, request(app).post("/api/admin/invoices/generate")).send({})).status).toBe(403);
    expect((await call(u, request(app).post("/api/admin/credit-notes")).send(cnBody)).status).toBe(403);
  });

  it("no grant: 403 everywhere, including the settings lookup", async () => {
    const u = await person(["EMPLOYEE", "REQUESTER"], HOUSE, {});
    for (const p of ["/api/admin/invoices", "/api/admin/credit-notes", "/api/admin/invoices/document-settings"]) {
      expect((await get(u, p)).status, p).toBe(403);
    }
  });

  it("document-settings: only the billing fields and ACTIVE seller GSTINs; company-settings keeps its own gate", async () => {
    const u = await person(["EMPLOYEE", "REQUESTER"], HOUSE, { creditnotes: "READ" });
    const r = await get(u, "/api/admin/invoices/document-settings");
    expect(r.body.settings).toMatchObject({ companyName: "Plumtrips", logoUrl: "https://x/logo.png", bankAccountNumber: "50200012345678", bankIfsc: "HDFC0001234" });
    expect(r.body.settings.gstProfiles.map((p: any) => p.gstin)).toEqual(["29ABCDE1234F1Z5"]);
    expect(JSON.stringify(r.body)).not.toContain("do-not-leak");
    expect((await get(u, "/api/admin/company-settings")).status).toBe(403); // unchanged gate
  });
});

describe("unchanged: customers, vendors, tenants, Super Admin", () => {
  it("customer / vendor accounts are refused even with FULL grants and staff-looking roles", async () => {
    const g = { invoices: "FULL", creditnotes: "FULL" };
    const refused = [
      await person(["CUSTOMER", "EMPLOYEE"], HOUSE, g),
      await person(["EMPLOYEE", "REQUESTER"], HOUSE, g, { customerMemberRole: "REQUESTER" }),
      await person(["EMPLOYEE"], HOUSE, g, { accountType: "CUSTOMER" }),
      await person(["BUSINESS", "WORKSPACE_LEADER"], HOUSE, g),
      await person(["VENDOR"], HOUSE, g),
    ];
    for (const w of refused) {
      for (const p of ["/api/admin/invoices", "/api/admin/credit-notes", "/api/admin/invoices/document-settings"]) {
        expect((await get(w, p)).status, `${JSON.stringify(w.user.roles)} ${p}`).toBe(403);
      }
    }
  });

  it("a non-HOUSE tenant EMPLOYEE + REQUESTER with the grant is still refused", async () => {
    const u = await person(["EMPLOYEE", "REQUESTER"], TENANT, { invoices: "FULL", creditnotes: "FULL" });
    expect((await get(u, "/api/admin/invoices")).status).toBe(403);
    expect((await get(u, "/api/admin/credit-notes")).status).toBe(403);
  });

  it("Super Admin passes everywhere with no grant", async () => {
    const sa = await person(["SUPERADMIN"], HOUSE, {});
    expect((await get(sa, "/api/admin/invoices")).status).toBe(200);
    expect((await get(sa, "/api/admin/invoices/document-settings")).status).toBe(200);
    expect((await get(sa, "/api/admin/company-settings")).status).toBe(200);
  });

  it("isExternalAccount: travel roles alone are staff; customer/vendor markers are not", () => {
    for (const r of ["REQUESTER", "APPROVER", "TRAVELLER", "WORKSPACE_LEADER"]) expect(isExternalAccount({ roles: ["EMPLOYEE", r] })).toBe(false);
    expect(isExternalAccount({ roles: ["EMPLOYEE"], customerMemberRole: "APPROVER" })).toBe(true);
    expect(isExternalAccount({ roles: ["CUSTOMER"] })).toBe(true);
    expect(isExternalAccount({ roles: ["EMPLOYEE"], accountType: "VENDOR" })).toBe(true);
  });
});
