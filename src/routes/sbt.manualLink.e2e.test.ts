// apps/backend/src/routes/sbt.manualLink.e2e.test.ts
//
// SBT → Manual Booking link through the REAL booking routes
// (docs/specs/sbt-to-manual-booking-spec.md §3.1, P1): a paid flight saved by
// POST /api/sbt/flights/bookings/save, and a hotel whose /book skeleton is
// filled by POST /api/sbt/hotels/bookings/save, each get ONE linked Manual
// Booking with the charge from the payment row and the API price — and the
// response the booker sees is unchanged and never waits on the link.
//
// Real: flights + hotels routers and their guards, payment gate, models,
// hooks, link service, in-memory Mongo. Stubbed (as in sbt.paymentGate.test.ts):
// requireAuth / requireWorkspace from headers, TBO, Razorpay, mail.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "jwt-secret-for-tests";
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
      _id: req.workspaceObjectId,
      customerId: String(req.headers["x-test-customer"] || ""),
      status: "ACTIVE",
      tenantType: "CORPORATE",
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

const { default: flightsRouter } = await import("./sbt.flights.js");
const { default: hotelsRouter } = await import("./sbt.hotels.js");
const { default: ManualBooking } = await import("../models/ManualBooking.js");
const { default: SBTConfig } = await import("../models/SBTConfig.js");
const { default: TravelBooking } = await import("../models/TravelBooking.js");
const { resetManualLinkSettingsCache } = await import("../services/sbtManualLink.js");
const { manualLinksSettled } = await import("../services/sbtManualLinkTrigger.js");
const { ensureSbtManualLinkIndexes } = await import("../bootstrap/ensureSbtManualLinkIndexes.js");

const app = express();
app.use(express.json());
app.use("/api/sbt/flights", flightsRouter);
app.use("/api/sbt/hotels", hotelsRouter);

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const WS = oid();
const CUSTOMER = oid();
const BOOKER = oid();

const as = (r: request.Test) =>
  r
    .set("x-test-user", JSON.stringify({ _id: String(BOOKER), id: String(BOOKER), sub: String(BOOKER), email: "riya@osprey.test", roles: ["CUSTOMER"] }))
    .set("x-test-ws", String(WS))
    .set("x-test-customer", String(CUSTOMER));

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sbt-manual-link-e2e-test"));
}, 120_000);
afterAll(async () => {
  await manualLinksSettled();
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await manualLinksSettled();
  await mongoose.connection.db!.dropDatabase();
  await ensureSbtManualLinkIndexes({ log: () => {}, error: () => {} } as any);
  await col("customers").insertOne({ _id: CUSTOMER, name: "Osprey Labs", legalName: "Osprey Labs Pvt Ltd" });
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(CUSTOMER), status: "ACTIVE", sbtOfficialBooking: { enabled: true, creditLimit: 100000, used: 0 } });
  await col("users").insertOne({ _id: BOOKER, email: "riya@osprey.test", name: "Riya Sen", sbtEnabled: true, sbtRole: null, customerId: String(CUSTOMER) });
  await SBTConfig.updateOne({ key: "global" }, { $set: { manualLinkEnabled: true, manualLinkEnabledAt: new Date(Date.now() - 60_000) } }, { upsert: true });
  resetManualLinkSettingsCache();
});

describe("a booking saved through the SBT routes gets its linked Manual Booking", () => {
  it("flight: bookings/save with a ticketed wallet payment → one CONFIRMED, locked booking; mirror stays the SBT row", async () => {
    const segs = [{
      Origin: { DepTime: "2026-12-20T06:30:00", Airport: { AirportCode: "DEL", CityName: "Delhi" } },
      Destination: { ArrTime: "2026-12-20T08:45:00", Airport: { AirportCode: "BOM", CityName: "Mumbai" } },
      Airline: { AirlineCode: "6E", AirlineName: "IndiGo", FlightNumber: "2134" },
      CabinClass: 2,
    }];
    await col("sbtpayments").insertOne({
      product: "FLIGHT", mode: "OFFICIAL", status: "TICKETED", userId: String(BOOKER), workspaceId: String(WS),
      tboBookingId: "1882001", amount: 10790, amountPaise: 1079000, baseAmount: 10290, addOnAmount: 500,
      margin: { marginPct: 5, marginAmount: 490, marginSource: "DEFAULT", marginVersion: 3, legs: [] },
      supplierResponses: [{ bookingId: "1882001", at: new Date(), response: { Response: { FlightItinerary: { Fare: { OfferedFare: 9800, BaseFare: 8000, Tax: 1800 }, Segments: segs } } } }],
      bookingDocIds: [], refunds: [], refundedPaise: 0, isTest: false, createdAt: new Date(),
    });
    const res = await as(request(app).post("/api/sbt/flights/bookings/save")).send({
      pnr: "QX7P2L", bookingId: "1882001", ticketId: "55001",
      origin: { city: "Delhi", code: "DEL" }, destination: { city: "Mumbai", code: "BOM" },
      departureTime: "2026-12-20T06:30:00", arrivalTime: "2026-12-20T08:45:00",
      airlineCode: "6E", airlineName: "IndiGo", flightNumber: "6E2134", baseFare: 8000, totalFare: 1,
      passengers: [{ title: "Ms", firstName: "Riya", lastName: "Sen", paxType: "ADULT", isLead: true, email: "riya@osprey.test" }],
      contactEmail: "riya@osprey.test", contactPhone: "9810000001", ticketingStatus: "TICKETED",
    });
    expect(res.status).toBe(200);
    const sbtId = res.body.booking._id ?? (await col("sbtbookings").findOne({ pnr: "QX7P2L" }))!._id;
    await manualLinksSettled();

    const mbs: any[] = await ManualBooking.find({}).lean();
    expect(mbs).toHaveLength(1);
    const mb = mbs[0];
    expect(String(mb.sbtLink.bookingId)).toBe(String(sbtId));
    expect(String(mb.workspaceId)).toBe(String(CUSTOMER));
    expect(String(mb.bookedBy)).toBe(String(BOOKER));
    expect(mb).toMatchObject({ status: "CONFIRMED", source: "SBT_AUTO", clientSelfBooked: true, supplierPNR: "QX7P2L" });
    expect(mb.pricing).toMatchObject({ actualPrice: 10300, quotedPrice: 10790, grandTotal: 10790 });
    expect(mb.pricingLocked).toMatchObject({ quotedPrice: 10790 });
    expect(mb.itinerary.legs[0]).toMatchObject({ origin: "Delhi", destination: "Mumbai", flightNo: "6E2134", departTime: "06:30" });
    expect(mb.sbtLink.paymentId).toBeTruthy();

    const rows: any[] = await TravelBooking.find({ reference: { $in: [sbtId, mb._id] } }).lean();
    expect(rows.map((r) => r.referenceModel)).toEqual(["SBTBooking"]);
  });

  it("hotel: the /book skeleton is CONFIRMED before save; the link waits for bookings/save and takes the charge", async () => {
    // What /book leaves behind: net + margin, CONFIRMED by TBO, no charge, unpaid.
    await col("sbthotelbookings").insertOne({
      userId: BOOKER, workspaceId: WS, clientReferenceId: "PLM-h1", status: "PENDING", totalFare: 0, paymentStatus: "pending",
      netAmount: 30000, marginAmount: 1860, marginSource: "DEFAULT", marginPercent: 6.2, bookedAt: new Date(), createdAt: new Date(),
    });
    await mongoose.model("SBTHotelBooking").findOneAndUpdate({ clientReferenceId: "PLM-h1" }, { $set: { status: "CONFIRMED", bookingId: "H-77", confirmationNo: "CNF889911", isVouchered: true } });
    await manualLinksSettled();
    expect(await ManualBooking.countDocuments({})).toBe(0);

    await col("sbtpayments").insertOne({
      product: "HOTEL", mode: "RAZORPAY", status: "BOOKED", userId: String(BOOKER), workspaceId: String(WS),
      clientReferenceId: "PLM-h1", tboBookingId: "H-77", razorpayOrderId: "order_h1", razorpayPaymentId: "pay_h1",
      amount: 31860, amountPaise: 3186000, bookingDocIds: [], refunds: [], refundedPaise: 0, isTest: false, paidAt: new Date(), createdAt: new Date(),
    });
    const res = await as(request(app).post("/api/sbt/hotels/bookings/save")).send({
      clientReferenceId: "PLM-h1", bookingId: "H-77", confirmationNo: "CNF889911", hotelCode: "1001", hotelName: "Taj Lands End",
      cityName: "Mumbai", checkIn: "2026-12-20", checkOut: "2026-12-23", rooms: 1, roomName: "Deluxe Sea View",
      guests: [{ Title: "Ms", FirstName: "Riya", LastName: "Sen", PaxType: 1, LeadPassenger: true }], totalFare: 1,
    });
    expect(res.status).toBe(200);
    await manualLinksSettled();

    const mbs: any[] = await ManualBooking.find({}).lean();
    expect(mbs).toHaveLength(1);
    expect(mbs[0]).toMatchObject({ type: "HOTEL", status: "CONFIRMED", supplierPNR: "CNF889911", clientSelfBooked: true });
    expect(mbs[0].pricing).toMatchObject({ actualPrice: 30000, quotedPrice: 31860, grandTotal: 31860 });
    expect(mbs[0].itinerary).toMatchObject({ hotelName: "Taj Lands End", nights: 3 });
    expect(mbs[0].passengers[0]).toMatchObject({ name: "Riya Sen", email: "riya@osprey.test" });
  });
});
