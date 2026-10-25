// apps/backend/src/scripts/report-duplicate-request-bookings.test.ts
//
// Report only: refuses without / with the wrong --expect-db, lists requests
// with more than one live Book Now booking, flags same-service bookings made
// within 30 minutes as likely accidental, and writes nothing.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const { reportDuplicateRequestBookings } = await import("./report-duplicate-request-bookings.js");

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const DB = "report-duplicate-request-bookings-test";
const quiet = () => {};
const R = { dup: oid(), multi: oid(), single: oid(), deleted: oid(), apart: oid() };
const at = (min: number) => new Date(Date.UTC(2026, 9, 20, 10, 0) + min * 60000);
const mb = (rid: any, ref: string, over: any = {}) => ({
  bookingRef: ref, source: "ADMIN_QUEUE", sourceBookingId: rid, type: "FLIGHT", status: "PENDING", isActive: true,
  travelDate: new Date("2027-04-02"), itinerary: { origin: "BLR", destination: "DEL" }, createdAt: at(0), ...over,
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri(DB));
}, 120_000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await col("approvalrequests").insertMany([
    { _id: R.dup, ticketId: "PL-DUP111" }, { _id: R.multi, ticketId: "REQ-MULTI1" }, { _id: R.single }, { _id: R.deleted }, { _id: R.apart, ticketId: "REQ-APART1" },
  ] as any[]);
  await col("manualbookings").insertMany([
    mb(R.dup, "MB-1"), mb(R.dup, "MB-2", { createdAt: at(4) }), // Book Now clicked twice
    mb(R.multi, "MB-3"), mb(R.multi, "MB-4", { type: "HOTEL", itinerary: { hotelName: "Taj" }, createdAt: at(2) }), // flight + hotel
    mb(R.single, "MB-5"),
    mb(R.deleted, "MB-6"), mb(R.deleted, "MB-7", { isActive: false, createdAt: at(1) }), // the duplicate was deleted
    mb(R.apart, "MB-8"), mb(R.apart, "MB-9", { createdAt: at(24 * 60) }), // same service, a day apart (a reissue?)
    { ...mb(R.single, "MB-10"), source: "MANUAL", sourceBookingId: undefined },
  ] as any[]);
});

describe("report-duplicate-request-bookings", () => {
  it("refuses without --expect-db, or with the wrong one", async () => {
    await expect(reportDuplicateRequestBookings({ log: quiet })).rejects.toThrow(/REFUSING/);
    await expect(reportDuplicateRequestBookings({ expectDb: "Plumtrips_hrms", log: quiet })).rejects.toThrow(/REFUSING/);
  });

  it("lists requests with more than one live booking and flags same-service ones made minutes apart; writes nothing", async () => {
    const before = JSON.stringify(await col("manualbookings").find({}).sort({ _id: 1 }).toArray());
    const r = await reportDuplicateRequestBookings({ expectDb: DB, log: quiet });
    expect(r.requestsWithBookings).toBe(5);
    expect(r.groups.map((g) => [g.caseCode, g.bookings.map((b) => b.ref), g.likelyAccidental])).toEqual([
      ["PL-DUP111", ["MB-1", "MB-2"], true],
      ["REQ-MULTI1", ["MB-3", "MB-4"], false],
      ["REQ-APART1", ["MB-8", "MB-9"], false],
    ]);
    expect(r.groups[0].why).toBe("MB-1 and MB-2: same service, created 4 min apart");
    expect(JSON.stringify(await col("manualbookings").find({}).sort({ _id: 1 }).toArray())).toBe(before);
  });
});
