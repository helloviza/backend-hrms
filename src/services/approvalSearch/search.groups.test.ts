// apps/backend/src/services/approvalSearch/search.groups.test.ts
//
// FLIGHT_OPTIONS_CAP counts flight groups (one itinerary, every fare family),
// never raw fares, and a group is never cut in half — by the group cap or by
// the session-size budget (F11).
import { describe, it, expect } from "vitest";

process.env.JWT_SECRET ||= "jwt-secret-for-tests";

const { capFlightGroups, capFlightSession, FLIGHT_OPTIONS_CAP, FLIGHT_SESSION_BYTES_CAP } = await import("./search.js");
const { flightGroupKey } = await import("./selection.js");

const raw = (no: string, dep: string, fare: string) => ({
  ResultIndex: `${no}-${fare}`,
  FareClassification: { Type: fare },
  Fare: { PublishedFare: 5000 },
  Segments: [[{ Airline: { AirlineCode: "6E", FlightNumber: no }, Origin: { DepTime: dep }, Destination: { ArrTime: dep } }]],
});
const flight = (no: string, dep: string, fares: string[]) => fares.map((f) => raw(no, dep, f));
const groupsOf = (list: any[]) => [...new Set(list.map(flightGroupKey))];

describe("capFlightGroups", () => {
  it("counts groups, keeps every fare of a kept group, and keeps departure order", () => {
    // Two flights leave at 07:00, so their fares interleave after the departure sort.
    const sorted = [
      raw("101", "2027-03-12T07:00:00", "Saver"),
      raw("202", "2027-03-12T07:00:00", "Saver"),
      raw("101", "2027-03-12T07:00:00", "Flexi"),
      raw("202", "2027-03-12T07:00:00", "Flexi"),
      raw("101", "2027-03-12T07:00:00", "Upfront"),
      ...flight("303", "2027-03-12T09:00:00", ["Saver", "Flexi", "Upfront"]),
    ];
    const kept = capFlightGroups(sorted, 2);
    expect(kept.map((r) => r.ResultIndex)).toEqual(["101-Saver", "101-Flexi", "101-Upfront", "202-Saver", "202-Flexi"]);
    expect(capFlightGroups(sorted, 3)).toHaveLength(8);
  });

  it("never cuts the last group: the old raw cap would have split it", () => {
    const sorted = [
      ...flight("101", "2027-03-12T06:00:00", ["Saver", "Flexi"]),
      ...flight("202", "2027-03-12T08:00:00", ["Saver", "Flexi", "Upfront"]),
      ...flight("303", "2027-03-12T10:00:00", ["Saver"]),
    ];
    expect(sorted.slice(0, 4).map((r) => r.ResultIndex)).toContain("202-Flexi"); // raw slice ends inside 202
    const kept = capFlightGroups(sorted, 2);
    expect(kept).toHaveLength(5);
    expect(kept.filter((r) => r.ResultIndex.startsWith("202"))).toHaveLength(3);
  });

  it(`the default cap is ${FLIGHT_OPTIONS_CAP} groups, not ${FLIGHT_OPTIONS_CAP} fares`, () => {
    const sorted = Array.from({ length: 250 }, (_, i) =>
      flight(String(1000 + i), `2027-03-12T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00`, ["Saver", "Flexi", "Upfront"]),
    ).flat();
    const kept = capFlightGroups(sorted);
    expect(groupsOf(kept)).toHaveLength(FLIGHT_OPTIONS_CAP);
    expect(kept).toHaveLength(FLIGHT_OPTIONS_CAP * 3);
  });

  it("the size budget stops at a group boundary; the first group is always kept", () => {
    const sorted = [
      ...flight("101", "2027-03-12T06:00:00", ["Saver", "Flexi"]),
      ...flight("202", "2027-03-12T08:00:00", ["Saver", "Flexi", "Upfront"]),
    ];
    const one = Buffer.byteLength(JSON.stringify(sorted[0]));
    expect(capFlightGroups(sorted, 200, one * 3).map((r) => r.ResultIndex)).toEqual(["101-Saver", "101-Flexi"]);
    expect(capFlightGroups(sorted, 200, 1)).toHaveLength(2);
    expect(capFlightGroups(sorted, 200, one * 10)).toHaveLength(5);
  });
});

describe("capFlightSession: one byte budget for the whole session", () => {
  // ~200 KB per fare: 60 two-fare flights (~24 MB) pass the 10 MB budget.
  const big = (no: string, dep: string, fares: string[]) =>
    flight(no, dep, fares).map((r) => ({ ...r, FareRules: "x".repeat(200 * 1024) }));
  const day = (dir: string, n: number) =>
    Array.from({ length: n }, (_, i) =>
      big(`${dir}${100 + i}`, `2027-03-12T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00`, ["Saver", "Flexi"]),
    ).flat();
  const bytesOf = (list: any[]) => list.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0);

  it("domestic return with both directions large: total under the cap, whole groups, both directions served", () => {
    const out = day("O", 60);
    const back = day("I", 60);
    const { kept, bytes, groups } = capFlightSession([out, back]);
    expect(bytesOf(out) + bytesOf(back)).toBeGreaterThan(FLIGHT_SESSION_BYTES_CAP);
    expect(bytes).toBeLessThanOrEqual(FLIGHT_SESSION_BYTES_CAP);
    expect(bytesOf([...kept[0], ...kept[1]])).toBe(bytes);
    for (const list of kept) {
      const counts = new Map<string, number>();
      for (const r of list) counts.set(flightGroupKey(r), (counts.get(flightGroupKey(r)) ?? 0) + 1);
      expect([...counts.values()].every((c) => c === 2)).toBe(true);
    }
    // Filled in turn: the two directions differ by at most one flight.
    const flights = kept.map((l) => groupsOf(l).length);
    expect(Math.abs(flights[0] - flights[1])).toBeLessThanOrEqual(1);
    expect(flights[0] + flights[1]).toBe(groups);
    expect(flights[1]).toBeGreaterThan(0);
  });

  it("one-way: the same as before when it fits; the whole budget when it doesn't", () => {
    const small = day("O", 30).map(({ FareRules: _f, ...r }) => r);
    expect(capFlightSession([small]).kept[0]).toEqual(small);
    expect(capFlightGroups(small)).toEqual(small);

    const large = day("O", 60);
    const { kept, bytes } = capFlightSession([large]);
    expect(bytes).toBeLessThanOrEqual(FLIGHT_SESSION_BYTES_CAP);
    expect(kept[0].length % 2).toBe(0);
    expect(bytes).toBeGreaterThan(FLIGHT_SESSION_BYTES_CAP - bytesOf(large.slice(0, 2)));
  });
});
