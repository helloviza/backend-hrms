// apps/backend/src/services/sbtManualLink.test.ts
//
// SBT → Manual Booking link, P1 (docs/specs/sbt-to-manual-booking-spec.md
// §3.1 / §3.3 / §8.1): mapping per kind, pricing (grandTotal === totalFare),
// bookedBy = the SBT user, idempotency (parallel + E11000), the old import
// row, test / demo / held, the switch and its start date, the hooks (save and
// query writes), failures + the 3rd-failure alert, fail-closed without the
// index, the sweep, the minimal cancellation note — and that the dashboard
// mirror still holds exactly ONE row per trip (the SBT one).
//
// Real: models, hooks, service, in-memory Mongo. Stubbed: the mailer.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";
for (const [k, v] of Object.entries({
  MONGO_URI: "mongodb://127.0.0.1:1/unused",
  JWT_SECRET: "jwt-secret-for-tests",
  JWT_REFRESH_SECRET: "refresh-secret-for-tests",
  FRONTEND_ORIGIN: "http://localhost:5173",
  AWS_REGION: "ap-south-1",
  S3_BUCKET: "test-bucket",
  GEMINI_API_KEY: "test",
})) process.env[k] ||= v;

const mail = vi.hoisted(() => ({ sent: [] as any[] }));
vi.mock("../utils/mailer.js", () => ({
  sendMail: async (m: any) => { mail.sent.push(m); return { messageId: "test" }; },
}));

const { default: ManualBooking } = await import("../models/ManualBooking.js");
const { saveWithBookingRefRetry, lockedPricingChanges } = await import("../utils/sbtLinkLock.js");
const { default: SBTBooking } = await import("../models/SBTBooking.js");
const { default: SBTHotelBooking } = await import("../models/SBTHotelBooking.js");
const { default: SBTConfig } = await import("../models/SBTConfig.js");
const { default: TravelBooking } = await import("../models/TravelBooking.js");
const svc = await import("./sbtManualLink.js");
const { manualLinksSettled } = await import("./sbtManualLinkTrigger.js");
const idx = await import("../bootstrap/ensureSbtManualLinkIndexes.js");

const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const CUSTOMER = oid();
const CWS = oid();
const USER = oid();
const BOOKED_AT = new Date("2026-12-02T09:00:00Z");
const SWITCH_ON = new Date("2026-12-01T00:00:00Z");

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sbt-manual-link-test"));
}, 120_000);
afterAll(async () => {
  await manualLinksSettled();
  await mongoose.disconnect();
  await mongod?.stop();
});

async function setSwitch(enabled: boolean, enabledAt: Date | null = SWITCH_ON) {
  await SBTConfig.updateOne({ key: "global" }, { $set: { manualLinkEnabled: enabled, manualLinkEnabledAt: enabledAt } }, { upsert: true });
  svc.resetManualLinkSettingsCache();
}

beforeEach(async () => {
  await manualLinksSettled();
  await mongoose.connection.db!.dropDatabase();
  mail.sent.length = 0;
  await idx.ensureSbtManualLinkIndexes({ log: () => {}, error: () => {} } as any);
  await col("customers").insertOne({ _id: CUSTOMER, name: "Osprey Labs", legalName: "Osprey Labs Pvt Ltd" });
  await col("customerworkspaces").insertOne({ _id: CWS, customerId: String(CUSTOMER), companyName: "Osprey Labs" });
  await col("users").insertOne({ _id: USER, email: "riya@osprey.test", phone: "+91 98100 00001", name: "Riya Sen" });
  await setSwitch(false);
});

/* ── fixtures ─────────────────────────────────────────────────────── */

const seg = (o: string, oc: string, d: string, dc: string, dep: string, arr: string, no: string, extra: Record<string, any> = {}) => ({
  Origin: { DepTime: dep, Airport: { AirportCode: oc, CityName: o } },
  Destination: { ArrTime: arr, Airport: { AirportCode: dc, CityName: d } },
  Airline: { AirlineCode: "6E", AirlineName: "IndiGo", FlightNumber: no },
  CabinClass: 2,
  ...extra,
});

/** One-way LCC flight (single-nested TicketLCC response) with a seat add-on. */
function flight(over: Record<string, any> = {}) {
  return {
    userId: USER,
    workspaceId: CWS,
    pnr: "QX7P2L",
    bookingId: "1882001",
    status: "CONFIRMED",
    origin: { code: "DEL", city: "Delhi" },
    destination: { code: "BOM", city: "Mumbai" },
    departureTime: "2026-12-20T06:30:00",
    arrivalTime: "2026-12-20T08:45:00",
    airlineCode: "6E",
    airlineName: "IndiGo",
    flightNumber: "6E2134",
    cabin: 2,
    passengers: [
      { title: "Ms", firstName: "Riya", lastName: "Sen", paxType: "ADULT", isLead: true, email: "riya@osprey.test", contactNo: "9810000001" },
      { title: "Mr", firstName: "Arun", lastName: "Sen", paxType: "CHILD", isLead: false },
    ],
    contactEmail: "riya@osprey.test",
    contactPhone: "9810000001",
    baseFare: 8000,
    totalFare: 10790,
    netAmount: 9800,
    extras: 500,
    marginAmount: 490,
    marginSource: "DEFAULT",
    paymentMode: "official",
    paymentStatus: "paid",
    bookedAt: BOOKED_AT,
    raw: { Response: { FlightItinerary: { Segments: [seg("Delhi", "DEL", "Mumbai", "BOM", "2026-12-20T06:30:00", "2026-12-20T08:45:00", "2134")] } } },
    ...over,
  };
}

function hotel(over: Record<string, any> = {}) {
  return {
    userId: USER,
    workspaceId: CWS,
    bookingId: "H-55",
    confirmationNo: "CNF889911",
    bookingRefNo: "BR-1",
    hotelCode: "1001",
    hotelName: "Taj Lands End",
    cityName: "Mumbai",
    checkIn: "2026-12-20",
    checkOut: "2026-12-23",
    rooms: 2,
    guests: [{ Title: "Ms", FirstName: "Riya", LastName: "Sen", PaxType: 1, LeadPassenger: true }],
    roomName: "Deluxe Sea View",
    mealType: "BB",
    totalFare: 31860,
    netAmount: 30000,
    marginAmount: 1860,
    marginSource: "DEFAULT",
    currency: "INR",
    isRefundable: true,
    cancelPolicies: [],
    status: "CONFIRMED",
    paymentStatus: "paid",
    paymentId: "pay_1",
    razorpayOrderId: "order_1",
    razorpayAmount: 31860,
    isVouchered: true,
    paymentMode: "personal",
    bookedAt: BOOKED_AT,
    ...over,
  };
}

async function rawFlight(over: Record<string, any> = {}) {
  const doc = { _id: oid(), ...flight(over) };
  await col("sbtbookings").insertOne(doc);
  return doc;
}

/* ── mapping ──────────────────────────────────────────────────────── */

describe("mapping (§3.1)", () => {
  it("one-way flight: locked API + charged price, grandTotal === totalFare, legs, passengers, bookedBy = the SBT user", async () => {
    const sbt = await rawFlight();
    const r = await svc.ensureLinkedManualBooking("SBTBooking", sbt, { via: "AUTO" });
    expect(r.status).toBe("created");
    const mb: any = await ManualBooking.findOne({ "sbtLink.bookingId": sbt._id }).lean();

    expect(String(mb.workspaceId)).toBe(String(CUSTOMER));
    expect(mb).toMatchObject({ type: "FLIGHT", source: "SBT_AUTO", status: "CONFIRMED", clientSelfBooked: true, supplierPNR: "QX7P2L", sourceBookingRef: "QX7P2L" });
    expect(String(mb.bookedBy)).toBe(String(USER));
    expect(mb.createdBy).toBe(String(USER));
    expect(mb.createdByEmail).toBe("riya@osprey.test");
    expect(new Date(mb.bookingDate).toISOString()).toBe(BOOKED_AT.toISOString());
    expect(new Date(mb.confirmedAt).getTime()).toBeGreaterThan(0);

    // API price = charge − recorded margin (the seat add-on is at cost).
    expect(mb.pricing).toMatchObject({ actualPrice: 10300, quotedPrice: 10790, gstMode: "ON_MARKUP", gstPercent: 18 });
    expect(mb.pricing.grandTotal).toBe(10790);
    expect(mb.pricing.gstAmount).toBeCloseTo((490 * 18) / 118, 2);
    expect(mb.pricingLocked).toMatchObject({ actualPrice: 10300, quotedPrice: 10790, reason: "SBT_API_PRICE", type: "FLIGHT" });

    expect(mb.itinerary.tripType).toBe("ONE_WAY");
    expect(mb.itinerary.legs).toHaveLength(1);
    expect(mb.itinerary.legs[0]).toMatchObject({ origin: "Delhi", destination: "Mumbai", flightNo: "6E2134", airline: "IndiGo", departTime: "06:30", arriveTime: "08:45", cabinClass: "Economy" });
    expect(new Date(mb.travelDate).toISOString()).toBe("2026-12-20T00:00:00.000Z");

    expect(mb.passengers).toEqual([
      expect.objectContaining({ name: "Riya Sen", email: "riya@osprey.test", phone: "9810000001", type: "ADULT" }),
      expect.objectContaining({ name: "Arun Sen", type: "CHILD" }),
    ]);
    expect(mb.sbtLink).toMatchObject({ model: "SBTBooking", createdVia: "AUTO", pricingBasis: "MARGIN_RECORD", paymentMode: "official", sbtStatus: "CONFIRMED" });

    const back: any = await col("sbtbookings").findOne({ _id: sbt._id });
    expect(String(back.manualBookingId)).toBe(String(mb._id));
  });

  it("return trip (GDS double-nested + returnTicketResult): every segment, ROUND_TRIP, returnDate, layover", async () => {
    const out = [
      seg("Delhi", "DEL", "Dubai", "DXB", "2026-12-20T02:10:00", "2026-12-20T04:40:00", "1451"),
      seg("Dubai", "DXB", "London", "LHR", "2026-12-20T07:55:00", "2026-12-20T12:10:00", "0007", { GroundTime: 195 }),
    ];
    const back = [seg("London", "LHR", "Delhi", "DEL", "2026-12-28T21:00:00", "2026-12-29T10:30:00", "0018")];
    const sbt = await rawFlight({
      returnPnr: "RT9KQ1",
      destination: { code: "LHR", city: "London" },
      raw: {
        Response: { Response: { FlightItinerary: { Segments: out } } },
        returnTicketResult: { Response: { Response: { FlightItinerary: { Segments: back } } } },
      },
    });
    await svc.ensureLinkedManualBooking("SBTBooking", sbt, { via: "AUTO" });
    const mb: any = await ManualBooking.findOne({ "sbtLink.bookingId": sbt._id }).lean();
    expect(mb.itinerary.tripType).toBe("ROUND_TRIP");
    expect(mb.itinerary.legs.map((l: any) => `${l.origin}-${l.destination}`)).toEqual(["Delhi-Dubai", "Dubai-London", "London-Delhi"]);
    expect(mb.itinerary.legs[0].layover).toBe("3h 15m");
    expect(mb.itinerary.legs[1].layover).toBeUndefined();
    expect(new Date(mb.returnDate).toISOString()).toBe("2026-12-28T00:00:00.000Z");
    expect(mb.sbtLink.returnPnr).toBe("RT9KQ1");
  });

  it("multi-city leg keeps its group and index; no margin record → NET_FALLBACK", async () => {
    const sbt = await rawFlight({ multiCityGroupId: "grp-1", legIndex: 1, legCount: 3, marginSource: undefined, marginAmount: 0, netAmount: 9000, extras: 300, raw: undefined });
    await svc.ensureLinkedManualBooking("SBTBooking", sbt, { via: "AUTO" });
    const mb: any = await ManualBooking.findOne({ "sbtLink.bookingId": sbt._id }).lean();
    expect(mb.sbtLink).toMatchObject({ multiCityGroupId: "grp-1", legIndex: 1, pricingBasis: "NET_FALLBACK" });
    expect(mb.pricing).toMatchObject({ actualPrice: 9300, quotedPrice: 10790, grandTotal: 10790 });
    // No supplier response kept → one leg from the booking's own fields.
    expect(mb.itinerary.legs).toEqual([expect.objectContaining({ origin: "Delhi", destination: "Mumbai", flightNo: "6E2134", departTime: "06:30" })]);
  });

  it("hotel: nights, rooms, check-in/out, lead guest takes the booker's email and phone", async () => {
    const h = { _id: oid(), ...hotel() };
    await col("sbthotelbookings").insertOne(h);
    await svc.ensureLinkedManualBooking("SBTHotelBooking", h, { via: "AUTO" });
    const mb: any = await ManualBooking.findOne({ "sbtLink.bookingId": h._id }).lean();
    expect(mb).toMatchObject({ type: "HOTEL", supplierName: "TBO", supplierPNR: "CNF889911", sector: "Mumbai" });
    expect(mb.itinerary).toMatchObject({ hotelName: "Taj Lands End", roomType: "Deluxe Sea View", destination: "Mumbai", nights: 3, roomCount: 2 });
    expect(new Date(mb.travelDate).toISOString()).toBe("2026-12-20T00:00:00.000Z");
    expect(new Date(mb.returnDate).toISOString()).toBe("2026-12-23T00:00:00.000Z");
    expect(mb.passengers[0]).toMatchObject({ name: "Riya Sen", email: "riya@osprey.test", phone: "+91 98100 00001" });
    expect(mb.pricing).toMatchObject({ actualPrice: 30000, quotedPrice: 31860, grandTotal: 31860 });
    expect(mb.sbtLink).toMatchObject({ model: "SBTHotelBooking", paymentMode: "personal" });
  });
});

/* ── idempotency + exclusions ─────────────────────────────────────── */

describe("idempotency and exclusions", () => {
  it("parallel links of one booking create ONE row; the rest answer exists", async () => {
    const sbt = await rawFlight();
    const rs = await Promise.all([1, 2, 3, 4].map(() => svc.ensureLinkedManualBooking("SBTBooking", sbt, { via: "AUTO" })));
    expect(rs.filter((r) => r.status === "created")).toHaveLength(1);
    expect(rs.every((r) => r.status === "created" || r.status === "exists")).toBe(true);
    expect(await ManualBooking.countDocuments({ "sbtLink.bookingId": sbt._id })).toBe(1);
  });

  it("a row from the old import counts as linked — no second booking", async () => {
    const sbt = await rawFlight();
    await col("manualbookings").insertOne({ bookingRef: "MB-2612-0001", source: "SBT", sourceBookingId: sbt._id, workspaceId: CUSTOMER, type: "FLIGHT", status: "CONFIRMED", travelDate: new Date(), bookedBy: oid() });
    const r = await svc.ensureLinkedManualBooking("SBTBooking", sbt, { via: "AUTO" });
    expect(r).toMatchObject({ status: "exists", legacy: true });
    expect(await ManualBooking.countDocuments({})).toBe(1);
  });

  it("test bookings never link; demo bookings link flagged as demo; only CONFIRMED links", async () => {
    expect((await svc.ensureLinkedManualBooking("SBTBooking", await rawFlight({ isTest: true }), { via: "AUTO" })).status).toBe("skipped");
    expect((await svc.ensureLinkedManualBooking("SBTBooking", await rawFlight({ status: "PENDING" }), { via: "AUTO" }))).toMatchObject({ status: "skipped", reason: "NOT_CONFIRMED" });
    const demo = await rawFlight({ isDemo: true, createdByDemoUser: true });
    expect((await svc.ensureLinkedManualBooking("SBTBooking", demo, { via: "AUTO" })).status).toBe("created");
    const mb: any = await ManualBooking.findOne({ "sbtLink.bookingId": demo._id }).lean();
    expect(mb).toMatchObject({ isDemo: true, createdByDemoUser: true });
    expect(await ManualBooking.countDocuments({})).toBe(1);
  });

  it("bookingRef collision in the same instant is retried, other duplicates are not", async () => {
    const yymm = (() => { const n = new Date(); return `${String(n.getFullYear()).slice(2)}${String(n.getMonth() + 1).padStart(2, "0")}`; })();
    // dropDatabase removed the unique bookingRef index; autoIndex rebuilds it unawaited.
    await col("manualbookings").createIndex({ bookingRef: 1 }, { unique: true, name: "bookingRef_1" }).catch(() => {});
    // count = 1 → the next ref would be …0002, which is already taken.
    await col("manualbookings").insertOne({ bookingRef: `MB-${yymm}-0002`, workspaceId: CUSTOMER, type: "OTHER", status: "PENDING", travelDate: new Date(), bookedBy: oid() });
    const doc = new ManualBooking({ workspaceId: CUSTOMER, type: "OTHER", status: "PENDING", travelDate: new Date(), bookedBy: oid(), pricing: { actualPrice: 0, quotedPrice: 0 } });
    const saved = await saveWithBookingRefRetry(doc);
    expect(saved.bookingRef).toBe(`MB-${yymm}-0003`);
  });
});

/* ── hooks + switch ───────────────────────────────────────────────── */

describe("save / query hooks and the switch", () => {
  it("switch OFF: a confirmed SBT save links nothing", async () => {
    await SBTBooking.create(flight());
    await manualLinksSettled();
    expect(await ManualBooking.countDocuments({})).toBe(0);
  });

  it("switch ON: the save hook links it; bookings made before the switch went on are left to the backfill", async () => {
    await setSwitch(true);
    const f = await SBTBooking.create(flight());
    const old = await SBTBooking.create(flight({ pnr: "OLD001", bookedAt: new Date("2026-11-20T09:00:00Z") }));
    await manualLinksSettled();
    expect(await ManualBooking.countDocuments({ "sbtLink.bookingId": f._id })).toBe(1);
    expect(await ManualBooking.countDocuments({ "sbtLink.bookingId": old._id })).toBe(0);
  });

  it("a hotel HOLD links only when it is vouchered (CONFIRMED)", async () => {
    await setSwitch(true);
    const h: any = await SBTHotelBooking.create(hotel({ status: "HELD", isHeld: true, isVouchered: false }));
    await manualLinksSettled();
    expect(await ManualBooking.countDocuments({})).toBe(0);
    h.status = "CONFIRMED";
    h.isVouchered = true;
    await h.save();
    await manualLinksSettled();
    expect(await ManualBooking.countDocuments({ "sbtLink.bookingId": h._id })).toBe(1);
  });

  it("hotel /book stamps CONFIRMED before bookings/save prices it: no link until the charge and payment are written", async () => {
    await setSwitch(true);
    // /book: the skeleton (net + margin, no charge yet) …
    const skel: any = await SBTHotelBooking.create(hotel({ status: "PENDING", totalFare: 0, paymentStatus: "pending", clientReferenceId: "PLM-1" }));
    // … then TBO answers "vouchered" → CONFIRMED, still unpriced and unpaid.
    await SBTHotelBooking.findOneAndUpdate({ clientReferenceId: "PLM-1" }, { $set: { status: "CONFIRMED", isVouchered: true } });
    await manualLinksSettled();
    expect(await ManualBooking.countDocuments({})).toBe(0);
    // bookings/save fills the skeleton from the payment row.
    const doc: any = await SBTHotelBooking.findById(skel._id);
    doc.set({ totalFare: 31860, paymentStatus: "paid" });
    await doc.save();
    await manualLinksSettled();
    const mb: any = await ManualBooking.findOne({ "sbtLink.bookingId": skel._id }).lean();
    expect(mb.pricing).toMatchObject({ actualPrice: 30000, quotedPrice: 31860, grandTotal: 31860 });
  });

  it("an unpaid flight never links automatically; the staff import still can", async () => {
    await setSwitch(true);
    const f = await SBTBooking.create(flight({ paymentStatus: "pending" }));
    await manualLinksSettled();
    expect(await ManualBooking.countDocuments({})).toBe(0);
    const lean: any = await col("sbtbookings").findOne({ _id: f._id });
    expect(await svc.ensureLinkedManualBooking("SBTBooking", lean, { via: "AUTO" })).toMatchObject({ status: "skipped", reason: "NOT_PAID" });
    expect((await svc.ensureLinkedManualBooking("SBTBooking", lean, { via: "IMPORT" })).status).toBe("created");
    expect(svc.linkableReason({ status: "CONFIRMED", totalFare: 0, paymentStatus: "paid" })).toBe("NOT_PRICED");
    expect(svc.linkableReason({ status: "CONFIRMED", totalFare: 100, isDemo: true })).toBeNull();
  });

  it("a query write (updateOne → CONFIRMED) links through the resync hook", async () => {
    await setSwitch(true);
    const f = await SBTBooking.create(flight({ status: "PENDING" }));
    await manualLinksSettled();
    expect(await ManualBooking.countDocuments({})).toBe(0);
    await SBTBooking.updateOne({ _id: f._id }, { $set: { status: "CONFIRMED" } });
    await manualLinksSettled();
    expect(await ManualBooking.countDocuments({ "sbtLink.bookingId": f._id })).toBe(1);
  });

  it("the dashboard mirror keeps ONE row per trip — the SBT one (P1 does not switch it)", async () => {
    await setSwitch(true);
    const f = await SBTBooking.create(flight());
    const h = await SBTHotelBooking.create(hotel());
    await manualLinksSettled();
    const mbs: any[] = await ManualBooking.find({}).lean();
    expect(mbs).toHaveLength(2);
    const refs = [f._id, h._id, ...mbs.map((m) => m._id)];
    const rows: any[] = await TravelBooking.find({ reference: { $in: refs } }).lean();
    expect(rows.map((r) => r.referenceModel).sort()).toEqual(["SBTBooking", "SBTHotelBooking"]);
    expect(rows.reduce((s, r) => s + r.amount, 0)).toBe(10790 + 31860);
    // A later edit of the linked booking still writes no mirror row.
    const mb: any = await ManualBooking.findById(mbs[0]._id);
    mb.notes = "Seat 12A confirmed";
    await mb.save();
    expect(await TravelBooking.countDocuments({ reference: mb._id })).toBe(0);
  });
});

/* ── failures ─────────────────────────────────────────────────────── */

describe("failures never block the booking", () => {
  it("records the error and attempts; the 3rd failure alerts ops once", async () => {
    const sbt = await rawFlight({ workspaceId: oid() }); // a workspace with no client company
    for (let i = 0; i < 4; i++) {
      const r = await svc.ensureLinkedManualBooking("SBTBooking", await col("sbtbookings").findOne({ _id: sbt._id }) as any, { via: "AUTO" });
      expect(r).toMatchObject({ status: "failed", reason: "NO_CUSTOMER" });
    }
    const row: any = await col("sbtbookings").findOne({ _id: sbt._id });
    expect(row.manualLinkAttempts).toBe(4);
    expect(row.manualLinkError).toMatch(/NO_CUSTOMER/);
    expect(row.manualLinkAlertedAt).toBeInstanceOf(Date);
    expect(mail.sent.filter((m) => /Manual Booking link failed/.test(m.subject))).toHaveLength(1);
    expect(await ManualBooking.countDocuments({})).toBe(0);
  });

  it("a failing link inside the save hook still saves the SBT booking", async () => {
    await setSwitch(true);
    const f = await SBTBooking.create(flight({ workspaceId: oid() }));
    await manualLinksSettled();
    expect(await SBTBooking.countDocuments({ _id: f._id })).toBe(1);
    const row: any = await col("sbtbookings").findOne({ _id: f._id });
    expect(row.manualLinkAttempts).toBe(1);
  });

  it("fails CLOSED while the unique link index is missing", async () => {
    await col("manualbookings").dropIndex("sbtLink_bookingId_unique");
    idx.resetSbtLinkIndexCheck();
    const sbt = await rawFlight();
    const r = await svc.ensureLinkedManualBooking("SBTBooking", sbt, { via: "AUTO" });
    expect(r).toMatchObject({ status: "failed", reason: "INDEX_MISSING" });
    expect(await ManualBooking.countDocuments({})).toBe(0);
    await idx.ensureSbtManualLinkIndexes({ log: () => {}, error: () => {} } as any);
    expect((await svc.ensureLinkedManualBooking("SBTBooking", sbt, { via: "AUTO" })).status).toBe("created");
  });
});

/* ── sweep ────────────────────────────────────────────────────────── */

describe("sweep", () => {
  it("links confirmed bookings the hook missed, since the switch, after a 2-minute grace", async () => {
    await setSwitch(true);
    const now = new Date("2026-12-02T10:00:00Z");
    const missed = await rawFlight({ bookedAt: new Date("2026-12-02T09:00:00Z") });
    const fresh = await rawFlight({ pnr: "FRESH1", bookedAt: new Date("2026-12-02T09:59:30Z") });
    const before = await rawFlight({ pnr: "OLD002", bookedAt: new Date("2026-11-30T09:00:00Z") });
    const r = await svc.sweepManualLinks(now);
    expect(r).toMatchObject({ created: 1, failed: 0 });
    expect(await ManualBooking.countDocuments({ "sbtLink.bookingId": missed._id })).toBe(1);
    expect(await ManualBooking.countDocuments({ "sbtLink.bookingId": { $in: [fresh._id, before._id] } })).toBe(0);
    // Second run: nothing left to do.
    expect((await svc.sweepManualLinks(now)).scanned).toBe(0);
  });

  it("does nothing while the switch is off", async () => {
    await rawFlight();
    expect(await svc.sweepManualLinks(new Date("2026-12-03T00:00:00Z"))).toMatchObject({ scanned: 0 });
  });
});

/* ── cancellation (minimal, P1) ───────────────────────────────────── */

describe("cancellation of a linked booking", () => {
  it("CANCEL_PENDING then CANCELLED: status recorded, note + ops alert each, status and price untouched", async () => {
    await setSwitch(true);
    const h: any = await SBTHotelBooking.create(hotel());
    await manualLinksSettled();
    const before: any = await ManualBooking.findOne({ "sbtLink.bookingId": h._id }).lean();

    h.status = "CANCEL_PENDING";
    await h.save();
    await manualLinksSettled();
    await SBTHotelBooking.updateOne({ _id: h._id }, { $set: { status: "CANCELLED", refundedAmount: 28000, cancellationCharge: 3860 } });
    await manualLinksSettled();

    const mb: any = await ManualBooking.findById(before._id).lean();
    expect(mb.status).toBe("CONFIRMED");
    expect(mb.pricing).toMatchObject({ actualPrice: 30000, quotedPrice: 31860, grandTotal: 31860 });
    expect(mb.sbtLink).toMatchObject({ sbtStatus: "CANCELLED", refundedAmount: 28000, cancellationCharge: 3860 });
    expect(mb.notes).toMatch(/Cancellation requested in SBT/);
    expect(mb.notes).toMatch(/Cancelled in SBT — refund ₹28,000, charge ₹3,860/);
    expect(mail.sent.filter((m) => /in SBT/.test(m.subject) && /Linked booking/.test(m.subject))).toHaveLength(2);

    // Same status again → nothing new.
    await SBTHotelBooking.updateOne({ _id: h._id }, { $set: { status: "CANCELLED", hotelName: "Taj Lands End " } });
    await manualLinksSettled();
    expect(mail.sent.filter((m) => /Linked booking/.test(m.subject))).toHaveLength(2);
  });
});

/* ── price lock (model level) ─────────────────────────────────────── */

describe("price lock — model guards (§3.3)", () => {
  async function linked() {
    const sbt = await rawFlight();
    await svc.ensureLinkedManualBooking("SBTBooking", sbt, { via: "AUTO" });
    return ManualBooking.findOne({ "sbtLink.bookingId": sbt._id });
  }

  it("a save that moves a locked figure is refused; other fields save", async () => {
    const mb: any = await linked();
    mb.pricing.quotedPrice = 9999;
    await expect(mb.save()).rejects.toMatchObject({ code: "PRICE_LOCKED" });
    const again: any = await ManualBooking.findById(mb._id);
    again.notes = "Window seat";
    again.givenBy = "Riya";
    await again.save();
    again.lineItems = [{ sNo: 1, itemDescription: "x", quantity: 1, actualRate: 1, quotedRate: 2 }];
    await expect(again.save()).rejects.toMatchObject({ code: "PRICE_LOCKED" });
    const fresh: any = (await ManualBooking.findById(mb._id))!.toObject();
    expect(lockedPricingChanges({ ...fresh, type: "HOTEL" })).toEqual(["type"]);
    expect(lockedPricingChanges(fresh)).toEqual([]);
  });

  it("query writes to pricing / lineItems / type on a locked row are refused; other query writes pass", async () => {
    const mb: any = await linked();
    await expect(ManualBooking.updateOne({ _id: mb._id }, { $set: { "pricing.quotedPrice": 1 } })).rejects.toMatchObject({ code: "PRICE_LOCKED" });
    await expect(ManualBooking.updateMany({}, { $set: { type: "HOTEL" } })).rejects.toMatchObject({ code: "PRICE_LOCKED" });
    await ManualBooking.updateOne({ _id: mb._id }, { $set: { notes: "ok" } });
    await ManualBooking.updateMany({ _id: mb._id }, { $set: { status: "INVOICED" } });
    const after: any = await ManualBooking.findById(mb._id).lean();
    expect(after).toMatchObject({ notes: "ok", status: "INVOICED" });
    expect(after.pricing.quotedPrice).toBe(10790);
  });

  it("the sanctioned writer can still change it (opt-out flag)", async () => {
    const mb: any = await linked();
    mb.$locals.allowLockedPricingWrite = true;
    mb.pricing.quotedPrice = 10000;
    await mb.save();
    await ManualBooking.updateOne({ _id: mb._id }, { $set: { "pricing.actualPrice": 9000 } }, { allowLockedPricingWrite: true } as any);
    const after: any = await ManualBooking.findById(mb._id).lean();
    expect(after.pricing).toMatchObject({ actualPrice: 9000, quotedPrice: 10000 });
  });
});
