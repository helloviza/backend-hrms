// apps/backend/src/services/travelKpis.unit.test.ts
//
// Phase B additions (2026-11-18): lead time, hotel nightly rate + stay, top
// routes, carbon, Visa/Forex/eSIM cards, and the cabin mix in flight insights.
import { describe, it, expect } from "vitest";
import {
  computeLeadTime, computeHotelRates, computeTopRoutes, computeCarbon, computeServiceCards, serviceCardOf,
} from "./travelKpis.js";
import { computeFlightInsights } from "./flightInsights.js";

const D = (s: string) => new Date(s);

describe("computeLeadTime", () => {
  it("IST calendar days from booking to travel; last-minute = ≤3 days; bad rows counted, excluded", () => {
    const f = (bookedAt: string, travelDate: string | null) => ({ service: "FLIGHT", bookedAt: D(bookedAt), travelDate: travelDate ? D(travelDate) : null });
    const r = computeLeadTime([
      f("2026-11-01T00:00:00Z", "2026-11-01T00:00:00Z"), // same day (manual dates: UTC midnight of IST date)
      f("2026-11-01T00:00:00Z", "2026-11-03T00:00:00Z"), // 2
      // SBT: booked 23:00 IST on 1 Nov (17:30Z), departs 06:00 IST on 2 Nov → 1 day, not 0
      f("2026-11-01T17:30:00Z", "2026-11-02T00:30:00Z"),
      f("2026-11-01T00:00:00Z", "2026-11-11T00:00:00Z"), // 10
      f("2026-11-01T00:00:00Z", "2026-12-15T00:00:00Z"), // 44
      f("2026-11-05T00:00:00Z", "2026-11-01T00:00:00Z"), // negative
      f("2026-11-01T00:00:00Z", null),                    // missing
      { service: "HOTEL", bookedAt: D("2026-11-01"), travelDate: D("2026-11-30") },
    ]);
    expect(r.total).toBe(7);
    expect(r.measured).toBe(5);
    expect(r.negative).toBe(1);
    expect(r.missingTravelDate).toBe(1);
    expect(r.buckets.map((b) => b.count)).toEqual([1, 2, 0, 1, 0, 1]);
    expect(r.lastMinute).toEqual({ days: 3, count: 3, pct: 60 });
    expect(r.medianDays).toBe(2);
  });
});

describe("computeHotelRates", () => {
  it("₹ per room-night by city, average stay; coverage counts", () => {
    const h = (city: string | null, nights: any, rooms: any, amount: number) => ({ service: "HOTEL", destinationCity: city, amount, metadata: { nights, rooms } });
    const r = computeHotelRates([
      h("Mumbai", 2, 1, 12000),
      h("Mumbai", 1, 2, 9000),   // 2 room-nights
      h("Delhi", 3, 1, 27000),
      h(null, 2, 1, 5000),       // stay counts, no city
      h("Pune", null, 1, 4000),  // city, no nights
      h("Goa", 90, 1, 1),        // implausible stay → ignored
      h("Mumbai", 3, 11, 999999), // group booking (>10 rooms) → left out of everything
      h("Delhi", 2, 10, 20000),  // exactly 10 rooms still counts
    ]);
    expect(r.excludedGroup).toBe(1);
    expect(r.total).toBe(7);
    expect(r.withNights).toBe(5);
    expect(r.withCity).toBe(6);
    expect(r.measured).toBe(4);
    expect(r.avgStay).toBe(2);
    expect(r.cities[0]).toEqual({ city: "Delhi", bookings: 2, roomNights: 23, spend: 47000, avgNightly: 2043.48 });
    expect(r.cities[1]).toEqual({ city: "Mumbai", bookings: 2, roomNights: 4, spend: 21000, avgNightly: 5250 });
  });
});

describe("computeTopRoutes", () => {
  it("direction-free city pairs, average fare per booking, coverage", () => {
    const f = (o: string | null, d: string | null, amount: number) => ({ service: "FLIGHT", destinationCity: d, amount, metadata: { originCity: o } });
    const r = computeTopRoutes([
      f("Delhi", "Mumbai", 10000), f("Mumbai", "Delhi", 12000), f("Bengaluru", "Delhi", 9000),
      f("Delhi", "Delhi", 5000), f(null, "Delhi", 1), f("Delhi", null, 1),
    ]);
    expect(r.total).toBe(6);
    expect(r.resolved).toBe(3);
    expect(r.routes[0]).toMatchObject({ route: "Delhi ⇄ Mumbai", count: 2, spend: 22000, avgFare: 11000 });
    expect(r.routes[1].route).toBe("Bengaluru ⇄ Delhi");
  });
});

describe("computeCarbon", () => {
  it("sums calculated records of in-scope flights only; coverage = flights with ≥1 record", () => {
    const r = computeCarbon(["a", "b", "c"], [
      { bookingId: "a", co2eKg: 100, distanceKm: 1000 },
      { bookingId: "a", co2eKg: 50, distanceKm: 1000 },
      { bookingId: "b", co2eKg: 30, distanceKm: 500 },
      { bookingId: "zzz", co2eKg: 999, distanceKm: 1 },
      { bookingId: "c", co2eKg: null, distanceKm: 100 },
    ]);
    expect(r).toEqual({ co2eKg: 180, covered: 2, total: 3, coveragePct: 66.7, avgKgPerFlight: 90, gramsPerKm: 72, distanceKm: 2500 });
  });
});

describe("computeServiceCards", () => {
  it("processed / under processing / cost; US visa fee counts as visa; outcomes once recorded", () => {
    const r = computeServiceCards([
      { service: "VISA", status: "CONFIRMED", amount: 10000, metadata: { visaOutcome: "APPROVED" } },
      { service: "VISA", status: "CONFIRMED", amount: 20000, metadata: {} },
      { service: "OTHER", status: "CONFIRMED", amount: 60000, metadata: { manualType: "US_VISA_EARLY_APPOINTMENT_FEE", visaOutcome: "REJECTED" } },
      { service: "VISA", status: "PENDING", amount: 5000, metadata: { visaOutcome: "AWAITING" } },
      { service: "VISA", status: "CANCELLED", amount: 9999, metadata: { visaOutcome: "APPROVED" } },
      { service: "FOREX", status: "CONFIRMED", amount: 3000 },
      { service: "OTHER", status: "CONFIRMED", amount: 1, metadata: { manualType: "INSURANCE" } },
    ]);
    expect(r.VISA).toEqual({ processed: 3, underProcessing: 1, totalCost: 90000, avgCost: 30000, outcomes: { APPROVED: 1, REJECTED: 1, AWAITING: 1, recorded: 3 } });
    expect(r.FOREX).toEqual({ processed: 1, underProcessing: 0, totalCost: 3000, avgCost: 3000 });
    expect(r.ESIM).toEqual({ processed: 0, underProcessing: 0, totalCost: 0, avgCost: null });
    expect(serviceCardOf({ service: "OTHER", metadata: { manualType: "INSURANCE" } })).toBeNull();
  });
});

describe("computeFlightInsights — cabin mix + from-ticket counts", () => {
  it("counts real cabins only, with coverage and ticket share", () => {
    const f = (meta: any, amount = 1000) => ({ service: "FLIGHT", amount, metadata: meta });
    const r = computeFlightInsights([
      f({ cabinClass: "Economy", cabinClassSource: "booking", departMinutesIST: 400, departTimeSource: "booking" }),
      f({ cabinClass: "Economy", cabinClassSource: "ticket", departMinutesIST: 700, departTimeSource: "ticket" }),
      f({ cabinClass: "Business", cabinClassSource: "ticket" }, 5000),
      f({}),
    ]);
    expect(r.cabins.known).toBe(3);
    expect(r.cabins.total).toBe(4);
    expect(r.cabins.fromTicket).toBe(2);
    expect(r.cabins.rows.find((x) => x.cabin === "Economy")).toEqual({ cabin: "Economy", count: 2, spend: 2000, pct: 66.7 });
    expect(r.departureSlots).toMatchObject({ timed: 2, fromTicket: 1 });
  });
});
