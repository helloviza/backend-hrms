// apps/backend/src/services/ticketFallback.unit.test.ts
//
// Phase B additions (2026-11-18): ticket fallback for departure time + cabin,
// and the airport time-zone table used to convert foreign departures to IST.
import { describe, it, expect } from "vitest";
import {
  realCabin, sbtCabin, parseTicketDate, ticketDeparture, ticketCabin, firstStop,
} from "./ticketFallback.js";
import { departureTimeZone, localToUtcMs, istMinutesOf, tzOffsetMinutes } from "../data/airportTimezones.js";

const D = (s: string) => new Date(`${s}T00:00:00Z`);
const booking = (over: any = {}) => ({
  bookingDate: D("2026-08-01"), travelDate: D("2026-08-18"),
  itinerary: { origin: "DEL - BLR", destination: "DEL" }, ...over,
});

describe("realCabin — real cabins only, never fare codes", () => {
  it.each([
    ["Economy", "Economy"], ["Economy, Class FL", "Economy"], ["ECONOMY SM", "Economy"], ["eco", "Economy"],
    ["Premium Economy", "Premium Economy"], ["Prem. Eco", "Premium Economy"],
    ["Business", "Business"], ["Premium Business", "Business"], ["IndiGo Stretch", "Business"], ["Xpress Biz", "Business"],
    ["First", "First"],
  ])("%s → %s", (raw, want) => expect(realCabin(raw)).toBe(want));
  it.each(["SM", "FL", "U1", "Q1", "RR", "Y", "J", "corporate fare", "", null])("fare code / noise %s → null", (raw) => {
    expect(realCabin(raw)).toBeNull();
  });
  it("SBT TBO cabin codes", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(sbtCabin)).toEqual([null, "Economy", "Premium Economy", "Business", "Business", "First", null]);
  });
});

describe("parseTicketDate", () => {
  it.each([
    ["2026-07-17", "2026-07-17"], ["17-Jul-2026", "2026-07-17"], ["17 Jul 2026", "2026-07-17"], ["16Aug2026", "2026-08-16"],
    ["Sun 19 Apr, 2026", "2026-04-19"], ["Mon, Aug 10, 2026", "2026-08-10"], ["17/07/2026", "2026-07-17"],
  ])("%s", (raw, iso) => expect(parseTicketDate(raw)?.toISOString().slice(0, 10)).toBe(iso));
  it("year-less dates need a hint", () => {
    expect(parseTicketDate("Jul 19")).toBeNull();
    expect(parseTicketDate("Jul 19", 2026)?.toISOString().slice(0, 10)).toBe("2026-07-19");
    expect(parseTicketDate("27AUG", 2026)?.toISOString().slice(0, 10)).toBe("2026-08-27");
  });
  it("garbage → null", () => {
    for (const v of ["", "null", null, "tomorrow", "2026"]) expect(parseTicketDate(v)).toBeNull();
  });
  it("firstStop of a route string", () => {
    expect(firstStop("BLR - DEL ")).toBe("BLR");
    expect(firstStop("Delhi to Mumbai")).toBe("Delhi");
  });
});

describe("airport time zones", () => {
  it("single-zone countries by country; multi-zone only per airport", () => {
    expect(departureTimeZone("DXB", "AE")).toBe("Asia/Dubai");
    expect(departureTimeZone("LHR", "GB")).toBe("Europe/London");
    expect(departureTimeZone("SEA", "US")).toBe("America/Los_Angeles");
    expect(departureTimeZone("XYZ", "US")).toBeNull(); // unlisted airport in a multi-zone country
    expect(departureTimeZone("LPA", "ES")).toBe("Atlantic/Canary");
    expect(departureTimeZone("ZZZ", null)).toBeNull();
  });
  it("converts local wall clock to IST, DST-aware", () => {
    // London 10:00 in summer (BST, +1) = 14:30 IST; in winter (GMT) = 15:30 IST.
    expect(istMinutesOf(localToUtcMs(Date.UTC(2026, 6, 15), 600, "Europe/London"))).toBe(14 * 60 + 30);
    expect(istMinutesOf(localToUtcMs(Date.UTC(2026, 0, 15), 600, "Europe/London"))).toBe(15 * 60 + 30);
    // Dubai 23:00 (+4) = 00:30 IST next day.
    expect(istMinutesOf(localToUtcMs(Date.UTC(2026, 6, 15), 23 * 60, "Asia/Dubai"))).toBe(30);
    expect(tzOffsetMinutes("Asia/Kolkata", Date.UTC(2026, 6, 15))).toBe(330);
  });
});

describe("ticketDeparture", () => {
  const seg = (i: number, dep: string, date: string, time: string, extra: any = {}) => ({ segmentIndex: i, depAirport: dep, depDate: date, depTime: time, ...extra });

  it("picks the segment that starts at the booking's origin, even when listed second", () => {
    const r = ticketDeparture(booking(), [seg(0, "BLR", "21-Aug-2026", "11:00"), seg(1, "DEL", "18-Aug-2026", "13:00")]);
    expect(r).toMatchObject({ ok: true, how: "origin", departTimeIST: "13:00", minutesIST: 780, fromTz: null, segmentIndex: 1 });
  });

  it("matches the origin by city name too", () => {
    const r = ticketDeparture(booking({ itinerary: { origin: "New Delhi" } }), [seg(0, "DEL", "2026-08-18", "06:05")]);
    expect(r).toMatchObject({ ok: true, how: "origin", minutesIST: 365 });
  });

  it("else the earliest-dated segment", () => {
    const r = ticketDeparture(booking({ itinerary: { origin: "DEL", destination: "DEL" } }), [
      seg(0, "BLR", "2026-08-19", "21:40"), seg(1, "BOM", "2026-08-17", "14:50"),
    ]);
    expect(r).toMatchObject({ ok: true, how: "earliest", departTimeIST: "14:50" });
  });

  it("rejects a date more than 7 days from the travel date (misread year, other trip)", () => {
    expect(ticketDeparture(booking(), [seg(0, "DEL", "2016-08-18", "13:00")])).toEqual({ ok: false, reason: "bad-date" });
    expect(ticketDeparture(booking(), [seg(0, "DEL", "03-Sep-2026", "13:00")])).toEqual({ ok: false, reason: "bad-date" });
    expect(ticketDeparture(booking(), [seg(0, "DEL", null as any, "13:00")])).toEqual({ ok: false, reason: "bad-date" });
  });

  it("with no travel date, the year must be within one of the booking date", () => {
    const b = booking({ travelDate: null });
    expect(ticketDeparture(b, [seg(0, "DEL", "2026-08-18", "13:00")])).toMatchObject({ ok: true });
    expect(ticketDeparture(b, [seg(0, "DEL", "2016-08-18", "13:00")])).toEqual({ ok: false, reason: "bad-date" });
  });

  it("converts a foreign departure to IST, skips an unknown zone", () => {
    const b = booking({ travelDate: D("2026-07-15"), itinerary: { origin: "LHR" } });
    expect(ticketDeparture(b, [seg(0, "LHR", "15-Jul-2026", "10:00")])).toMatchObject({ ok: true, departTimeIST: "14:30", fromTz: "Europe/London" });
    const us = booking({ travelDate: D("2026-07-15"), itinerary: { origin: "SEA" } });
    expect(ticketDeparture(us, [seg(0, "SEA", "2026-07-15", "09:00")])).toMatchObject({ ok: true, departTimeIST: "21:30", fromTz: "America/Los_Angeles" });
    expect(ticketDeparture(booking({ itinerary: { origin: "QQQ" } }), [seg(0, "QQQ", "2026-08-18", "09:00")])).toEqual({ ok: false, reason: "unknown-tz" });
  });

  it("no rows / no time", () => {
    expect(ticketDeparture(booking(), [])).toEqual({ ok: false, reason: "no-rows" });
    expect(ticketDeparture(booking(), [seg(0, "DEL", "2026-08-18", "")])).toEqual({ ok: false, reason: "no-time" });
  });

  it("passenger rows of one segment count once", () => {
    const r = ticketDeparture(booking(), [seg(0, "DEL", "2026-08-18", "13:00", { passengerIndex: 0 }), seg(0, "DEL", "2026-08-18", "13:00", { passengerIndex: 1 })]);
    expect(r).toMatchObject({ ok: true, minutesIST: 780 });
  });
});

describe("ticketCabin", () => {
  it("prefers the chosen segment, then any real cabin in segment order; fare codes never count", () => {
    const rows = [
      { segmentIndex: 0, cabinClass: "SM" },
      { segmentIndex: 1, cabinClass: "Business" },
      { segmentIndex: 2, cabinClass: "Economy" },
    ];
    expect(ticketCabin(rows, 2)).toBe("Economy");
    expect(ticketCabin(rows, 0)).toBe("Business");
    expect(ticketCabin([{ segmentIndex: 0, cabinClass: "FL" }, { segmentIndex: 1, cabinClass: "U1" }])).toBeNull();
  });
});
