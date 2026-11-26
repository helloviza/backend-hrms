// apps/backend/src/routes/invoices.billTo.test.ts
//
// Invoicing a booking with a bill-to snapshot (ManualBooking.billTo —
// docs/specs/sbt-to-manual-booking-spec.md §3.7, P4; services/invoiceBillTo.ts):
//   • place of supply and the CGST/SGST vs IGST split follow billTo.state
//     (seller here is Karnataka);
//   • the client block is the snapshot's party: a person's name and address,
//     or the chosen GST registration — a person with no GSTIN is B2C
//     ("GSTIN: Unregistered (B2C)" on the PDF, never the company's GSTIN);
//   • a booking without a bill-to is invoiced exactly as before;
//   • D-9: one invoice never mixes bill-tos — /generate (one invoice) and
//     add-bookings answer 409 MIXED_BILL_TO and write nothing; /bulk-generate
//     (one invoice per booking) gives each booking its own party.
// No numbering / counter changes.
//
// Real: invoices router, generation service, PDF, models, in-memory replica set.
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

const { default: invoicesRouter, enrichClientDetails } = await import("./invoices.js");
const { generateInvoicePdf } = await import("../utils/invoicePdf.js");
const { default: Customer } = await import("../models/Customer.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");
const { default: Invoice } = await import("../models/Invoice.js");
const PDFDocument = (await import("pdfkit")).default;

const app = express();
app.use(express.json());
app.use("/api/admin/invoices", invoicesRouter);

let mongod: MongoMemoryReplSet;
const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const STAFF = new mongoose.Types.ObjectId();
const staff = (r: request.Test) =>
  r.set("x-test-user", JSON.stringify({ _id: String(STAFF), id: String(STAFF), sub: String(STAFF), roles: ["SUPERADMIN"] })).set("x-test-ws", String(HOUSE));
const col = (n: string) => mongoose.connection.db!.collection(n);

const COMPANY_GSTIN_KA = "29AAHCM5991L1ZU"; // not validated here; a company-on-file GSTIN
const REG_GSTIN_DL = "07AAHCM5991L1ZS";
const PERSON_GSTIN_MH = "27AAPFU0939F1ZV";

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri("invoice-bill-to-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await col("companysettings").insertOne({
    companyName: "Plumtrips", invoiceSeriesCadence: "annual", supplierState: "Karnataka",
    gstProfiles: [{ gstin: "29ABCDE1234F1Z5", state: "Karnataka", stateCode: "29", legalName: "Plumtrips KA", addressLine1: "", addressLine2: "", city: "Bengaluru", pincode: "560001", isDefault: true, active: true, invoiceSeriesPrefix: "" }],
  } as any);
});

async function company() {
  const c: any = await Customer.create({
    name: "Osprey", legalName: "Osprey Labs Pvt Ltd", gstStatus: "REGISTERED", gstNumber: COMPANY_GSTIN_KA, gstRegisteredState: "Karnataka",
    address: { street: "1 MG Road", city: "Bengaluru", state: "Karnataka", country: "India", pincode: "560001" },
  });
  await CustomerWorkspace.create({ customerId: String(c._id), companyName: c.legalName });
  return c;
}

let seq = 0;
async function booking(customerId: any, billTo?: Record<string, any>) {
  seq += 1;
  const b: any = await ManualBooking.create({
    workspaceId: customerId, bookedBy: STAFF, type: "FLIGHT", supplierName: "TBO", givenBy: "Ops",
    status: "CONFIRMED", bookingRef: `MB-BT-${seq}`,
    travelDate: new Date("2026-12-20T00:00:00Z"), passengers: [{ name: "Riya Sen", type: "ADULT" }],
    itinerary: { origin: "DEL", destination: "BOM", airline: "6E", flightNo: "6E2134" },
    pricing: { gstMode: "ON_MARKUP", gstPercent: 18, actualPrice: 10300, quotedPrice: 10790 },
    ...(billTo ? { billTo: { source: "SBT_CHECKOUT", ...billTo } } : {}),
  });
  return String(b._id);
}

const PERSON_MH = { kind: "INDIVIDUAL", legalName: "Riya Sen", state: "Maharashtra", stateCode: "27", address: { line1: "12 Carter Road", city: "Mumbai", pincode: "400050", country: "India" }, email: "riya@osprey.test" };
const PERSON_KA = { ...PERSON_MH, state: "Karnataka", stateCode: "29", address: { line1: "4 Church St", city: "Bengaluru", pincode: "560001", country: "India" } };
const PERSON_MH_GST = { ...PERSON_MH, gstin: PERSON_GSTIN_MH };
const REG_DL = { kind: "COMPANY", registrationId: "reg-dl", gstin: REG_GSTIN_DL, stateCode: "07", state: "Delhi", legalName: "Osprey Labs Pvt Ltd (Delhi)", address: { line1: "Connaught Place", city: "New Delhi", pincode: "110001", country: "India" } };

const generate = (bookingIds: string[]) =>
  staff(request(app).post("/api/admin/invoices/generate")).send({ bookingIds, invoiceDate: "2026-12-01" });

async function pdfLines(inv: any): Promise<string[]> {
  const spy = vi.spyOn(PDFDocument.prototype as any, "text");
  try {
    const clientDetails = await enrichClientDetails(inv);
    await generateInvoicePdf({ ...inv, clientDetails });
    return spy.mock.calls.map((a: any[]) => String(a[0]));
  } finally {
    spy.mockRestore();
  }
}

describe("place of supply and GST split follow the bill-to state", () => {
  it("person in Maharashtra (seller Karnataka) → IGST; B2C, never the company's GSTIN", async () => {
    const c = await company();
    const r = await generate([await booking(c._id, PERSON_MH)]);
    expect(r.status).toBe(201);
    const inv = r.body.invoice;
    expect(inv.supplyType).toBe("IGST");
    expect(inv.igstAmount).toBeGreaterThan(0);
    expect(inv.cgstAmount).toBe(0);
    expect(inv.clientState).toBe("Maharashtra");
    expect(inv.clientDetails).toMatchObject({ companyName: "Riya Sen", gstin: "", state: "Maharashtra", city: "Mumbai", billToKind: "INDIVIDUAL" });
    const client = await enrichClientDetails(inv);
    expect(client).toMatchObject({ gstStatus: "UNREGISTERED", addressLine1: "12 Carter Road" });
    const lines = await pdfLines(inv);
    expect(lines).toContain("GSTIN: Unregistered (B2C)");
    expect(lines.join("\n")).not.toContain(COMPANY_GSTIN_KA);
  });

  it("person in Karnataka → CGST + SGST", async () => {
    const c = await company();
    const r = await generate([await booking(c._id, PERSON_KA)]);
    expect(r.body.invoice.supplyType).toBe("CGST_SGST");
    expect(r.body.invoice.cgstAmount).toBeGreaterThan(0);
    expect(r.body.invoice.igstAmount).toBe(0);
  });

  it("person with a GSTIN → that GSTIN on the invoice, B2B", async () => {
    const c = await company();
    const r = await generate([await booking(c._id, PERSON_MH_GST)]);
    expect(r.body.invoice.clientDetails.gstin).toBe(PERSON_GSTIN_MH);
    expect((await enrichClientDetails(r.body.invoice)).gstStatus).toBe("REGISTERED");
    expect(await pdfLines(r.body.invoice)).toContain(`GSTIN: ${PERSON_GSTIN_MH}`);
  });

  it("a chosen company registration (Delhi) → its GSTIN, name and state; IGST", async () => {
    const c = await company();
    const r = await generate([await booking(c._id, REG_DL)]);
    const inv = r.body.invoice;
    expect(inv.supplyType).toBe("IGST");
    expect(inv.clientDetails).toMatchObject({ gstin: REG_GSTIN_DL, companyName: "Osprey Labs Pvt Ltd (Delhi)", state: "Delhi", billToKind: "COMPANY", billToRegistrationId: "reg-dl" });
  });

  it("a booking without a bill-to is invoiced exactly as before (company GSTIN, Karnataka)", async () => {
    const c = await company();
    const r = await generate([await booking(c._id)]);
    const inv = r.body.invoice;
    expect(inv.supplyType).toBe("CGST_SGST");
    expect(inv.clientDetails).toMatchObject({ companyName: "Osprey Labs Pvt Ltd", gstin: COMPANY_GSTIN_KA, state: "Karnataka" });
    expect(inv.clientDetails.billToKind).toBeUndefined();
  });
});

describe("D-9: one invoice, one bill-to", () => {
  it("/generate with mixed bill-tos → 409 MIXED_BILL_TO, nothing written", async () => {
    const c = await company();
    const ids = [await booking(c._id, PERSON_MH), await booking(c._id)];
    const r = await generate(ids);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ code: "MIXED_BILL_TO" });
    expect(r.body.message).toMatch(/Invoice them separately/);
    expect(await Invoice.countDocuments({})).toBe(0);
    expect(await ManualBooking.countDocuments({ status: "INVOICED" })).toBe(0);
  });

  it("/generate with the same bill-to on every booking → one invoice to that party", async () => {
    const c = await company();
    const r = await generate([await booking(c._id, PERSON_MH), await booking(c._id, PERSON_MH)]);
    expect(r.status).toBe(201);
    expect(r.body.invoice.clientDetails.companyName).toBe("Riya Sen");
    expect(r.body.invoice.bookingIds).toHaveLength(2);
  });

  it("/bulk-generate (one per booking) gives each booking its own party", async () => {
    const c = await company();
    const ids = [await booking(c._id, PERSON_MH), await booking(c._id, REG_DL), await booking(c._id)];
    const r = await staff(request(app).post("/api/admin/invoices/bulk-generate")).send({ bookingIds: ids, invoiceDate: "2026-12-01" });
    expect(r.status).toBeLessThan(300);
    const invs: any[] = await Invoice.find({}).lean();
    expect(invs).toHaveLength(3);
    const byBooking = new Map(invs.map((i) => [String(i.bookingIds[0]), i]));
    expect(byBooking.get(ids[0])!.clientDetails).toMatchObject({ companyName: "Riya Sen", gstin: "" });
    expect(byBooking.get(ids[0])!.supplyType).toBe("IGST");
    expect(byBooking.get(ids[1])!.clientDetails).toMatchObject({ gstin: REG_GSTIN_DL, state: "Delhi" });
    expect(byBooking.get(ids[2])!.clientDetails).toMatchObject({ gstin: COMPANY_GSTIN_KA });
    expect(byBooking.get(ids[2])!.supplyType).toBe("CGST_SGST");
  });

  it("add-bookings of a different bill-to onto a draft → 409 MIXED_BILL_TO", async () => {
    const c = await company();
    const first = await generate([await booking(c._id, PERSON_MH)]);
    expect(first.status).toBe(201);
    const other = await booking(c._id);
    const r = await staff(request(app).post(`/api/admin/invoices/${first.body.invoice._id}/add-bookings`)).send({ bookingIds: [other] });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("MIXED_BILL_TO");
    expect((await ManualBooking.findById(other).lean() as any).status).toBe("CONFIRMED");
  });
});
