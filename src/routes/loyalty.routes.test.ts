// apps/backend/src/routes/loyalty.routes.test.ts
//
// Loyalty Points — Phase 1 through the real routes:
//   1. every invoice / credit-note write site touches loyalty after it commits
//      (status, bulk marks, reverts, cancel, PATCH, add-bookings, generation,
//      declare-payment, CN issue incl. its PDF-failure rollback, CN cancel,
//      CN override), and a failing reconcile never fails the finance action
//   2. the staff admin API (routes/admin.loyalty.ts): the `loyalty` capability
//      gate (READ / FULL), HOUSE only, settings + change log, the start-date
//      lock (Super Admin + reason once passed), accounts list / detail,
//      link / unlink, manual adjustment, the customer "Rewards" endpoints
//
// Real: invoices + creditNotes + admin.loyalty routers, requireBillingStaff,
//   requireHouse, requirePermission / holdsCapability, models, the loyalty
//   engine, an in-memory REPLICA SET.
// Stubbed: requireAuth (x-test-user), requireWorkspace (x-test-ws), PDF
//   renderers, S3, task automation.
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
vi.mock("../middleware/requireWorkspace.js", async (importOriginal) => {
  const actual: any = await importOriginal();
  const requireWorkspace = (req: any, _res: any, next: any) => {
    const ws = String(req.headers["x-test-ws"] || "69679a7628330a58d29f2254");
    req.workspaceObjectId = new (require("mongoose").Types.ObjectId)(ws);
    req.workspaceId = ws;
    req.workspace = { _id: ws, customerId: String(req.headers["x-test-cust"] || "") };
    next();
  };
  return { ...actual, requireWorkspace, default: requireWorkspace };
});
vi.mock("../utils/invoicePdf.js", () => ({
  generateInvoicePdf: vi.fn(async () => Buffer.from("%PDF")),
  prefetchInvoiceAssets: vi.fn(async () => ({})),
}));
vi.mock("../utils/creditNotePdf.js", () => ({ generateCreditNotePdf: vi.fn(async () => Buffer.from("%PDF")) }));
vi.mock("../utils/s3Upload.js", () => ({ uploadAndPresign: vi.fn(async (k: string) => `https://s3.test/${k}`) }));
vi.mock("../services/taskAutomation.js", () => ({ triggerTaskAutomation: vi.fn(async () => undefined) }));

const { default: invoicesRouter, workspaceRouter: invoicesWorkspaceRouter } = await import("./invoices.js");
const { default: creditNotesRouter } = await import("./creditNotes.js");
const { default: adminLoyaltyRouter } = await import("./admin.loyalty.js");
const { requireHouse } = await import("../middleware/requireHouse.js");
const { generateCreditNotePdf } = await import("../utils/creditNotePdf.js");
const { UserPermission } = await import("../models/UserPermission.js");
const { default: Customer } = await import("../models/Customer.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");
const { default: LoyaltyAccount } = await import("../models/LoyaltyAccount.js");
const { default: LoyaltyLedger } = await import("../models/LoyaltyLedger.js");
const { default: LoyaltySettings } = await import("../models/LoyaltySettings.js");
const L = await import("../services/loyalty.js");
const { default: logger } = await import("../utils/logger.js");

const oid = (s?: string) => new mongoose.Types.ObjectId(s);
const col = (n: string) => mongoose.connection.db!.collection(n);
const HOUSE = "69679a7628330a58d29f2254";
const TENANT = oid();

const user = (roles: string[]) => { const id = String(oid()); return { _id: id, id, sub: id, roles }; };
const SA = user(["SUPERADMIN"]);
const FULL = user(["EMPLOYEE"]);
const READ = user(["EMPLOYEE"]);
const NONE = user(["EMPLOYEE"]);
const TENANT_FULL = user(["EMPLOYEE"]);
const LEADER = user(["WORKSPACE_LEADER"]);

const app = express();
app.use(express.json());
const wsHeader = (req: any, _res: any, next: any) => {
  const ws = String(req.headers["x-test-ws"] || HOUSE);
  req.workspaceObjectId = oid(ws);
  req.workspaceId = ws;
  next();
};
app.use("/api/admin/invoices", wsHeader, invoicesRouter);
app.use("/api/admin/credit-notes", wsHeader, creditNotesRouter);
app.use("/api/invoices/workspace", invoicesWorkspaceRouter);
app.use("/api/admin/loyalty", (req: any, _res, next) => {
  req.user = JSON.parse(String(req.headers["x-test-user"] || "{}"));
  next();
}, wsHeader, requireHouse, adminLoyaltyRouter);

const as = (u: any, r: request.Test, ws = HOUSE) => r.set("x-test-user", JSON.stringify(u)).set("x-test-ws", ws);
const inv = {
  put: (path: string, body: any) => as(SA, request(app).put(`/api/admin/invoices${path}`)).send(body),
  post: (path: string, body: any = {}) => as(SA, request(app).post(`/api/admin/invoices${path}`)).send(body),
  patch: (path: string, body: any) => as(SA, request(app).patch(`/api/admin/invoices${path}`)).send(body),
};
const cnPost = (path: string, body: any = {}) => as(SA, request(app).post(`/api/admin/credit-notes${path}`)).send(body);
const loy = {
  get: (u: any, path: string, ws = HOUSE) => as(u, request(app).get(`/api/admin/loyalty${path}`), ws),
  put: (u: any, path: string, body: any) => as(u, request(app).put(`/api/admin/loyalty${path}`)).send(body),
  patch: (u: any, path: string, body: any) => as(u, request(app).patch(`/api/admin/loyalty${path}`)).send(body),
  post: (u: any, path: string, body: any = {}) => as(u, request(app).post(`/api/admin/loyalty${path}`)).send(body),
};

const WS = oid();
const CUST = oid();
const REASON = oid();
const LAUNCH = new Date("2026-01-01T00:00:00+05:30");
const LINE = { bookingRef: "MB-OLD", rowType: "COST", description: "Flight", subDescription: "", qty: 1, rate: 10000, igst: 1800, amount: 11800, passengerNames: [], type: "FLIGHT" };

async function invoice(status: string, extra: Record<string, unknown> = {}) {
  const _id = oid();
  await col("invoices").insertOne({
    _id, invoiceNo: `INV-R-${String(_id).slice(-6)}`, workspaceId: WS, status,
    bookingIds: [], lineItems: [LINE], subtotal: 10000, totalGST: 1800, grandTotal: 11800,
    supplyType: "CGST_SGST", cgstAmount: 900, sgstAmount: 900, utgstAmount: 0, igstAmount: 0,
    issuerDetails: { gstin: "" }, clientDetails: { companyName: "Acme" }, editHistory: [],
    invoiceDate: new Date(Date.now() - 30 * 86400000), generatedAt: new Date(Date.now() - 30 * 86400000),
    createdAt: new Date(Date.now() - 30 * 86400000),
    ...(status === "SENT" || status === "PAID" || status === "PAYMENT_DECLARED" ? { sentAt: new Date() } : {}),
    ...(status === "PAID" ? { paidAt: new Date() } : {}),
    ...extra,
  } as any);
  return _id;
}

async function creditNote(invoiceId: mongoose.Types.ObjectId, status: string, grandTotal = 5900) {
  const _id = oid();
  const igst = +(1800 * grandTotal / 11800).toFixed(2);
  await col("creditnotes").insertOne({
    _id, creditNoteNo: `CN-R-${String(_id).slice(-6)}`, workspaceId: WS,
    originalInvoiceId: invoiceId, originalInvoiceNo: "INV-R", originalInvoiceDate: new Date(Date.now() - 30 * 86400000),
    originalInvoiceAmount: 11800, serviceCategory: "FLIGHT", reasonId: REASON, reasonText: "Flight cancelled",
    gstReasonCode: "01", gstReasonText: "Sales Return", gstReasonOverridden: false, isFullCredit: false,
    lineItems: [{ ...LINE, originalAmount: 11800, creditedAmount: grandTotal, amount: grandTotal, igst }],
    subtotal: grandTotal - igst, totalGST: igst, grandTotal,
    supplyType: "CGST_SGST", status, creditNoteDate: new Date(), generatedAt: new Date(), editHistory: [],
    issuerDetails: { gstin: "" }, clientDetails: { companyName: "Acme" },
    ...(status === "ISSUED" ? { issuedAt: new Date() } : {}),
  } as any);
  return _id;
}

async function holding(invoiceId?: unknown) {
  await L.loyaltyIdle();
  const rows: any[] = await LoyaltyLedger.find(invoiceId ? { invoiceId: String(invoiceId) } : {}).lean();
  const h: Record<string, number> = { ON_THE_WAY: 0, LOCKED: 0, READY: 0 };
  for (const r of rows) h[r.bucket] += r.points;
  return h;
}
const account = async () => { await L.loyaltyIdle(); return LoyaltyAccount.findOne({ memberCustomerIds: String(CUST) }).lean() as any; };

let mongod: MongoMemoryReplSet;
beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri("loyalty-routes-test"));
  await Promise.all([LoyaltyAccount.syncIndexes(), LoyaltyLedger.syncIndexes(), LoyaltySettings.syncIndexes()]);
}, 120_000);
afterAll(async () => { await L.loyaltyIdle(); await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  await L.loyaltyIdle();
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  L.__resetLoyaltyCaches();
  await col("customers").insertOne({ _id: CUST, name: "Acme", legalName: "Acme Pvt Ltd", gstNumber: "29AAACA1234A1Z5", gstStatus: "REGISTERED", panNumber: "AAACA1234A" } as any);
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(CUST), companyName: "Acme" } as any);
  await col("creditnotereasons").insertOne({ _id: REASON, category: "FLIGHT", reason: "Flight cancelled", code: "FLT",
    gstReasonCode: "01", gstReasonText: "Sales Return", isActive: true, displayOrder: 1 } as any);
  const perm = (u: any, access: string, ws = HOUSE) => ({
    userId: u._id, email: `${u._id}@x`, workspaceId: ws, universe: "STAFF", status: "active",
    level: { code: "L1", name: "x" }, modules: { loyalty: { access, scope: "ALL" } }, grantedBy: "test",
  });
  await UserPermission.create([perm(FULL, "FULL"), perm(READ, "READ"), perm(TENANT_FULL, "FULL", String(TENANT))] as any);
  await L.getLoyaltySettings();
  await LoyaltySettings.updateOne({ key: "global" }, { $set: { launchDate: LAUNCH } });
});

/* ───────────────────────────── 1. triggers ───────────────────────────── */

describe("invoice write sites touch loyalty", () => {
  it("PUT /:id/status DRAFT → SENT → PAID earns ON_THE_WAY then LOCKED", async () => {
    const id = await invoice("DRAFT");
    expect((await inv.put(`/${id}/status`, { status: "SENT" })).status).toBe(200);
    expect(await holding(id)).toEqual({ ON_THE_WAY: 100, LOCKED: 0, READY: 0 });
    expect((await inv.put(`/${id}/status`, { status: "PAID" })).status).toBe(200);
    expect(await holding(id)).toEqual({ ON_THE_WAY: 0, LOCKED: 100, READY: 0 });
  });

  it("bulk-mark-sent and bulk-mark-paid", async () => {
    const a = await invoice("DRAFT"); const b = await invoice("DRAFT");
    expect((await inv.post("/bulk-mark-sent", { ids: [String(a), String(b)] })).body.updated).toHaveLength(2);
    expect(await holding()).toEqual({ ON_THE_WAY: 200, LOCKED: 0, READY: 0 });
    expect((await inv.post("/bulk-mark-paid", { ids: [String(a)], paidAt: new Date().toISOString() })).body.updated).toHaveLength(1);
    expect(await holding(a)).toEqual({ ON_THE_WAY: 0, LOCKED: 100, READY: 0 });
  });

  it("revert-to-sent, revert-to-draft and cancel claw the points back", async () => {
    const id = await invoice("PAID");
    L.loyaltyTouch({ invoiceId: id });
    await L.loyaltyIdle();
    expect(await holding(id)).toEqual({ ON_THE_WAY: 0, LOCKED: 100, READY: 0 });
    expect((await inv.post(`/${id}/revert-to-sent`, { reason: "Bounced" })).status).toBe(200);
    expect(await holding(id)).toEqual({ ON_THE_WAY: 100, LOCKED: 0, READY: 0 });
    expect((await inv.post(`/${id}/revert-to-draft`, { reason: "Fix lines" })).status).toBe(200);
    expect(await holding(id)).toEqual({ ON_THE_WAY: 0, LOCKED: 0, READY: 0 });
    expect((await inv.put(`/${id}/status`, { status: "SENT" })).status).toBe(200);
    expect(await holding(id)).toEqual({ ON_THE_WAY: 100, LOCKED: 0, READY: 0 });
    expect((await inv.post(`/${id}/cancel`, { reason: "Duplicate" })).status).toBe(200);
    expect(await holding(id)).toEqual({ ON_THE_WAY: 0, LOCKED: 0, READY: 0 });
    const reasons = (await LoyaltyLedger.find({ invoiceId: String(id) }).lean()).map((r: any) => r.reason);
    expect(reasons[0]).toBe("EARN");
    expect(reasons.slice(1).every((r) => r === "STATUS_CHANGE")).toBe(true);
  });

  it("PATCH /:id and add-bookings (DRAFT) reconcile the account", async () => {
    const id = await invoice("DRAFT");
    expect((await inv.patch(`/${id}`, { notes: "edited" })).status).toBe(200);
    const a1 = await account();
    expect(a1.lastReconciledAt).toBeInstanceOf(Date);
    const b: any = await ManualBooking.create({
      workspaceId: CUST, bookedBy: oid(), type: "FLIGHT", supplierName: "TBO", givenBy: "Ops", status: "CONFIRMED",
      bookingRef: "MB-LOY-1", travelDate: new Date("2026-11-01T00:00:00Z"), passengers: [{ name: "Asha Rao", type: "ADULT" }],
      pricing: { gstMode: "ON_MARKUP", gstPercent: 18, actualPrice: 10000, quotedPrice: 11180 },
    });
    expect((await inv.post(`/${id}/add-bookings`, { bookingIds: [String(b._id)] })).status).toBe(200);
    const a2 = await account();
    expect(a2.lastReconciledAt.getTime()).toBeGreaterThan(a1.lastReconciledAt.getTime());
  });

  it("invoice generation creates the customer's account (a DRAFT earns nothing)", async () => {
    const c: any = await Customer.create({ name: "Gen Co", legalName: "Gen Co", gstRegisteredState: "Karnataka", gstNumber: "29AAACG1234A1Z5" });
    await CustomerWorkspace.create({ customerId: String(c._id), companyName: "Gen Co" });
    const b: any = await ManualBooking.create({
      workspaceId: c._id, bookedBy: oid(), type: "FLIGHT", supplierName: "TBO", givenBy: "Ops", status: "CONFIRMED",
      bookingRef: "MB-LOY-GEN", travelDate: new Date("2026-11-01T00:00:00Z"), passengers: [{ name: "Asha Rao", type: "ADULT" }],
      pricing: { gstMode: "ON_MARKUP", gstPercent: 18, actualPrice: 10000, quotedPrice: 11180 },
    });
    const r = await inv.post("/generate", { bookingIds: [String(b._id)] });
    expect(r.status).toBe(201);
    await L.loyaltyIdle();
    const a: any = await LoyaltyAccount.findOne({ memberCustomerIds: String(c._id) }).lean();
    expect(a).toBeTruthy();
    expect(a.name).toBe("Gen Co");
    expect(await LoyaltyLedger.countDocuments({ accountId: String(a._id) })).toBe(0);
    // Marking it SENT now earns.
    expect((await inv.put(`/${r.body.invoice._id}/status`, { status: "SENT" })).status).toBe(200);
    expect((await holding(r.body.invoice._id)).ON_THE_WAY).toBeGreaterThan(0);
  });

  it("customer declare-payment (SENT → PAYMENT_DECLARED) reconciles; points stay ON_THE_WAY", async () => {
    const id = await invoice("SENT");
    L.loyaltyTouch({ invoiceId: id });
    await L.loyaltyIdle();
    const before = (await account()).lastReconciledAt;
    const r = await request(app).put(`/api/invoices/workspace/${id}/declare-payment`)
      .set("x-test-user", JSON.stringify(LEADER)).set("x-test-ws", String(WS)).set("x-test-cust", String(CUST)).send({});
    expect(r.status).toBe(200);
    expect((await account()).lastReconciledAt.getTime()).toBeGreaterThan(before.getTime());
    expect(await holding(id)).toEqual({ ON_THE_WAY: 100, LOCKED: 0, READY: 0 });
  });

  it("a failing reconcile never fails the finance action", async () => {
    const id = await invoice("DRAFT");
    const err = vi.spyOn(logger, "error").mockImplementation((() => logger) as any);
    const agg = vi.spyOn(LoyaltyLedger, "aggregate").mockImplementation((() => { throw new Error("loyalty down"); }) as any);
    try {
      const r = await inv.put(`/${id}/status`, { status: "SENT" });
      expect(r.status).toBe(200);
      expect(r.body.invoice.status).toBe("SENT");
      await L.loyaltyIdle();
      expect(err).toHaveBeenCalledWith("[Loyalty] touch failed", expect.objectContaining({ message: "loyalty down" }));
    } finally { agg.mockRestore(); err.mockRestore(); }
    expect((await col("invoices").findOne({ _id: id }))!.status).toBe("SENT");
  });
});

describe("credit-note write sites touch loyalty", () => {
  it("CN /issue reduces the points; CN /cancel restores them", async () => {
    const id = await invoice("SENT");
    L.loyaltyTouch({ invoiceId: id });
    await L.loyaltyIdle();
    const cn = await creditNote(id, "DRAFT", 5900);
    expect((await cnPost(`/${cn}/issue`)).status).toBe(200);
    expect(await holding(id)).toEqual({ ON_THE_WAY: 50, LOCKED: 0, READY: 0 });
    expect((await cnPost(`/${cn}/cancel`, { reason: "Raised in error" })).status).toBe(200);
    expect(await holding(id)).toEqual({ ON_THE_WAY: 100, LOCKED: 0, READY: 0 });
    const reasons = (await LoyaltyLedger.find({ invoiceId: String(id) }).sort({ createdAt: 1, _id: 1 }).lean()).map((r: any) => r.reason);
    expect(reasons).toEqual(["EARN", "CREDIT_NOTE", "CREDIT_NOTE"]);
  });

  it("CN /issue whose PDF fails is rolled back — and loyalty ends where it started", async () => {
    const id = await invoice("PAID");
    L.loyaltyTouch({ invoiceId: id });
    await L.loyaltyIdle();
    expect(await holding(id)).toEqual({ ON_THE_WAY: 0, LOCKED: 100, READY: 0 });
    const cn = await creditNote(id, "DRAFT", 5900);
    vi.mocked(generateCreditNotePdf).mockRejectedValue(new Error("pdf down"));
    try {
      const r = await cnPost(`/${cn}/issue`);
      expect(r.status).toBe(500);
      expect(r.body.error).toBe("CREDIT_NOTE_ISSUE_PDF_FAILED");
    } finally { vi.mocked(generateCreditNotePdf).mockResolvedValue(Buffer.from("%PDF") as any); }
    expect(await holding(id)).toEqual({ ON_THE_WAY: 0, LOCKED: 100, READY: 0 });
    expect((await col("creditnotes").findOne({ _id: cn }))!.status).toBe("DRAFT");
  });

  it("CN /override (Super Admin) restoring a CANCELLED note reduces the points", async () => {
    const id = await invoice("SENT");
    L.loyaltyTouch({ invoiceId: id });
    await L.loyaltyIdle();
    const cn = await creditNote(id, "CANCELLED", 5900);
    const r = await cnPost(`/${cn}/override`, { reason: "Cancelled by mistake", changes: { status: "ISSUED" } });
    expect(r.status).toBe(200);
    expect(await holding(id)).toEqual({ ON_THE_WAY: 50, LOCKED: 0, READY: 0 });
  });
});

/* ───────────────────────────── 2. admin API ───────────────────────────── */

describe("admin API — access", () => {
  it("needs the loyalty capability: none → 403, READ can view, FULL can edit, Super Admin bypasses", async () => {
    expect((await loy.get(NONE, "/settings")).status).toBe(403);
    expect((await loy.get(READ, "/settings")).status).toBe(200);
    expect((await loy.put(READ, "/settings", { minRedemption: 2000 })).status).toBe(403);
    expect((await loy.put(FULL, "/settings", { minRedemption: 2000 })).status).toBe(200);
    expect((await loy.get(SA, "/accounts")).status).toBe(200);
  });

  it("is HOUSE only — a tenant user holding a FULL grant is refused", async () => {
    const r = await loy.get(TENANT_FULL, "/settings", String(TENANT));
    expect(r.status).toBe(403);
  });
});

describe("admin API — settings", () => {
  it("returns the PRD defaults, and logs every change (old → new, who)", async () => {
    await LoyaltySettings.deleteMany({});
    const g = await loy.get(READ, "/settings");
    expect(g.body.settings).toMatchObject({
      programmeEnabled: true, thresholdInr: 2_000_000, minRedemption: 1000,
      defaultCapPct: 25, validityMonths: 24, enrolBusinessesOnly: true, redemptionOpen: false,
    });
    expect(new Date(g.body.settings.launchDate).toISOString()).toBe("2026-10-31T18:30:00.000Z"); // 2026-11-01 00:00 IST
    expect(g.body.settings.rateHistory).toEqual([expect.objectContaining({ pointsPer100: 1, effectiveFrom: "2026-10-31T18:30:00.000Z" })]);
    const r = await loy.put(FULL, "/settings", { thresholdInr: 1_500_000, defaultCapPct: 30 });
    expect(r.body.changed.sort()).toEqual(["defaultCapPct", "thresholdInr"]);
    const log = (await loy.get(READ, "/settings")).body.changeLog;
    expect(log.map((l: any) => [l.field, l.old, l.new, l.by]).sort()).toEqual([
      ["defaultCapPct", 25, 30, FULL._id], ["thresholdInr", 2_000_000, 1_500_000, FULL._id],
    ]);
    expect((await loy.put(FULL, "/settings", { defaultCapPct: 101 })).status).toBe(400);
    const noRate = await loy.put(FULL, "/settings", { pointsPer100: 2 });
    expect(noRate.status).toBe(400);
    expect(noRate.body.error).toMatch(/settings\/rates/);
  });

  it("a future launch date may move further out with FULL; any start earlier than now needs a Super Admin + reason", async () => {
    await LoyaltySettings.updateOne({ key: "global" }, { $set: { launchDate: new Date(Date.now() + 10 * 86400000) } });
    expect((await loy.put(FULL, "/settings", { launchDate: "2027-01-01" })).status).toBe(200);
    // Future → past is now locked too (it would grant points back in time).
    expect((await loy.put(FULL, "/settings", { launchDate: "2026-03-01", reason: "x" })).status).toBe(403);
    expect((await loy.put(SA, "/settings", { launchDate: "2026-03-01" })).status).toBe(400);
    expect((await loy.put(SA, "/settings", { launchDate: "2026-03-01", reason: "Pilot start" })).status).toBe(200);
    await LoyaltySettings.updateOne({ key: "global" }, { $set: { launchDate: LAUNCH } }); // passed
    expect((await loy.put(FULL, "/settings", { launchDate: "2026-02-01", reason: "x" })).status).toBe(403);
    expect((await loy.put(SA, "/settings", { launchDate: "2026-02-01" })).status).toBe(400);
    const ok = await loy.put(SA, "/settings", { launchDate: "2026-02-01", reason: "Board approved an earlier start" });
    expect(ok.status).toBe(200);
    expect(new Date(ok.body.settings.launchDate).toISOString()).toBe("2026-01-31T18:30:00.000Z");
    const entry = (await loy.get(SA, "/settings")).body.changeLog[0];
    expect(entry).toMatchObject({ field: "launchDate", reason: "Board approved an earlier start", by: SA._id });
  });

  it("the enrolment rule is Super Admin + reason; the threshold stays FULL", async () => {
    expect((await loy.put(FULL, "/settings", { thresholdInr: 1_000_000 })).status).toBe(200);
    expect((await loy.put(FULL, "/settings", { enrolBusinessesOnly: false, reason: "x" })).status).toBe(403);
    expect((await loy.put(SA, "/settings", { enrolBusinessesOnly: false })).status).toBe(400);
    const ok = await loy.put(SA, "/settings", { enrolBusinessesOnly: false, reason: "Agents join the programme" });
    expect(ok.body.changed).toEqual(["enrolBusinessesOnly"]);
    const entry = (await loy.get(SA, "/settings")).body.changeLog[0];
    expect(entry).toMatchObject({ field: "enrolBusinessesOnly", old: true, new: false, reason: "Agents join the programme" });
  });

  it("redemptionOpen (clients can use points) is Super Admin + reason, and logged", async () => {
    expect((await loy.put(FULL, "/settings", { redemptionOpen: true, reason: "x" })).status).toBe(403);
    expect((await loy.put(SA, "/settings", { redemptionOpen: true })).status).toBe(400);
    expect((await loy.put(SA, "/settings", { redemptionOpen: "yes", reason: "x" })).status).toBe(400);
    const ok = await loy.put(SA, "/settings", { redemptionOpen: true, reason: "Redemption goes live" });
    expect(ok.body.changed).toEqual(["redemptionOpen"]);
    expect(ok.body.settings.redemptionOpen).toBe(true);
    const entry = (await loy.get(SA, "/settings")).body.changeLog[0];
    expect(entry).toMatchObject({ field: "redemptionOpen", old: false, new: true, reason: "Redemption goes live", by: SA._id });
    await LoyaltySettings.updateOne({ key: "global" }, { $set: { redemptionOpen: false } });
  });

  it("earn rates: Super Admin + reason, never back-dated, and never re-price existing invoices", async () => {
    const id = await invoice("SENT"); // created 30 days ago
    L.loyaltyTouch({ invoiceId: id });
    expect(await holding(id)).toEqual({ ON_THE_WAY: 100, LOCKED: 0, READY: 0 });

    expect((await loy.post(FULL, "/settings/rates", { pointsPer100: 3, reason: "x" })).status).toBe(403);
    expect((await loy.post(SA, "/settings/rates", { pointsPer100: 3 })).status).toBe(400);
    const back = await loy.post(SA, "/settings/rates", { pointsPer100: 3, reason: "x", effectiveFrom: "2026-01-01" });
    expect(back.status).toBe(400);
    expect(back.body.error).toMatch(/back-dated/);
    // Not before the seeded launch rate (2026-11-01 IST) either — history stays in date order.
    const early = await loy.post(SA, "/settings/rates", { pointsPer100: 3, reason: "x" });
    expect(early.status).toBe(400);
    expect(early.body.error).toMatch(/latest rate/);
    const ok = await loy.post(SA, "/settings/rates", { pointsPer100: 3, reason: "Festive season", effectiveFrom: "2026-11-15" });
    expect(ok.status).toBe(200);
    expect(ok.body.settings.rateHistory.map((r: any) => r.pointsPer100)).toEqual([1, 3]);

    const acct = await account();
    const rec = await loy.post(FULL, `/accounts/${acct._id}/reconcile`);
    expect(rec.body.result.rowsWritten).toBe(0);
    expect(await holding(id)).toEqual({ ON_THE_WAY: 100, LOCKED: 0, READY: 0 });
    // An invoice created after the new rate takes effect earns at it.
    const after = new Date("2026-11-20T10:00:00+05:30");
    const fresh = await invoice("DRAFT", { createdAt: after, invoiceDate: after });
    expect((await inv.put(`/${fresh}/status`, { status: "SENT" })).status).toBe(200);
    expect(await holding(fresh)).toEqual({ ON_THE_WAY: 300, LOCKED: 0, READY: 0 });
  });
});

describe("admin API — accounts", () => {
  it("lists accounts with balances, filters eligible / not, and shows the detail with its ledger", async () => {
    const id = await invoice("SENT");
    L.loyaltyTouch({ invoiceId: id });
    await L.loyaltyIdle();
    await L.loyaltyIdle();
    const list = await loy.get(READ, "/accounts");
    expect(list.body.accounts).toHaveLength(1);
    const a = list.body.accounts[0];
    expect(a).toMatchObject({ name: "Acme Pvt Ltd", balances: { onTheWay: 100, locked: 0, ready: 0 }, cumulativeInr: 10000, eligibleAt: null });
    expect(a.members).toEqual([{ customerId: String(CUST), name: "Acme Pvt Ltd" }]);
    expect((await loy.get(READ, "/accounts?eligible=yes")).body.accounts).toHaveLength(0);
    expect((await loy.get(READ, "/accounts?eligible=no")).body.accounts).toHaveLength(1);

    const d = await loy.get(READ, `/accounts/${a._id}`);
    expect(d.body.account.members[0]).toMatchObject({ customerId: String(CUST), enrolled: true });
    expect(d.body.ledger).toHaveLength(1);
    expect(d.body.ledger[0]).toMatchObject({ points: 100, bucket: "ON_THE_WAY", currentInvoiceNo: expect.stringMatching(/^INV-R-/) });
  });

  it("reconcile now, PATCH (logged), and the start-date override lock", async () => {
    await invoice("SENT");
    const acct = await L.ensureAccountForCustomer(String(CUST));
    expect((await loy.post(READ, `/accounts/${acct!._id}/reconcile`)).status).toBe(403);
    const rec = await loy.post(FULL, `/accounts/${acct!._id}/reconcile`);
    expect(rec.body.result.rowsWritten).toBe(1);

    // Disabling: the preview shows what it removes; a reason is required; the removal is logged.
    expect((await loy.get(READ, `/accounts/${acct!._id}/disable-preview`)).body.pointsRemoved).toEqual({ onTheWay: 100, locked: 0, ready: 0 });
    expect((await loy.patch(FULL, `/accounts/${acct!._id}`, { enabled: false })).status).toBe(400);
    const p = await loy.patch(FULL, `/accounts/${acct!._id}`, { enabled: false, capPctOverride: 40, reason: "Contract ended" });
    expect(p.body.changed.sort()).toEqual(["capPctOverride", "enabled"]);
    expect((await holding()).ON_THE_WAY).toBe(0);
    const dis = (await loy.get(READ, `/accounts/${acct!._id}`)).body.account.changeLog.find((c: any) => c.field === "enabled");
    expect(dis).toMatchObject({ old: true, new: false, reason: "Contract ended", detail: { pointsRemoved: { onTheWay: 100, locked: 0, ready: 0 } } });
    // Re-enabling needs no reason.
    expect((await loy.patch(FULL, `/accounts/${acct!._id}`, { enabled: true })).status).toBe(200);
    expect((await holding()).ON_THE_WAY).toBe(100);
    // The effective start (the passed launch date) is locked.
    expect((await loy.patch(FULL, `/accounts/${acct!._id}`, { startDateOverride: "2026-06-01" })).status).toBe(403);
    expect((await loy.patch(SA, `/accounts/${acct!._id}`, { startDateOverride: "2026-06-01" })).status).toBe(400);
    expect((await loy.patch(SA, `/accounts/${acct!._id}`, { startDateOverride: "2026-06-01", reason: "Joined mid-year" })).status).toBe(200);
    const d = await loy.get(READ, `/accounts/${acct!._id}`);
    expect(d.body.account.changeLog.map((c: any) => c.field)).toEqual(expect.arrayContaining(["enabled", "capPctOverride", "startDateOverride"]));
    expect(d.body.account.changeLog.find((c: any) => c.field === "startDateOverride").reason).toBe("Joined mid-year");
  });

  it("an account start override: future → further future is FULL; future → earlier than now is Super Admin + reason", async () => {
    const acct = await L.ensureAccountForCustomer(String(CUST));
    await LoyaltySettings.updateOne({ key: "global" }, { $set: { launchDate: new Date(Date.now() + 10 * 86400000) } });
    expect((await loy.patch(FULL, `/accounts/${acct!._id}`, { startDateOverride: "2027-03-01" })).status).toBe(200);
    expect((await loy.patch(FULL, `/accounts/${acct!._id}`, { startDateOverride: "2026-05-01", reason: "x" })).status).toBe(403);
    expect((await loy.patch(SA, `/accounts/${acct!._id}`, { startDateOverride: "2026-05-01" })).status).toBe(400);
    expect((await loy.patch(SA, `/accounts/${acct!._id}`, { startDateOverride: "2026-05-01", reason: "Early adopter" })).status).toBe(200);
  });

  it("link / unlink through the API, with PAN-sharing suggestions", async () => {
    const sib = oid();
    await col("customers").insertOne({ _id: sib, name: "Acme Haryana", gstNumber: "06AAACA1234A1Z1", gstStatus: "REGISTERED" } as any);
    const wsSib = oid();
    await col("customerworkspaces").insertOne({ _id: wsSib, customerId: String(sib) } as any);
    const sibInv = oid();
    await col("invoices").insertOne({ _id: sibInv, invoiceNo: "INV-SIB", workspaceId: wsSib, status: "PAID", subtotal: 50000, totalGST: 9000, grandTotal: 59000, invoiceDate: new Date(), createdAt: new Date() } as any);
    const acct = await L.ensureAccountForCustomer(String(CUST));

    const d = await loy.get(READ, `/accounts/${acct!._id}`);
    expect(d.body.suggestions).toEqual([{ customerId: String(sib), name: "Acme Haryana", pan: "AAACA1234A", accountId: null }]);

    expect((await loy.post(READ, `/accounts/${acct!._id}/link`, { customerId: String(sib) })).status).toBe(403);
    const l = await loy.post(FULL, `/accounts/${acct!._id}/link`, { customerId: String(sib) });
    expect(l.status).toBe(200);
    expect(await holding(sibInv)).toEqual({ ON_THE_WAY: 0, LOCKED: 500, READY: 0 });
    expect((await LoyaltyAccount.findById(acct!._id).lean())!.memberCustomerIds).toEqual([String(CUST), String(sib)]);

    const u = await loy.post(FULL, `/accounts/${acct!._id}/unlink`, { customerId: String(sib) });
    expect(u.status).toBe(200);
    const rows: any[] = await LoyaltyLedger.find({ invoiceId: String(sibInv) }).lean();
    expect(rows.filter((r) => r.accountId === String(acct!._id)).reduce((s, r) => s + r.points, 0)).toBe(0);
    expect(rows.filter((r) => r.accountId === u.body.newAccountId).reduce((s, r) => s + r.points, 0)).toBe(500);
    expect((await loy.post(FULL, `/accounts/${acct!._id}/unlink`, { customerId: String(CUST) })).status).toBe(400); // sole member
  });

  it("manual adjustment needs FULL and a reason; its bucket follows eligibility", async () => {
    const acct = await L.ensureAccountForCustomer(String(CUST));
    expect((await loy.post(READ, `/accounts/${acct!._id}/adjust`, { points: 10, reason: "x" })).status).toBe(403);
    expect((await loy.post(FULL, `/accounts/${acct!._id}/adjust`, { points: 10 })).status).toBe(400);
    expect((await loy.post(FULL, `/accounts/${acct!._id}/adjust`, { bucket: "READY", points: 10, reason: "x" })).status).toBe(400);
    const r = await loy.post(FULL, `/accounts/${acct!._id}/adjust`, { points: 10, reason: "Correction", idempotencyKey: "abc" });
    expect(r.body).toMatchObject({ ok: true, duplicate: false, moves: [{ bucket: "LOCKED", points: 10 }], balances: { onTheWay: 0, locked: 10, ready: 0 } });
    const again = await loy.post(FULL, `/accounts/${acct!._id}/adjust`, { points: 10, reason: "Correction", idempotencyKey: "abc" });
    expect(again.body).toMatchObject({ duplicate: true, balances: { locked: 10 } });
    expect((await loy.post(FULL, `/accounts/${acct!._id}/adjust`, { points: -11, reason: "Too much" })).status).toBe(400);
    const row: any = await LoyaltyLedger.findOne({ reason: "MANUAL" }).lean();
    expect(row).toMatchObject({ note: "Correction", createdBy: FULL._id, invoiceId: null });
  });
});

describe("admin API — customer Rewards endpoints", () => {
  it("shows no account until there is one; FULL can create it", async () => {
    const g = await loy.get(READ, `/customers/${CUST}`);
    expect(g.body).toMatchObject({ account: null, customer: { name: "Acme Pvt Ltd", enrolled: true } });
    expect((await loy.post(READ, `/customers/${CUST}/account`)).status).toBe(403);
    const c = await loy.post(FULL, `/customers/${CUST}/account`);
    expect(c.status).toBe(200);
    const g2 = await loy.get(READ, `/customers/${CUST}`);
    expect(String(g2.body.account._id)).toBe(c.body.accountId);
    expect((await loy.get(READ, "/customers/search?q=acme")).body.customers[0]).toMatchObject({ customerId: String(CUST), accountId: c.body.accountId });
  });
});
