// apps/backend/src/routes/invoices.allInclusive.test.ts
//
// ALL_INCLUSIVE invoice layout (utils/invoiceLayout.ts) — presentation only:
//   • totals, the CGST/SGST/IGST split and the stored line items are identical
//     to a SEPARATE invoice of the same bookings (1 booking and 2 bookings);
//   • refused (400, nothing written) for a client that is not Unregistered;
//   • the layout is stored, and a re-download renders it again — even after
//     the client's GST status later changes;
//   • Business Profiles "Default invoice layout": validated on both save paths,
//     reported by gst-preview for the popup.
//
// Real: customers / master-data / invoices routers, generation service, PDF,
//   models, in-memory Mongo. Stubbed: requireAuth / requireWorkspace (headers).
//   The PDF checks spy on PDFKit's text() — calls go through unchanged.
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

const { default: masterDataRouter } = await import("./masterData.js");
const { default: customersRouter } = await import("./customers.js");
const { default: invoicesRouter } = await import("./invoices.js");
const { generateInvoicePdf } = await import("../utils/invoicePdf.js");
const { buildAllInclusiveRows, allInclusiveTaxNote, resolveDefaultInvoiceLayout } = await import("../utils/invoiceLayout.js");
const { default: Customer } = await import("../models/Customer.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");
const { default: Onboarding } = await import("../models/Onboarding.js");
const PDFDocument = (await import("pdfkit")).default;

const app = express();
app.use(express.json());
app.use("/api/master-data", masterDataRouter);
app.use("/api/customers", customersRouter);
app.use("/api/admin/invoices", invoicesRouter);

let mongod: MongoMemoryReplSet;
const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const STAFF = new mongoose.Types.ObjectId();
const staff = (r: request.Test) =>
  r.set("x-test-user", JSON.stringify({ _id: String(STAFF), id: String(STAFF), sub: String(STAFF), roles: ["SUPERADMIN"] })).set("x-test-ws", String(HOUSE));
const col = (n: string) => mongoose.connection.db!.collection(n);
const GSTIN_DL = "07AAHCM5991L1ZS";

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } }); // generation runs in a transaction
  await mongoose.connect(mongod.getUri("invoice-all-inclusive-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
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
    status: "CONFIRMED", bookingRef: `MB-AI-${seq}`,
    travelDate: new Date("2026-11-20T00:00:00Z"), passengers: [{ name: "Asha Rao", type: "ADULT" }],
    itinerary: { origin: "BLR", destination: "DEL", airline: "6E", flightNo: "6E-123" },
    // Cost 9,600 + fee 400 (GST 61.02 inside) = 10,000.
    pricing: { gstMode: "ON_MARKUP", gstPercent: 18, actualPrice: 9600, quotedPrice: 10000 },
    ...over,
  });
  return String(b._id);
}

const generate = (bookingIds: string[], invoiceFormat?: string) =>
  staff(request(app).post("/api/admin/invoices/generate")).send({ bookingIds, invoiceDate: "2026-11-17", ...(invoiceFormat ? { invoiceFormat } : {}) });

const tax = (inv: any) => ({
  subtotal: inv.subtotal, totalGST: inv.totalGST, grandTotal: inv.grandTotal, supplyType: inv.supplyType,
  cgst: inv.cgstAmount, sgst: inv.sgstAmount, utgst: inv.utgstAmount, igst: inv.igstAmount,
  placeOfSupply: inv.placeOfSupply,
  lines: (inv.lineItems || []).map((l: any) => [l.rowType, l.description, l.qty, l.rate, l.igst, l.amount]),
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

describe("totals are identical to Separate", () => {
  it.each([
    ["one booking, same state (CGST+SGST)", "Karnataka", 1],
    ["two bookings, same state", "Karnataka", 2],
    ["one booking, inter-state (IGST)", "Maharashtra", 1],
  ])("%s", async (_label, state, n) => {
    const a = await company({ legalName: "B2C A", gstStatus: "UNREGISTERED", gstRegisteredState: state });
    const b = await company({ legalName: "B2C B", gstStatus: "UNREGISTERED", gstRegisteredState: state });
    const sepIds = [], allIds = [];
    for (let i = 0; i < n; i++) { sepIds.push(await booking(a._id)); allIds.push(await booking(b._id)); }

    const sep = await generate(sepIds, "SEPARATE");
    const all = await generate(allIds, "ALL_INCLUSIVE");
    expect(sep.status, JSON.stringify(sep.body)).toBe(201);
    expect(all.status, JSON.stringify(all.body)).toBe(201);

    expect(tax(all.body.invoice)).toEqual(tax(sep.body.invoice));
    expect(all.body.invoice.grandTotal).toBe(10000 * n);
    expect(all.body.invoice.invoiceLayout).toBe("ALL_INCLUSIVE");
    expect(sep.body.invoice.invoiceLayout).toBe("SEPARATE");
  });
});

describe("refused for a client that is not Unregistered", () => {
  it.each([["REGISTERED", { gstStatus: "REGISTERED", gstNumber: GSTIN_DL, gstRegisteredState: "Delhi" }], ["NOT_SET", {}]])(
    "%s → 400, nothing written",
    async (_label, fields) => {
      const c = await company({ legalName: "Registered Co", ...fields });
      const id = await booking(c._id);
      const r = await generate([id], "ALL_INCLUSIVE");
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("ALL_INCLUSIVE_NOT_ALLOWED");
      expect(r.body.message).toMatch(/only for clients whose GST status is Unregistered/);
      expect(await col("invoices").countDocuments({})).toBe(0);
      const b: any = await ManualBooking.findById(id).lean();
      expect(b.status).toBe("CONFIRMED");
      expect(b.invoiceId ?? null).toBeNull();

      // Separate still works for the same client.
      expect((await generate([id], "SEPARATE")).status).toBe(201);
    },
  );
});

describe("the PDF", () => {
  it("All-inclusive: one all-in row per booking, only Total + words, GST stated under the table", async () => {
    const c = await company({ legalName: "B2C", gstStatus: "UNREGISTERED" });
    const r = await generate([await booking(c._id), await booking(c._id, { type: "HOTEL", itinerary: { hotelName: "Taj", destination: "Goa" } })], "ALL_INCLUSIVE");
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const t = await pdfText(r.body.invoice);

    expect(t).toContain("Flight services");
    expect(t).toContain("Hotel services");
    expect(t.filter((s) => s === "₹10,000.00").length).toBe(2); // one row each
    expect(t).toContain("₹20,000.00");
    // The Separate invoice's own detail line for each booking.
    expect(t.filter((s) => s.includes("Asha Rao"))).toEqual([
      "1 Passenger || Asha Rao || BLR-DEL || 6E 6E-123 || Travel Date: 20 Nov 2026",
      "1 Night x 1 Room || Asha Rao || Taj || Goa || Check-in: 20 Nov 2026",
    ]);
    expect(t).toContain("Amount inclusive of all taxes and service charges. GST included: CGST ₹61.02 + SGST ₹61.02 = ₹122.04");
    for (const gone of ["Transaction Fees", "Sub Total", "QTY", "RATE", "CGST (9%)", "SGST (9%)", "IGST (18%)"]) {
      expect(t, gone).not.toContain(gone);
    }
    expect(t).toContain("Total");
    expect(t.some((s) => /Twenty Thousand/i.test(s))).toBe(true);
    expect(t).toContain("Bank Details");
  });

  it("inter-state: the note states IGST", async () => {
    const c = await company({ legalName: "B2C MH", gstStatus: "UNREGISTERED", gstRegisteredState: "Maharashtra" });
    const r = await generate([await booking(c._id)], "ALL_INCLUSIVE");
    const t = await pdfText(r.body.invoice);
    expect(t).toContain("Amount inclusive of all taxes and service charges. GST included: IGST ₹61.02");
  });

  it("Separate is unchanged (itemised, Sub Total and tax rows)", async () => {
    const c = await company({ legalName: "B2C", gstStatus: "UNREGISTERED" });
    const r = await generate([await booking(c._id)], "SEPARATE");
    const t = await pdfText(r.body.invoice);
    for (const s of ["Flight Cost", "Transaction Fees", "Sub Total", "CGST (9%)"]) expect(t).toContain(s);
    expect(t.some((s) => s.startsWith("Amount inclusive of all taxes"))).toBe(false);
  });
});

describe("re-download keeps the layout", () => {
  it("bulk-pdf re-renders the stored invoice as All-inclusive, even after the client becomes Registered", async () => {
    const c = await company({ legalName: "B2C", gstStatus: "UNREGISTERED" });
    const r = await generate([await booking(c._id)], "ALL_INCLUSIVE");
    expect(r.status).toBe(201);
    expect((await col("invoices").findOne({}) as any).invoiceLayout).toBe("ALL_INCLUSIVE");

    await Customer.updateOne({ _id: c._id }, { $set: { gstStatus: "REGISTERED", gstNumber: GSTIN_DL } });

    for (let i = 0; i < 2; i++) {
      const spy = vi.spyOn(PDFDocument.prototype as any, "text");
      try {
        const dl = await staff(request(app).get(`/api/admin/invoices/bulk-pdf?workspaceId=${c._id}`)).buffer(true);
        expect(dl.status).toBe(200);
        const t = spy.mock.calls.map((a: any[]) => String(a[0]));
        expect(t).toContain("Flight services");
        expect(t.some((s) => s.startsWith("Amount inclusive of all taxes"))).toBe(true);
        expect(t).not.toContain("Sub Total");
      } finally {
        spy.mockRestore();
      }
    }
  });
});

describe("Business Profiles default + popup preview", () => {
  it("PATCH /customers: All-inclusive refused unless Unregistered; leaving Unregistered drops it to Separate", async () => {
    const reg = await company({ legalName: "Reg", gstStatus: "REGISTERED", gstNumber: GSTIN_DL, gstRegisteredState: "Delhi" });
    const bad = await staff(request(app).patch(`/api/customers/${reg._id}`)).send({ defaultInvoiceLayout: "ALL_INCLUSIVE" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("ALL_INCLUSIVE_NOT_ALLOWED");
    expect((await staff(request(app).patch(`/api/customers/${reg._id}`)).send({ defaultInvoiceLayout: "COMBINED" })).status).toBe(200);
    expect((await Customer.findById(reg._id).lean() as any).defaultInvoiceLayout).toBe("COMBINED");
    expect((await staff(request(app).patch(`/api/customers/${reg._id}`)).send({ defaultInvoiceLayout: "NOPE" })).status).toBe(400);

    const b2c = await company({ legalName: "B2C", gstStatus: "UNREGISTERED" });
    expect((await staff(request(app).patch(`/api/customers/${b2c._id}`)).send({ defaultInvoiceLayout: "ALL_INCLUSIVE" })).status).toBe(200);
    expect((await Customer.findById(b2c._id).lean() as any).defaultInvoiceLayout).toBe("ALL_INCLUSIVE");

    const prev = await staff(request(app).get(`/api/admin/invoices/gst-preview?customerId=${b2c._id}`));
    expect(prev.status).toBe(200);
    expect(prev.body).toMatchObject({ customerGstStatus: "UNREGISTERED", defaultInvoiceLayout: "ALL_INCLUSIVE" });

    const moved = await staff(request(app).patch(`/api/customers/${b2c._id}`)).send({ gstStatus: "NOT_SET" });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await Customer.findById(b2c._id).lean() as any).defaultInvoiceLayout).toBe("SEPARATE");
  });

  it("PATCH /master-data (onboarded business): same rule", async () => {
    const ob: any = await Onboarding.create({
      workspaceId: HOUSE, type: "business", email: "agent@example.test", token: "tok-ai",
      expiresAt: new Date(Date.now() + 86_400_000), status: "approved", formPayload: { legalName: "Agent" },
    });
    const linked: any = await Customer.create({ name: "Agent", legalName: "Agent", onboardingId: ob._id, gstStatus: "NOT_SET" });
    const bad = await staff(request(app).patch(`/api/master-data/${ob._id}`)).send({ legalName: "Agent", defaultInvoiceLayout: "ALL_INCLUSIVE" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("ALL_INCLUSIVE_NOT_ALLOWED");

    const ok = await staff(request(app).patch(`/api/master-data/${ob._id}`)).send({ legalName: "Agent", gstStatus: "UNREGISTERED", defaultInvoiceLayout: "ALL_INCLUSIVE" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await Customer.findById(linked._id).lean() as any).defaultInvoiceLayout).toBe("ALL_INCLUSIVE");
  });

  it("gst-preview reports Separate for a client with no default", async () => {
    const c = await company({ legalName: "Plain", gstStatus: "REGISTERED", gstNumber: GSTIN_DL, gstRegisteredState: "Delhi" });
    const prev = await staff(request(app).get(`/api/admin/invoices/gst-preview?customerId=${c._id}`));
    expect(prev.body).toMatchObject({ customerGstStatus: "REGISTERED", defaultInvoiceLayout: "SEPARATE" });
  });
});

describe("helpers", () => {
  it("rows: one per booking, amounts summed; group-booking items fall back to passengers + date", () => {
    const rows = buildAllInclusiveRows([
      { bookingRef: "A", type: "FLIGHT", rowType: "COST", subDescription: "X || BLR-DEL", amount: 9600, passengerNames: ["X"] },
      { bookingRef: "A", type: "FLIGHT", rowType: "SERVICE_FEE", subDescription: "X || BLR-DEL", amount: 400, passengerNames: ["X"] },
      { bookingRef: "G", type: "GROUP_BOOKING", rowType: "COST", subDescription: "Qty 2 × Rate 50", amount: 118, passengerNames: ["Y"], travelDate: "2026-12-05T00:00:00Z" },
      { bookingRef: "G", type: "GROUP_BOOKING", rowType: "COST", subDescription: "Qty 1 × Rate 10", amount: 11.8, passengerNames: ["Y"] },
    ]);
    expect(rows).toEqual([
      { bookingRef: "A", description: "Flight services", subDescription: "X || BLR-DEL", amount: 10000 },
      { bookingRef: "G", description: "Travel services", subDescription: "Y || Travel Date: 05/12/2026", amount: 129.8 },
    ]);
  });

  it("tax note per supply type", () => {
    const f = (n: number) => `₹${n.toFixed(2)}`;
    expect(allInclusiveTaxNote({ supplyType: "CGST_SGST", totalGST: 305.08, cgstAmount: 152.54, sgstAmount: 152.54 }, f))
      .toBe("Amount inclusive of all taxes and service charges. GST included: CGST ₹152.54 + SGST ₹152.54 = ₹305.08");
    expect(allInclusiveTaxNote({ supplyType: "CGST_UTGST", totalGST: 10, cgstAmount: 5, utgstAmount: 5 }, f)).toContain("CGST ₹5.00 + UTGST ₹5.00 = ₹10.00");
    expect(allInclusiveTaxNote({ supplyType: "IGST", totalGST: 305.08, igstAmount: 305.08 }, f)).toContain("GST included: IGST ₹305.08");
  });

  it("default layout resolution", () => {
    expect(resolveDefaultInvoiceLayout("ALL_INCLUSIVE", "UNREGISTERED")).toEqual({ value: "ALL_INCLUSIVE" });
    expect(resolveDefaultInvoiceLayout("ALL_INCLUSIVE", "REGISTERED").refused?.error).toBe("ALL_INCLUSIVE_NOT_ALLOWED");
    expect(resolveDefaultInvoiceLayout("", "REGISTERED")).toEqual({ value: "SEPARATE" });
    expect(resolveDefaultInvoiceLayout(undefined, "REGISTERED", "ALL_INCLUSIVE")).toEqual({ value: "SEPARATE" });
    expect(resolveDefaultInvoiceLayout(undefined, "UNREGISTERED", "ALL_INCLUSIVE")).toEqual({});
  });
});
