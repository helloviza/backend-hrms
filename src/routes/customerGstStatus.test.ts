// apps/backend/src/routes/customerGstStatus.test.ts
//
// Customer GST status (REGISTERED / UNREGISTERED / NOT_SET) + billing GST fixes:
//   • migration mapping, GSTIN check digit, REGISTERED validation (format, check
//     digit, PAN match), onboarding "Not registered";
//   • UNREGISTERED (affiliates, agents, individuals): saves with no GSTIN, the
//     invoice reads "Unregistered (B2C)", tax amounts identical to any other
//     company in the same state, and no GST details reach TBO;
//   • REGISTERED: an invalid GSTIN is refused, a Business Master edit of an
//     onboarded company reaches the next invoice (F1), and a blank GSTIN on an
//     issued invoice is flagged — never back-filled from today's record (F9);
//   • NOT_SET: invoice generation unchanged, status reported for the staff hint;
//   • a Workspace Leader can't change GST details through workspace settings.
//
// Real: masterData / customers / invoices / workspace.settings routers, the
//   invoice-generation service, invoice PDF, models, in-memory Mongo.
// Stubbed: requireAuth / requireWorkspace (headers). The PDF test spies on
//   PDFKit's text() — calls go through unchanged.
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
const { default: wsSettingsRouter } = await import("./workspace.settings.js");
const { createInvoiceFromBookings } = await import("../services/invoiceGeneration.service.js");
const { syncCustomerFromOnboarding } = await import("../services/syncCustomerFromOnboarding.js");
const { generateInvoicePdf } = await import("../utils/invoicePdf.js");
const {
  migrationGstStatus,
  gstinChecksumValid,
  validateRegisteredGstin,
  gstStatusFromForm,
  stripSbtGstIfUnregistered,
} = await import("../utils/customerGst.js");
const { default: Customer } = await import("../models/Customer.js");
const { default: CustomerWorkspace } = await import("../models/CustomerWorkspace.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");
const { default: Onboarding } = await import("../models/Onboarding.js");
const { default: Invoice } = await import("../models/Invoice.js");
const PDFDocument = (await import("pdfkit")).default;

const app = express();
app.use(express.json());
app.use("/api/master-data", masterDataRouter);
app.use("/api/customers", customersRouter);
app.use("/api/admin/invoices", invoicesRouter);
app.use("/api/workspace/settings", wsSettingsRouter);

let mongod: MongoMemoryServer;
const oid = () => new mongoose.Types.ObjectId();
const HOUSE = new mongoose.Types.ObjectId("69679a7628330a58d29f2254");
const STAFF = oid();
const staff = (r: request.Test) =>
  r.set("x-test-user", JSON.stringify({ _id: String(STAFF), id: String(STAFF), sub: String(STAFF), roles: ["SUPERADMIN"] })).set("x-test-ws", String(HOUSE));

// Real GSTINs (pass the check digit) — Mölnlycke, Delhi + Haryana, PAN AAHCM5991L.
const GSTIN_DL = "07AAHCM5991L1ZS";
const GSTIN_HR = "06AAHCM5991L1ZU";
const PAN = "AAHCM5991L";

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("customer-gst-status-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  const db = mongoose.connection.db!;
  for (const c of await db.collections()) await c.deleteMany({});
});

async function company(fields: Record<string, unknown>) {
  const c: any = await Customer.create({ name: fields.legalName || "Acme", gstRegisteredState: "Karnataka", ...fields });
  const ws: any = await CustomerWorkspace.create({ customerId: String(c._id), companyName: c.legalName || c.name });
  return { c, ws };
}

let refSeq = 0;
async function booking(customerId: mongoose.Types.ObjectId) {
  refSeq += 1;
  return ManualBooking.create({
    workspaceId: customerId, bookedBy: STAFF, type: "FLIGHT", supplierName: "TBO", givenBy: "Ops",
    status: "CONFIRMED", bookingRef: `MB-GST-${refSeq}`,
    travelDate: new Date("2026-11-01T00:00:00Z"), passengers: [{ name: "Asha Rao", type: "ADULT" }],
    pricing: { gstMode: "ON_MARKUP", gstPercent: 18, actualPrice: 10000, quotedPrice: 11180 },
  });
}

async function invoiceFor(customerId: mongoose.Types.ObjectId) {
  const b: any = await booking(customerId);
  const [inv] = await createInvoiceFromBookings([String(b._id)], { format: "COMBINED", createdBy: String(STAFF) });
  return inv;
}

const amounts = (inv: any) => ({
  subtotal: inv.subtotal, totalGST: inv.totalGST, grandTotal: inv.grandTotal, supplyType: inv.supplyType,
  cgst: inv.cgstAmount, sgst: inv.sgstAmount, utgst: inv.utgstAmount, igst: inv.igstAmount,
  lines: (inv.lineItems || []).map((l: any) => [l.amount, l.igst]),
});

// Renders the real PDF; the spy only records each string drawn (calls through).
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

describe("status rules", () => {
  it("migration: GSTIN on the Customer → REGISTERED, none → NOT_SET (never UNREGISTERED)", () => {
    expect(migrationGstStatus({ gstNumber: GSTIN_DL })).toBe("REGISTERED");
    expect(migrationGstStatus({ gstin: GSTIN_DL })).toBe("REGISTERED");
    expect(migrationGstStatus({ gstNumber: "  " })).toBe("NOT_SET");
    expect(migrationGstStatus({})).toBe("NOT_SET");
  });

  it("GSTIN check digit + PAN match", () => {
    expect(gstinChecksumValid(GSTIN_DL)).toBe(true);
    expect(gstinChecksumValid(GSTIN_HR)).toBe(true);
    expect(gstinChecksumValid("07AAHCM5991L1ZT")).toBe(false);
    expect(validateRegisteredGstin(GSTIN_DL, PAN)).toBeNull();
    expect(validateRegisteredGstin(GSTIN_DL, "")).toBeNull();
    expect(validateRegisteredGstin("07AAHCM5991L1ZT", PAN)).toMatch(/check-digit/);
    expect(validateRegisteredGstin("NOT-A-GSTIN", PAN)).toMatch(/format/);
    expect(validateRegisteredGstin(GSTIN_DL, "ABCDE1234F")).toMatch(/does not belong to PAN/);
    expect(validateRegisteredGstin("", PAN)).toMatch(/needs a GSTIN/);
  });

  it("onboarding: 'Not registered' or URP → UNREGISTERED; a GSTIN → REGISTERED; else NOT_SET", () => {
    expect(gstStatusFromForm({ gstNotRegistered: true })).toBe("UNREGISTERED");
    expect(gstStatusFromForm({ entityType: "URP" })).toBe("UNREGISTERED");
    expect(gstStatusFromForm({ gstNumber: GSTIN_DL })).toBe("REGISTERED");
    expect(gstStatusFromForm({})).toBe("NOT_SET");
    expect(gstStatusFromForm({ gstNumber: GSTIN_DL, gstStatus: "UNREGISTERED" })).toBe("UNREGISTERED");
  });
});

describe("UNREGISTERED (B2C) company", () => {
  it("an onboarding submitted as 'Not registered' (no GSTIN) creates an UNREGISTERED company", async () => {
    const invite: any = await Onboarding.create({
      workspaceId: HOUSE, type: "business", email: "affiliate@example.test", token: "tok-unreg",
      expiresAt: new Date(Date.now() + 86_400_000), status: "submitted",
      formPayload: { legalName: "Riya Travels Affiliate", gstNotRegistered: true, panNumber: "ABCDE1234F" },
    });
    await syncCustomerFromOnboarding(invite.toObject());
    const c: any = await Customer.findOne({ onboardingId: invite._id }).lean();
    expect(c.gstStatus).toBe("UNREGISTERED");
    expect(c.gstNumber || "").toBe("");
  });

  it("Business Master saves an UNREGISTERED company with no GSTIN (both save paths)", async () => {
    const { c } = await company({ legalName: "Influencer One" });
    const res = await staff(request(app).patch(`/api/customers/${c._id}`)).send({ gstStatus: "UNREGISTERED", gstNumber: "" });
    expect(res.status).toBe(200);
    expect((await Customer.findById(c._id).lean() as any).gstStatus).toBe("UNREGISTERED");

    const ob: any = await Onboarding.create({
      workspaceId: HOUSE, type: "business", email: "agent@example.test", token: "tok-agent",
      expiresAt: new Date(Date.now() + 86_400_000), status: "approved", formPayload: { legalName: "Agent Two" },
    });
    const linked: any = await Customer.create({ name: "Agent Two", legalName: "Agent Two", onboardingId: ob._id, gstNumber: "OLD-JUNK" });
    const res2 = await staff(request(app).patch(`/api/master-data/${ob._id}`)).send({ gstStatus: "UNREGISTERED", gstNumber: "", legalName: "Agent Two" });
    expect(res2.status).toBe(200);
    const after: any = await Customer.findById(linked._id).lean();
    expect(after.gstStatus).toBe("UNREGISTERED");
    expect(after.gstNumber).toBe("OLD-JUNK"); // nothing deleted
  });

  it("invoice shows 'Unregistered (B2C)' — and tax amounts equal a same-state registered company's", async () => {
    const reg = await company({ legalName: "Registered Co", gstNumber: GSTIN_DL, gstStatus: "REGISTERED" });
    const unreg = await company({ legalName: "Unregistered Co", gstNumber: GSTIN_HR, gstStatus: "UNREGISTERED" });
    const unset = await company({ legalName: "Unset Co" });

    const invReg = await invoiceFor(reg.c._id);
    const invUnreg = await invoiceFor(unreg.c._id);
    const invUnset = await invoiceFor(unset.c._id);

    // Tax untouched by status.
    expect(amounts(invUnreg)).toEqual(amounts(invReg));
    expect(amounts(invUnset)).toEqual(amounts(invReg));
    // Pinned: ₹10,000 cost, ₹11,180 quoted, GST 18% on the ₹1,180 markup →
    // ₹180 GST split 90/90 intra-state, the figures generation gives today.
    expect(amounts(invReg)).toMatchObject({ supplyType: "CGST_SGST", totalGST: 180, grandTotal: 11180, cgst: 90, sgst: 90, igst: 0 });

    // An old GSTIN still on file never prints for an UNREGISTERED company.
    expect(invUnreg.clientDetails.gstin).toBe("");
    const view = await staff(request(app).get(`/api/admin/invoices/${invUnreg._id}`));
    expect(view.status).toBe(200);
    expect(view.body.invoice.clientDetails.gstin).toBe("");
    expect(view.body.invoice.clientDetails.gstStatus).toBe("UNREGISTERED");

    const printed = await pdfText({ ...invUnreg, clientDetails: view.body.invoice.clientDetails });
    expect(printed).toContain("GSTIN: Unregistered (B2C)");
    const printedReg = await pdfText({ ...invReg, clientDetails: (await staff(request(app).get(`/api/admin/invoices/${invReg._id}`))).body.invoice.clientDetails });
    expect(printedReg).toContain(`GSTIN: ${GSTIN_DL}`);
    expect(printedReg.join("|")).not.toContain("Unregistered");
  });

  it("workspace settings tell SBT the company is UNREGISTERED and offer no GSTIN to pre-fill", async () => {
    const { ws } = await company({ legalName: "B2C Partner", gstStatus: "UNREGISTERED" });
    await CustomerWorkspace.updateOne({ _id: ws._id }, { $set: { gstNumber: GSTIN_DL } });
    const res = await request(app).get("/api/workspace/settings")
      .set("x-test-user", JSON.stringify({ _id: String(oid()), roles: ["CUSTOMER", "WORKSPACE_LEADER"] }))
      .set("x-test-ws", String(ws._id));
    expect(res.status).toBe(200);
    expect(res.body.gstStatus).toBe("UNREGISTERED");
    expect(res.body.gstNumber).toBe("");
  });

  it("no GST details go to TBO — flight passengers (both legs) and hotel gstInfo are stripped", async () => {
    const { ws } = await company({ legalName: "B2C Partner", gstStatus: "UNREGISTERED" });
    const gst = { GSTNumber: GSTIN_DL, GSTCompanyName: "X", GSTCompanyAddress: "Y", GSTCompanyContactNumber: "9", GSTCompanyEmail: "a@b.c" };
    const req: any = {
      workspaceObjectId: ws._id,
      body: {
        Passengers: [{ FirstName: "Asha", IsLeadPax: true, ...gst }, { FirstName: "Ravi" }],
        returnPassengers: [{ FirstName: "Asha", IsLeadPax: true, ...gst }],
        gstInfo: { gstin: "BAD" },
        GSTCompanyInfo: { GSTIN: GSTIN_DL },
      },
    };
    expect(await stripSbtGstIfUnregistered(req)).toBe(true);
    for (const p of [...req.body.Passengers, ...req.body.returnPassengers]) {
      expect(Object.keys(p).filter((k) => k.startsWith("GST"))).toEqual([]);
    }
    expect(req.body.gstInfo).toBeUndefined();
    expect(req.body.GSTCompanyInfo).toBeUndefined();
    expect(req.body.Passengers[0].FirstName).toBe("Asha");
  });

  it("REGISTERED and NOT_SET companies keep sending GST to TBO exactly as before", async () => {
    for (const status of ["REGISTERED", undefined]) {
      const { ws } = await company({ legalName: `Co ${status}`, gstStatus: status, gstNumber: GSTIN_DL });
      const req: any = { workspaceObjectId: ws._id, body: { Passengers: [{ GSTNumber: GSTIN_DL }], gstInfo: { gstin: GSTIN_DL } } };
      expect(await stripSbtGstIfUnregistered(req)).toBe(false);
      expect(req.body.Passengers[0].GSTNumber).toBe(GSTIN_DL);
      expect(req.body.gstInfo.gstin).toBe(GSTIN_DL);
    }
  });
});

describe("REGISTERED company", () => {
  it("an invalid GSTIN is refused on both Business Master save paths, and nothing is written", async () => {
    const { c } = await company({ legalName: "Reg Co", gstNumber: GSTIN_DL, panNumber: PAN, gstStatus: "REGISTERED" });
    const bad = await staff(request(app).patch(`/api/customers/${c._id}`)).send({ gstNumber: "07AAHCM5991L1ZT", phone: "123" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("GSTIN_INVALID");
    const still: any = await Customer.findById(c._id).lean();
    expect(still.gstNumber).toBe(GSTIN_DL);
    expect(still.phone).toBeUndefined();

    const panMismatch = await staff(request(app).patch(`/api/customers/${c._id}`)).send({ gstNumber: GSTIN_DL, panNumber: "ABCDE1234F" });
    expect(panMismatch.status).toBe(400);

    const toRegisteredBlank = await staff(request(app).patch(`/api/customers/${c._id}`)).send({ gstStatus: "REGISTERED", gstNumber: "" });
    expect(toRegisteredBlank.status).toBe(400);

    const ob: any = await Onboarding.create({
      workspaceId: HOUSE, type: "business", email: "reg@example.test", token: "tok-reg",
      expiresAt: new Date(Date.now() + 86_400_000), status: "approved", formPayload: { legalName: "Reg Two", gstNumber: GSTIN_DL },
    });
    await Customer.create({ name: "Reg Two", legalName: "Reg Two", onboardingId: ob._id, gstNumber: GSTIN_DL, gstStatus: "REGISTERED" });
    const bad2 = await staff(request(app).patch(`/api/master-data/${ob._id}`)).send({ gstNumber: "12345", legalName: "Reg Two" });
    expect(bad2.status).toBe(400);
    expect(((await Onboarding.findById(ob._id).lean()) as any).formPayload.gstNumber).toBe(GSTIN_DL);
  });

  it("F1: a Business Master edit of an onboarded company reaches the next invoice (GSTIN, legal name, state, address)", async () => {
    const ob: any = await Onboarding.create({
      workspaceId: HOUSE, type: "business", email: "moln@example.test", token: "tok-moln",
      expiresAt: new Date(Date.now() + 86_400_000), status: "approved", formPayload: { legalName: "Molnlycke", gstNumber: GSTIN_DL },
    });
    const cust: any = await Customer.create({
      name: "Molnlycke", legalName: "Molnlycke", onboardingId: ob._id, gstNumber: GSTIN_DL,
      gstStatus: "REGISTERED", gstRegisteredState: "Delhi",
    });
    await CustomerWorkspace.create({ customerId: String(cust._id), companyName: "Molnlycke" });

    const res = await staff(request(app).patch(`/api/master-data/${ob._id}`)).send({
      legalName: "Molnlycke Health Care India Private Limited",
      gstNumber: GSTIN_HR, panNumber: PAN, gstRegisteredState: "Haryana",
      address: { street: "Plot 7, Sector 18", street2: "", city: "Gurugram", country: "India", pincode: "122015" },
    });
    expect(res.status).toBe(200);

    const after: any = await Customer.findById(cust._id).lean();
    expect(after.gstNumber).toBe(GSTIN_HR);
    expect(after.legalName).toBe("Molnlycke Health Care India Private Limited");
    expect(after.gstRegisteredState).toBe("Haryana");
    expect(after.address).toMatchObject({ street: "Plot 7, Sector 18", city: "Gurugram", pincode: "122015", state: "Haryana" });

    const inv = await invoiceFor(cust._id);
    expect(inv.clientDetails).toMatchObject({ gstin: GSTIN_HR, companyName: "Molnlycke Health Care India Private Limited", city: "Gurugram" });
    expect(inv.clientState).toBe("Haryana");

    // A blank GSTIN in a later form save never wipes the Customer's GSTIN —
    // and for a REGISTERED company it is the kept GSTIN that gets validated.
    const keep = await staff(request(app).patch(`/api/master-data/${ob._id}`)).send({ gstNumber: "", phone: "" });
    expect(keep.status).toBe(200);
    expect(((await Customer.findById(cust._id).lean()) as any).gstNumber).toBe(GSTIN_HR);
    const blank = await staff(request(app).patch(`/api/master-data/${ob._id}`)).send({ gstStatus: "NOT_SET", gstNumber: "" });
    expect(blank.status).toBe(200);
    expect(((await Customer.findById(cust._id).lean()) as any).gstNumber).toBe(GSTIN_HR);
  });

  it("F9: a blank GSTIN on an issued invoice is shown blank + flagged, never back-filled from today's record", async () => {
    const { c } = await company({ legalName: "Was Blank Co", gstStatus: "NOT_SET" });
    const inv = await invoiceFor(c._id);
    expect(inv.clientDetails.gstin).toBe("");

    // Later the company registers and its record gains a GSTIN.
    await Customer.updateOne({ _id: c._id }, { $set: { gstNumber: GSTIN_DL, gstStatus: "REGISTERED" } });

    const view = await staff(request(app).get(`/api/admin/invoices/${inv._id}`));
    expect(view.status).toBe(200);
    expect(view.body.invoice.clientDetails.gstin).toBe("");             // shown as stored
    expect(view.body.invoice.clientDetails.gstStatus).toBe("REGISTERED"); // → staff flag "GSTIN missing on this invoice"
    const stored: any = await Invoice.findById(inv._id).lean();
    expect(stored.clientDetails.gstin).toBe("");                         // stored invoice untouched

    // The client's PDF carries neither the back-filled GSTIN nor a staff flag.
    const printed = (await pdfText({ ...stored, clientDetails: view.body.invoice.clientDetails })).join("|");
    expect(printed).not.toContain(GSTIN_DL);
    expect(printed).not.toContain("missing");
  });
});

describe("NOT_SET company", () => {
  it("invoices exactly as before (GSTIN from the record) and the view reports NOT_SET for the staff hint", async () => {
    const { c } = await company({ legalName: "Legacy Co", gstNumber: GSTIN_DL });
    const inv = await invoiceFor(c._id);
    expect(inv.clientDetails.gstin).toBe(GSTIN_DL);
    const view = await staff(request(app).get(`/api/admin/invoices/${inv._id}`));
    expect(view.body.invoice.clientDetails.gstin).toBe(GSTIN_DL);
    expect(view.body.invoice.clientDetails.gstStatus).toBe("NOT_SET");
    const list = await staff(request(app).get("/api/customers"));
    expect(list.body.items.find((i: any) => i.id === String(c._id)).gstStatus).toBe("NOT_SET");
  });

  it("a NOT_SET company saves with any GSTIN, as today (no validation)", async () => {
    const { c } = await company({ legalName: "Loose Co" });
    const res = await staff(request(app).patch(`/api/customers/${c._id}`)).send({ gstNumber: "whatever" });
    expect(res.status).toBe(200);
  });
});

describe("GST details are locked for the client", () => {
  const leader = (ws: mongoose.Types.ObjectId) => (r: request.Test) =>
    r.set("x-test-user", JSON.stringify({ _id: String(oid()), roles: ["CUSTOMER", "WORKSPACE_LEADER"] })).set("x-test-ws", String(ws));

  it("a Workspace Leader can't change GSTIN or GST status; PAN still saves; staff unchanged", async () => {
    const { ws } = await company({ legalName: "Client Co", gstNumber: GSTIN_DL, gstStatus: "REGISTERED" });
    await CustomerWorkspace.updateOne({ _id: ws._id }, { $set: { gstNumber: GSTIN_DL } });

    for (const body of [{ gstNumber: GSTIN_HR }, { gstStatus: "UNREGISTERED" }, { pan: PAN, gstNumber: GSTIN_HR }]) {
      const res = await leader(ws._id)(request(app).patch("/api/workspace/settings/pan")).send(body);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("GST_LOCKED");
    }
    expect(((await CustomerWorkspace.findById(ws._id).lean()) as any).gstNumber).toBe(GSTIN_DL);
    expect(((await CustomerWorkspace.findById(ws._id).lean()) as any).pan || "").toBe("");

    const pan = await leader(ws._id)(request(app).patch("/api/workspace/settings/pan")).send({ pan: PAN });
    expect(pan.status).toBe(200);
    expect(pan.body.pan).toBe(PAN);

    const asStaff = await request(app).patch("/api/workspace/settings/pan")
      .set("x-test-user", JSON.stringify({ _id: String(STAFF), roles: ["ADMIN"] })).set("x-test-ws", String(ws._id))
      .send({ gstNumber: GSTIN_HR });
    expect(asStaff.status).toBe(200);
  });
});
