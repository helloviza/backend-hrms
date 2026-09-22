// Multi-leg (Step 4, Piece 1): itinerary.legs[] + tripType are ADDITIVE and
// the pre-save hook derives the flat fields every existing reader uses.
//
// Runs against a real in-memory mongod (mongodb-memory-server) rather than a
// literal fixture, because the two things under test are hooks: the
// pre("save") derivation and the post("save") TravelBooking mirror. A
// fixture that never persists proves neither (see the test-literal-vs-
// document gap this repo already documents).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import ManualBooking, { deriveFlatFromLegs, type ManualBookingLeg } from "./ManualBooking.js";
import TravelBooking from "./TravelBooking.js";
import CustomerWorkspace from "./CustomerWorkspace.js";
import { deriveTripType, returnJourneyStart } from "../services/flightLegs.js";

let mongod: MongoMemoryServer;
const customerId = new Types.ObjectId();
const userId = new Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  // The mirror resolves the CustomerWorkspace by customerId — without one it
  // leaves workspaceId undefined and TravelBooking's required field rejects
  // the upsert, which would make the mirror assertions vacuous.
  await CustomerWorkspace.create({ customerId: String(customerId), name: "Legs Test Co" });
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await ManualBooking.deleteMany({});
  await TravelBooking.deleteMany({});
});

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

function base(over: Record<string, any> = {}) {
  return {
    workspaceId: customerId,
    bookedBy: userId,
    type: "FLIGHT",
    supplierName: "TBO",
    givenBy: "Ops",
    travelDate: D("2026-01-01"), // placeholder — the hook overwrites it when legs exist
    passengers: [{ name: "Priya Sharma", type: "ADULT" }],
    pricing: { actualPrice: 1000, quotedPrice: 1200, gstMode: "ON_MARKUP", gstPercent: 18 },
    ...over,
  };
}

const outbound: ManualBookingLeg = {
  origin: "DEL", destination: "BOM", flightNo: "AI 101", airline: "Air India",
  departDate: D("2026-10-15"), departTime: "06:30", arriveDate: D("2026-10-15"), arriveTime: "08:40",
};
const inbound: ManualBookingLeg = {
  origin: "BOM", destination: "DEL", flightNo: "AI 102", airline: "Air India",
  departDate: D("2026-10-20"), departTime: "19:00", arriveDate: D("2026-10-20"), arriveTime: "21:10",
};

describe("ManualBooking legs[] → flat-field derivation on save", () => {
  it("ROUND_TRIP: destination is the TURNAROUND city (not the origin), returnDate is the RETURN leg's departure", async () => {
    const b = await ManualBooking.create(
      base({ itinerary: { tripType: "ROUND_TRIP", legs: [outbound, inbound] } }),
    );
    const saved: any = await ManualBooking.findById(b._id).lean();

    expect(saved.itinerary.origin).toBe("DEL");
    expect(saved.itinerary.destination).toBe("BOM"); // NOT "DEL"
    expect(saved.itinerary.flightNo).toBe("AI 101"); // leg 0, never joined
    expect(saved.itinerary.airline).toBe("Air India");
    expect(saved.travelDate).toEqual(D("2026-10-15"));
    // The fix: before Step 4 the autofill wrote leg 0's ARRIVAL (15 Oct) here.
    expect(saved.returnDate).toEqual(D("2026-10-20"));
    // Legs persisted 1:1 and in order.
    expect(saved.itinerary.legs.map((l: any) => `${l.origin}-${l.destination}`)).toEqual(["DEL-BOM", "BOM-DEL"]);
    expect(saved.itinerary.tripType).toBe("ROUND_TRIP");
  });

  it("MULTI_CITY: destination + returnDate come from the LAST leg", async () => {
    const b = await ManualBooking.create(
      base({
        itinerary: {
          tripType: "MULTI_CITY",
          legs: [
            outbound,
            { origin: "BOM", destination: "GOI", flightNo: "6E 55", airline: "IndiGo", departDate: D("2026-10-18"), arriveDate: D("2026-10-18") },
            { origin: "GOI", destination: "BLR", flightNo: "UK 9", airline: "Vistara", departDate: D("2026-10-22"), arriveDate: D("2026-10-23") },
          ],
        },
      }),
    );
    const saved: any = await ManualBooking.findById(b._id).lean();
    expect(saved.itinerary.origin).toBe("DEL");
    expect(saved.itinerary.destination).toBe("BLR");
    expect(saved.itinerary.flightNo).toBe("AI 101");
    expect(saved.travelDate).toEqual(D("2026-10-15"));
    expect(saved.returnDate).toEqual(D("2026-10-23"));
  });

  it("ONE_WAY via hub (2 legs): destination is the final arrival, returnDate its date", async () => {
    const b = await ManualBooking.create(
      base({
        itinerary: {
          tripType: "ONE_WAY",
          legs: [
            { ...outbound, layover: "2h 15m" },
            { origin: "BOM", destination: "DXB", flightNo: "AI 995", airline: "Air India", departDate: D("2026-10-15"), arriveDate: D("2026-10-15") },
          ],
        },
      }),
    );
    const saved: any = await ManualBooking.findById(b._id).lean();
    expect(saved.itinerary.destination).toBe("DXB");
    expect(saved.returnDate).toEqual(D("2026-10-15"));
  });

  it("4-leg ROUND_TRIP via a hub each way: turnaround + return leg located from the layover pattern", async () => {
    const b = await ManualBooking.create(
      base({
        itinerary: {
          tripType: "ROUND_TRIP",
          legs: [
            { origin: "DEL", destination: "BOM", flightNo: "AI 101", airline: "Air India", departDate: D("2026-10-15"), arriveDate: D("2026-10-15"), layover: "1h 30m" },
            { origin: "BOM", destination: "DXB", flightNo: "AI 995", airline: "Air India", departDate: D("2026-10-15"), arriveDate: D("2026-10-15") },
            { origin: "DXB", destination: "BOM", flightNo: "AI 996", airline: "Air India", departDate: D("2026-10-22"), arriveDate: D("2026-10-22"), layover: "3h" },
            { origin: "BOM", destination: "DEL", flightNo: "AI 102", airline: "Air India", departDate: D("2026-10-22"), arriveDate: D("2026-10-23") },
          ],
        },
      }),
    );
    const saved: any = await ManualBooking.findById(b._id).lean();
    expect(saved.itinerary.destination).toBe("DXB");
    expect(saved.returnDate).toEqual(D("2026-10-22"));
  });

  it("re-derives on every save, so editing the legs updates the flat fields", async () => {
    const b = await ManualBooking.create(
      base({ itinerary: { tripType: "ROUND_TRIP", legs: [outbound, inbound] } }),
    );
    b.itinerary.legs![1] = { ...inbound, departDate: D("2026-10-25") };
    b.markModified("itinerary");
    await b.save();
    const saved: any = await ManualBooking.findById(b._id).lean();
    expect(saved.returnDate).toEqual(D("2026-10-25"));
  });
});

describe("legacy rows (no legs) are untouched — the change is additive", () => {
  it("a flat-only booking keeps every flat field exactly as written; no legs/tripType appear", async () => {
    const b = await ManualBooking.create(
      base({
        travelDate: D("2026-11-02"),
        returnDate: D("2026-11-09"),
        sector: "DEL-BOM",
        itinerary: { origin: "DEL", destination: "BOM", flightNo: "6E 201", airline: "IndiGo" },
      }),
    );
    const saved: any = await ManualBooking.findById(b._id).lean();
    expect(saved.itinerary).toMatchObject({ origin: "DEL", destination: "BOM", flightNo: "6E 201", airline: "IndiGo" });
    expect(saved.travelDate).toEqual(D("2026-11-02"));
    expect(saved.returnDate).toEqual(D("2026-11-09"));
    expect(saved.sector).toBe("DEL-BOM");
    // Absent, not [] — a persisted empty array would make "legacy" and
    // "no legs" indistinguishable and would trip the absent-field trap.
    expect(saved.itinerary).not.toHaveProperty("legs");
    expect(saved.itinerary).not.toHaveProperty("tripType");
  });

  it("a pre-existing row written without the new paths survives a plain re-save unchanged", async () => {
    // Insert straight into the collection, bypassing the schema — this is
    // what every row in prod looks like today.
    await ManualBooking.collection.insertOne({
      workspaceId: customerId,
      bookedBy: userId,
      bookingRef: "MB-LEGACY-0001",
      type: "FLIGHT",
      status: "CONFIRMED",
      source: "MANUAL",
      travelDate: D("2026-03-01"),
      returnDate: D("2026-03-01"),
      itinerary: { origin: "BLR", destination: "HYD", flightNo: "6E 77", airline: "IndiGo" },
      passengers: [{ name: "Old Row", type: "ADULT" }],
      pricing: { actualPrice: 500, quotedPrice: 600, gstMode: "ON_MARKUP", gstPercent: 18 },
    } as any);
    const doc = (await ManualBooking.findOne({ bookingRef: "MB-LEGACY-0001" }))!;
    doc.notes = "touched by an unrelated edit";
    await doc.save();
    const saved: any = await ManualBooking.findById(doc._id).lean();
    expect(saved.itinerary).toMatchObject({ origin: "BLR", destination: "HYD", flightNo: "6E 77", airline: "IndiGo" });
    expect(saved.travelDate).toEqual(D("2026-03-01"));
    expect(saved.returnDate).toEqual(D("2026-03-01"));
    expect(saved.itinerary).not.toHaveProperty("legs");
  });

  it("deriveFlatFromLegs is a no-op for an empty or absent legs array", () => {
    const flat = { itinerary: { origin: "A", destination: "B", legs: [] as ManualBookingLeg[] }, travelDate: D("2026-01-01"), returnDate: D("2026-01-02") };
    deriveFlatFromLegs(flat);
    expect(flat.itinerary).toMatchObject({ origin: "A", destination: "B" });
    expect(flat.returnDate).toEqual(D("2026-01-02"));
    const none: any = { itinerary: { origin: "A" } };
    deriveFlatFromLegs(none);
    expect(none.itinerary).toEqual({ origin: "A" });
  });
});

describe("the TravelBooking mirror gets a single, correct origin/destination — no mirror change", () => {
  it("ROUND_TRIP mirrors destination = turnaround city and travelDateEnd = return departure", async () => {
    const b = await ManualBooking.create(
      base({ status: "CONFIRMED", itinerary: { tripType: "ROUND_TRIP", legs: [outbound, inbound] } }),
    );
    const m: any = await TravelBooking.findOne({ reference: b._id }).lean();
    expect(m).toBeTruthy();
    expect(m.origin).toBe("DEL");
    expect(m.destination).toBe("BOM"); // Top Destinations must not rank DEL for DEL→BOM→DEL
    expect(m.travelDate).toEqual(D("2026-10-15"));
    expect(m.travelDateEnd).toEqual(D("2026-10-20")); // was the outbound arrival before the fix
    expect(m.metadata.airline).toBe("Air India");
    expect(m.service).toBe("FLIGHT");
    // Piece 3: the whole trip rides along in metadata (descriptive only).
    expect(m.metadata.tripType).toBe("ROUND_TRIP");
    expect(m.metadata.legs.map((l: any) => `${l.origin}-${l.destination}/${l.flightNo}`)).toEqual(["DEL-BOM/AI 101", "BOM-DEL/AI 102"]);
    expect(m.metadata.legs[1].departDate).toEqual(D("2026-10-20"));
    expect(Object.keys(m.metadata.legs[0]).sort()).toEqual(["airline", "arriveDate", "departDate", "destination", "flightNo", "origin"]);
  });

  it("a legacy booking mirrors empty legs/tripType metadata", async () => {
    const b = await ManualBooking.create(
      base({ itinerary: { origin: "BLR", destination: "HYD", flightNo: "6E 77", airline: "IndiGo" } }),
    );
    const m: any = await TravelBooking.findOne({ reference: b._id }).lean();
    expect(m.origin).toBe("BLR");
    expect(m.destination).toBe("HYD");
    expect(m.metadata.tripType).toBe("");
    expect(m.metadata.legs).toEqual([]);
  });

  it("MULTI_CITY mirrors the final destination", async () => {
    const b = await ManualBooking.create(
      base({
        itinerary: {
          tripType: "MULTI_CITY",
          legs: [outbound, { origin: "BOM", destination: "GOI", departDate: D("2026-10-18"), arriveDate: D("2026-10-18") }],
        },
      }),
    );
    const m: any = await TravelBooking.findOne({ reference: b._id }).lean();
    expect(m.destination).toBe("GOI");
    expect(m.travelDateEnd).toEqual(D("2026-10-18"));
  });
});

describe("flightLegs helpers", () => {
  it("deriveTripType: 1 leg / returns to origin / all layovers / otherwise", () => {
    expect(deriveTripType([outbound])).toBe("ONE_WAY");
    expect(deriveTripType([outbound, inbound])).toBe("ROUND_TRIP");
    expect(deriveTripType([{ ...outbound, layover: "2h" }, { origin: "BOM", destination: "DXB" }])).toBe("ONE_WAY");
    expect(deriveTripType([outbound, { origin: "BOM", destination: "DXB" }])).toBe("MULTI_CITY");
    // Case-insensitive on codes; final leg's (always-empty) layover never counts.
    expect(deriveTripType([{ origin: "del", destination: "BOM" }, { origin: "BOM", destination: "DEL" }])).toBe("ROUND_TRIP");
  });

  it("returnJourneyStart: n≤2 → 1; layover pattern; day-gap fallback; midpoint fallback", () => {
    expect(returnJourneyStart([outbound, inbound])).toBe(1);
    // 1 outbound + 2 return segments, layovers printed: break after leg 0.
    expect(
      returnJourneyStart([
        { origin: "DEL", destination: "DXB" },
        { origin: "DXB", destination: "BOM", layover: "2h" },
        { origin: "BOM", destination: "DEL" },
      ]),
    ).toBe(1);
    // No layovers printed at all → the first later-day departure.
    expect(
      returnJourneyStart([
        { origin: "DEL", destination: "BOM", arriveDate: "2026-10-15" },
        { origin: "BOM", destination: "DXB", departDate: "2026-10-15", arriveDate: "2026-10-15" },
        { origin: "DXB", destination: "BOM", departDate: "2026-10-22", arriveDate: "2026-10-22" },
        { origin: "BOM", destination: "DEL", departDate: "2026-10-22" },
      ]),
    ).toBe(2);
    // Nothing to go on → midpoint.
    expect(returnJourneyStart([{ origin: "A", destination: "B" }, { origin: "B", destination: "C" }, { origin: "C", destination: "A" }])).toBe(2);
  });
});
