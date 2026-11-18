// apps/backend/src/services/travelSpendPhaseB.unit.test.ts
//
// Travel Spend Phase B (2026-11-18) — the pure pieces: destination tiers
// (N3), airline normalisation, departure-time parsing, the insights
// computation, quarterly stats (N10), the departure-time gate and the
// hotel mirror status map (FU-1).
import { describe, it, expect } from "vitest";
import {
  travelLookup as lookupDestination, travelLookupFuzzy as lookupDestinationFuzzy, travelCountryFuzzy as lookupCountryFuzzy, visaCountryCode, railStationCity,
  lookupDestination as baseLookup,
} from "../data/destinationLookup.js";
import { resolveManualDestination, internationalFrom, manualFlightAnalytics, sbtFlightAnalytics } from "./travelMirrorAnalytics.js";
import { carriersInText, carrierFromFlightNo, carrierShares, splitCarriers } from "../utils/airlineNormalize.js";
import { parseClockTime, slotOf, parseSbtLocalAsIST, sbtClockMinutes } from "../utils/flightTime.js";
import { computeFlightInsights } from "./flightInsights.js";
import { quarterPlan, buildQuarterly } from "./quarterlySpend.js";
import { departTimeGateErrors, departTimeRequired } from "../utils/departTimeGate.js";

process.env.NODE_ENV = "test";
const { mapHotelMirrorStatus, istDateKey } = await import("../models/SBTHotelBooking.js");

describe("N3 destination lookup", () => {
  it("knows the new IATA codes and cities", () => {
    expect(lookupDestination("MNL")).toMatchObject({ city: "Manila", country: "PH", international: true });
    expect(lookupDestination("NMI")).toMatchObject({ city: "Mumbai", country: "IN" });
    expect(lookupDestination("DXN")).toMatchObject({ city: "Noida", country: "IN" });
    for (const [k, city] of [["SYD", "Sydney"], ["CMB", "Colombo"], ["IXS", "Silchar"], ["DOH", "Doha"], ["AUH", "Abu Dhabi"], ["London", "London"], ["Goa", "Goa"], ["Ghent", "Ghent"], ["Luxembourg", "Luxembourg"]]) {
      expect(lookupDestination(k)?.city).toBe(city);
    }
  });
  it("3-letter codes are exact-match only — never a word inside free text", () => {
    expect(lookupDestinationFuzzy("Blue Sea Beach Resort")).toBeNull();
    expect(lookupDestinationFuzzy("Man of the year hotel")).toBeNull();
    expect(lookupDestination("SEA")?.city).toBe("Seattle");
  });
  it("still fuzzy-matches city names (old and new)", () => {
    expect(lookupDestinationFuzzy("jodhpur, rajasthan")?.city).toBe("Jodhpur");
    expect(lookupDestinationFuzzy("Scarsdale Pl, London")?.city).toBe("London");
    expect(lookupDestinationFuzzy("north goa")?.city).toBe("Goa");
    expect(lookupDestinationFuzzy("Karmėlava")?.city).toBe("Kaunas");
  });
  it("country-only tier never invents a city", () => {
    expect(lookupCountryFuzzy("Balangir, Odisha")).toBe("IN");
    expect(lookupCountryFuzzy("Phoenix , USA")).toBe("US");
    expect(lookupCountryFuzzy("Madhya Pradesh")).toBe("IN");
    expect(lookupCountryFuzzy("--")).toBeNull();
  });
  it("visa country: noise stripped, approved 'uk to usa' → US", () => {
    expect(visaCountryCode("Dubai ( super fast)")).toBe("AE");
    expect(visaCountryCode("Saudi Arabia (e-visa)")).toBe("SA");
    expect(visaCountryCode("UK 2 year")).toBe("GB");
    expect(visaCountryCode("Germany NA")).toBe("DE");
    expect(visaCountryCode("UK to USA")).toBe("US");
    expect(visaCountryCode("China Visa")).toBe("CN");
  });
  it("the shared table (Pluto, location service) is unchanged — the additions are Travel Spend only", () => {
    for (const k of ["London", "Thane", "MNL", "NMI", "Manila", "Goa"]) expect(baseLookup(k)).toBeNull();
    expect(baseLookup("Mumbai")?.city).toBe("Mumbai");
  });
  it("rail station codes resolve only through the rail table", () => {
    expect(railStationCity("NDLS")).toBe("Delhi");
    expect(railStationCity("BRC")).toBe("Vadodara");
    expect(lookupDestination("NDLS")).toBeNull();
  });
});

describe("resolveManualDestination tiers", () => {
  const hotel = (sector: string, hotelName = "") => ({ type: "HOTEL", sector, itinerary: { hotelName } });
  it("visa rows get a country and never a city", () => {
    expect(resolveManualDestination({ type: "VISA", itinerary: { visaCountry: "Dubai" } }, "")).toEqual({ destinationCity: null, destinationCountry: "AE", tier: "visa" });
    expect(resolveManualDestination({ type: "VISA", itinerary: { visaCountry: "London" } }, "London").destinationCity).toBeNull();
    expect(resolveManualDestination({ type: "US_VISA_EARLY_APPOINTMENT_FEE", itinerary: {} }, "").destinationCountry).toBe("US");
    expect(resolveManualDestination({ type: "VISA", sector: "Australia visa expedite charge", itinerary: {} }, "").destinationCountry).toBe("AU");
  });
  it("hotel sector cities, country-only regions, hotel-name fallback", () => {
    expect(resolveManualDestination(hotel("Manila"), "Manila")).toMatchObject({ destinationCity: "Manila", destinationCountry: "PH", tier: "T3" });
    expect(resolveManualDestination(hotel("UAE"), "UAE")).toMatchObject({ destinationCity: null, destinationCountry: "AE" });
    expect(resolveManualDestination(hotel("..", "Hilton London"), "..")).toMatchObject({ destinationCity: "London", tier: "T6-hotelName" });
    expect(resolveManualDestination(hotel("..", "Blue Sea Beach Resort"), "..").destinationCity).toBeNull();
  });
  it("flight route strings resolve to the last stop; visa reads the destination too", () => {
    expect(resolveManualDestination({ type: "DUMMY_FLIGHT", itinerary: { destination: "GRU-CDG-AMS" } }, "GRU-CDG-AMS")).toMatchObject({ destinationCity: "Amsterdam", tier: "route" });
    expect(resolveManualDestination({ type: "FLIGHT", itinerary: { destination: "DEL,JAI" } }, "DEL,JAI").destinationCity).toBe("Jaipur");
    expect(resolveManualDestination({ type: "VISA", itinerary: { destination: "Vietnam" } }, "Vietnam").destinationCountry).toBe("VN");
    expect(resolveManualDestination({ type: "VISA", sector: "Delhi-Dubai", itinerary: {} }, "").destinationCountry).toBe("AE");
  });
  it("train station codes", () => {
    expect(resolveManualDestination({ type: "TRAIN", itinerary: { destination: "NDLS" } }, "NDLS")).toMatchObject({ destinationCity: "Delhi", destinationCountry: "IN", tier: "rail" });
  });
});

describe("international = any leg outside India", () => {
  it("an inbound leg counts", () => {
    expect(internationalFrom(["SAN", "EWR", "EWR", "DEL"], "IN")).toBe(true);
    expect(internationalFrom(["DEL", "BOM"], "IN")).toBe(false);
    expect(internationalFrom(["XXX"], null)).toBeNull();
  });
});

describe("airline normalisation", () => {
  it("collapses spellings and splits combos with or without separators", () => {
    expect(carriersInText("INdigo")).toEqual(["IndiGo"]);
    expect(carriersInText("Air India & Indigo")).toEqual(["Air India", "IndiGo"]);
    expect(carriersInText("Indigo Air India Express")).toEqual(["IndiGo", "Air India Express"]);
    expect(carriersInText("AKASA/INDIGO")).toEqual(["Akasa Air", "IndiGo"]);
    expect(carriersInText("Akasa Air/\t IndiGo")).toEqual(["Akasa Air", "IndiGo"]);
    expect(carriersInText("Klm Royal Dutch")).toEqual(["KLM"]);
    expect(carriersInText("SWISS Swiss")).toEqual(["SWISS"]);
    expect(carriersInText("Fly Dubai FZ")).toEqual(["flydubai"]);
    expect(carriersInText("BT - Air Baltic")).toEqual(["airBaltic"]);
  });
  it("junk is nothing; a flight-number prefix rescues it", () => {
    for (const j of ["NA", "0000", "TEST", "ZDUMXG", "7628 & 7629"]) expect(carriersInText(j)).toEqual([]);
    expect(carrierFromFlightNo("6E-5217")).toBe("IndiGo");
    expect(carrierFromFlightNo("AI 302")).toBe("Air India");
    expect(splitCarriers("6E-5217")).toEqual(["IndiGo"]);
    expect(splitCarriers("NA", "6E 123")).toEqual(["IndiGo"]);
  });
  it("shares split by booking and sum to 1", () => {
    expect(carrierShares({ airline: "Air India & Indigo" })).toEqual([{ name: "Air India", share: 0.5 }, { name: "IndiGo", share: 0.5 }]);
    const legs = carrierShares({ legs: [{ airline: "IndiGo" }, { airline: "IndiGo" }, { airline: "Air India" }, { airline: "" }] });
    expect(legs.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 5);
    expect(legs.find((s) => s.name === "IndiGo")!.share).toBeCloseTo(0.5, 5);
    expect(legs.find((s) => s.name === "Unknown")!.share).toBeCloseTo(0.25, 5);
    expect(carrierShares({ airline: "TEST" })).toEqual([{ name: "Unknown", share: 1 }]);
  });
});

describe("departure time", () => {
  it("parses printed times leniently and refuses non-times", () => {
    expect(parseClockTime("06:30")).toBe(390);
    expect(parseClockTime("18:15 hrs")).toBe(1095);
    expect(parseClockTime("07:00 Fri")).toBe(420);
    expect(parseClockTime("15:2O")).toBe(920);
    expect(parseClockTime("6:30 pm")).toBe(1110);
    expect(parseClockTime("0630")).toBe(390);
    expect(parseClockTime("EK 328")).toBeNull();
    expect(parseClockTime("25:00")).toBeNull();
  });
  it("slots are IST clock buckets", () => {
    expect([slotOf(0), slotOf(359), slotOf(360), slotOf(539), slotOf(720), slotOf(1259), slotOf(1260)]).toEqual(["<06", "<06", "06-09", "06-09", "12-15", "18-21", ">=21"]);
  });
  it("SBT local time is read as IST", () => {
    expect(parseSbtLocalAsIST("2026-03-15T14:20:00")!.toISOString()).toBe("2026-03-15T08:50:00.000Z");
    expect(parseSbtLocalAsIST("2026-03-15T14:20")!.toISOString()).toBe("2026-03-15T08:50:00.000Z");
    expect(parseSbtLocalAsIST("2026-03-15T14:20:00Z")!.toISOString()).toBe("2026-03-15T14:20:00.000Z");
    expect(sbtClockMinutes("2026-03-15T14:20:00")).toBe(860);
  });
  it("first leg's time feeds the mirror; Unknown only when no time", () => {
    const a = manualFlightAnalytics({ itinerary: { legs: [{ airline: "IndiGo", departTime: "18:15 hrs" }, { airline: "IndiGo", departTime: "06:00" }] } });
    expect(a).toMatchObject({ departTimeIST: "18:15", departMinutesIST: 1095, departTimeUnknown: false });
    expect(manualFlightAnalytics({ itinerary: { legs: [{ departTimeUnknown: true }] } }).departTimeUnknown).toBe(true);
    expect(sbtFlightAnalytics({ airlineName: "Indigo", departureTime: "2026-05-04T12:15:00" })).toMatchObject({ departTimeIST: "12:15", carrierShares: [{ name: "IndiGo", share: 1 }] });
  });
});

describe("computeFlightInsights", () => {
  const f = (amount: number, intl: boolean | null, shares: any, min: number | null, unknown = false) =>
    ({ service: "FLIGHT", amount, isInternational: intl, metadata: { carrierShares: shares, departMinutesIST: min, departTimeUnknown: unknown } });
  it("splits dom/intl, shares airlines by booking, reports coverage", () => {
    const r = computeFlightInsights([
      f(1000, false, [{ name: "IndiGo", share: 1 }], 390),
      f(3000, true, [{ name: "IndiGo", share: 0.5 }, { name: "Emirates", share: 0.5 }], 1300),
      f(500, null, null, null, true),
      { service: "HOTEL", amount: 800, isInternational: false },
      { service: "VISA", amount: 99, isInternational: true },
    ]);
    expect(r.domesticInternational.FLIGHT).toEqual({ domestic: { count: 1, spend: 1000 }, international: { count: 1, spend: 3000 }, unknown: { count: 1, spend: 500 } });
    expect(r.domesticInternational.HOTEL.domestic).toEqual({ count: 1, spend: 800 });
    expect(r.airlines.flights).toBe(3);
    const indigo = r.airlines.rows.find((x) => x.name === "IndiGo")!;
    expect(indigo).toMatchObject({ count: 1.5, spend: 2500, countPct: 50 });
    expect(r.airlines.rows.at(-1)!.name).toBe("Unknown");
    expect(r.airlines.rows.reduce((a, x) => a + x.count, 0)).toBeCloseTo(3, 5);
    expect(r.departureSlots).toMatchObject({ timed: 2, total: 3, markedUnknown: 1 });
    expect(r.departureSlots.slots.find((x) => x.slot === "06-09")!.pct).toBe(50);
  });
  it("tail beyond the top N folds into Other; Unknown stays its own row", () => {
    const rows = ["A", "B", "C", "Unknown"].map((n) => f(100, false, [{ name: n, share: 1 }], null));
    const r = computeFlightInsights(rows, 2);
    expect(r.airlines.rows.map((x) => x.name)).toEqual(["A", "B", "Other", "Unknown"]);
  });
});

describe("quarterly stats are relative to the anchor quarter (N10)", () => {
  const rows = (y: number, q: number, amount: number, svc = "FLIGHT") => ({ _id: { y, q, svc }, amount });
  it("Q4 2026 to date + projection, Q3 closed", () => {
    const now = new Date("2026-11-18T06:00:00Z");
    const plan = quarterPlan(new Date("2026-11-18T00:00:00Z"), now);
    expect(plan.quarters.map((q) => `${q.y}Q${q.q}`)).toEqual(["2026Q1", "2026Q2", "2026Q3", "2026Q4"]);
    const out = buildQuarterly([rows(2026, 3, 900), rows(2026, 4, 490), rows(2026, 4, 10, "HOTEL"), rows(2025, 4, 77)], plan, now);
    expect(out.quarters.map((q) => q.label)).toEqual(["Q1 2026", "Q2 2026", "Q3 2026", "Q4 2026*"]);
    expect(out.stats).toMatchObject({ prevLabel: "Q3 2026", prevClosed: 900, currentLabel: "Q4 2026", currentToDate: 500 });
    // 49 of 92 days elapsed → 500 / 49 × 92
    expect(out.stats.currentProjected).toBe(Math.round((500 / 49) * 92));
    expect(out.stats.q1Closed).toBe(900); // legacy key carries the new meaning
  });
  it("a past anchor quarter is closed: projection = total; crosses the year", () => {
    const now = new Date("2026-11-18T06:00:00Z");
    const plan = quarterPlan(new Date("2026-02-10T00:00:00Z"), now);
    expect(plan.quarters.map((q) => `${q.y}Q${q.q}`)).toEqual(["2025Q2", "2025Q3", "2025Q4", "2026Q1"]);
    const out = buildQuarterly([rows(2026, 1, 300)], plan, now);
    expect(out.stats).toMatchObject({ currentLabel: "Q1 2026", currentToDate: 300, currentProjected: 300, prevLabel: "Q4 2025" });
  });
});

describe("departure time gate (server)", () => {
  const flight = (legs: any[], extra: any = {}) => ({ type: "FLIGHT", status: "CONFIRMED", source: "MANUAL", itinerary: { legs }, ...extra });
  it("required per leg on the move into Done; Unknown satisfies it", () => {
    expect(departTimeGateErrors(flight([{ departTime: "06:30" }, { departTime: "" }]))).toEqual([departTimeRequired(2)]);
    expect(departTimeGateErrors(flight([{ departTimeUnknown: true }]))).toEqual([]);
    expect(departTimeGateErrors(flight([{ departTime: "EK 328" }]))).toEqual([departTimeRequired(1)]);
  });
  it("not asked when Pending, already Done, SBT-sourced, legacy (no legs) or not a flight", () => {
    expect(departTimeGateErrors(flight([{}], { status: "PENDING" }))).toEqual([]);
    expect(departTimeGateErrors(flight([{}]), "CONFIRMED")).toEqual([]);
    expect(departTimeGateErrors(flight([{}], { source: "SBT_AUTO" }))).toEqual([]);
    expect(departTimeGateErrors(flight([]))).toEqual([]);
    expect(departTimeGateErrors(flight([{}], { type: "HOTEL" }))).toEqual([]);
    expect(departTimeGateErrors(flight([{}]), "WIP")).toEqual([departTimeRequired(1)]);
  });
});

describe("FU-1 hotel mirror status", () => {
  const now = new Date("2026-11-18T20:00:00Z"); // 19 Nov 01:30 IST
  it("dead holds are FAILED, cancel-pending is CANCELLED", () => {
    for (const s of ["EXPIRED", "CLOSED", "ORPHAN_CLEANED", "FAILED"]) expect(mapHotelMirrorStatus(s, "", now)).toBe("FAILED");
    expect(mapHotelMirrorStatus("CANCEL_PENDING", "", now)).toBe("CANCELLED");
    expect(mapHotelMirrorStatus("CONFIRMED", "", now)).toBe("CONFIRMED");
  });
  it("HELD past check-in (IST) is FAILED; today or later stays PENDING", () => {
    expect(istDateKey(now)).toBe("2026-11-19");
    expect(mapHotelMirrorStatus("HELD", "2026-11-18", now)).toBe("FAILED");
    expect(mapHotelMirrorStatus("HELD", "2026-11-19", now)).toBe("PENDING");
    expect(mapHotelMirrorStatus("HELD", "", now)).toBe("PENDING");
  });
});
