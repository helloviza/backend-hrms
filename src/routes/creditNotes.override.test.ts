// apps/backend/src/routes/creditNotes.override.test.ts
//
// POST /api/admin/credit-notes/:id/override — Super Admin ONLY (Imran's call,
// 2026-10-07): edit amount / date / GST reason / notes on a credit note in ANY
// status, and set any status — incl. CANCELLED → ISSUED under the same number.
// Books stay consistent: invoice creditedAmount = sum of ISSUED notes after
// every override, over-credit refused, GST rebuilt as at creation, number
// unchanged, date ≥ invoice date, reason required, history logged, PDF
// re-rendered. Everyone else — FULL / WRITE staff, tenant admins — gets 403.
//
// Real: creditNotes router, requireBillingStaff, requirePermission,
//   isSuperAdmin, models, in-memory Mongo. Stubbed: requireAuth
//   (x-test-user), workspace resolver (x-test-ws), S3, PDF renderer (a spy),
//   task automation.
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
const pdf = vi.hoisted(() => ({ generateCreditNotePdf: vi.fn(async (_cn: any) => Buffer.from("%PDF")) }));
vi.mock("../utils/creditNotePdf.js", () => pdf);
vi.mock("../utils/s3Upload.js", () => ({ uploadAndPresign: vi.fn(async (k: string) => `https://s3.test/${k}`) }));
vi.mock("../services/taskAutomation.js", () => ({ triggerTaskAutomation: vi.fn(async () => undefined) }));

const { default: creditNotesRouter } = await import("./creditNotes.js");
const { UserPermission } = await import("../models/UserPermission.js");

const oid = (s?: string) => new mongoose.Types.ObjectId(s);
const col = (n: string) => mongoose.connection.db!.collection(n);
const HOUSE = "69679a7628330a58d29f2254";
const WS = oid();
const INV = oid();
const REASON = oid();
const DAY = 86400000;
const IST = 5.5 * 3600000;
const istDay = (at: number | Date) => new Date(new Date(at).getTime() + IST).toISOString().slice(0, 10);
const INVOICE_DAY = istDay(Date.now() - 30 * DAY);

const app = express();
app.use(express.json());
app.use("/api/admin/credit-notes", (req: any, _res: any, next: any) => {
  const ws = String(req.headers["x-test-ws"] || "");
  req.workspaceObjectId = ws ? oid(ws) : undefined;
  next();
}, creditNotesRouter);

type Who = { user: Record<string, unknown>; ws: string };
const call = (w: Who, r: request.Test) => r.set("x-test-user", JSON.stringify(w.user)).set("x-test-ws", w.ws);
async function person(roles: string[], ws: string, grants: Record<string, string>, extra: Record<string, unknown> = {}): Promise<Who> {
  const id = oid();
  await col("users").insertOne({ _id: id, email: `${id}@t.local`, name: `u${String(id).slice(-4)}`, roles, workspaceId: ws } as any);
  if (Object.keys(grants).length) {
    const modules: any = {};
    for (const [k, v] of Object.entries(grants)) modules[k] = { access: v, scope: "ALL" };
    await UserPermission.create({ userId: String(id), email: `${id}@t.local`, workspaceId: ws, universe: "STAFF",
      level: { code: "L1", name: "Employee" }, modules, grantedBy: "test" } as any);
  }
  return { user: { _id: String(id), id: String(id), sub: String(id), roles, workspaceId: ws, ...extra }, ws };
}

let sa: Who;
const override = (who: Who, id: string, body: any) => call(who, request(app).post(`/api/admin/credit-notes/${id}/override`)).send(body);
const credited = async () => (await col("invoices").findOne({ _id: INV }))!.creditedAmount;
const doc = async (id: string) => (await col("creditnotes").findOne({ _id: oid(id) }))!;
const line = (creditedAmount: number) => ({ bookingRef: "B1", rowType: "COST", description: "Flight", creditedAmount });

async function newNote(amount: number | "full", issue: boolean) {
  const body = amount === "full"
    ? { originalInvoiceId: String(INV), reasonId: String(REASON), isFullCredit: true }
    : { originalInvoiceId: String(INV), reasonId: String(REASON), isFullCredit: false, lineItems: [line(amount)] };
  const r = await call(sa, request(app).post("/api/admin/credit-notes")).send(body);
  expect(r.status).toBe(201);
  if (issue) expect((await call(sa, request(app).post(`/api/admin/credit-notes/${r.body.creditNote._id}/issue`))).status).toBe(200);
  return r.body.creditNote as { _id: string; creditNoteNo: string };
}

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("credit-notes-override-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

beforeEach(async () => {
  for (const c of ["invoices", "creditnotes", "creditnotereasons", "users", "userpermissions", "counters"]) await col(c).deleteMany({});
  pdf.generateCreditNotePdf.mockClear();
  await col("creditnotereasons").insertOne({ _id: REASON, category: "FLIGHT", reason: "Flight cancelled", code: "FLT",
    gstReasonCode: "01", gstReasonText: "Sales Return", isActive: true, displayOrder: 1 } as any);
  await col("invoices").insertOne({
    _id: INV, invoiceNo: "INV-1", workspaceId: WS, status: "SENT",
    invoiceDate: new Date(`${INVOICE_DAY}T00:00:00.000Z`), generatedAt: new Date(`${INVOICE_DAY}T00:00:00.000Z`),
    grandTotal: 11800, supplyType: "IGST", issuerDetails: { gstin: "" }, clientDetails: { companyName: "Acme" },
    lineItems: [{ bookingRef: "B1", rowType: "COST", description: "Flight", qty: 1, rate: 10000, igst: 1800, amount: 11800 }],
  } as any);
  sa = await person(["SUPERADMIN"], HOUSE, {});
});

describe("Super Admin edits any status", () => {
  it("ISSUED: amount + date + GST code — GST rebuilt, number kept, credited total recomputed, PDF re-rendered, history logged", async () => {
    const n = await newNote("full", true);
    expect(await credited()).toBe(11800);
    pdf.generateCreditNotePdf.mockClear();
    const day = istDay(Date.now() - 5 * DAY);
    const r = await override(sa, n._id, { reason: "Airline refunded half", changes: { isFullCredit: false, lineItems: [line(5900)], creditNoteDate: day, gstReasonCode: "04" } });
    expect(r.status).toBe(200);
    expect(r.body.creditNote).toMatchObject({ status: "ISSUED", creditNoteNo: n.creditNoteNo, grandTotal: 5900, totalGST: 900, subtotal: 5000, igstAmount: 900, gstReasonCode: "04", gstReasonOverridden: true });
    expect(istDay(r.body.creditNote.creditNoteDate)).toBe(day);
    expect(await credited()).toBe(5900);
    expect(r.body.creditedAmount).toBe(5900);
    expect(pdf.generateCreditNotePdf).toHaveBeenCalledTimes(1);
    expect(pdf.generateCreditNotePdf.mock.calls[0][0]).toMatchObject({ grandTotal: 5900, creditNoteNo: n.creditNoteNo });
    expect((await doc(n._id)).pdfUrl).toContain(n.creditNoteNo);

    const h = (await doc(n._id)).editHistory.at(-1);
    expect(h).toMatchObject({ override: true, reason: "Airline refunded half" });
    expect(String(h.editedBy)).toBe(String(sa.user._id));
    expect(h.fieldsChanged).toEqual(expect.arrayContaining(["creditNoteDate", "gstReasonCode", "totals", "lineItems"]));
    expect(h.oldValues).toMatchObject({ gstReasonCode: "01", totals: { grandTotal: 11800 } });
    expect(h.newValues).toMatchObject({ creditNoteDate: day, gstReasonCode: "04", totals: { grandTotal: 5900, totalGST: 900 } });
  });

  it("CANCELLED: edit amount (credited stays 0), then restore → ISSUED with the SAME number", async () => {
    const n = await newNote("full", true);
    expect((await call(sa, request(app).post(`/api/admin/credit-notes/${n._id}/cancel`)).send({ reason: "Wrong" })).status).toBe(200);
    expect(await credited()).toBe(0);

    expect((await override(sa, n._id, { reason: "Correct figure", changes: { isFullCredit: false, lineItems: [line(4000)] } })).status).toBe(200);
    expect((await doc(n._id)).status).toBe("CANCELLED");
    expect(await credited()).toBe(0);

    const r = await override(sa, n._id, { reason: "Cancelled by mistake", changes: { status: "ISSUED" } });
    expect(r.status).toBe(200);
    const d = await doc(n._id);
    expect(d).toMatchObject({ status: "ISSUED", creditNoteNo: n.creditNoteNo, grandTotal: 4000 });
    expect(d.cancelledAt ?? null).toBeNull();
    expect(d.cancellationReason ?? null).toBeNull();
    expect(await credited()).toBe(4000);
    expect(d.editHistory.at(-1)).toMatchObject({ override: true, reason: "Cancelled by mistake", oldValues: { status: "CANCELLED" }, newValues: { status: "ISSUED" } });
    expect(await col("creditnotes").countDocuments()).toBe(1);
  });

  it("ISSUED → DRAFT → ISSUED, credited total right after each; then the normal cancel still balances", async () => {
    const n = await newNote(7000, true);
    expect(await credited()).toBe(7000);
    expect((await override(sa, n._id, { reason: "Re-check", changes: { status: "DRAFT" } })).status).toBe(200);
    expect(await credited()).toBe(0);
    expect((await doc(n._id)).issuedAt ?? null).toBeNull();
    expect((await override(sa, n._id, { reason: "Checked", changes: { status: "ISSUED" } })).status).toBe(200);
    expect(await credited()).toBe(7000);
    expect((await doc(n._id)).creditNoteNo).toBe(n.creditNoteNo);
    // the ordinary cancel route keeps working on an overridden note
    expect((await call(sa, request(app).post(`/api/admin/credit-notes/${n._id}/cancel`)).send({ reason: "x" })).status).toBe(200);
    expect(await credited()).toBe(0);
  });

  it("ISSUED → CANCELLED by override stamps the cancellation with the reason", async () => {
    const n = await newNote(3000, true);
    expect((await override(sa, n._id, { reason: "Duplicate of CN-x", changes: { status: "CANCELLED" } })).status).toBe(200);
    expect(await doc(n._id)).toMatchObject({ status: "CANCELLED", cancellationReason: "Duplicate of CN-x" });
    expect(await credited()).toBe(0);
  });
});

describe("books stay consistent", () => {
  it("refuses an over-credit (restore or amount) with a clear message; nothing changes", async () => {
    const a = await newNote(8000, true);
    const b = await newNote(3000, false);
    // a DRAFT doesn't count, so raising its amount is fine…
    expect((await override(sa, b._id, { reason: "x", changes: { isFullCredit: false, lineItems: [line(5000)] } })).status).toBe(200);
    expect(await credited()).toBe(8000);
    // …but issuing it would take the invoice to ₹13000 of ₹11800
    const r = await override(sa, b._id, { reason: "x", changes: { status: "ISSUED" } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/₹13000.*₹11800/);
    expect((await doc(b._id)).status).toBe("DRAFT");
    expect(await credited()).toBe(8000);
    // raising an ISSUED note past what the invoice still allows is refused too
    const c = await newNote(3000, true);
    const up = await override(sa, c._id, { reason: "x", changes: { isFullCredit: false, lineItems: [line(4000)] } });
    expect(up.status).toBe(400);
    expect((await doc(c._id)).grandTotal).toBe(3000);
    expect(await credited()).toBe(11000);
    expect(a).toBeTruthy();
  });

  it("reason required; nothing-to-change refused; date before the invoice refused; bad status refused", async () => {
    const n = await newNote(1000, true);
    expect((await override(sa, n._id, { changes: { notes: "x" } })).status).toBe(400);
    expect((await override(sa, n._id, { reason: "  ", changes: { notes: "x" } })).status).toBe(400);
    expect((await override(sa, n._id, { reason: "x", changes: {} })).status).toBe(400);
    expect((await override(sa, n._id, { reason: "x", changes: { creditNoteDate: istDay(Date.now() - 31 * DAY) } })).status).toBe(400);
    expect((await override(sa, n._id, { reason: "x", changes: { status: "VOID" } })).status).toBe(400);
    expect((await override(sa, n._id, { reason: "x", changes: { gstReasonCode: "09" } })).status).toBe(400);
    const d = await doc(n._id);
    expect(d.notes).toBeUndefined();
    expect(d.editHistory.filter((h: any) => h.override)).toHaveLength(0);
    expect(pdf.generateCreditNotePdf).toHaveBeenCalledTimes(1); // only the original issue
  });
});

describe("only Super Admin", () => {
  it("FULL and WRITE staff, tenant admins and look-alike role fields get 403; nothing changes", async () => {
    const n = await newNote("full", true);
    const refused = [
      await person(["EMPLOYEE"], HOUSE, { creditnotes: "FULL" }),
      await person(["EMPLOYEE"], HOUSE, { creditnotes: "WRITE" }),
      await person(["ADMIN"], HOUSE, { creditnotes: "FULL" }),
      await person(["TENANT_ADMIN"], String(WS), { creditnotes: "FULL" }),
      await person(["EMPLOYEE"], HOUSE, { creditnotes: "FULL" }, { hrmsAccessRole: "SUPERADMIN" }),
      await person(["SUPERADMIN"], HOUSE, {}, { _demoImpersonation: true }),
    ];
    for (const who of refused) {
      const r = await override(who, n._id, { reason: "x", changes: { status: "CANCELLED" } });
      expect(r.status).toBe(403);
    }
    expect((await doc(n._id)).status).toBe("ISSUED");
    expect(await credited()).toBe(11800);
  });
});
