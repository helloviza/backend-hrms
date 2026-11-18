// apps/backend/src/models/travelMirror.phaseB.test.ts
//
// Travel Spend Phase B (2026-11-18), against a real in-memory mongod:
//   - manual flight mirror: legs' times, flat flightNo, carrierShares, first
//     leg's IST time, international = any leg outside India
//   - SBT flight mirror: departure parsed as IST, tenantId → Customer _id (N7)
//   - SBT hotel mirror: FU-1 statuses, canonical city, tenantId (N7)
//   - jobs/stale-hotel-hold-mirror.ts: HELD past check-in → FAILED, mirror only
//   - scripts/mark-house-sbt-test-bookings.ts: groups A–D, dry run writes nothing
//   - scripts/resync-travel-booking-mirrors.ts --include-analytics
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

process.env.NODE_ENV = "test";

const { buildManualBookingMirror } = await import("./ManualBooking.js");
const { buildSBTBookingMirror } = await import("./SBTBooking.js");
const { default: SBTHotelBooking, buildSBTHotelBookingMirror } = await import("./SBTHotelBooking.js");
const { runStaleHotelHoldMirrorSweep } = await import("../jobs/stale-hotel-hold-mirror.js");
const { markHouseSbtTestBookings, classifyHouseTestBooking } = await import("../scripts/mark-house-sbt-test-bookings.js");
const { resyncTravelBookingMirrors, blockDriverWrites } = await import("../scripts/resync-travel-booking-mirrors.js");

const oid = () => new mongoose.Types.ObjectId();
const col = (n: string) => mongoose.connection.db!.collection(n);
const CUST = new mongoose.Types.ObjectId("6a00000000000000000000e1");
const WS = new mongoose.Types.ObjectId("6a00000000000000000000e2");
const STAFF = oid();

let mongod: MongoMemoryServer;
beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("phaseb_mirror_test"));
}, 120_000);
afterAll(async () => { await mongoose.disconnect(); await mongod?.stop(); });
beforeEach(async () => {
  for (const c of ["customers", "customerworkspaces", "users", "manualbookings", "sbtbookings", "sbthotelbookings", "travelbookings"]) await col(c).deleteMany({});
  await col("customers").insertOne({ _id: CUST, name: "Acme" } as any);
  await col("customerworkspaces").insertOne({ _id: WS, customerId: String(CUST), name: "Acme WS" } as any);
});

describe("manual flight mirror (Phase B analytics)", () => {
  it("carries times, carriers, first-leg IST time; international if any leg is abroad", async () => {
    const doc = {
      _id: oid(), workspaceId: CUST, bookedBy: STAFF, type: "FLIGHT", status: "CONFIRMED", bookingRef: "MB-1",
      bookingDate: new Date("2026-11-02T00:00:00Z"), pricing: { grandTotal: 40000 }, passengers: [{ name: "Asha" }],
      itinerary: {
        origin: "SAN", destination: "DEL", airline: "United Airlines", flightNo: "UA 1",
        legs: [
          { origin: "SAN", destination: "EWR", airline: "United Airlines", flightNo: "UA 1", departTime: "06:10 hrs", arriveTime: "14:40" },
          { origin: "EWR", destination: "DEL", airline: "Air India", flightNo: "AI 106", departTime: "20:30" },
        ],
      },
    };
    const m: any = await buildManualBookingMirror(doc);
    expect(m.destinationCity).toBe("Delhi");
    expect(m.isInternational).toBe(true);
    expect(m.metadata.flightNo).toBe("UA 1");
    expect(m.metadata.legs[0]).toMatchObject({ departTime: "06:10 hrs", arriveTime: "14:40" });
    expect(m.metadata.carrierShares).toEqual([{ name: "United Airlines", share: 0.5 }, { name: "Air India", share: 0.5 }]);
    expect(m.metadata).toMatchObject({ departTimeIST: "06:10", departMinutesIST: 370, departTimeUnknown: false });
  });
  it("visa rows: country only", async () => {
    const m: any = await buildManualBookingMirror({ _id: oid(), workspaceId: CUST, bookedBy: STAFF, type: "VISA", status: "CONFIRMED", bookingRef: "MB-2", bookingDate: new Date(), pricing: {}, passengers: [], itinerary: { visaCountry: "Dubai" } });
    expect(m).toMatchObject({ destinationCity: null, destinationCountry: "AE", isInternational: true });
    expect(m.metadata.carrierShares).toBeUndefined();
  });
});

describe("SBT flight mirror", () => {
  it("IST departure, workspace-keyed customerId resolves to the Customer (N7)", async () => {
    const m: any = await buildSBTBookingMirror({
      _id: oid(), userId: STAFF, workspaceId: WS, customerId: String(WS), status: "CONFIRMED", totalFare: 5000,
      origin: { code: "DEL", city: "Delhi" }, destination: { code: "DXB", city: "Dubai" }, airlineName: "Indigo", flightNumber: "6E 1461",
      departureTime: "2026-06-09T08:35:00", arrivalTime: "2026-06-09T11:00:00", bookedAt: new Date("2026-06-03T05:00:00Z"),
    });
    expect(m.tenantId).toBe(String(CUST));
    expect(m.travelDate.toISOString()).toBe("2026-06-09T03:05:00.000Z");
    expect(m.isInternational).toBe(true);
    expect(m.metadata).toMatchObject({ flightNo: "6E 1461", departTimeIST: "08:35", carrierShares: [{ name: "IndiGo", share: 1 }] });
  });
  it("no customerId → the booking workspace's customer; unknown workspace → 'default'", async () => {
    const base = { _id: oid(), userId: STAFF, status: "CONFIRMED", origin: {}, destination: {}, departureTime: "", arrivalTime: "" };
    expect((await buildSBTBookingMirror({ ...base, workspaceId: WS }) as any).tenantId).toBe(String(CUST));
    expect((await buildSBTBookingMirror({ ...base, workspaceId: oid() }) as any).tenantId).toBe("default");
    expect((await buildSBTBookingMirror({ ...base, customerId: String(CUST) }) as any).tenantId).toBe(String(CUST));
  });
});

describe("SBT hotel mirror (FU-1, N7)", () => {
  const now = new Date("2026-11-18T06:00:00Z");
  const h = (status: string, extra: any = {}) => ({ _id: oid(), userId: STAFF, workspaceId: WS, status, totalFare: 1000, cityName: "New Delhi", countryCode: "IN", checkIn: "2026-12-01", ...extra });
  it("maps dead holds and canonicalises the city", async () => {
    expect((await buildSBTHotelBookingMirror(h("EXPIRED"), now) as any).status).toBe("FAILED");
    expect((await buildSBTHotelBookingMirror(h("CANCEL_PENDING"), now) as any).status).toBe("CANCELLED");
    expect((await buildSBTHotelBookingMirror(h("HELD"), now) as any).status).toBe("PENDING");
    expect((await buildSBTHotelBookingMirror(h("HELD", { checkIn: "2026-05-20" }), now) as any).status).toBe("FAILED");
    const m: any = await buildSBTHotelBookingMirror(h("CONFIRMED"), now);
    expect(m).toMatchObject({ tenantId: String(CUST), destinationCity: "Delhi", status: "CONFIRMED" });
  });
  it("daily sweep: HELD past check-in → mirror FAILED, source still HELD", async () => {
    const past = oid();
    const future = oid();
    await col("sbthotelbookings").insertMany([
      { _id: past, userId: STAFF, workspaceId: WS, status: "HELD", totalFare: 91577, cityName: "New Delhi", checkIn: "2026-05-20", bookedAt: new Date("2026-04-09T00:00:00Z") },
      { _id: future, userId: STAFF, workspaceId: WS, status: "HELD", totalFare: 500, cityName: "Goa", checkIn: "2099-01-01", bookedAt: new Date("2026-04-09T00:00:00Z") },
    ] as any[]);
    await col("travelbookings").insertMany([
      { reference: past, referenceModel: "SBTHotelBooking", status: "PENDING", amount: 91577, tenantId: "x", service: "HOTEL" },
      { reference: future, referenceModel: "SBTHotelBooking", status: "PENDING", amount: 500, tenantId: "x", service: "HOTEL" },
    ] as any[]);
    const r = await runStaleHotelHoldMirrorSweep(new Date("2026-11-18T06:00:00Z"));
    expect(r).toMatchObject({ candidates: 1, synced: 1, failed: 0 });
    expect((await col("travelbookings").findOne({ reference: past }))!.status).toBe("FAILED");
    expect((await col("travelbookings").findOne({ reference: future }))!.status).toBe("PENDING");
    expect((await col("sbthotelbookings").findOne({ _id: past }))!.status).toBe("HELD");
    expect(await runStaleHotelHoldMirrorSweep(new Date("2026-11-18T06:00:00Z"))).toMatchObject({ candidates: 0 });
  });
});

describe("mark-house-sbt-test-bookings (N5)", () => {
  it("classifies groups A–D only", () => {
    const mar = { bookedAt: new Date("2026-03-15T06:00:00Z") };
    const may = { bookedAt: new Date("2026-05-15T06:00:00Z") };
    expect(classifyHouseTestBooking("FLIGHT", mar, "admin@plumtrips.com")).toBe("A");
    expect(classifyHouseTestBooking("FLIGHT", { ...mar, customerId: String(CUST) }, "admin@plumtrips.com")).toBeNull();
    expect(classifyHouseTestBooking("HOTEL", mar, null)).toBe("B");
    expect(classifyHouseTestBooking("HOTEL", mar, "someone@client.com")).toBeNull();
    expect(classifyHouseTestBooking("FLIGHT", may, "neelb@plumtrips.com")).toBe("C");
    expect(classifyHouseTestBooking("HOTEL", may, "neelb@plumtrips.com")).toBeNull();
    expect(classifyHouseTestBooking("HOTEL", may, "TBOcertification@plumtrips.com")).toBe("D");
    expect(classifyHouseTestBooking("FLIGHT", { ...may, isTest: true }, "admin@plumtrips.com")).toBeNull();
    expect(classifyHouseTestBooking("FLIGHT", { bookedAt: new Date("2026-07-01T00:00:00+05:30") }, "admin@plumtrips.com")).toBeNull();
    // 31 Mar 20:00 UTC is 1 Apr 01:30 IST → April (C), not March (A)
    expect(classifyHouseTestBooking("FLIGHT", { bookedAt: new Date("2026-03-31T20:00:00Z") }, "admin@plumtrips.com")).toBe("C");
  });
  it("dry run lists, totals and writes nothing; --apply needs --expect-count + --backup, then flags source + mirror", async () => {
    const admin = oid();
    await col("users").insertOne({ _id: admin, email: "admin@plumtrips.com" } as any);
    const f = oid();
    await col("sbtbookings").insertOne({ _id: f, userId: admin, workspaceId: WS, status: "CONFIRMED", totalFare: 4950, pnr: "MOCK-1", origin: { code: "DEL" }, destination: { code: "BOM" }, bookedAt: new Date("2026-03-10T06:00:00Z") } as any);
    await col("travelbookings").insertOne({ reference: f, referenceModel: "SBTBooking", status: "CONFIRMED", amount: 4950, tenantId: "default", service: "FLIGHT", bookedAt: new Date("2026-03-10T06:00:00Z") } as any);
    const lines: string[] = [];
    const dry = await markHouseSbtTestBookings({ expectDb: "phaseb_mirror_test", log: (l) => lines.push(l) });
    expect(dry.rows.map((r) => r.group)).toEqual(["A"]);
    expect(dry.totalsBefore["Mar 2026"].spend - dry.totalsAfter["Mar 2026"].spend).toBe(4950);
    expect((await col("sbtbookings").findOne({ _id: f }))!.isTest).toBeUndefined();
    await expect(markHouseSbtTestBookings({ expectDb: "phaseb_mirror_test", apply: true, log: () => {} })).rejects.toThrow(/expect-count/);
    await expect(markHouseSbtTestBookings({ expectDb: "phaseb_mirror_test", apply: true, expectCount: 1, log: () => {} })).rejects.toThrow(/backup/);
    const backup = `${process.env.TEMP || "/tmp"}/phaseb-mark-backup-${Date.now()}.json`;
    const done = await markHouseSbtTestBookings({ expectDb: "phaseb_mirror_test", apply: true, expectCount: 1, backup, log: () => {} });
    expect(done.written).toMatchObject({ flagged: 1, mirrorsTest: 1 });
    expect((await col("sbtbookings").findOne({ _id: f }))!.isTest).toBe(true);
    expect((await col("travelbookings").findOne({ reference: f }))!.isTest).toBe(true);
  });
});

describe("resync --include-analytics", () => {
  it("targets analytics-only drift and reports the panels before → after", async () => {
    const mbDoc: any = {
      _id: oid(), workspaceId: CUST, bookedBy: STAFF, type: "FLIGHT", status: "CONFIRMED", bookingRef: "MB-9",
      bookingDate: new Date("2026-10-02T00:00:00Z"), createdAt: new Date("2026-10-02T00:00:00Z"), pricing: { grandTotal: 9000 }, passengers: [{ name: "Ravi" }],
      itinerary: { origin: "DEL", destination: "MNL", airline: "Indigo", legs: [{ origin: "DEL", destination: "MNL", airline: "Indigo", departTime: "07:15" }] },
    };
    await col("manualbookings").insertOne(mbDoc);
    const built: any = await buildManualBookingMirror(mbDoc);
    // The row as the pre-Phase B sync wrote it: no city (MNL unknown), no analytics metadata.
    await col("travelbookings").insertOne({ ...built, destinationCity: null, destinationCountry: null, isInternational: null, metadata: { bookingRef: "MB-9", legs: [] } });

    const plain = await resyncTravelBookingMirrors({ apply: false, expectDb: "phaseb_mirror_test", log: () => {} });
    expect(plain.rows).toHaveLength(0);
    expect(plain.insights).toBeNull();

    blockDriverWrites();
    const r = await resyncTravelBookingMirrors({ apply: false, expectDb: "phaseb_mirror_test", includeAnalytics: true, log: () => {} });
    expect(r.rows).toHaveLength(1);
    expect(Object.keys(r.rows[0].changes).sort()).toEqual(["destinationCity", "destinationCountry", "isInternational", "metadata"]);
    const all = r.insights!["All time"];
    expect(all.before.domesticInternational.FLIGHT.unknown.count).toBe(1);
    expect(all.after.domesticInternational.FLIGHT.international.count).toBe(1);
    expect(all.before.departureSlots.timed).toBe(0);
    expect(all.after.departureSlots.timed).toBe(1);
    expect(all.after.airlines.rows[0]).toMatchObject({ name: "IndiGo", countPct: 100 });
  });
});
