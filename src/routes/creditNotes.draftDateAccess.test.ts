// apps/backend/src/routes/creditNotes.draftDateAccess.test.ts
//
// Credit notes — Access Console grant, save as draft, draft edits, the credit-note
// date, issue re-checks, cancel → reissue, and the READ/WRITE/FULL split.
//
//   • Credit Notes is offered in /admin/access under the key the API checks
//     ("creditnotes"), and a grant made there opens the API end to end;
//   • a DRAFT renders no PDF and leaves the invoice's credited total alone;
//   • editing a draft's amount / date / notes recomputes GST as at creation,
//     keeps the number, and logs who / when / old → new;
//   • amount and date out of range are refused on edit AND at issue;
//   • issuing a draft keeps its number, credits the invoice, and the PDF is
//     rendered with the chosen date;
//   • cancelling releases the amount so a corrected note can be issued;
//   • ISSUED / CANCELLED notes stay locked;
//   • WRITE drafts and edits, only FULL (and Super Admin) issues and cancels.
//
// Real: creditNotes + permissions routers, requireAdmin, requirePermission,
//   models, in-memory Mongo. Stubbed: requireAuth (x-test-user header), the
//   access-console door, S3 upload, the PDF renderer (a spy), task automation.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import fs from "node:fs";
import path from "node:path";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

vi.mock("../middleware/auth.js", () => {
  const requireAuth = (req: any, _res: any, next: any) => {
    req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
    next();
  };
  return { requireAuth, default: requireAuth };
});
vi.mock("../middleware/requireAccessConsole.js", () => ({
  requireAccessConsole: (_req: any, _res: any, next: any) => next(),
  requireAccessConsoleWrite: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireWorkspace.js", () => ({
  requireWorkspace: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../middleware/requireSuperAdmin.js", () => ({
  requireSuperAdmin: (_req: any, _res: any, next: any) => next(),
}));
const pdf = vi.hoisted(() => ({
  generateCreditNotePdf: vi.fn(async (_cn: any) => Buffer.from("%PDF-test")),
}));
vi.mock("../utils/creditNotePdf.js", () => pdf);
vi.mock("../utils/s3Upload.js", () => ({
  uploadAndPresign: vi.fn(async (key: string) => `https://s3.test/${key}`),
}));
vi.mock("../services/taskAutomation.js", () => ({
  triggerTaskAutomation: vi.fn(async () => undefined),
}));

const { default: creditNotesRouter } = await import("./creditNotes.js");
const { default: permissionsRouter } = await import("./permissions.js");
const { MODULE_FEATURE_MAP, isModuleGrantable } = await import("../utils/featureToModules.js");
const { UserPermission } = await import("../models/UserPermission.js");

const oid = (s?: string) => new mongoose.Types.ObjectId(s);
const col = (n: string) => mongoose.connection.db!.collection(n);

const WS = oid();
const SA = oid();
const INV = oid();
const REASON = oid();
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_MS = 5.5 * 60 * 60 * 1000;
const istDay = (at: number | Date = Date.now()) => new Date(new Date(at).getTime() + IST_MS).toISOString().slice(0, 10);
const TODAY = istDay();
const INVOICE_DAY = istDay(Date.now() - 30 * DAY_MS);
const MID_DAY = istDay(Date.now() - 10 * DAY_MS);

const app = express();
app.use(express.json());
app.use("/api/admin/credit-notes", creditNotesRouter);
app.use("/api/permissions", (req: any, _res: any, next: any) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  req.isPlatformSuperAdmin = true;
  req.workspaceObjectId = WS;
  next();
}, permissionsRouter);

type Who = { _id: string; roles: string[]; email?: string };
const saUser: Who = { _id: String(SA), roles: ["SUPERADMIN"], email: "sa@plumtrips.com" };
const as = (who: Who, r: request.Test) =>
  r.set("x-test-user", JSON.stringify({ ...who, id: who._id, sub: who._id }));

// A real grant through POST /api/permissions/grant (what /admin/access sends),
// then the user's roles read back from the DB — the token would carry those.
async function grantedUser(email: string, access: "READ" | "WRITE" | "FULL"): Promise<Who> {
  const u = await col("users").insertOne({ email, name: email.split("@")[0], roles: ["EMPLOYEE"], workspaceId: WS } as any);
  const res = await as(saUser, request(app).post("/api/permissions/grant")).send({
    email, universe: "STAFF", levelCode: "L5", workspaceId: String(WS),
    modules: { creditnotes: { access, scope: "ALL" } },
  });
  expect(res.status).toBe(200);
  const doc = await col("users").findOne({ _id: u.insertedId });
  return { _id: String(u.insertedId), roles: doc!.roles, email };
}

let full: Who;
let write: Who;

const createBody = (extra: Record<string, unknown> = {}) => ({
  originalInvoiceId: String(INV), reasonId: String(REASON), isFullCredit: true, ...extra,
});
const partialLine = (creditedAmount: number) => ({
  bookingRef: "B1", rowType: "COST", description: "Flight DEL-BOM", creditedAmount,
});
const invoiceDoc = () => col("invoices").findOne({ _id: INV });

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("credit-notes-draft-date-access-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

beforeEach(async () => {
  for (const c of ["invoices", "creditnotes", "creditnotereasons", "users", "userpermissions", "counters"]) await col(c).deleteMany({});
  pdf.generateCreditNotePdf.mockClear();
  await col("users").insertOne({ _id: SA, email: "sa@plumtrips.com", name: "Imran Ali", roles: ["SUPERADMIN"] } as any);
  await col("creditnotereasons").insertOne({
    _id: REASON, category: "FLIGHT", reason: "Flight cancelled", code: "FLT_CANCEL",
    gstReasonCode: "01", gstReasonText: "Sales Return", isActive: true, displayOrder: 1,
  } as any);
  await col("invoices").insertOne({
    _id: INV, invoiceNo: "INV-20260001", workspaceId: WS, status: "SENT",
    invoiceDate: new Date(`${INVOICE_DAY}T00:00:00.000Z`), generatedAt: new Date(`${INVOICE_DAY}T00:00:00.000Z`),
    grandTotal: 11800, supplyType: "IGST",
    issuerDetails: { companyName: "Plumtrips", gstin: "" }, clientDetails: { companyName: "Acme Corp" },
    lineItems: [{ bookingRef: "B1", rowType: "COST", description: "Flight DEL-BOM", qty: 1, rate: 10000, igst: 1800, amount: 11800 }],
  } as any);
  full = await grantedUser("finance.full@plumtrips.com", "FULL");
  write = await grantedUser("finance.write@plumtrips.com", "WRITE");
});

describe("Access Console — Credit Notes is grantable", () => {
  it("/admin/access lists Credit Notes under the key the API checks, gated like the API (invoicesEnabled)", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../../../frontend/src/pages/admin/access/AccessConsole.tsx"), "utf8");
    expect(src).toMatch(/\{\s*key:\s*"creditnotes",\s*label:\s*"Credit Notes"\s*\}/);
    expect(src).toMatch(/creditnotes:\s*\["invoicesEnabled"\]/);
    expect(MODULE_FEATURE_MAP.creditnotes).toEqual(["invoicesEnabled"]);
    expect(isModuleGrantable("creditnotes", { _id: oid(), config: { features: { invoicesEnabled: true } } } as any)).toBe(true);
    expect(isModuleGrantable("creditnotes", { _id: oid(), config: { features: { invoicesEnabled: false } } } as any)).toBe(false);
  });

  it("a grant saved from the console stores creditnotes and opens the API", async () => {
    const perm = await UserPermission.findOne({ userId: write._id }).lean();
    expect((perm as any).modules.creditnotes).toMatchObject({ access: "WRITE", scope: "ALL" });
    expect((await as(write, request(app).get("/api/admin/credit-notes"))).status).toBe(200);
  });

  it("updating another module leaves an existing credit-note grant unchanged", async () => {
    const res = await as(saUser, request(app).patch("/api/permissions/update")).send({
      userId: write._id, modules: { invoices: { access: "READ", scope: "ALL" } },
    });
    expect(res.status).toBe(200);
    const perm = await UserPermission.findOne({ userId: write._id }).lean();
    expect((perm as any).modules.creditnotes).toMatchObject({ access: "WRITE", scope: "ALL" });
  });

  it("no grant → 403 on the API", async () => {
    const u = await col("users").insertOne({ email: "nobody@plumtrips.com", roles: ["HR"] } as any);
    const who = { _id: String(u.insertedId), roles: ["HR"] };
    expect((await as(who, request(app).get("/api/admin/credit-notes"))).status).toBe(403);
  });
});

describe("Save as draft", () => {
  it("creates a DRAFT with a number; no PDF; invoice credited total untouched", async () => {
    const res = await as(write, request(app).post("/api/admin/credit-notes")).send(createBody({ creditNoteDate: MID_DAY }));
    expect(res.status).toBe(201);
    expect(res.body.creditNote.status).toBe("DRAFT");
    expect(res.body.creditNote.creditNoteNo).toMatch(/^CN-\d{8}$/);
    expect(istDay(res.body.creditNote.creditNoteDate)).toBe(MID_DAY);
    expect(pdf.generateCreditNotePdf).not.toHaveBeenCalled();
    expect((await invoiceDoc())!.creditedAmount).toBeUndefined();
  });

  it("date defaults to today (IST) when omitted", async () => {
    const res = await as(write, request(app).post("/api/admin/credit-notes")).send(createBody());
    expect(res.status).toBe(201);
    expect(istDay(res.body.creditNote.creditNoteDate)).toBe(TODAY);
  });

  it("refuses a date in the future, before the invoice, or not a date", async () => {
    const tomorrow = istDay(Date.now() + DAY_MS);
    const before = istDay(Date.now() - 31 * DAY_MS);
    for (const d of [tomorrow, before, "2026-02-31", "06/10/2026"]) {
      const res = await as(write, request(app).post("/api/admin/credit-notes")).send(createBody({ creditNoteDate: d }));
      expect(res.status, d).toBe(400);
    }
    expect(await col("creditnotes").countDocuments()).toBe(0);
  });
});

describe("Edit draft", () => {
  async function draft() {
    const res = await as(write, request(app).post("/api/admin/credit-notes")).send(createBody());
    return res.body.creditNote;
  }

  it("amount + date + notes: GST recomputed as at creation, number kept, every change logged", async () => {
    const cn = await draft();
    const res = await as(write, request(app).patch(`/api/admin/credit-notes/${cn._id}`)).send({
      isFullCredit: false, lineItems: [partialLine(5900)], creditNoteDate: MID_DAY,
      notes: "Corrected after airline refund", reasonNote: "Partial refund",
    });
    expect(res.status).toBe(200);
    const after = res.body.creditNote;
    expect(after.creditNoteNo).toBe(cn.creditNoteNo);
    expect(after).toMatchObject({ grandTotal: 5900, totalGST: 900, subtotal: 5000, igstAmount: 900, cgstAmount: 0, isFullCredit: false });
    expect(after.lineItems[0]).toMatchObject({ amount: 5900, igst: 900, originalAmount: 11800, creditedAmount: 5900 });
    expect(istDay(after.creditNoteDate)).toBe(MID_DAY);

    const entry = after.editHistory.at(-1);
    expect(String(entry.editedBy)).toBe(write._id);
    expect(entry.editedAt).toBeTruthy();
    expect(entry.fieldsChanged).toEqual(expect.arrayContaining(["creditNoteDate", "notes", "reasonNote", "lineItems", "totals"]));
    expect(entry.oldValues).toMatchObject({ creditNoteDate: TODAY, totals: { grandTotal: 11800 } });
    expect(entry.newValues).toMatchObject({ creditNoteDate: MID_DAY, totals: { grandTotal: 5900, totalGST: 900 } });

    // Draft edits never touch the invoice.
    expect((await invoiceDoc())!.creditedAmount).toBeUndefined();

    // GET names the editor (never the id).
    const one = await as(write, request(app).get(`/api/admin/credit-notes/${cn._id}`));
    expect(one.body.creditNote.editHistory.at(-1).editedByName).toBe("finance.write");
  });

  it("refuses out-of-range amount and date", async () => {
    const cn = await draft();
    const patch = (body: any) => as(write, request(app).patch(`/api/admin/credit-notes/${cn._id}`)).send(body);
    expect((await patch({ isFullCredit: false, lineItems: [partialLine(12000)] })).status).toBe(400); // > line
    expect((await patch({ isFullCredit: false, lineItems: [partialLine(0)] })).status).toBe(400);     // not > 0
    expect((await patch({ creditNoteDate: istDay(Date.now() + DAY_MS) })).status).toBe(400);
    expect((await patch({ creditNoteDate: istDay(Date.now() - 31 * DAY_MS) })).status).toBe(400);
    const still = await col("creditnotes").findOne({ _id: oid(cn._id) });
    expect(still!.grandTotal).toBe(11800);
    expect(istDay(still!.creditNoteDate)).toBe(TODAY);
  });

  it("amount must fit the invoice's remaining creditable amount (other ISSUED notes count, this draft does not)", async () => {
    const issued = (await as(full, request(app).post("/api/admin/credit-notes")).send(
      createBody({ isFullCredit: false, lineItems: [partialLine(8000)] }))).body.creditNote;
    expect((await as(full, request(app).post(`/api/admin/credit-notes/${issued._id}/issue`))).status).toBe(200);

    const d = (await as(write, request(app).post("/api/admin/credit-notes")).send(
      createBody({ isFullCredit: false, lineItems: [partialLine(3000)] }))).body.creditNote;
    const patch = (amt: number) => as(write, request(app).patch(`/api/admin/credit-notes/${d._id}`))
      .send({ isFullCredit: false, lineItems: [partialLine(amt)] });
    expect((await patch(3801)).status).toBe(400);
    expect((await patch(3800)).status).toBe(200);
  });
});

describe("Issue", () => {
  it("FULL issues a draft: number kept, invoice credited, PDF rendered with the chosen date", async () => {
    const d = (await as(write, request(app).post("/api/admin/credit-notes")).send(createBody({ creditNoteDate: MID_DAY }))).body.creditNote;
    const res = await as(full, request(app).post(`/api/admin/credit-notes/${d._id}/issue`));
    expect(res.status).toBe(200);
    expect(res.body.creditNote).toMatchObject({ status: "ISSUED", creditNoteNo: d.creditNoteNo });
    expect((await invoiceDoc())!.creditedAmount).toBe(11800);

    expect(pdf.generateCreditNotePdf).toHaveBeenCalledTimes(1);
    const rendered = pdf.generateCreditNotePdf.mock.calls[0][0];
    const at = new Date(rendered.creditNoteDate);
    // Stored at 12:00 IST: the same calendar day on the UTC server and in IST.
    expect(at.toISOString().slice(0, 10)).toBe(MID_DAY);
    expect(istDay(at)).toBe(MID_DAY);

    // Lists and exports show the chosen date.
    const list = await as(full, request(app).get("/api/admin/credit-notes"));
    expect(istDay(list.body.items[0].creditNoteDate)).toBe(MID_DAY);
    const csv = await as(full, request(app).get("/api/admin/credit-notes/export?format=csv"));
    expect(csv.text).toContain(at.toLocaleDateString("en-IN"));
  });

  it("re-runs every check: date now out of range, balance used up by a sibling, invoice no longer creditable", async () => {
    const a = (await as(write, request(app).post("/api/admin/credit-notes")).send(createBody())).body.creditNote;
    const b = (await as(write, request(app).post("/api/admin/credit-notes")).send(createBody())).body.creditNote;
    const issue = (id: string) => as(full, request(app).post(`/api/admin/credit-notes/${id}/issue`));

    // Date drifted out of range (e.g. an older draft) → refused, stays DRAFT.
    await col("creditnotes").updateOne({ _id: oid(a._id) }, { $set: { creditNoteDate: new Date(Date.now() - 40 * DAY_MS) } });
    expect((await issue(a._id)).status).toBe(400);
    await col("creditnotes").updateOne({ _id: oid(a._id) }, { $set: { creditNoteDate: new Date() } });

    expect((await issue(a._id)).status).toBe(200);
    const r = await issue(b._id); // full balance already credited by a
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/exceeds remaining creditable/);

    await col("creditnotes").deleteMany({});
    await col("invoices").updateOne({ _id: INV }, { $set: { status: "CANCELLED", creditedAmount: 0 } });
    const c = (await col("creditnotes").insertOne({
      creditNoteNo: "CN-X", workspaceId: WS, originalInvoiceId: INV, originalInvoiceNo: "INV-20260001",
      originalInvoiceDate: new Date(`${INVOICE_DAY}T00:00:00.000Z`), originalInvoiceAmount: 11800,
      serviceCategory: "FLIGHT", reasonId: REASON, reasonText: "x", gstReasonCode: "01", gstReasonText: "Sales Return",
      isFullCredit: true, lineItems: [{ amount: 100, creditedAmount: 100, originalAmount: 11800, description: "x" }],
      grandTotal: 100, status: "DRAFT", creditNoteDate: new Date(),
    } as any)).insertedId;
    expect((await issue(String(c))).status).toBe(400);
  });

  it("WRITE cannot issue or cancel (403); Super Admin can", async () => {
    const d = (await as(write, request(app).post("/api/admin/credit-notes")).send(createBody())).body.creditNote;
    expect((await as(write, request(app).post(`/api/admin/credit-notes/${d._id}/issue`))).status).toBe(403);
    expect((await as(saUser, request(app).post(`/api/admin/credit-notes/${d._id}/issue`))).status).toBe(200);
    expect((await as(write, request(app).post(`/api/admin/credit-notes/${d._id}/cancel`)).send({ reason: "x" })).status).toBe(403);
    expect((await as(saUser, request(app).post(`/api/admin/credit-notes/${d._id}/cancel`)).send({ reason: "Wrong amount" })).status).toBe(200);
  });
});

describe("Cancel → reissue, and locked notes", () => {
  it("cancelling releases the amount; a corrected note can be issued for the full remaining amount", async () => {
    const wrong = (await as(full, request(app).post("/api/admin/credit-notes")).send(createBody())).body.creditNote;
    await as(full, request(app).post(`/api/admin/credit-notes/${wrong._id}/issue`));
    expect((await invoiceDoc())!.creditedAmount).toBe(11800);

    const c = await as(full, request(app).post(`/api/admin/credit-notes/${wrong._id}/cancel`)).send({ reason: "Wrong date" });
    expect(c.status).toBe(200);
    expect((await invoiceDoc())!.creditedAmount).toBe(0);

    const fixed = await as(full, request(app).post("/api/admin/credit-notes")).send(createBody({ creditNoteDate: MID_DAY }));
    expect(fixed.status).toBe(201);
    expect(fixed.body.creditNote.grandTotal).toBe(11800);
    expect(fixed.body.creditNote.creditNoteNo).not.toBe(wrong.creditNoteNo);
    expect((await as(full, request(app).post(`/api/admin/credit-notes/${fixed.body.creditNote._id}/issue`))).status).toBe(200);
    expect((await invoiceDoc())!.creditedAmount).toBe(11800);
  });

  it("ISSUED and CANCELLED notes cannot be edited, re-issued or restored", async () => {
    const n = (await as(full, request(app).post("/api/admin/credit-notes")).send(createBody())).body.creditNote;
    await as(full, request(app).post(`/api/admin/credit-notes/${n._id}/issue`));
    const patch = () => as(full, request(app).patch(`/api/admin/credit-notes/${n._id}`)).send({ notes: "edit", creditNoteDate: MID_DAY });

    expect((await patch()).status).toBe(400);
    await as(full, request(app).post(`/api/admin/credit-notes/${n._id}/cancel`)).send({ reason: "x" });
    expect((await patch()).status).toBe(400);
    expect((await as(full, request(app).post(`/api/admin/credit-notes/${n._id}/issue`))).status).toBe(400);
    expect((await as(full, request(app).post(`/api/admin/credit-notes/${n._id}/cancel`)).send({ reason: "x" })).status).toBe(400);

    const doc = await col("creditnotes").findOne({ _id: oid(n._id) });
    expect(doc!.status).toBe("CANCELLED");
    expect(doc!.notes).toBeUndefined();
    expect((await invoiceDoc())!.creditedAmount).toBe(0);
  });
});
