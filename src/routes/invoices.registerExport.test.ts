// apps/backend/src/routes/invoices.registerExport.test.ts
//
// Invoice register export (GET /api/admin/invoices/export, CSV + XLSX) — the
// GST columns added after the original ones (utils/invoiceRegister.ts):
//   • the INV-20260042 shape (cost 8,000 + fee 2,000 incl. 18% GST, same
//     state, Unregistered client) → Taxable 1,694.92, CGST 152.54,
//     SGST 152.54, pass-through 8,000;
//   • a Separate and an All-inclusive invoice of the SAME bookings give the
//     same row except the Layout column (and the invoice's own number/status);
//   • the original 16 columns are unchanged, CSV and XLSX agree.
//
// Real: invoices router, generation service, models, in-memory Mongo, ExcelJS.
// Stubbed: requireAuth / requireWorkspace (headers).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import ExcelJS from "exceljs";
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

const { default: invoicesRouter } = await import("./invoices.js");
const { requireWorkspace } = await import("../middleware/requireWorkspace.js");
const { invoiceTaxBreakdown, registerGstCells } = await import("../utils/invoiceRegister.js");
const { default: Customer } = await import("../models/Customer.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");

const app = express();
app.use(express.json());
app.use("/api/admin/invoices", requireWorkspace, invoicesRouter);

let mongod: MongoMemoryReplSet;
const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const SUPER = new mongoose.Types.ObjectId();
const asSuper = (r: request.Test) => r
  .set("x-test-user", JSON.stringify({ _id: String(SUPER), id: String(SUPER), sub: String(SUPER), roles: ["SUPERADMIN"] }))
  .set("x-test-ws", String(HOUSE));
const col = (n: string) => mongoose.connection.db!.collection(n);

const ORIGINAL = [
  "Invoice No", "Billing Period", "Client", "Client GSTIN", "Client Address", "Our GSTIN", "Bookings Count",
  "Subtotal", "Total GST", "Grand Total", "Status", "Generated At", "Due Date", "Paid At", "Terms", "Notes",
];
const ADDED = [
  "Taxable Value", "Non-taxable / Pass-through Amount", "CGST", "SGST", "UTGST", "IGST",
  "Supply Type", "Place of Supply", "Client GSTIN (or Unregistered)", "Invoice Layout",
];

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri("invoice-register-export-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await col("companysettings").insertOne({
    companyName: "Plumtrips", invoiceSeriesCadence: "annual", supplierState: "Karnataka",
    gstProfiles: [{ gstin: "29ABCDE1234F1Z5", state: "Karnataka", stateCode: "29", legalName: "Plumtrips KA", addressLine1: "", addressLine2: "", city: "Bengaluru", pincode: "560001", isDefault: true, active: true, invoiceSeriesPrefix: "" }],
  } as any);
});

async function client(state = "Karnataka") {
  const c: any = await Customer.create({ name: "QC Helping Hands", legalName: "QC Helping Hands Foundation", gstStatus: "UNREGISTERED", gstRegisteredState: state });
  await CustomerWorkspace.create({ customerId: String(c._id), companyName: c.legalName });
  return c;
}
let seq = 0;
async function booking(customerId: any) {
  seq += 1;
  const b: any = await ManualBooking.create({
    workspaceId: customerId, bookedBy: SUPER, type: "FLIGHT", supplierName: "TBO", givenBy: "Ops",
    status: "CONFIRMED", bookingRef: `MB-RX-${seq}`,
    travelDate: new Date("2026-11-24T00:00:00Z"), passengers: [{ name: "Asha QC", type: "ADULT" }],
    itinerary: { origin: "BLR", destination: "DEL", airline: "QC Air", flightNo: "QC 101" },
    // The INV-20260042 shape: cost 8,000 + fee 2,000 (GST 305.08 inside) = 10,000.
    pricing: { gstMode: "ON_MARKUP", gstPercent: 18, actualPrice: 8000, quotedPrice: 10000 },
  });
  return String(b._id);
}
async function generate(bookingIds: string[], invoiceFormat: string) {
  const r = await asSuper(request(app).post("/api/admin/invoices/generate")).send({ bookingIds, invoiceDate: "2026-11-17", invoiceFormat });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.invoice;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function csvExport(): Promise<Record<string, string>[]> {
  const r = await asSuper(request(app).get("/api/admin/invoices/export?format=csv"));
  expect(r.status).toBe(200);
  const [header, ...rows] = parseCsv(r.text);
  expect(header).toEqual([...ORIGINAL, ...ADDED]);
  return rows.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i]])));
}
async function xlsxExport(): Promise<Record<string, unknown>[]> {
  const r = await asSuper(request(app).get("/api/admin/invoices/export?format=xlsx")).buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => cb(null, Buffer.concat(chunks)));
  });
  expect(r.status).toBe(200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(r.body);
  const ws = wb.getWorksheet("Invoices")!;
  const header = (ws.getRow(1).values as any[]).slice(1);
  expect(header).toEqual([...ORIGINAL, ...ADDED]);
  const out: Record<string, unknown>[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const v = (row.values as any[]).slice(1);
    out.push(Object.fromEntries(header.map((h: string, i: number) => [h, v[i]])));
  });
  return out;
}

describe("register export: GST columns", () => {
  it("INV-20260042 shape: Taxable 1,694.92, CGST 152.54, SGST 152.54, pass-through 8,000 (CSV and XLSX)", async () => {
    const c = await client();
    const inv = await generate([await booking(c._id)], "ALL_INCLUSIVE");

    const [row] = await csvExport();
    expect(row["Invoice No"]).toBe(inv.invoiceNo);
    expect(row["Taxable Value"]).toBe("1694.92");
    expect(row["Non-taxable / Pass-through Amount"]).toBe("8000");
    expect(row["CGST"]).toBe("152.54");
    expect(row["SGST"]).toBe("152.54");
    expect(row["UTGST"]).toBe("0");
    expect(row["IGST"]).toBe("0");
    expect(row["Supply Type"]).toBe("CGST_SGST");
    expect(row["Place of Supply"]).toBe(inv.placeOfSupply);
    expect(row["Place of Supply"]).toMatch(/Karnataka|29/);
    expect(row["Client GSTIN (or Unregistered)"]).toBe("Unregistered");
    expect(row["Invoice Layout"]).toBe("All-inclusive");
    // The original columns are untouched, and the new ones reconcile to them.
    expect(row["Client GSTIN"]).toBe("");
    expect(row["Subtotal"]).toBe("9694.92");
    expect(row["Total GST"]).toBe("305.08");
    expect(row["Grand Total"]).toBe("10000");

    const [x] = await xlsxExport();
    expect(x["Taxable Value"]).toBe(1694.92);
    expect(x["Non-taxable / Pass-through Amount"]).toBe(8000);
    expect(x["CGST"]).toBe(152.54);
    expect(x["SGST"]).toBe(152.54);
    expect(x["Client GSTIN (or Unregistered)"]).toBe("Unregistered");
    expect(x["Invoice Layout"]).toBe("All-inclusive");
  });

  it("inter-state: IGST carries the tax, CGST/SGST 0", async () => {
    const c = await client("Maharashtra");
    await generate([await booking(c._id)], "SEPARATE");
    const [row] = await csvExport();
    expect(row["Supply Type"]).toBe("IGST");
    expect(row["IGST"]).toBe("305.08");
    expect(row["CGST"]).toBe("0");
    expect(row["SGST"]).toBe("0");
    expect(row["Taxable Value"]).toBe("1694.92");
    expect(row["Invoice Layout"]).toBe("Separate");
  });

  it("Separate and All-inclusive of the SAME bookings: identical rows except Layout", async () => {
    const c = await client();
    const ids = [await booking(c._id), await booking(c._id)];
    const sep = await generate(ids, "SEPARATE");
    const cancel = await asSuper(request(app).post(`/api/admin/invoices/${sep._id}/cancel`)).send({ reason: "Wrong layout" });
    expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
    const all = await generate(ids, "ALL_INCLUSIVE"); // the same two bookings, released by the cancel

    for (const rows of [await csvExport(), await xlsxExport()] as Record<string, unknown>[][]) {
      const a = rows.find((r) => r["Invoice No"] === all.invoiceNo)!;
      const s = rows.find((r) => r["Invoice No"] === sep.invoiceNo)!;
      expect(a["Invoice Layout"]).toBe("All-inclusive");
      expect(s["Invoice Layout"]).toBe("Separate");
      // Its own number and the cancel are the only other differences.
      const strip = (r: Record<string, unknown>) => {
        const { ["Invoice No"]: _n, ["Status"]: _s, ["Invoice Layout"]: _l, ...rest } = r;
        return rest;
      };
      expect(strip(a)).toEqual(strip(s));
      expect(a["Bookings Count"]).toEqual(s["Bookings Count"]);
      expect(Number(a["Taxable Value"])).toBe(3389.84);
      expect(Number(a["Non-taxable / Pass-through Amount"])).toBe(16000);
    }
  });

  it("an invoice from before the layout was stored reads 'Not recorded'; a registered client shows its GSTIN", () => {
    const cells = registerGstCells({
      lineItems: [{ amount: 500, igst: 0 }, { amount: 118, igst: 18 }],
      cgstAmount: 9, sgstAmount: 9, supplyType: "CGST_SGST", placeOfSupply: "Karnataka (29)",
      clientDetails: { gstin: "07AAHCM5991L1ZS" },
    });
    expect(cells).toEqual([100, 500, 9, 9, 0, 0, "CGST_SGST", "Karnataka (29)", "07AAHCM5991L1ZS", "Not recorded"]);
    // Paise arithmetic: no float drift across many lines.
    const many = Array.from({ length: 30 }, () => ({ amount: 2000, igst: 305.08 }));
    expect(invoiceTaxBreakdown({ lineItems: many }).taxableValue).toBe(50847.6);
  });
});
