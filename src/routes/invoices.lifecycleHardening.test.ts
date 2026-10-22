// apps/backend/src/routes/invoices.lifecycleHardening.test.ts
//
// Invoice / credit-note life-cycle hardening (prerequisite for loyalty
// points; docs/audits/loyalty-points-audit.md §2/§5/§6). Every status write
// goes through utils/invoiceLifecycle.ts, and no issued invoice can change
// value or disappear without a credit note or a recorded reason:
//   2. PUT /:id/status takes forward moves only; the rest name their route
//   3. bulk-mark-sent skips PAYMENT_DECLARED instead of pushing it to SENT
//   4. add-bookings is DRAFT-only, resolves both client-id forms, and
//      re-derives totals + GST split the way PATCH does
//   5. cancel refuses an invoice that has an ISSUED credit note
//   6. revert-to-draft refuses an invoice that has an ISSUED credit note
//   7. credit-note override won't ISSUE against a DRAFT / CANCELLED invoice
//      and re-checks the credit cap when amounts change
//   8. booking claim + invoice write are one transaction — two generations of one booking
//      yield one invoice, a lost race draws no number, a failed write leaves no claim
//
// Real: invoices + creditNotes routers, requireBillingStaff, in-memory REPLICA SET,
//   requirePermission, models, the generation service.
// Stubbed: requireAuth (x-test-user), workspace resolver (x-test-ws), PDF
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
vi.mock("../utils/invoicePdf.js", () => ({
  generateInvoicePdf: vi.fn(async () => Buffer.from("%PDF")),
  prefetchInvoiceAssets: vi.fn(async () => ({})),
}));
vi.mock("../utils/creditNotePdf.js", () => ({ generateCreditNotePdf: vi.fn(async () => Buffer.from("%PDF")) }));
vi.mock("../utils/s3Upload.js", () => ({ uploadAndPresign: vi.fn(async (k: string) => `https://s3.test/${k}`) }));
vi.mock("../services/taskAutomation.js", () => ({ triggerTaskAutomation: vi.fn(async () => undefined) }));

const { default: invoicesRouter } = await import("./invoices.js");
const { default: creditNotesRouter } = await import("./creditNotes.js");
const { createInvoiceFromBookings, claimBookingsForInvoice } = await import("../services/invoiceGeneration.service.js");
const { default: Customer } = await import("../models/Customer.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");
const { default: Invoice } = await import("../models/Invoice.js");

const oid = (s?: string) => new mongoose.Types.ObjectId(s);
const col = (n: string) => mongoose.connection.db!.collection(n);
const HOUSE = "69679a7628330a58d29f2254";
const SA_ID = oid();
const SA_USER = { _id: String(SA_ID), id: String(SA_ID), sub: String(SA_ID), roles: ["SUPERADMIN"], workspaceId: HOUSE };

const withWs = (req: any, _res: any, next: any) => {
  req.workspaceObjectId = oid(String(req.headers["x-test-ws"] || HOUSE));
  next();
};
const app = express();
app.use(express.json());
app.use("/api/admin/invoices", withWs, invoicesRouter);
app.use("/api/admin/credit-notes", withWs, creditNotesRouter);

const as = (r: request.Test) => r.set("x-test-user", JSON.stringify(SA_USER)).set("x-test-ws", HOUSE);
const put = (path: string, body: any) => as(request(app).put(`/api/admin/invoices${path}`)).send(body);
const post = (path: string, body: any = {}) => as(request(app).post(`/api/admin/invoices${path}`)).send(body);
const invDoc = async (id: mongoose.Types.ObjectId) => (await col("invoices").findOne({ _id: id }))!;

const WS = oid();
const CUST = oid();
const OTHER_CUST = oid();
const REASON = oid();

const LINE = { bookingRef: "MB-OLD", rowType: "COST", description: "Flight", subDescription: "", qty: 1, rate: 10000, igst: 1800, amount: 11800, passengerNames: [], type: "FLIGHT" };

async function invoice(status: string, extra: Record<string, unknown> = {}) {
  const _id = oid();
  await col("invoices").insertOne({
    _id, invoiceNo: `INV-T-${String(_id).slice(-6)}`, workspaceId: WS, status,
    bookingIds: [], lineItems: [LINE], subtotal: 10000, totalGST: 1800, grandTotal: 11800,
    supplyType: "CGST_SGST", cgstAmount: 900, sgstAmount: 900, utgstAmount: 0, igstAmount: 0,
    issuerDetails: { gstin: "" }, clientDetails: { companyName: "Acme" }, editHistory: [],
    invoiceDate: new Date(Date.now() - 30 * 86400000), generatedAt: new Date(Date.now() - 30 * 86400000),
    ...(status === "SENT" || status === "PAID" || status === "PAYMENT_DECLARED" ? { sentAt: new Date() } : {}),
    ...(status === "PAID" ? { paidAt: new Date() } : {}),
    ...extra,
  } as any);
  return _id;
}

async function creditNote(invoiceId: mongoose.Types.ObjectId, status: string, grandTotal = 11800, extra: Record<string, unknown> = {}) {
  const _id = oid();
  await col("creditnotes").insertOne({
    _id, creditNoteNo: `CN-T-${String(_id).slice(-6)}`, workspaceId: WS,
    originalInvoiceId: invoiceId, originalInvoiceNo: "INV-T", originalInvoiceDate: new Date(Date.now() - 30 * 86400000),
    originalInvoiceAmount: 11800, serviceCategory: "FLIGHT", reasonId: REASON, reasonText: "Flight cancelled",
    gstReasonCode: "01", gstReasonText: "Sales Return", gstReasonOverridden: false,
    isFullCredit: grandTotal === 11800,
    lineItems: [{ ...LINE, originalAmount: 11800, creditedAmount: grandTotal, amount: grandTotal, igst: +(1800 * grandTotal / 11800).toFixed(2) }],
    subtotal: grandTotal - +(1800 * grandTotal / 11800).toFixed(2), totalGST: +(1800 * grandTotal / 11800).toFixed(2), grandTotal,
    supplyType: "CGST_SGST", status, creditNoteDate: new Date(), generatedAt: new Date(), editHistory: [],
    issuerDetails: { gstin: "" }, clientDetails: { companyName: "Acme" },
    ...(status === "ISSUED" ? { issuedAt: new Date() } : {}),
    ...(status === "CANCELLED" ? { cancelledAt: new Date(), cancellationReason: "x" } : {}),
    ...extra,
  } as any);
  return _id;
}

// Through the model, not a raw insert: ManualBooking's pre-save hook derives
// the pricing fields (markup, GST) the invoice line builder reads.
let refSeq = 0;
async function booking(customerId: mongoose.Types.ObjectId, extra: Record<string, unknown> = {}) {
  refSeq += 1;
  const b: any = await ManualBooking.create({
    workspaceId: customerId, bookedBy: SA_ID, type: "FLIGHT", supplierName: "TBO", givenBy: "Ops",
    status: "CONFIRMED", bookingRef: `MB-LC-${refSeq}`,
    travelDate: new Date("2026-11-01T00:00:00Z"), passengers: [{ name: "Asha Rao", type: "ADULT" }],
    pricing: { gstMode: "ON_MARKUP", gstPercent: 18, actualPrice: 10000, quotedPrice: 11180 },
    ...extra,
  });
  return b._id as mongoose.Types.ObjectId;
}

let mongod: MongoMemoryReplSet;
beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); // generation runs in a transaction
  await mongoose.connect(mongod.getUri("invoice-lifecycle-hardening-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(CUST), companyName: "Acme" } as any);
  await col("creditnotereasons").insertOne({ _id: REASON, category: "FLIGHT", reason: "Flight cancelled", code: "FLT",
    gstReasonCode: "01", gstReasonText: "Sales Return", isActive: true, displayOrder: 1 } as any);
});

/* ── 2. PUT /:id/status ─────────────────────────────────────────────── */

describe("PUT /:id/status — forward moves only", () => {
  it.each([
    ["DRAFT", "SENT"],
    ["SENT", "PAID"],
    ["PAYMENT_DECLARED", "PAID"],
  ])("%s → %s succeeds", async (from, to) => {
    const id = await invoice(from);
    const r = await put(`/${id}/status`, { status: to, paidAt: new Date().toISOString() });
    expect(r.status).toBe(200);
    expect((await invDoc(id)).status).toBe(to);
  });

  it.each([
    ["SENT", "CANCELLED", /\/:id\/cancel/],
    ["DRAFT", "CANCELLED", /\/:id\/cancel/],
    ["PAID", "CANCELLED", /credit note/i],
    ["PAYMENT_DECLARED", "CANCELLED", /\/:id\/cancel/],
    ["SENT", "DRAFT", /revert-to-draft/],
    ["PAID", "SENT", /revert-to-sent/],
    ["PAYMENT_DECLARED", "SENT", /revert-to-sent/],
    ["SENT", "PAYMENT_DECLARED", /declare-payment/],
    ["DRAFT", "PAID", /SENT first/],
    ["PAID", "DRAFT", /not an allowed/],
    ["CANCELLED", "SENT", /final/],
  ])("%s → %s is refused (400) and the invoice is untouched", async (from, to, msg) => {
    const id = await invoice(from);
    const before = await invDoc(id);
    const r = await put(`/${id}/status`, { status: to });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(msg);
    const after = await invDoc(id);
    expect(after.status).toBe(from);
    expect(after.editHistory).toHaveLength(before.editHistory.length);
  });

  it("an unknown status is refused", async () => {
    const id = await invoice("SENT");
    const r = await put(`/${id}/status`, { status: "VOID" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Unknown invoice status/);
  });
});

/* ── 3. bulk-mark-sent ──────────────────────────────────────────────── */

describe("POST /bulk-mark-sent", () => {
  it("skips PAYMENT_DECLARED with a reason and leaves it alone; still sends DRAFT", async () => {
    const declared = await invoice("PAYMENT_DECLARED", { paymentDeclaredAt: new Date() });
    const draft = await invoice("DRAFT");
    const r = await post("/bulk-mark-sent", { ids: [String(declared), String(draft)] });
    expect(r.status).toBe(200);
    expect(r.body.updated).toEqual([String(draft)]);
    expect(r.body.skipped).toEqual([{ id: String(declared), reason: expect.stringMatching(/declared payment/) }]);
    expect((await invDoc(declared)).status).toBe("PAYMENT_DECLARED");
    expect((await invDoc(declared)).paymentDeclaredAt).toBeTruthy();
    expect((await invDoc(draft)).status).toBe("SENT");
  });

  it("bulk-mark-paid still confirms SENT and PAYMENT_DECLARED, blocks DRAFT", async () => {
    const sent = await invoice("SENT");
    const declared = await invoice("PAYMENT_DECLARED");
    const draft = await invoice("DRAFT");
    const r = await post("/bulk-mark-paid", { ids: [String(sent), String(declared), String(draft)], paidAt: new Date().toISOString() });
    expect(r.body.updated.sort()).toEqual([String(sent), String(declared)].sort());
    expect(r.body.blocked).toEqual([{ id: String(draft), reason: expect.stringMatching(/SENT first/) }]);
  });
});

/* ── 4. add-bookings ────────────────────────────────────────────────── */

describe("POST /:id/add-bookings", () => {
  it("refuses a SENT invoice (revert to DRAFT first) and changes nothing", async () => {
    const id = await invoice("SENT");
    const b = await booking(CUST);
    const r = await post(`/${id}/add-bookings`, { bookingIds: [String(b)] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/DRAFT.*revert-to-draft/);
    expect((await invDoc(id)).grandTotal).toBe(11800);
    expect((await col("manualbookings").findOne({ _id: b }))!.status).toBe("CONFIRMED");
  });

  it.each(["PAID", "PAYMENT_DECLARED", "CANCELLED"])("refuses a %s invoice", async (status) => {
    const id = await invoice(status);
    const r = await post(`/${id}/add-bookings`, { bookingIds: [String(await booking(CUST))] });
    expect(r.status).toBe(400);
  });

  it("DRAFT under CustomerWorkspace._id accepts the client's booking (Customer._id) — totals and GST split re-derived like PATCH", async () => {
    const id = await invoice("DRAFT");
    const b = await booking(CUST);
    const r = await post(`/${id}/add-bookings`, { bookingIds: [String(b)] });
    expect(r.status).toBe(200);

    const d = await invDoc(id);
    // Existing line 11800 (GST 1800) + ON_MARKUP booking: COST 10000 (no GST)
    // + Transaction Fees 1180 (GST 180 inclusive).
    const sumAmount = d.lineItems.reduce((s: number, l: any) => s + l.amount, 0);
    const sumGst = d.lineItems.reduce((s: number, l: any) => s + l.igst, 0);
    expect(d.grandTotal).toBeCloseTo(sumAmount, 2);
    expect(d.totalGST).toBeCloseTo(sumGst, 2);
    expect(d.subtotal).toBeCloseTo(d.grandTotal - d.totalGST, 2);
    expect(d).toMatchObject({ grandTotal: 22980, totalGST: 1980, subtotal: 21000, cgstAmount: 990, sgstAmount: 990, igstAmount: 0 });
    // The old raw $set added GST-inclusive amounts straight onto subtotal (10000 + 11180).
    expect(d.subtotal).not.toBe(10000 + 11180);
    expect(d.bookingIds.map(String)).toEqual([String(b)]);
    expect(d.editHistory.at(-1)).toMatchObject({ fieldsChanged: ["bookingsAdded", "totals"] });

    const bk = (await col("manualbookings").findOne({ _id: b }))!;
    expect(bk.status).toBe("INVOICED");
    expect(String(bk.invoiceId)).toBe(String(id));
  });

  it("legacy invoice keyed on Customer._id also accepts the client's booking", async () => {
    const id = await invoice("DRAFT", { workspaceId: CUST });
    const r = await post(`/${id}/add-bookings`, { bookingIds: [String(await booking(CUST))] });
    expect(r.status).toBe(200);
  });

  it("refuses another client's booking", async () => {
    const id = await invoice("DRAFT");
    const r = await post(`/${id}/add-bookings`, { bookingIds: [String(await booking(OTHER_CUST))] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/same workspace/);
  });

  it("refuses a booking already claimed by another invoice", async () => {
    const id = await invoice("DRAFT");
    const b = await booking(CUST, { invoiceId: oid() });
    const r = await post(`/${id}/add-bookings`, { bookingIds: [String(b)] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/already invoiced/);
  });
});

/* ── 5 + 6. cancel / revert-to-draft with an ISSUED credit note ─────── */

describe("POST /:id/cancel and /:id/revert-to-draft — ISSUED credit notes block them", () => {
  it("cancel refuses a SENT invoice with an ISSUED credit note", async () => {
    const id = await invoice("SENT");
    await creditNote(id, "ISSUED", 5900);
    const r = await post(`/${id}/cancel`, { reason: "Duplicate" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/full credit note instead/);
    expect((await invDoc(id)).status).toBe("SENT");
  });

  it("cancel goes through when the only credit notes are DRAFT / CANCELLED", async () => {
    const id = await invoice("SENT");
    await creditNote(id, "DRAFT", 5900);
    await creditNote(id, "CANCELLED", 5900);
    const r = await post(`/${id}/cancel`, { reason: "Duplicate" });
    expect(r.status).toBe(200);
    expect((await invDoc(id)).status).toBe("CANCELLED");
  });

  it("cancel still refuses PAID and requires a reason", async () => {
    expect((await post(`/${await invoice("PAID")}/cancel`, { reason: "x" })).status).toBe(400);
    expect((await post(`/${await invoice("SENT")}/cancel`, {})).status).toBe(400);
  });

  it("revert-to-draft refuses a SENT invoice with an ISSUED credit note", async () => {
    const id = await invoice("SENT");
    await creditNote(id, "ISSUED", 5900);
    const r = await post(`/${id}/revert-to-draft`, { reason: "Wrong client" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/issued credit note/);
    expect((await invDoc(id)).status).toBe("SENT");
  });

  it("revert-to-draft still works with no ISSUED credit note", async () => {
    const id = await invoice("SENT");
    await creditNote(id, "CANCELLED", 5900);
    const r = await post(`/${id}/revert-to-draft`, { reason: "Wrong client" });
    expect(r.status).toBe(200);
    expect((await invDoc(id)).status).toBe("DRAFT");
  });
});

/* ── 7. credit-note override ────────────────────────────────────────── */

describe("POST /credit-notes/:id/override", () => {
  const override = (id: mongoose.Types.ObjectId, body: any) =>
    as(request(app).post(`/api/admin/credit-notes/${id}/override`)).send(body);

  it("requires a reason", async () => {
    const inv = await invoice("SENT");
    const cn = await creditNote(inv, "CANCELLED", 5900);
    expect((await override(cn, { reason: "  ", changes: { status: "ISSUED" } })).status).toBe(400);
  });

  it.each(["DRAFT", "CANCELLED"])("refuses to ISSUE a note whose invoice is %s", async (status) => {
    const inv = await invoice(status);
    const cn = await creditNote(inv, "CANCELLED", 5900);
    const r = await override(cn, { reason: "Restore", changes: { status: "ISSUED" } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(new RegExp(`is ${status}`));
    expect((await col("creditnotes").findOne({ _id: cn }))!.status).toBe("CANCELLED");
  });

  it("still restores CANCELLED → ISSUED against a SENT invoice", async () => {
    const inv = await invoice("SENT");
    const cn = await creditNote(inv, "CANCELLED", 5900);
    const r = await override(cn, { reason: "Cancelled by mistake", changes: { status: "ISSUED" } });
    expect(r.status).toBe(200);
    expect((await invDoc(inv)).creditedAmount).toBe(5900);
  });

  it("re-checks the invoice credit cap when an ISSUED note's amount is raised", async () => {
    const inv = await invoice("SENT");
    await creditNote(inv, "ISSUED", 8000);
    const cn = await creditNote(inv, "ISSUED", 2000);
    const r = await override(cn, {
      reason: "Raise",
      changes: { isFullCredit: false, lineItems: [{ bookingRef: "MB-OLD", rowType: "COST", description: "Flight", creditedAmount: 5000 }] },
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/would total ₹13000/);
    expect((await col("creditnotes").findOne({ _id: cn }))!.grandTotal).toBe(2000);
  });
});

/* ── 8. atomic booking claim on generation ──────────────────────────── */

describe("generation claims bookings atomically", () => {
  async function company() {
    const c: any = await Customer.create({ name: "Race Co", legalName: "Race Co", gstRegisteredState: "Karnataka" });
    await CustomerWorkspace.create({ customerId: String(c._id), companyName: "Race Co" });
    const b: any = await ManualBooking.create({
      workspaceId: c._id, bookedBy: SA_ID, type: "FLIGHT", supplierName: "TBO", givenBy: "Ops",
      status: "CONFIRMED", bookingRef: `MB-RACE-${String(c._id).slice(-4)}`,
      travelDate: new Date("2026-11-01T00:00:00Z"), passengers: [{ name: "Asha Rao", type: "ADULT" }],
      pricing: { gstMode: "ON_MARKUP", gstPercent: 18, actualPrice: 10000, quotedPrice: 11180 },
    });
    return b;
  }

  it("two concurrent generations of one booking produce ONE invoice; the loser fails cleanly", async () => {
    const b = await company();
    const run = () => createInvoiceFromBookings([String(b._id)], { format: "COMBINED", createdBy: String(SA_ID) });
    const results = await Promise.allSettled([run(), run()]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect([400, 409]).toContain(lost[0].reason.httpStatus);

    const invoices = await col("invoices").find({ bookingIds: b._id }).toArray();
    expect(invoices).toHaveLength(1);
    const bk = (await col("manualbookings").findOne({ _id: b._id }))!;
    expect(bk.status).toBe("INVOICED");
    expect(String(bk.invoiceId)).toBe(String(invoices[0]._id));
  });

  it("a lost claim aborts before any invoice is written or numbered", async () => {
    const b = await company();
    await col("manualbookings").updateOne({ _id: b._id }, { $set: { invoiceId: oid() } }); // claimed elsewhere, status not yet INVOICED
    await expect(createInvoiceFromBookings([String(b._id)], { format: "COMBINED", createdBy: String(SA_ID) }))
      .rejects.toMatchObject({ httpStatus: 409, body: { code: "BOOKINGS_ALREADY_INVOICED" } });
    expect(await col("invoices").countDocuments()).toBe(0);
    expect(await col("counters").countDocuments()).toBe(0);
  });

  it("a failure after the claim rolls the claim back — no booking is left invoiced against a missing invoice", async () => {
    const b = await company();
    const spy = vi.spyOn(Invoice, "create").mockRejectedValueOnce(new Error("server died mid-write"));
    try {
      await expect(createInvoiceFromBookings([String(b._id)], { format: "COMBINED", createdBy: String(SA_ID) }))
        .rejects.toThrow("server died mid-write");
    } finally {
      spy.mockRestore();
    }
    const bk = (await col("manualbookings").findOne({ _id: b._id }))!;
    expect(bk.status).toBe("CONFIRMED");
    expect(bk.invoiceId ?? null).toBeNull();
    expect(await col("invoices").countDocuments()).toBe(0);
  });

  it("claimBookingsForInvoice: a partial claim reports false and the aborted transaction leaves no trace", async () => {
    const free = await booking(CUST);
    const taken = await booking(CUST, { status: "INVOICED", invoiceId: oid() });
    const docs = await col("manualbookings").find({ _id: { $in: [free, taken] } }).toArray();
    const mine = oid();
    const session = await mongoose.startSession();
    try {
      await expect(session.withTransaction(async () => {
        expect(await claimBookingsForInvoice(docs, mine, session)).toBe(false);
        throw new Error("abort");
      })).rejects.toThrow("abort");
    } finally {
      await session.endSession();
    }
    const f = (await col("manualbookings").findOne({ _id: free }))!;
    expect(f.status).toBe("CONFIRMED");
    expect(f.invoiceId ?? null).toBeNull();
    const t = (await col("manualbookings").findOne({ _id: taken }))!;
    expect(String(t.invoiceId)).not.toBe(String(mine));
  });
});
