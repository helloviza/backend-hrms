// apps/backend/src/routes/invoices.layoutChange.test.ts
//
// 1. Bulk generate ("1 invoice / booking") follows the client's Default
//    invoice layout when the popup sends none, under the /generate rules
//    (All-inclusive only for a Registered or Unregistered client); a sent
//    layout wins. Figures are those of a Separate bulk run.
// 2. Staff "Change layout" (POST /:id/layout): presentation only — invoice
//    number, totals, GST split and (Separate ↔ All-inclusive) the stored lines
//    are identical before and after. DRAFT allowed; SENT needs confirmSent and
//    is logged; PAID / CANCELLED / PAYMENT_DECLARED refused; the stored PDF is
//    rendered again; invoices WRITE required.
//
// Real: invoices router, generation service, PDF renderer, models, in-memory
//   Mongo. Stubbed: requireAuth / requireWorkspace (headers) and the S3 upload
//   of the PDF (storeInvoicePdf).
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
vi.mock("../middleware/requireWorkspace.js", async (orig) => ({
  ...(await orig<any>()),
  requireWorkspace: (req: any, _res: any, next: any) => {
    const id = String(req.headers["x-test-ws"] || "");
    req.workspaceId = id;
    req.workspaceObjectId = new mongoose.Types.ObjectId(id);
    next();
  },
}));
vi.mock("../utils/invoicePdfStore.js", async (orig) => ({
  ...(await orig<any>()),
  storeInvoicePdf: vi.fn(async (no: string) => `https://s3.test/invoices/${no}.pdf`),
}));

const { default: invoicesRouter } = await import("./invoices.js");
const { generateInvoicePdf } = await import("../utils/invoicePdf.js");
const pdfStore = await import("../utils/invoicePdfStore.js");
const { default: Customer } = await import("../models/Customer.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");
const { UserPermission } = await import("../models/UserPermission.js");
const PDFDocument = (await import("pdfkit")).default;

// Several tests render 2–4 PDFs each; under a full parallel run that can pass 5s.
vi.setConfig({ testTimeout: 30_000 });

const app = express();
app.use(express.json());
app.use("/api/admin/invoices", invoicesRouter);

let mongod: MongoMemoryReplSet;
const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const STAFF = new mongoose.Types.ObjectId();
const as = (r: request.Test, user: Record<string, unknown>) =>
  r.set("x-test-user", JSON.stringify(user)).set("x-test-ws", String(HOUSE));
const superAdmin = { _id: String(STAFF), id: String(STAFF), sub: String(STAFF), roles: ["SUPERADMIN"] };
const staff = (r: request.Test) => as(r, superAdmin);
const col = (n: string) => mongoose.connection.db!.collection(n);
const GSTIN_DL = "07AAHCM5991L1ZS";

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri("invoice-layout-change-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  vi.mocked(pdfStore.storeInvoicePdf).mockClear();
  await col("companysettings").insertOne({
    companyName: "Plumtrips", invoiceSeriesCadence: "annual", supplierState: "Karnataka",
    gstProfiles: [{ gstin: "29ABCDE1234F1Z5", state: "Karnataka", stateCode: "29", legalName: "Plumtrips KA", addressLine1: "", addressLine2: "", city: "Bengaluru", pincode: "560001", isDefault: true, active: true, invoiceSeriesPrefix: "" }],
  } as any);
});

async function company(fields: Record<string, unknown>) {
  const c: any = await Customer.create({ name: "Acme", legalName: "Acme", gstRegisteredState: "Karnataka", ...fields });
  await CustomerWorkspace.create({ customerId: String(c._id), companyName: c.legalName });
  return c;
}

let seq = 0;
async function booking(customerId: any, over: Record<string, any> = {}) {
  seq += 1;
  const b: any = await ManualBooking.create({
    workspaceId: customerId, bookedBy: STAFF, type: "FLIGHT", supplierName: "TBO", givenBy: "Ops",
    status: "CONFIRMED", bookingRef: `MB-LC-${seq}`,
    travelDate: new Date("2026-11-20T00:00:00Z"), passengers: [{ name: "Asha Rao", type: "ADULT" }],
    itinerary: { origin: "BLR", destination: "DEL", airline: "6E", flightNo: "6E-123" },
    // Cost 9,600 + fee 400 (GST 61.02 inside) = 10,000.
    pricing: { gstMode: "ON_MARKUP", gstPercent: 18, actualPrice: 9600, quotedPrice: 10000 },
    ...over,
  });
  return String(b._id);
}
const hotel = (customerId: any) => booking(customerId, {
  type: "HOTEL", itinerary: { hotelName: "Taj", city: "Delhi", checkIn: new Date("2026-11-20"), checkOut: new Date("2026-11-22") },
  pricing: { gstMode: "ON_MARKUP", gstPercent: 18, actualPrice: 4500, quotedPrice: 5000 },
});

const bulk = (bookingIds: string[], extra: Record<string, unknown> = {}) =>
  staff(request(app).post("/api/admin/invoices/bulk-generate")).send({ bookingIds, invoiceDate: "2026-11-18", ...extra });
const generate = (bookingIds: string[], invoiceFormat: string) =>
  staff(request(app).post("/api/admin/invoices/generate")).send({ bookingIds, invoiceDate: "2026-11-18", invoiceFormat });
const changeLayout = (id: string, body: Record<string, unknown>, user: Record<string, unknown> = superAdmin) =>
  as(request(app).post(`/api/admin/invoices/${id}/layout`), user).send(body);
const rawInvoice = (id: string) => col("invoices").findOne({ _id: new mongoose.Types.ObjectId(id) }) as Promise<any>;

/** Every stored figure a layout change must not touch (lines separately). */
const figures = (inv: any) => ({
  invoiceNo: inv.invoiceNo, status: inv.status, subtotal: inv.subtotal, totalGST: inv.totalGST, grandTotal: inv.grandTotal,
  supplyType: inv.supplyType, cgst: inv.cgstAmount, sgst: inv.sgstAmount, utgst: inv.utgstAmount, igst: inv.igstAmount,
  placeOfSupply: inv.placeOfSupply, invoiceDate: String(inv.invoiceDate), dueDate: String(inv.dueDate),
  bookingIds: (inv.bookingIds || []).map(String), clientGstin: inv.clientDetails?.gstin ?? "",
});
const lines = (inv: any) => (inv.lineItems || []).map((l: any) => [l.bookingRef, l.rowType, l.description, l.qty, l.rate, l.igst, l.amount]);
const sums = (inv: any) => ({
  amount: Math.round((inv.lineItems || []).reduce((s: number, l: any) => s + l.amount, 0) * 100),
  gst: Math.round((inv.lineItems || []).reduce((s: number, l: any) => s + (l.igst ?? 0), 0) * 100),
});

async function pdfText(inv: any): Promise<string[]> {
  const spy = vi.spyOn(PDFDocument.prototype as any, "text");
  try {
    const buf = await generateInvoicePdf(inv);
    expect(buf.length).toBeGreaterThan(1000);
    return spy.mock.calls.map((a: any[]) => String(a[0]));
  } finally {
    spy.mockRestore();
  }
}

describe("bulk generate follows the client's Default invoice layout", () => {
  it.each([
    ["Registered (CSTEP-like, inter-state IGST)", { gstStatus: "REGISTERED", gstNumber: GSTIN_DL, gstRegisteredState: "Delhi" }],
    ["Unregistered (B2C)", { gstStatus: "UNREGISTERED" }],
  ])("%s, default All-inclusive, no layout sent → every invoice All-inclusive, figures = Separate", async (_l, fields) => {
    const allC = await company({ legalName: "Default AI", defaultInvoiceLayout: "ALL_INCLUSIVE", ...fields });
    const sepC = await company({ legalName: "Default unset", ...fields });
    const allR = await bulk([await booking(allC._id), await booking(allC._id)]);
    const sepR = await bulk([await booking(sepC._id), await booking(sepC._id)]);
    expect(allR.status, JSON.stringify(allR.body)).toBe(201);
    expect(sepR.status, JSON.stringify(sepR.body)).toBe(201);
    expect(allR.body.generated).toHaveLength(2);
    expect(allR.body.failed).toEqual([]);

    for (let i = 0; i < 2; i++) {
      const a = await rawInvoice(allR.body.generated[i].invoiceId);
      const s = await rawInvoice(sepR.body.generated[i].invoiceId);
      expect(a.invoiceLayout).toBe("ALL_INCLUSIVE");
      expect(s.invoiceLayout).toBe("SEPARATE");
      const { invoiceNo: _a, bookingIds: _b, ...fa } = figures(a);
      const { invoiceNo: _c, bookingIds: _d, ...fs } = figures(s);
      expect(fa).toEqual(fs);
      expect(lines(a).map((l: any[]) => l.slice(1))).toEqual(lines(s).map((l: any[]) => l.slice(1)));
      expect(a.grandTotal).toBe(10000);
      const t = await pdfText(a);
      expect(t).toContain("Flight services");
      expect(t).not.toContain("Transaction Fees");
    }
  });

  it("a layout sent by the popup wins over the default", async () => {
    const c = await company({ legalName: "B2C", gstStatus: "UNREGISTERED", defaultInvoiceLayout: "ALL_INCLUSIVE" });
    const r = await bulk([await booking(c._id)], { invoiceFormat: "SEPARATE" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await rawInvoice(r.body.generated[0].invoiceId)).invoiceLayout).toBe("SEPARATE");
  });

  it("Combined: each invoice gets the per-category lines, same totals as Separate", async () => {
    const c = await company({ legalName: "Comb", gstStatus: "UNREGISTERED", defaultInvoiceLayout: "COMBINED" });
    const s = await company({ legalName: "Sep", gstStatus: "UNREGISTERED" });
    const cr = await bulk([await hotel(c._id)]);
    const sr = await bulk([await hotel(s._id)]);
    const ci = await rawInvoice(cr.body.generated[0].invoiceId);
    const si = await rawInvoice(sr.body.generated[0].invoiceId);
    expect(ci.invoiceLayout).toBe("COMBINED");
    const { invoiceNo: _a, bookingIds: _b, ...fc } = figures(ci);
    const { invoiceNo: _c, bookingIds: _d, ...fs } = figures(si);
    expect(fc).toEqual(fs);
    expect(sums(ci)).toEqual(sums(si));
    expect(lines(ci)).not.toEqual(lines(si));
  });

  it.each([
    ["sent All-inclusive", { gstStatus: "NOT_SET" }, { invoiceFormat: "ALL_INCLUSIVE" }],
    ["stale All-inclusive default", { gstStatus: "NOT_SET" }, {}],
  ])("client with GST status not set + %s → 400, nothing written", async (label, fields, extra) => {
    const c = await company({ legalName: "Unknown", ...fields });
    if (label.startsWith("stale")) await col("customers").updateOne({ _id: c._id }, { $set: { defaultInvoiceLayout: "ALL_INCLUSIVE" } });
    const id = await booking(c._id);
    const r = await bulk([id], extra);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("ALL_INCLUSIVE_NOT_ALLOWED");
    expect(await col("invoices").countDocuments({})).toBe(0);
    expect(((await ManualBooking.findById(id).lean()) as any).status).toBe("CONFIRMED");
  });

  it("no default and no layout sent → Separate (stored)", async () => {
    const c = await company({ legalName: "Plain", gstStatus: "NOT_SET" });
    const r = await bulk([await booking(c._id)]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await rawInvoice(r.body.generated[0].invoiceId)).invoiceLayout).toBe("SEPARATE");
  });

  it("an unknown layout → 400", async () => {
    const c = await company({ legalName: "X", gstStatus: "UNREGISTERED" });
    const r = await bulk([await booking(c._id)], { invoiceFormat: "FANCY" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("INVOICE_LAYOUT_INVALID");
  });
});

describe("Change layout", () => {
  async function separateDraft(fields: Record<string, unknown> = { gstStatus: "REGISTERED", gstNumber: GSTIN_DL, gstRegisteredState: "Delhi" }, n = 1) {
    const c = await company({ legalName: "CSTEP-like", ...fields });
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(i % 2 ? await hotel(c._id) : await booking(c._id));
    const r = await generate(ids, "SEPARATE");
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { customer: c, id: String(r.body.invoice._id) };
  }

  it("DRAFT Separate → All-inclusive → Separate: number, figures and lines identical; logged; PDF re-stored", async () => {
    const { id } = await separateDraft();
    const before = await rawInvoice(id);

    const r = await changeLayout(id, { layout: "ALL_INCLUSIVE" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.from).toBe("SEPARATE");
    expect(r.body.pdfUrl).toBe(`https://s3.test/invoices/${before.invoiceNo}.pdf`);
    expect(pdfStore.storeInvoicePdf).toHaveBeenCalledWith(before.invoiceNo, expect.any(Buffer));

    const after = await rawInvoice(id);
    expect(after.invoiceLayout).toBe("ALL_INCLUSIVE");
    expect(figures(after)).toEqual(figures(before));
    expect(lines(after)).toEqual(lines(before));
    const h = after.editHistory.at(-1);
    expect(h.fieldsChanged).toEqual(["invoiceLayout"]);
    expect(h.oldValues).toEqual({ invoiceLayout: "SEPARATE" });
    expect(h.newValues).toEqual({ invoiceLayout: "ALL_INCLUSIVE" });
    expect(String(h.editedBy)).toBe(String(STAFF));

    const t = await pdfText(after);
    expect(t).toContain("Flight services");
    expect(t).toContain("Amount inclusive of all taxes - IGST @18% ₹61.02");

    const back = await changeLayout(id, { layout: "SEPARATE" });
    expect(back.status).toBe(200);
    const again = await rawInvoice(id);
    expect(again.invoiceLayout).toBe("SEPARATE");
    expect(figures(again)).toEqual(figures(before));
    expect(lines(again)).toEqual(lines(before));
  });

  it("Separate ↔ Combined regroups the lines from the bookings; every stored figure identical", async () => {
    const { id } = await separateDraft({ gstStatus: "UNREGISTERED" }, 3);
    const before = await rawInvoice(id);

    const r = await changeLayout(id, { layout: "COMBINED" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const comb = await rawInvoice(id);
    expect(comb.invoiceLayout).toBe("COMBINED");
    expect(figures(comb)).toEqual(figures(before));
    expect(sums(comb)).toEqual(sums(before));
    expect(comb.lineItems.length).toBeLessThan(before.lineItems.length);
    expect(comb.editHistory.at(-1).fieldsChanged).toEqual(["invoiceLayout", "lineItems"]);

    // Combined → All-inclusive rebuilds the Separate lines exactly.
    const ai = await changeLayout(id, { layout: "ALL_INCLUSIVE" });
    expect(ai.status, JSON.stringify(ai.body)).toBe(200);
    const after = await rawInvoice(id);
    expect(after.invoiceLayout).toBe("ALL_INCLUSIVE");
    expect(figures(after)).toEqual(figures(before));
    expect(lines(after)).toEqual(lines(before));
  });

  it("a legacy invoice with no stored layout is treated by its lines (bulk Separate before this fix)", async () => {
    const { id } = await separateDraft();
    await col("invoices").updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $unset: { invoiceLayout: "" } });
    const before = await rawInvoice(id);
    const r = await changeLayout(id, { layout: "ALL_INCLUSIVE" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.from).toBe("SEPARATE");
    const after = await rawInvoice(id);
    expect(after.editHistory.at(-1).oldValues).toEqual({ invoiceLayout: null });
    expect(figures(after)).toEqual(figures(before));
    expect(lines(after)).toEqual(lines(before));
  });

  it("same layout → unchanged, nothing logged, no PDF write", async () => {
    const { id } = await separateDraft();
    const r = await changeLayout(id, { layout: "SEPARATE" });
    expect(r.status).toBe(200);
    expect(r.body.unchanged).toBe(true);
    expect((await rawInvoice(id)).editHistory ?? []).toHaveLength(0);
    expect(pdfStore.storeInvoicePdf).not.toHaveBeenCalled();
  });

  it("SENT: refused without confirmSent; with it, changed and logged as confirmed", async () => {
    const { id } = await separateDraft();
    await col("invoices").updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { status: "SENT", sentAt: new Date() } });
    const before = await rawInvoice(id);

    const no = await changeLayout(id, { layout: "ALL_INCLUSIVE" });
    expect(no.status).toBe(409);
    expect(no.body.error).toBe("CONFIRM_SENT_REQUIRED");
    expect(no.body.message).toMatch(/client may already have the old PDF/);
    expect((await rawInvoice(id)).invoiceLayout).toBe("SEPARATE");

    const yes = await changeLayout(id, { layout: "ALL_INCLUSIVE", confirmSent: true });
    expect(yes.status, JSON.stringify(yes.body)).toBe(200);
    const after = await rawInvoice(id);
    expect(after.status).toBe("SENT");
    expect(after.invoiceLayout).toBe("ALL_INCLUSIVE");
    expect(figures(after)).toEqual(figures(before));
    expect(after.editHistory.at(-1).newValues).toEqual({ invoiceLayout: "ALL_INCLUSIVE", sentInvoiceConfirmed: true });
  });

  it.each(["PAID", "CANCELLED", "PAYMENT_DECLARED"])("%s → 400, unchanged", async (status) => {
    const { id } = await separateDraft();
    await col("invoices").updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { status } });
    const r = await changeLayout(id, { layout: "ALL_INCLUSIVE", confirmSent: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("LAYOUT_CHANGE_NOT_ALLOWED");
    expect((await rawInvoice(id)).invoiceLayout).toBe("SEPARATE");
    expect(pdfStore.storeInvoicePdf).not.toHaveBeenCalled();
  });

  it("All-inclusive for a client whose GST status is not set → 400", async () => {
    const { id } = await separateDraft({ gstStatus: "NOT_SET" });
    const r = await changeLayout(id, { layout: "ALL_INCLUSIVE" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("ALL_INCLUSIVE_NOT_ALLOWED");
    // Combined is still allowed for that client.
    expect((await changeLayout(id, { layout: "COMBINED" })).status).toBe(200);
  });

  it("lines edited after generation → Combined refused (409), All-inclusive still allowed", async () => {
    const { id } = await separateDraft({ gstStatus: "UNREGISTERED" }, 2);
    const inv = await rawInvoice(id);
    // Move ₹100 from the first COST row to its fee row: same totals, different lines.
    const li = inv.lineItems.map((l: any) => ({ ...l }));
    li[0].amount -= 100; li[0].rate -= 100; li[1].amount += 100; li[1].rate += 100;
    await col("invoices").updateOne({ _id: inv._id }, { $set: { lineItems: li } });

    const r = await changeLayout(id, { layout: "COMBINED" });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("LAYOUT_LINES_EDITED");
    expect((await rawInvoice(id)).lineItems).toEqual(li);
    expect((await changeLayout(id, { layout: "ALL_INCLUSIVE" })).status).toBe(200);
  });

  it("invoices WRITE required: a READ-only staff member gets 403", async () => {
    const { id } = await separateDraft();
    const reader = new mongoose.Types.ObjectId();
    await UserPermission.create({
      userId: String(reader), email: `${reader}@t.local`, workspaceId: String(HOUSE), universe: "STAFF",
      level: { code: "L1", name: "Employee" }, modules: { invoices: { access: "READ", scope: "ALL" } }, grantedBy: "test",
    } as any);
    const r = await changeLayout(id, { layout: "ALL_INCLUSIVE" }, { _id: String(reader), id: String(reader), sub: String(reader), roles: ["ADMIN"] });
    expect(r.status).toBe(403);
    expect((await rawInvoice(id)).invoiceLayout).toBe("SEPARATE");
  });

  describe("cut-off: generated before 17 Nov 2026 00:00 IST", () => {
    const setGenerated = (id: string, at: string, extra: Record<string, unknown> = {}) =>
      col("invoices").updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { generatedAt: new Date(at), createdAt: new Date(at), ...extra } });

    it("generated 16 Nov 23:59 IST → refused; nothing written, no PDF, no history", async () => {
      const { id } = await separateDraft();
      await setGenerated(id, "2026-11-16T18:29:00.000Z");
      await col("invoices").updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $unset: { invoiceLayout: "" } });
      const before = await rawInvoice(id);
      const r = await changeLayout(id, { layout: "ALL_INCLUSIVE" });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("GENERATED_BEFORE_CUTOFF");
      expect(r.body.message).toBe("Generated before 17 Nov 2026");
      const after = await rawInvoice(id);
      expect(after).toEqual(before);
      expect("invoiceLayout" in after).toBe(false);
      expect(pdfStore.storeInvoicePdf).not.toHaveBeenCalled();
    });

    it("generated 17 Nov 00:00 IST → allowed", async () => {
      const { id } = await separateDraft();
      await setGenerated(id, "2026-11-16T18:30:00.000Z");
      const r = await changeLayout(id, { layout: "ALL_INCLUSIVE" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect((await rawInvoice(id)).invoiceLayout).toBe("ALL_INCLUSIVE");
    });

    it("reissued: generated after the cut-off but dated earlier → allowed", async () => {
      const { id } = await separateDraft();
      await setGenerated(id, "2026-11-18T05:00:00.000Z", { invoiceDate: new Date("2026-10-01T00:00:00.000Z") });
      const r = await changeLayout(id, { layout: "ALL_INCLUSIVE" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const after = await rawInvoice(id);
      expect(after.invoiceLayout).toBe("ALL_INCLUSIVE");
      expect(after.invoiceDate.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    });
  });

  it("an unknown layout → 400; a missing invoice → 404", async () => {
    const { id } = await separateDraft();
    expect((await changeLayout(id, { layout: "FANCY" })).status).toBe(400);
    expect((await changeLayout(String(new mongoose.Types.ObjectId()), { layout: "SEPARATE" })).status).toBe(404);
  });
});

describe("bulk Change layout (POST /bulk-layout)", () => {
  const bulkLayout = (body: Record<string, unknown>, user: Record<string, unknown> = superAdmin) =>
    as(request(app).post("/api/admin/invoices/bulk-layout"), user).send(body);
  const oid = (id: string) => new mongoose.Types.ObjectId(id);

  it("mixed selection: changed / skipped with reasons; one combined confirm for SENT; figures untouched", async () => {
    const reg = await company({ legalName: "CSTEP-like", gstStatus: "REGISTERED", gstNumber: GSTIN_DL, gstRegisteredState: "Delhi" });
    const notSet = await company({ legalName: "No status", gstStatus: "NOT_SET" });
    const mk = async (c: any, fmt = "SEPARATE") => String((await generate([await booking(c._id)], fmt)).body.invoice._id);
    const ids = {
      draft: await mk(reg), sent: await mk(reg), paid: await mk(reg), cancelled: await mk(reg),
      old: await mk(reg), notSet: await mk(notSet), already: await mk(reg, "ALL_INCLUSIVE"),
    };
    await col("invoices").updateOne({ _id: oid(ids.sent) }, { $set: { status: "SENT", sentAt: new Date() } });
    await col("invoices").updateOne({ _id: oid(ids.paid) }, { $set: { status: "PAID" } });
    await col("invoices").updateOne({ _id: oid(ids.cancelled) }, { $set: { status: "CANCELLED" } });
    await col("invoices").updateOne({ _id: oid(ids.old) }, { $set: { generatedAt: new Date("2026-11-10T06:00:00Z"), createdAt: new Date("2026-11-10T06:00:00Z") }, $unset: { invoiceLayout: "" } });
    const missing = String(new mongoose.Types.ObjectId());
    const all = [...Object.values(ids), missing];
    const before = new Map<string, any>();
    for (const id of Object.values(ids)) before.set(id, await rawInvoice(id));

    // Without the confirm: refused as a whole, nothing changed.
    const no = await bulkLayout({ invoiceIds: all, layout: "ALL_INCLUSIVE" });
    expect(no.status).toBe(409);
    expect(no.body.error).toBe("CONFIRM_SENT_REQUIRED");
    expect(no.body.sentInvoiceNos).toEqual([before.get(ids.sent).invoiceNo]);
    for (const id of Object.values(ids)) expect(await rawInvoice(id)).toEqual(before.get(id));
    expect(pdfStore.storeInvoicePdf).not.toHaveBeenCalled();

    const r = await bulkLayout({ invoiceIds: all, layout: "ALL_INCLUSIVE", confirmSent: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.changed.map((c: any) => c.invoiceId).sort()).toEqual([ids.draft, ids.sent].sort());
    expect(r.body.failed).toEqual([]);
    const reason = Object.fromEntries(r.body.skipped.map((s: any) => [s.invoiceId, s.reason]));
    expect(reason[ids.old]).toBe("Generated before 17 Nov 2026");
    expect(reason[ids.paid]).toMatch(/Draft or Sent invoice only \(this one is PAID\)/);
    expect(reason[ids.cancelled]).toMatch(/this one is CANCELLED/);
    expect(reason[ids.notSet]).toMatch(/needs the client's GST status/);
    expect(reason[ids.already]).toBe("Already All-inclusive");
    expect(reason[missing]).toBe("Invoice not found");
    expect(r.body.skipped).toHaveLength(6);

    for (const id of [ids.draft, ids.sent]) {
      const after = await rawInvoice(id);
      expect(after.invoiceLayout).toBe("ALL_INCLUSIVE");
      expect(figures(after)).toEqual(figures(before.get(id)));
      expect(lines(after)).toEqual(lines(before.get(id)));
      expect(after.editHistory).toHaveLength((before.get(id).editHistory ?? []).length + 1);
      expect(pdfStore.storeInvoicePdf).toHaveBeenCalledWith(after.invoiceNo, expect.any(Buffer));
    }
    expect((await rawInvoice(ids.sent)).editHistory.at(-1).newValues.sentInvoiceConfirmed).toBe(true);
    expect(pdfStore.storeInvoicePdf).toHaveBeenCalledTimes(2);
    // Skipped invoices untouched — the pre-cut-off one gets no layout value at all.
    for (const id of [ids.paid, ids.cancelled, ids.old, ids.notSet, ids.already]) expect(await rawInvoice(id)).toEqual(before.get(id));
    expect("invoiceLayout" in (await rawInvoice(ids.old))).toBe(false);
  });

  it("no SENT invoice in the selection → no confirm needed", async () => {
    const c = await company({ legalName: "B2C", gstStatus: "UNREGISTERED" });
    const id = String((await generate([await booking(c._id)], "SEPARATE")).body.invoice._id);
    const r = await bulkLayout({ invoiceIds: [id], layout: "COMBINED" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.changed).toHaveLength(1);
  });

  it("invoices WRITE required; bad input → 400", async () => {
    const reader = new mongoose.Types.ObjectId();
    await UserPermission.create({
      userId: String(reader), email: `${reader}@t.local`, workspaceId: String(HOUSE), universe: "STAFF",
      level: { code: "L1", name: "Employee" }, modules: { invoices: { access: "READ", scope: "ALL" } }, grantedBy: "test",
    } as any);
    const id = String(new mongoose.Types.ObjectId());
    expect((await bulkLayout({ invoiceIds: [id], layout: "SEPARATE" }, { _id: String(reader), id: String(reader), sub: String(reader), roles: ["ADMIN"] })).status).toBe(403);
    expect((await bulkLayout({ invoiceIds: [], layout: "SEPARATE" })).status).toBe(400);
    expect((await bulkLayout({ invoiceIds: [id], layout: "FANCY" })).status).toBe(400);
  });
});
