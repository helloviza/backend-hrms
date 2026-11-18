// apps/backend/src/scripts/resync-travel-booking-mirrors.test.ts
// Dry run reports drift + totals and writes nothing; --apply repairs exactly
// the targeted rows; a re-run then finds nothing.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const { resyncTravelBookingMirrors, blockDriverWrites } = await import("./resync-travel-booking-mirrors.js");

const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const CUST = "6a00000000000000000000d1";
const STAFF = oid();
const OCT = new Date("2026-10-15T00:00:00Z");
const NOV = new Date("2026-11-05T00:00:00Z");

const mb = (status: string, amount: number, bookingDate: Date, extra: any = {}) => ({
  _id: oid(), workspaceId: new mongoose.Types.ObjectId(CUST), bookedBy: STAFF, type: "FLIGHT", status,
  bookingRef: `MB-${Math.random().toString(36).slice(2, 7)}`, bookingDate, createdAt: bookingDate,
  pricing: { grandTotal: amount }, passengers: [{ name: "Asha Rao" }], itinerary: { destination: "Mumbai" }, ...extra,
});

let mongod: MongoMemoryServer;
const ids: Record<string, mongoose.Types.ObjectId> = {};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("resync_test"));
  const inSync = mb("CONFIRMED", 1000, OCT);
  const invoicedPending = mb("INVOICED", 5000, OCT);   // mirror PENDING  (N1)
  const invoicedCancelled = mb("INVOICED", 38000, NOV); // mirror CANCELLED (N1)
  const neverMirrored = mb("INVOICED", 7000, NOV);    // no mirror row
  const sbtOrigin = mb("CONFIRMED", 9999, NOV, { source: "SBT" }); // never mirrored by design
  Object.assign(ids, { inSync: inSync._id, invoicedPending: invoicedPending._id, invoicedCancelled: invoicedCancelled._id, neverMirrored: neverMirrored._id });
  await col("manualbookings").insertMany([inSync, invoicedPending, invoicedCancelled, neverMirrored, sbtOrigin] as any[]);

  const hotelId = oid();
  const flightId = oid();
  ids.hotel = hotelId; ids.flight = flightId;
  await col("sbthotelbookings").insertOne({ _id: hotelId, userId: STAFF, customerId: CUST, status: "CANCELLED", totalFare: 4000, cityName: "Goa", bookedAt: NOV } as any);
  await col("sbtbookings").insertOne({ _id: flightId, userId: STAFF, customerId: CUST, status: "CONFIRMED", totalFare: 6721, destination: { city: "Mumbai", code: "BOM" }, bookedAt: NOV } as any);

  // Current mirror: the in-sync row as the live sync wrote it, plus stale rows.
  const { buildManualBookingMirror } = await import("../models/ManualBooking.js");
  await col("travelbookings").insertMany([
    { ...(await buildManualBookingMirror(inSync)) },
    { ...(await buildManualBookingMirror(invoicedPending)), status: "PENDING" },
    { ...(await buildManualBookingMirror(invoicedCancelled)), status: "CANCELLED" },
    { reference: hotelId, referenceModel: "SBTHotelBooking", source: "SBT", service: "HOTEL", tenantId: CUST, userId: STAFF, status: "PENDING", amount: 4000, bookedAt: NOV, destinationCity: "Goa", destination: "Goa", origin: "", paymentMode: "OFFICIAL", isDemo: false, isTest: false },
    { reference: flightId, referenceModel: "SBTBooking", source: "SBT", service: "FLIGHT", tenantId: CUST, userId: STAFF, status: "CONFIRMED", amount: 0, bookedAt: NOV, paymentMode: "OFFICIAL", isDemo: false, isTest: false },
  ] as any[]);
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });

describe("resync-travel-booking-mirrors", () => {
  it("refuses without the matching --expect-db", async () => {
    await expect(resyncTravelBookingMirrors({ apply: false })).rejects.toThrow(/expect-db/);
    await expect(resyncTravelBookingMirrors({ apply: false, expectDb: "Plumtrips_hrms" })).rejects.toThrow(/REFUSING/);
  });

  it("dry run: targets the drifted + missing rows, computes totals, writes nothing", async () => {
    const snapshot = JSON.stringify(await col("travelbookings").find().sort({ _id: 1 }).toArray());
    const r = await resyncTravelBookingMirrors({ apply: false, expectDb: "resync_test", log: () => {} });

    expect(r.targeted).toEqual({ ManualBooking: 3, SBTBooking: 1, SBTHotelBooking: 1 });
    const byId = Object.fromEntries(r.rows.map((x) => [x.id, x]));
    expect(byId[String(ids.inSync)]).toBeUndefined();
    expect(byId[String(ids.invoicedPending)].changes.status).toEqual({ before: "PENDING", after: "CONFIRMED" });
    expect(byId[String(ids.invoicedCancelled)].changes.status).toEqual({ before: "CANCELLED", after: "CONFIRMED" });
    expect(byId[String(ids.neverMirrored)].missing).toBe(true);
    expect(byId[String(ids.hotel)].changes.status).toEqual({ before: "PENDING", after: "CANCELLED" });
    expect(byId[String(ids.flight)].changes.amount).toEqual({ before: 0, after: 6721 });

    // Before: confirmed = inSync 1000 + flight 0. After: +5000 +38000 +7000 +6721.
    expect(r.totals["All time"].before.spend).toBe(1000);
    expect(r.totals["All time"].after.spend).toBe(1000 + 5000 + 38000 + 7000 + 6721);
    expect(r.totals["All time"].before.cancelledSpend).toBe(38000);
    expect(r.totals["All time"].after.cancelledSpend).toBe(4000);
    expect(r.totals["Oct 2026"].after.spend - r.totals["Oct 2026"].before.spend).toBe(5000);
    expect(r.totals["Nov 2026"].after.spend - r.totals["Nov 2026"].before.spend).toBe(38000 + 7000 + 6721);
    expect(r.totals["Nov 2026"].after.trips - r.totals["Nov 2026"].before.trips).toBe(2); // the flight was already a trip

    expect(JSON.stringify(await col("travelbookings").find().sort({ _id: 1 }).toArray())).toBe(snapshot);
    expect(r.written).toBeNull();
  });

  it("--apply re-syncs exactly those rows; totals then match the dry run's 'after'; a re-run finds nothing", async () => {
    const dry = await resyncTravelBookingMirrors({ apply: false, expectDb: "resync_test", log: () => {} });
    const r = await resyncTravelBookingMirrors({ apply: true, expectDb: "resync_test", log: () => {} });
    expect(r.written).toEqual({
      ManualBooking: { synced: 3, failed: 0, missing: 0 },
      SBTBooking: { synced: 1, failed: 0, missing: 0 },
      SBTHotelBooking: { synced: 1, failed: 0, missing: 0 },
    });
    expect(await col("travelbookings").countDocuments({ referenceModel: "ManualBooking" })).toBe(4); // SBT-origin still unmirrored

    const again = await resyncTravelBookingMirrors({ apply: false, expectDb: "resync_test", log: () => {} });
    expect(again.rows).toHaveLength(0);
    for (const w of Object.keys(dry.totals)) expect(again.totals[w].before).toEqual(dry.totals[w].after);
  });

  // Last: patches the driver for the rest of this file.
  it("a dry run completes with every driver write blocked (it issues no writes)", async () => {
    await col("travelbookings").updateOne({ reference: ids.hotel }, { $set: { status: "PENDING" } });
    blockDriverWrites();
    expect(() => col("travelbookings").insertOne({ x: 1 } as any)).toThrow(/WRITE BLOCKED/);
    const r = await resyncTravelBookingMirrors({ apply: false, expectDb: "resync_test", log: () => {} });
    expect(r.targeted.SBTHotelBooking).toBe(1);
  });
});
