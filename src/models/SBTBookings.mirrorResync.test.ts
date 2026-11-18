// apps/backend/src/models/SBTBookings.mirrorResync.test.ts
//
// Travel Spend audit 2026-11, N4: SBTHotelBooking and SBTBooking synced the
// TravelBooking mirror only in post("save"). Their status transitions
// (routes/sbt.hotels.ts, jobs/deferred-status-check.ts, orphan cleanup, hold
// reminders), the flight fare update (sbt.flights.ts updateOne) and the
// isTest / isDemo flag scripts all use findOneAndUpdate / updateOne /
// updateMany — so the mirror stayed PENDING with a stale fare.
//
// Real: both SBT models + TravelBooking, in-memory mongod. Source rows are
// inserted raw (with a deliberately stale mirror row) and then written
// through the model exactly as the routes / jobs do.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const { default: SBTHotelBooking, resyncSBTHotelBookingMirrors } = await import("./SBTHotelBooking.js");
const { default: SBTBooking, resyncSBTBookingMirrors } = await import("./SBTBooking.js");
const { default: TravelBooking } = await import("./TravelBooking.js");

const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const mirror = (id: unknown) => col("travelbookings").findOne({ reference: id });
const CUST = "6a0000000000000000000001";
const USER = oid();

async function hotel(extra: Record<string, unknown> = {}) {
  const _id = oid();
  await col("sbthotelbookings").insertOne({
    _id, userId: USER, workspaceId: oid(), customerId: CUST, status: "HELD",
    hotelName: "Taj", cityName: "Mumbai", countryCode: "IN", totalFare: 9000,
    checkIn: new Date("2026-12-01T00:00:00Z"), checkOut: new Date("2026-12-03T00:00:00Z"),
    bookedAt: new Date("2026-11-10T06:00:00Z"), createdAt: new Date("2026-11-10T06:00:00Z"),
    ...extra,
  } as any);
  // Stale mirror, the shape prod has (source moved on, mirror didn't).
  await col("travelbookings").insertOne({
    reference: _id, referenceModel: "SBTHotelBooking", source: "SBT", service: "HOTEL",
    tenantId: CUST, userId: USER, status: "PENDING", amount: 9000, isDemo: false, isTest: false,
    bookedAt: new Date("2026-11-10T06:00:00Z"),
  } as any);
  return _id;
}

async function flight(extra: Record<string, unknown> = {}) {
  const _id = oid();
  await col("sbtbookings").insertOne({
    _id, userId: USER, workspaceId: oid(), customerId: CUST, status: "PENDING",
    totalFare: 0, airlineName: "IndiGo", flightNumber: "6E 123", pnr: "ABC123",
    origin: { city: "Delhi", code: "DEL" }, destination: { city: "Mumbai", code: "BOM" },
    departureTime: "2026-12-05T06:00:00", bookedAt: new Date("2026-11-10T06:00:00Z"),
    createdAt: new Date("2026-11-10T06:00:00Z"), passengers: [{ firstName: "A" }],
    ...extra,
  } as any);
  await col("travelbookings").insertOne({
    reference: _id, referenceModel: "SBTBooking", source: "SBT", service: "FLIGHT",
    tenantId: CUST, userId: USER, status: "PENDING", amount: 0, isDemo: false, isTest: false,
    bookedAt: new Date("2026-11-10T06:00:00Z"),
  } as any);
  return _id;
}

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("sbt-mirror-resync-test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  vi.restoreAllMocks();
});

describe("SBTHotelBooking mirror — query writes", () => {
  it("findOneAndUpdate HELD → CANCELLED (sbt.hotels cancel / orphan cleanup) cancels the mirror", async () => {
    const id = await hotel();
    await SBTHotelBooking.findOneAndUpdate({ _id: id }, { $set: { status: "CANCELLED" } });
    expect((await mirror(id))!.status).toBe("CANCELLED");
  });

  it("findByIdAndUpdate → CONFIRMED with a new fare (deferred status check) counts it as spend", async () => {
    const id = await hotel();
    await SBTHotelBooking.findByIdAndUpdate(id, { $set: { status: "CONFIRMED", totalFare: 12500 } });
    const m = (await mirror(id))!;
    expect(m.status).toBe("CONFIRMED");
    expect(m.amount).toBe(12500);
    expect(m.destinationCity).toBe("Mumbai");
  });

  it("terminal non-booked states stay PENDING/FAILED per mapStatus", async () => {
    const id = await hotel({ status: "CONFIRMED" });
    await col("travelbookings").updateOne({ reference: id }, { $set: { status: "CONFIRMED" } });
    await SBTHotelBooking.findByIdAndUpdate(id, { $set: { status: "FAILED" } });
    expect((await mirror(id))!.status).toBe("FAILED");
  });

  it("updateMany isTest (scripts/mark-sbt-test-data.ts) flags the mirror too", async () => {
    const a = await hotel();
    const b = await hotel();
    await SBTHotelBooking.updateMany({ _id: { $in: [a, b] } }, { $set: { isTest: true } });
    expect((await mirror(a))!.isTest).toBe(true);
    expect((await mirror(b))!.isTest).toBe(true);
  });

  it("skips writes to unmirrored fields (statusCheckDone, reminder flags)", async () => {
    const id = await hotel();
    const spy = vi.spyOn(TravelBooking, "findOneAndUpdate");
    await SBTHotelBooking.findByIdAndUpdate(id, { $set: { statusCheckDone: true } as any });
    expect(spy).not.toHaveBeenCalled();
    expect((await mirror(id))!.status).toBe("PENDING");
  });

  it("resyncSBTHotelBookingMirrors rebuilds a missing row", async () => {
    const id = await hotel({ status: "CONFIRMED" });
    await col("travelbookings").deleteOne({ reference: id });
    expect(await resyncSBTHotelBookingMirrors([id])).toEqual({ synced: 1, failed: 0, missing: 0 });
    expect((await mirror(id))!.status).toBe("CONFIRMED");
  });
});

describe("SBTBooking (flight) mirror — query writes", () => {
  it("updateOne totalFare (sbt.flights.ts fare update) reaches the mirror", async () => {
    const id = await flight({ status: "CONFIRMED" });
    await SBTBooking.updateOne({ _id: id }, { $set: { totalFare: 6721 } });
    const m = (await mirror(id))!;
    expect(m.amount).toBe(6721);
    expect(m.status).toBe("CONFIRMED");
  });

  it("findByIdAndUpdate status → CONFIRMED / CANCELLED", async () => {
    const id = await flight();
    await SBTBooking.findByIdAndUpdate(id, { $set: { status: "CONFIRMED", totalFare: 5400 } });
    expect((await mirror(id))!.status).toBe("CONFIRMED");
    await SBTBooking.findByIdAndUpdate(id, { $set: { status: "CANCELLED" } });
    expect((await mirror(id))!.status).toBe("CANCELLED");
  });

  it("updateMany isDemo flags the mirror (the 4 residual demo rows)", async () => {
    const id = await flight({ status: "CONFIRMED" });
    await SBTBooking.updateMany({ _id: id }, { $set: { isDemo: true } });
    expect((await mirror(id))!.isDemo).toBe(true);
  });

  it("resyncSBTBookingMirrors reports missing sources", async () => {
    expect(await resyncSBTBookingMirrors([oid()])).toEqual({ synced: 0, failed: 0, missing: 1 });
  });
});
