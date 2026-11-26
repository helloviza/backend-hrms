// apps/backend/src/routes/sbt.invoiceTo.test.ts
//
// "Invoice to" at SBT checkout + the billing snapshots
// (docs/specs/sbt-to-manual-booking-spec.md §3.6 / §3.7, P4; D-8, D-10):
//   • GET /api/sbt/invoice-to/options: off → { enabled:false }; on → the
//     company's active registrations (default first), the booker's name;
//   • POST /api/sbt/hotels/checkout validates the choice BEFORE any money moves
//     and stores the snapshot on the payment row:
//       Official + "My name" → 400 INVOICE_TO_NOT_ALLOWED (D-8), wallet untouched;
//       Personal + "My company" → 400 unless the company allows it (D-10);
//       a person: name / address / state required, GSTIN validated, state
//       DERIVED from the GSTIN; a company: default or chosen registration, or
//       (no registrations) its name, state and legacy GSTIN;
//       switch off / no choice sent → nothing stored (as before);
//       Official rows carry the wallet mode at checkout;
//   • the chain: payment row → bookings/save → SBT booking → linked Manual
//     Booking (billTo + sbtLink.walletMode), and a later mode switch never
//     moves it.
//
// Real: hotels / flights / invoice-to routers, payment gate, checkout, link
// service, models, in-memory replica set. Stubbed: auth / workspace headers,
// Razorpay order creation, TBO logging, mail. TBO itself sits on a dead port.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";
process.env.RAZORPAY_KEY_ID = "rzp_test_key";
process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
delete process.env.TBO_ENV;

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
    req.workspace = {
      _id: req.workspaceObjectId, customerId: String(req.headers["x-test-customer"] || ""), status: "ACTIVE", tenantType: "CORPORATE",
      config: { features: { sbtEnabled: true, flightBookingEnabled: true, hotelBookingEnabled: true } },
    };
    next();
  },
}));
vi.mock("../utils/tboFileLogger.js", () => ({ logTBOCall: () => {}, listTBOLogs: () => [], readTBOLog: () => null }));
vi.mock("../services/tbo.log.consolidator.js", () => ({ consolidateCertificationLogs: async () => {} }));
vi.mock("../jobs/static-data-refresh.js", () => ({
  resolveCityCodeAgainstCatalog: () => null,
  resolveCityCode: () => null,
  TBOHotelMaster: { find: () => ({ select: () => ({ lean: async () => [] }) }) },
}));
vi.mock("../utils/mailer.js", async (orig) => ({ ...(await orig<any>()), sendMail: vi.fn(async () => ({})) }));
vi.mock("../utils/companySettings.js", async (orig) => ({
  ...(await orig<any>()),
  getCompanySettings: async () => ({ opsEmail: "ops@test", supportEmail: "support@test", accountManagerEmail: "" }),
}));
const rzp = vi.hoisted(() => ({ createRazorpayOrder: vi.fn() }));
vi.mock("../services/sbtRazorpay.js", async (orig) => ({ ...(await orig<any>()), createRazorpayOrder: rzp.createRazorpayOrder, razorpayConfigured: () => true }));

const { default: hotelsRouter } = await import("./sbt.hotels.js");
const { default: flightsRouter } = await import("./sbt.flights.js");
const { default: invoiceToRouter } = await import("./sbt.invoiceTo.js");
const { resetInvoiceToCache } = await import("../services/sbtInvoiceTo.js");
const { resetManualLinkSettingsCache } = await import("../services/sbtManualLink.js");
const { manualLinksSettled } = await import("../services/sbtManualLinkTrigger.js");
const { ensureSbtManualLinkIndexes } = await import("../bootstrap/ensureSbtManualLinkIndexes.js");
const { changeBillingMode } = await import("../services/sbtWalletMode.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");

const app = express();
app.use(express.json());
app.use("/api/sbt/hotels", hotelsRouter);
app.use("/api/sbt/flights", flightsRouter);
app.use("/api/sbt/invoice-to", invoiceToRouter);

let mongod: MongoMemoryReplSet;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const WS = oid();
const CUSTOMER = oid();
const BOOKER = oid();
const REG_KA = oid();
const REG_DL = oid();
const GSTIN_KA = "29AAHCM5991L1ZU";
const GSTIN_DL = "07AAHCM5991L1ZS";
const PERSON_GSTIN_MH = "27AAPFU0939F1ZV";

const as = (r: request.Test) =>
  r
    .set("x-test-user", JSON.stringify({ _id: String(BOOKER), id: String(BOOKER), sub: String(BOOKER), email: "riya@osprey.test", roles: ["CUSTOMER"] }))
    .set("x-test-ws", String(WS))
    .set("x-test-customer", String(CUSTOMER));

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongod.getUri("sbt-invoice-to-test"));
  await mongoose.model("SBTPayment").syncIndexes();
  await mongoose.model("SBTWalletLedger").syncIndexes();
}, 120_000);
afterAll(async () => {
  await manualLinksSettled();
  await mongoose.disconnect();
  await mongod?.stop();
});

async function setSwitches(invoiceTo: boolean, manualLink = false) {
  await col("sbtconfigs").updateOne({ key: "global" }, { $set: { invoiceToEnabled: invoiceTo, manualLinkEnabled: manualLink, manualLinkEnabledAt: new Date(Date.now() - 60_000) } }, { upsert: true });
  resetInvoiceToCache();
  resetManualLinkSettingsCache();
}

let quoteSeq = 0;
async function quote() {
  quoteSeq += 1;
  const quoteId = `q-${quoteSeq}`;
  await col("sbtquotes").insertOne({ quoteId, product: "HOTEL", userId: String(BOOKER), workspaceId: String(WS), serverDisplayFare: 31860, sourceRef: `BC-${quoteSeq}`, createdAt: new Date() } as any);
  return { quoteId, bookingCode: `BC-${quoteSeq}` };
}
async function checkout(mode: "official" | "personal", invoiceTo?: unknown) {
  const q = await quote();
  return as(request(app).post("/api/sbt/hotels/checkout")).send({
    mode, kind: "HOTEL_BOOK", quoteId: q.quoteId,
    request: { BookingCode: q.bookingCode, ClientReferenceId: `PLM-${q.quoteId}` },
    save: { hotelName: "Taj Lands End", cityName: "Mumbai", checkIn: "2026-12-20", checkOut: "2026-12-23" },
    ...(invoiceTo !== undefined ? { invoiceTo } : {}),
  });
}
const lastRow = async () => (await col("sbtpayments").find({}).sort({ _id: -1 }).limit(1).toArray())[0] as any;
const used = async () => ((await col("customerworkspaces").findOne({ _id: WS })) as any).sbtOfficialBooking.used;

beforeEach(async () => {
  await manualLinksSettled();
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await ensureSbtManualLinkIndexes({ log: () => {}, error: () => {} } as any);
  rzp.createRazorpayOrder.mockReset();
  rzp.createRazorpayOrder.mockImplementation(async (amountPaise: number) => ({ id: `order_${Date.now()}_${Math.random()}`, amount: amountPaise, currency: "INR" }));
  await col("customers").insertOne({
    _id: CUSTOMER, name: "Osprey", legalName: "Osprey Labs Pvt Ltd", gstStatus: "REGISTERED", gstNumber: GSTIN_KA, gstRegisteredState: "Karnataka",
    gstRegistrations: [
      { _id: REG_KA, gstin: GSTIN_KA, state: "Karnataka", stateCode: "29", legalName: "Osprey Labs Pvt Ltd", address: { line1: "1 MG Road", city: "Bengaluru", pincode: "560001", country: "India" }, isDefault: true, active: true },
      { _id: REG_DL, gstin: GSTIN_DL, state: "Delhi", stateCode: "07", legalName: "Osprey Labs Pvt Ltd (Delhi)", label: "Delhi office", address: { line1: "Connaught Place", city: "New Delhi", pincode: "110001", country: "India" }, isDefault: false, active: true },
      { _id: oid(), gstin: "33AAHCM5991L1ZX", state: "Tamil Nadu", isDefault: false, active: false },
    ],
  } as any);
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(CUSTOMER), companyName: "Osprey Labs", status: "ACTIVE", sbtOfficialBooking: { enabled: true, creditLimit: 100000, used: 0 } } as any);
  await col("users").insertOne({ _id: BOOKER, email: "riya@osprey.test", name: "Riya Sen", sbtEnabled: true, sbtRole: null, customerId: String(CUSTOMER) } as any);
  await setSwitches(true);
});

const PERSON = { kind: "INDIVIDUAL", name: "Riya Sen", state: "Maharashtra", address: { line1: "12 Carter Road", city: "Mumbai", pincode: "400050" } };

describe("GET /api/sbt/invoice-to/options", () => {
  it("off → enabled:false; on → active registrations (default marked) and the booker's name", async () => {
    await setSwitches(false);
    expect((await as(request(app).get("/api/sbt/invoice-to/options"))).body).toMatchObject({ ok: true, enabled: false });
    await setSwitches(true);
    const r = await as(request(app).get("/api/sbt/invoice-to/options"));
    expect(r.body).toMatchObject({ enabled: true, allowPersonalToCompany: false, me: { name: "Riya Sen" }, company: { name: "Osprey Labs Pvt Ltd" } });
    expect(r.body.company.registrations.map((x: any) => [x.gstin, x.isDefault])).toEqual([[GSTIN_KA, true], [GSTIN_DL, false]]);
  });
});

describe("checkout validates and snapshots the choice", () => {
  it("Personal + My name → stored on the payment row (B2C, the given state)", async () => {
    const r = await checkout("personal", PERSON);
    expect(r.status).toBe(200);
    expect((await lastRow()).billTo).toMatchObject({ kind: "INDIVIDUAL", legalName: "Riya Sen", state: "Maharashtra", stateCode: "27", gstin: null, source: "SBT_CHECKOUT", address: { line1: "12 Carter Road" } });
    expect((await lastRow()).walletMode).toBeUndefined();
  });

  it("a GSTIN decides the state (the sent state is ignored); a bad GSTIN, no state or no address → 400", async () => {
    expect((await checkout("personal", { ...PERSON, state: "Kerala", gstin: PERSON_GSTIN_MH })).status).toBe(200);
    expect((await lastRow()).billTo).toMatchObject({ gstin: PERSON_GSTIN_MH, state: "Maharashtra", stateCode: "27" });
    const n = await col("sbtpayments").countDocuments({});
    for (const bad of [
      { ...PERSON, gstin: "27AAPFU0939F1ZX" },
      { ...PERSON, state: "" },
      { ...PERSON, state: "Atlantis" },
      { ...PERSON, address: { line1: "" } },
      { ...PERSON, name: "" },
      { kind: "SOMEONE" },
    ]) {
      const r = await checkout("personal", bad);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe("INVOICE_TO_INVALID");
    }
    expect(await col("sbtpayments").countDocuments({})).toBe(n);
    expect(rzp.createRazorpayOrder).toHaveBeenCalledTimes(1);
  });

  it("Personal + My company: refused (D-10) until the company allows it, then the default registration", async () => {
    const refused = await checkout("personal", { kind: "COMPANY" });
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe("INVOICE_TO_NOT_ALLOWED");
    expect(await col("sbtpayments").countDocuments({})).toBe(0);
    await col("customerworkspaces").updateOne({ _id: WS }, { $set: { "sbtBilling.allowPersonalInvoiceToCompany": true } });
    expect((await checkout("personal", { kind: "COMPANY" })).status).toBe(200);
    expect((await lastRow()).billTo).toMatchObject({ kind: "COMPANY", registrationId: String(REG_KA), gstin: GSTIN_KA, state: "Karnataka" });
  });

  it("Official + My name → 400 (D-8) before the wallet moves", async () => {
    const r = await checkout("official", PERSON);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("INVOICE_TO_NOT_ALLOWED");
    expect(await used()).toBe(0);
    expect(await col("sbtpayments").countDocuments({})).toBe(0);
  });

  it("Official + a chosen registration → that GSTIN, and the wallet mode at checkout", async () => {
    await checkout("official", { kind: "COMPANY", registrationId: String(REG_DL) });
    const row = await lastRow();
    expect(row).toMatchObject({ mode: "OFFICIAL", walletMode: "POSTPAID" });
    expect(row.billTo).toMatchObject({ kind: "COMPANY", registrationId: String(REG_DL), gstin: GSTIN_DL, state: "Delhi", legalName: "Osprey Labs Pvt Ltd (Delhi)" });
  });

  it("an inactive or unknown registration → 400", async () => {
    expect((await checkout("official", { kind: "COMPANY", registrationId: String(oid()) })).body.code).toBe("INVOICE_TO_INVALID");
  });

  it("a company with no registrations: its name, state and legacy GSTIN", async () => {
    await col("customers").updateOne({ _id: CUSTOMER }, { $unset: { gstRegistrations: "" } });
    await checkout("official", { kind: "COMPANY" });
    expect((await lastRow()).billTo).toMatchObject({ kind: "COMPANY", registrationId: null, gstin: GSTIN_KA, state: "Karnataka", legalName: "Osprey Labs Pvt Ltd" });
  });

  it("switch off, or no choice sent → nothing stored (invoiced to the company, as before)", async () => {
    await setSwitches(false);
    expect((await checkout("personal", PERSON)).status).toBe(200);
    expect((await lastRow()).billTo).toBeUndefined();
    await setSwitches(true);
    expect((await checkout("personal")).status).toBe(200);
    expect((await lastRow()).billTo).toBeUndefined();
  });

  it("Official on a Prepaid company records PREPAID", async () => {
    await changeBillingMode(WS, { mode: "PREPAID", reason: "advance" }, "staff");
    await col("customerworkspaces").updateOne({ _id: WS }, { $set: { "sbtOfficialBooking.used": -50000 } });
    await checkout("official", { kind: "COMPANY" });
    expect((await lastRow()).walletMode).toBe("PREPAID");
  });
});

describe("the snapshot travels to the booking and its Manual Booking, and stays", () => {
  it("payment row → flight bookings/save → SBT booking → linked Manual Booking; a later switch moves nothing", async () => {
    await setSwitches(true, true);
    const billTo = { kind: "COMPANY", registrationId: String(REG_DL), gstin: GSTIN_DL, stateCode: "07", state: "Delhi", legalName: "Osprey Labs Pvt Ltd (Delhi)", source: "SBT_CHECKOUT", at: new Date() };
    await col("sbtpayments").insertOne({
      product: "FLIGHT", mode: "OFFICIAL", status: "TICKETED", userId: String(BOOKER), workspaceId: String(WS), walletMode: "POSTPAID", billTo,
      tboBookingId: "1882001", amount: 10790, amountPaise: 1079000, baseAmount: 10790, addOnAmount: 0,
      margin: { marginPct: 5, marginAmount: 490, marginSource: "DEFAULT", marginVersion: 1, legs: [] },
      bookingDocIds: [], refunds: [], refundedPaise: 0, isTest: false, createdAt: new Date(),
    } as any);
    const r = await as(request(app).post("/api/sbt/flights/bookings/save")).send({
      pnr: "QX7P2L", bookingId: "1882001", origin: { city: "Delhi", code: "DEL" }, destination: { city: "Mumbai", code: "BOM" },
      departureTime: "2026-12-20T06:30:00", arrivalTime: "2026-12-20T08:45:00", airlineCode: "6E", airlineName: "IndiGo",
      flightNumber: "6E2134", baseFare: 8000, totalFare: 1, passengers: [{ firstName: "Riya", lastName: "Sen", paxType: "ADULT", isLead: true }],
      // A tampered body can't set them.
      walletMode: "PREPAID", billTo: { kind: "INDIVIDUAL", legalName: "Mallory", state: "Goa" },
    });
    expect(r.status).toBe(200);
    const sbt: any = await col("sbtbookings").findOne({ pnr: "QX7P2L" });
    expect(sbt).toMatchObject({ walletMode: "POSTPAID", billTo: { gstin: GSTIN_DL, state: "Delhi" } });

    await manualLinksSettled();
    const mb: any = await ManualBooking.findOne({ "sbtLink.bookingId": sbt._id }).lean();
    expect(mb.sbtLink.walletMode).toBe("POSTPAID");
    expect(mb.billTo).toMatchObject({ kind: "COMPANY", gstin: GSTIN_DL, state: "Delhi", source: "SBT_CHECKOUT" });

    await changeBillingMode(WS, { mode: "PREPAID", reason: "later" }, "staff");
    const again: any = await ManualBooking.findById(mb._id).lean();
    expect(again.sbtLink.walletMode).toBe("POSTPAID");
    expect(((await col("sbtbookings").findOne({ _id: sbt._id })) as any).walletMode).toBe("POSTPAID");
  });
});
