// apps/backend/src/scripts/backfill-booking-metrics.test.ts
//
// Dry run by default (counts, writes nothing); --apply flags demo mirror
// rows, creates mirror rows for Book Now bookings and retires the CONCIERGE
// rows they supersede (never deletes); a CONCIERGE row with no booking is
// kept; a re-run is a no-op; refuses without / with the wrong --expect-db.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const { backfillBookingMetrics } = await import("./backfill-booking-metrics.js");

let mongod: MongoMemoryServer;
const col = (n: string) => mongoose.connection.db!.collection(n);
const oid = () => new mongoose.Types.ObjectId();
const DB = "backfill-booking-metrics-test";
const CUSTOMER = oid();
const STAFF = oid();
const B = { demo: oid(), queueConfirmed: oid(), queueCancelled: oid() };
const R = { confirmed: oid(), cancelled: oid(), noBooking: oid() };
const quiet = () => {};

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
  const base = { workspaceId: CUSTOMER, type: "FLIGHT", bookedBy: STAFF, bookingDate: new Date("2026-10-10"), pricing: { grandTotal: 1000 } };
  await col("manualbookings").insertMany([
    { _id: B.demo, bookingRef: "MB-1", source: "MANUAL", status: "CONFIRMED", isDemo: true, createdByDemoUser: true, ...base },
    { _id: B.queueConfirmed, bookingRef: "MB-2", source: "ADMIN_QUEUE", sourceBookingId: R.confirmed, status: "CONFIRMED", ...base },
    { _id: B.queueCancelled, bookingRef: "MB-3", source: "ADMIN_QUEUE", sourceBookingId: R.cancelled, status: "CANCELLED", ...base },
  ]);
  await col("travelbookings").insertMany([
    // the demo booking's mirror, written before the flag was copied
    { reference: B.demo, referenceModel: "ManualBooking", source: "CONCIERGE", status: "CONFIRMED", amount: 1000, tenantId: String(CUSTOMER), isActive: true, isDemo: false },
    // request-keyed rows from Mark Done / booking completion
    { reference: R.confirmed, referenceModel: "ApprovalRequest", source: "CONCIERGE", status: "CONFIRMED", amount: 1000, tenantId: String(CUSTOMER) },
    { reference: R.cancelled, referenceModel: "ApprovalRequest", source: "CONCIERGE", status: "CONFIRMED", amount: 1000, tenantId: String(CUSTOMER) },
    { reference: R.noBooking, referenceModel: "ApprovalRequest", source: "CONCIERGE", status: "CONFIRMED", amount: 500, tenantId: String(CUSTOMER) },
  ]);
});

const snapshot = async () => JSON.stringify(await col("travelbookings").find({}).sort({ _id: 1 }).toArray());

describe("backfill-booking-metrics", () => {
  it("refuses without --expect-db, or with the wrong one", async () => {
    await expect(backfillBookingMetrics({ apply: false, log: quiet })).rejects.toThrow(/REFUSING/);
    await expect(backfillBookingMetrics({ expectDb: "prod", apply: true, log: quiet })).rejects.toThrow(/REFUSING/);
  });

  it("dry run reports the counts and writes nothing", async () => {
    const before = await snapshot();
    const r = await backfillBookingMetrics({ expectDb: DB, apply: false, log: quiet });
    expect(r).toMatchObject({
      demoMirrorRowsToFlag: 1,
      queueBookingsToMirror: 2,
      queueBookingsToMirrorByStatus: { CONFIRMED: 1, CANCELLED: 1 },
      conciergeRowsToRetire: 2,
      written: null,
    });
    expect(r.conciergeRetireReasons).toEqual({
      "booking CONFIRMED/INVOICED": { n: 1, amount: 1000 },
      "booking cancelled": { n: 1, amount: 1000 },
    });
    expect(await snapshot()).toBe(before);
  });

  it("--apply fixes all three; a CONCIERGE row with no booking is kept; nothing is deleted; re-run is a no-op", async () => {
    const r = await backfillBookingMetrics({ expectDb: DB, apply: true, log: quiet });
    expect(r.written?.flagged).toBe(1);
    expect(r.written?.created).toBe(2);

    const tb = col("travelbookings");
    expect(await tb.findOne({ reference: B.demo })).toMatchObject({ isDemo: true, createdByDemoUser: true });
    expect(await tb.findOne({ reference: B.queueConfirmed })).toMatchObject({ referenceModel: "ManualBooking", status: "CONFIRMED", isActive: true, isDemo: false });
    expect(await tb.findOne({ reference: B.queueCancelled })).toMatchObject({ referenceModel: "ManualBooking", status: "CANCELLED" });
    expect(await tb.findOne({ reference: R.confirmed })).toMatchObject({ isActive: false });
    expect(await tb.findOne({ reference: R.cancelled })).toMatchObject({ isActive: false });
    expect((await tb.findOne({ reference: R.noBooking }))!.isActive).not.toBe(false);
    expect(await tb.countDocuments({})).toBe(6); // 4 seeded + 2 created, none removed

    const again = await backfillBookingMetrics({ expectDb: DB, apply: true, log: quiet });
    expect(again).toMatchObject({ demoMirrorRowsToFlag: 0, queueBookingsToMirror: 0, conciergeRowsToRetire: 0 });
    expect(again.written).toEqual({ flagged: 0, created: 0, retired: 0 });
  });
});
