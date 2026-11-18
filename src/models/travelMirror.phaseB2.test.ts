// apps/backend/src/models/travelMirror.phaseB2.test.ts
//
// Travel Spend Phase B additions (2026-11-18), against a real in-memory mongod:
//   - manual flight mirror: departure time + cabin fall back to the extracted
//     ticket (mirror only, flagged "ticket"); the booking's own values win;
//     fare-class codes never become a cabin; foreign departures → IST
//   - manual visa outcome (optional field) → mirror; hotel nights/rooms
//   - SBT flight cabin + origin city; SBT hotel nights
//   - a finished extraction / corrected ticket refreshes the mirror row
//   - resync --include-analytics dry run reports the ticket-filled rows
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const { default: ManualBooking, buildManualBookingMirror, VISA_OUTCOMES } = await import("./ManualBooking.js");
const { buildSBTBookingMirror } = await import("./SBTBooking.js");
const { buildSBTHotelBookingMirror, stayNights } = await import("./SBTHotelBooking.js");
const { refreshBookingMirrorSafely } = await import("../services/documentExtraction.service.js");
const { resyncTravelBookingMirrors } = await import("../scripts/resync-travel-booking-mirrors.js");

const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const CUST = new mongoose.Types.ObjectId("6a00000000000000000000e1");
const WS = new mongoose.Types.ObjectId("6a00000000000000000000e2");
const STAFF = oid();
const D = (s: string) => new Date(`${s}T00:00:00Z`);

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("phaseb2_mirror_test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  for (const c of ["customers", "customerworkspaces", "manualbookings", "sbtbookings", "sbthotelbookings", "travelbookings", "extracteddocuments"]) await col(c).deleteMany({});
  await col("customers").insertOne({ _id: CUST, name: "Acme" } as any);
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(CUST), name: "Acme WS" } as any);
});

const flight = (over: any = {}) => ({
  _id: oid(), workspaceId: CUST, bookedBy: STAFF, type: "FLIGHT", status: "INVOICED", bookingRef: "MB-T1",
  bookingDate: D("2026-08-01"), travelDate: D("2026-08-18"), pricing: { grandTotal: 9000 }, passengers: [{ name: "Asha" }],
  itinerary: { origin: "DEL - BLR", destination: "DEL", airline: "IndiGo", flightNo: "6E 1" }, ...over,
});
const ticket = (bookingId: any, rows: any[], status = "extracted") =>
  col("extracteddocuments").insertOne({
    _id: oid(), sourceModule: "manualBookings", sourceId: bookingId, bookingId, workspaceId: CUST, status,
    attachmentRef: `k-${oid()}`, originalFilename: "t.pdf", mimeType: "application/pdf", size: 1, docType: "flight",
    flightRows: rows, createdAt: new Date(),
  } as any);
const row = (i: number, dep: string, date: string, time: string, cabin: string | null = null) =>
  ({ passengerIndex: 0, segmentIndex: i, depAirport: dep, depDate: date, depTime: time, cabinClass: cabin });

describe("manual flight mirror — ticket fallback", () => {
  it("fills departure time + cabin from the ticket, flagged 'ticket'", async () => {
    const b = flight();
    await ticket(b._id, [row(0, "BLR", "21-Aug-2026", "11:00", "SM"), row(1, "DEL", "18-Aug-2026", "13:00", "Economy, Class FL")]);
    const m: any = await buildManualBookingMirror(b);
    expect(m.metadata).toMatchObject({
      departTimeIST: "13:00", departMinutesIST: 780, departTimeSource: "ticket", departTimeFromTz: null,
      cabinClass: "Economy", cabinClassSource: "ticket", originCity: "Delhi",
    });
  });

  it("the booking's own values win; no ticket read needed", async () => {
    const b = flight({ itinerary: { origin: "DEL", destination: "BLR", legs: [{ origin: "DEL", destination: "BLR", departTime: "06:30", cabinClass: "Business" }] } });
    await ticket(b._id, [row(0, "DEL", "2026-08-18", "13:00", "Economy")]);
    const m: any = await buildManualBookingMirror(b);
    expect(m.metadata).toMatchObject({ departTimeIST: "06:30", departTimeSource: "booking", cabinClass: "Business", cabinClassSource: "booking" });
  });

  it("fare-code-only cabin stays unknown; non-extracted tickets are ignored", async () => {
    const b = flight({ itinerary: { origin: "DEL", legs: [{ origin: "DEL", destination: "BLR", cabinClass: "SM" }] } });
    await ticket(b._id, [row(0, "DEL", "2026-08-18", "13:00", "FL")]);
    await ticket(b._id, [row(0, "DEL", "2026-08-18", "13:00", "Business")], "failed");
    const m: any = await buildManualBookingMirror(b);
    expect(m.metadata.cabinClass).toBeNull();
    expect(m.metadata.cabinClassSource).toBeNull();
    expect(m.metadata.departTimeSource).toBe("ticket");
  });

  it("foreign departure converted to IST; a bad ticket date leaves the time empty", async () => {
    const lon = flight({ travelDate: D("2026-07-15"), itinerary: { origin: "LHR", destination: "DEL" } });
    await ticket(lon._id, [row(0, "LHR", "15-Jul-2026", "10:00", "Premium Economy")]);
    const m: any = await buildManualBookingMirror(lon);
    expect(m.metadata).toMatchObject({ departTimeIST: "14:30", departTimeSource: "ticket", departTimeFromTz: "Europe/London", cabinClass: "Premium Economy" });

    const bad = flight();
    await ticket(bad._id, [row(0, "DEL", "2016-08-18", "13:00")]);
    const m2: any = await buildManualBookingMirror(bad);
    expect(m2.metadata.departMinutesIST).toBeNull();
    expect(m2.metadata.departTimeSource).toBeNull();
  });
});

describe("manual visa outcome + hotel stay", () => {
  it("visa outcome is optional, validated, and carried to the mirror", async () => {
    expect(VISA_OUTCOMES).toEqual(["APPROVED", "REJECTED", "AWAITING"]);
    const base = { workspaceId: CUST, bookedBy: STAFF, type: "VISA", status: "CONFIRMED", bookingDate: D("2026-08-01"), passengers: [{ name: "Asha" }], pricing: { actualPrice: 1, quotedPrice: 1 } };
    const ok = new ManualBooking({ ...base, itinerary: { visaCountry: "UAE", visaOutcome: "APPROVED" } });
    expect(ok.validateSync()?.errors?.["itinerary.visaOutcome"]).toBeUndefined();
    const none = new ManualBooking({ ...base, itinerary: { visaCountry: "UAE" } });
    expect(none.validateSync()?.errors?.["itinerary.visaOutcome"]).toBeUndefined();
    const badV = new ManualBooking({ ...base, itinerary: { visaOutcome: "MAYBE" } });
    expect(badV.validateSync()?.errors?.["itinerary.visaOutcome"]).toBeDefined();

    const m: any = await buildManualBookingMirror({ _id: oid(), ...base, itinerary: { visaCountry: "UAE", visaOutcome: "REJECTED" } });
    expect(m.metadata.visaOutcome).toBe("REJECTED");
    const m2: any = await buildManualBookingMirror({ _id: oid(), ...base, itinerary: { visaCountry: "UAE" } });
    expect("visaOutcome" in m2.metadata).toBe(false);
  });

  it("hotel nights + rooms go to the mirror", async () => {
    const m: any = await buildManualBookingMirror({
      _id: oid(), workspaceId: CUST, bookedBy: STAFF, type: "HOTEL", status: "CONFIRMED", bookingDate: D("2026-08-01"),
      passengers: [{ name: "Asha" }], sector: "Mumbai", itinerary: { hotelName: "Taj", nights: 3, roomCount: 2 },
    });
    expect(m.metadata).toMatchObject({ nights: 3, rooms: 2 });
  });
});

describe("SBT mirrors — cabin, origin city, hotel nights", () => {
  it("flight: TBO cabin code → cabin, origin city canonical", async () => {
    const m: any = await buildSBTBookingMirror({
      _id: oid(), userId: STAFF, workspaceId: WS, customerId: String(CUST), status: "CONFIRMED", totalFare: 5000, cabin: 4,
      origin: { code: "DEL", city: "New Delhi" }, destination: { code: "BOM", city: "Mumbai" }, airlineCode: "AI", airlineName: "Air India",
      flightNumber: "AI 1", departureTime: "2026-11-21T08:35:00", arrivalTime: "2026-11-21T10:35:00", bookedAt: new Date(),
    });
    expect(m.metadata).toMatchObject({ cabinClass: "Business", cabinClassSource: "booking", originCity: "Delhi", departTimeSource: "booking" });
  });

  it("hotel: nights from check-in / check-out", async () => {
    expect(stayNights("2026-12-01", "2026-12-04")).toBe(3);
    expect(stayNights("2026-12-01T14:00:00", "2026-12-02")).toBe(1);
    expect(stayNights("2026-12-04", "2026-12-01")).toBeNull();
    expect(stayNights("", "2026-12-01")).toBeNull();
    const m: any = await buildSBTHotelBookingMirror({
      _id: oid(), userId: STAFF, workspaceId: WS, status: "CONFIRMED", totalFare: 9000, hotelName: "H", cityName: "Mumbai",
      checkIn: "2026-12-01", checkOut: "2026-12-03", rooms: 1, bookedAt: new Date(),
    }, new Date("2026-11-20T00:00:00Z"));
    expect(m.metadata.nights).toBe(2);
  });
});

describe("refresh on extraction + resync dry run", () => {
  it("refreshBookingMirrorSafely rebuilds the booking's mirror row from its ticket", async () => {
    const b = await ManualBooking.create({ ...flight(), _id: undefined, pricing: { actualPrice: 8000, quotedPrice: 9000 } } as any);
    let m: any = await col("travelbookings").findOne({ reference: b._id });
    expect(m.metadata.departMinutesIST).toBeNull();
    const t = await ticket(b._id, [row(0, "DEL", "2026-08-18", "13:00", "Economy")]);
    await refreshBookingMirrorSafely({ sourceModule: "manualBookings", bookingId: b._id, _id: t.insertedId } as any);
    m = await col("travelbookings").findOne({ reference: b._id });
    expect(m.metadata).toMatchObject({ departTimeIST: "13:00", departTimeSource: "ticket", cabinClass: "Economy", cabinClassSource: "ticket" });
    // Other modules and missing bookings are a no-op, never a throw.
    await expect(refreshBookingMirrorSafely({ sourceModule: "expenses", bookingId: b._id, _id: oid() } as any)).resolves.toBeUndefined();
    await expect(refreshBookingMirrorSafely({ sourceModule: "manualBookings", bookingId: oid(), _id: oid() } as any)).resolves.toBeUndefined();
  });

  it("resync --include-analytics dry run targets and reports ticket-filled rows; writes nothing", async () => {
    const b = await ManualBooking.create({ ...flight(), _id: undefined, bookingDate: new Date(), travelDate: new Date(), pricing: { actualPrice: 8000, quotedPrice: 9000 } } as any);
    const day = new Date().toISOString().slice(0, 10);
    const [y, mo, d] = day.split("-").map(Number);
    const fmt = `${String(d).padStart(2, "0")}-${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][mo - 1]}-${y}`;
    await ticket(b._id, [row(0, "DEL", fmt, "13:00", "Economy")]);
    const before: any = await col("travelbookings").findOne({ reference: b._id });
    const report: any = await resyncTravelBookingMirrors({ apply: false, includeAnalytics: true, expectDb: "phaseb2_mirror_test", log: () => {} });
    const r = report.rows.find((x: any) => x.id === String(b._id));
    expect(r?.changes?.metadata).toBeDefined();
    const ins = report.insights["All time"].after;
    expect(ins.departureSlots.fromTicket).toBe(1);
    expect(ins.cabins).toMatchObject({ known: 1, fromTicket: 1 });
    const after: any = await col("travelbookings").findOne({ reference: b._id });
    expect(after.metadata).toEqual(before.metadata);
  });
});
