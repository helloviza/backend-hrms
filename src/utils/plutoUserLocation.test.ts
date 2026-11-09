// Pluto user-location rules (audit docs/audits/pluto-office-location-2026-11-09.md).
// Deterministic: the catalog lookup is injected, the geo service and the two
// models are mocked, and no test touches Mongo, MaxMind, TBO or an LLM.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const H = vi.hoisted(() => ({
  ipMock: vi.fn(),
  userFindById: vi.fn(),
  employeeFindOne: vi.fn(),
}));

vi.mock("../services/location.service.js", () => ({ resolveCityFromIpBounded: H.ipMock }));
vi.mock("../models/User.js", () => ({
  default: { findById: (...a: any[]) => ({ select: () => ({ lean: () => H.userFindById(...a) }) }) },
}));
vi.mock("../models/Employee.js", () => ({
  default: { findOne: (...a: any[]) => ({ select: () => ({ lean: () => H.employeeFindOne(...a) }) }) },
}));

import mongoose from "mongoose";
import {
  mentionsOffice,
  isOfficePlace,
  mentionsNearMe,
  resolveCityStrict,
  resolveOfficeCity,
  loadOfficeText,
  suggestCurrentCity,
  suggestFlightOrigin,
  flightOriginChip,
  FLIGHT_ORIGIN_ASK_CHIP,
  parseCityAnswer,
  spliceFlightAnswer,
  officeDisclosure,
  type StrictDeps,
} from "./plutoUserLocation.js";
import { pickCatalogCity } from "./plutoHotelDestination.js";

/* A tiny fake `tbocities`, keyed by normalised query. */
const CATALOG: Record<string, any[]> = {
  bengaluru: [{ code: "111124", name: "Bengaluru/Bangalore,   Karnataka", countryCode: "IN", searchName: "bengaluru bangalore karnataka" }],
  bangalore: [{ code: "111124", name: "Bengaluru/Bangalore,   Karnataka", countryCode: "IN", searchName: "bengaluru bangalore karnataka" }],
  mumbai: [{ code: "144306", name: "Mumbai/Bombay,   Maharashtra", countryCode: "IN", searchName: "mumbai bombay maharashtra" }],
  pune: [{ code: "131766", name: "Pune,   Maharashtra", countryCode: "IN", searchName: "pune maharashtra" }],
  springfield: [
    { code: "SP1", name: "Springfield,   Illinois", countryCode: "US", searchName: "springfield illinois" },
    { code: "SP2", name: "Springfield,   Missouri", countryCode: "US", searchName: "springfield missouri" },
  ],
  // A prefix/$text-style hit that is NOT the city "remote" — must not count.
  remote: [{ code: "RM1", name: "Remoteville,   Somewhere", countryCode: "XX", searchName: "remoteville somewhere" }],
};
const deps: StrictDeps = {
  findCatalogMatches: (async (name: string) => CATALOG[name.toLowerCase().trim()] ?? []) as any,
  pickCatalogCity,
};

beforeEach(() => {
  Object.values(H).forEach((m) => m.mockReset());
});

describe("mentionsOffice — the office as a PLACE", () => {
  it.each([
    "Suggest hotels near my office",
    "Hotels near my office",
    "hotels close to our office",
    "hotel near the office please",
    "stay near office",
    "hotels near work",
    "hotels walking distance from my workplace",
    "flights from my office to Mumbai",
    "hotels near our head office",
  ])("detects %s", (p) => expect(mentionsOffice(p)).toBe(true));

  it.each([
    "work trip to Mumbai next week",
    "hotels for my office party",
    "flights after office hours",
    "business hotel in Pune",
    "Recommend places to visit in Goa",
    "hotels near me",
  ])("does not fire on %s", (p) => expect(mentionsOffice(p)).toBe(false));
});

describe("isOfficePlace — a captured endpoint", () => {
  it.each(["my office", "office", "the office", "our head office", "work", "my workplace", "office city"])(
    "%s → office",
    (s) => expect(isOfficePlace(s)).toBe(true),
  );
  it.each(["Mumbai", "my home", "workshop", "", null])("%s → not office", (s) => expect(isOfficePlace(s as any)).toBe(false));
});

describe("mentionsNearMe", () => {
  it.each(["hotels near me", "any hotels around here", "hotels nearby", "need a hotel tonight here", "hotel close to me"])(
    "detects %s",
    (p) => expect(mentionsNearMe(p)).toBe(true),
  );
  it.each(["hotels near my office", "hotels in Pune", "Search hotels in Bengaluru (my current location)"])(
    "does not fire on %s",
    (p) => expect(mentionsNearMe(p)).toBe(false),
  );
});

describe("resolveCityStrict — exactly one city, or nothing", () => {
  it("'Bengaluru' → ONE (curated name, catalog code)", async () => {
    const r = await resolveCityStrict("Bengaluru", deps);
    expect(r).toEqual({ status: "ONE", city: { cityName: "Bengaluru", countryCode: "IN", cityCode: "111124" } });
  });
  it("'bangalore' → ONE Bengaluru (curated canonicalises the spelling)", async () => {
    const r = await resolveCityStrict("bangalore", deps);
    expect(r.status === "ONE" && r.city.cityName).toBe("Bengaluru");
  });
  it("'Mumbai - Andheri' → ONE Mumbai (first segment)", async () => {
    const r = await resolveCityStrict("Mumbai - Andheri", deps);
    expect(r.status === "ONE" && r.city.cityName).toBe("Mumbai");
  });
  it("'Head Office' → NONE", async () => expect((await resolveCityStrict("Head Office", deps)).status).toBe("NONE"));
  it("'Remote' → NONE (a prefix hit like 'Remoteville' is not evidence)", async () =>
    expect((await resolveCityStrict("Remote", deps)).status).toBe("NONE"));
  it("'' → NONE", async () => expect((await resolveCityStrict("", deps)).status).toBe("NONE"));
  it("'Springfield' (two real cities) → MANY", async () =>
    expect((await resolveCityStrict("Springfield", deps)).status).toBe("MANY"));
  it("a catalog failure degrades to NONE, never throws", async () => {
    const broken: StrictDeps = { findCatalogMatches: (async () => { throw new Error("db down"); }) as any, pickCatalogCity };
    expect((await resolveCityStrict("Atlantis", broken)).status).toBe("NONE");
  });
});

describe("resolveOfficeCity — profile → RESOLVED or ASK", () => {
  const loaderFor = (raw: string | null) => async () => (raw === null ? null : { raw, source: "jobLocation" as const });

  it("jobLocation 'Bengaluru' → RESOLVED Bengaluru, source jobLocation", async () => {
    const r = await resolveOfficeCity({}, deps, loaderFor("Bengaluru"));
    expect(r).toMatchObject({ status: "RESOLVED", city: { cityName: "Bengaluru", cityCode: "111124" }, source: "jobLocation" });
  });
  it("'Head Office' → ASK not_a_city", async () =>
    expect(await resolveOfficeCity({}, deps, loaderFor("Head Office"))).toMatchObject({ status: "ASK", reason: "not_a_city" }));
  it("'Remote' → ASK not_a_city", async () =>
    expect(await resolveOfficeCity({}, deps, loaderFor("Remote"))).toMatchObject({ status: "ASK", reason: "not_a_city" }));
  it("'' / nothing on file → ASK empty", async () =>
    expect(await resolveOfficeCity({}, deps, loaderFor(null))).toMatchObject({ status: "ASK", reason: "empty" }));
  it("'Springfield' → ASK ambiguous", async () =>
    expect(await resolveOfficeCity({}, deps, loaderFor("Springfield"))).toMatchObject({ status: "ASK", reason: "ambiguous" }));
});

describe("loadOfficeText — User.jobLocation, fallback Employee.location", () => {
  const UID = "64b000000000000000000001";
  const WS = "656565656565656565656565";

  it("no live DB → null without querying (a turn never waits on Mongo)", async () => {
    expect(await loadOfficeText({ user: { _id: UID } })).toBeNull();
    expect(H.userFindById).not.toHaveBeenCalled();
  });

  it("jobLocation wins; Employee is not consulted", async () => {
    const spy = vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1 as any);
    H.userFindById.mockResolvedValue({ jobLocation: "  Pune ", email: "a@x.com" });
    expect(await loadOfficeText({ user: { _id: UID }, workspaceObjectId: WS })).toEqual({ raw: "Pune", source: "jobLocation" });
    expect(H.employeeFindOne).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("blank jobLocation → Employee.location, scoped to the request's workspace", async () => {
    const spy = vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(1 as any);
    H.userFindById.mockResolvedValue({ jobLocation: "", email: "A@X.com" });
    H.employeeFindOne.mockResolvedValue({ location: "Mumbai" });
    expect(await loadOfficeText({ user: { _id: UID }, workspaceObjectId: WS })).toEqual({ raw: "Mumbai", source: "employee.location" });
    expect(H.employeeFindOne).toHaveBeenCalledWith({ workspaceId: WS, $or: [{ ownerId: UID }, { email: "a@x.com" }] });
    spy.mockRestore();
  });
});

describe("suggestCurrentCity — IP city only when genuinely resolvable", () => {
  const ip = (over: Record<string, any>) =>
    H.ipMock.mockResolvedValue({ city: null, rawCity: null, region: null, country: null, source: "unresolved", confidence: 0, accuracyRadiusKm: null, reason: "x", ...over });

  it("source ip + strict city → suggestion", async () => {
    ip({ city: "Bengaluru", rawCity: "Bengaluru", source: "ip", reason: "ok" });
    expect(await suggestCurrentCity({ ip: "49.43.246.108" }, { deps })).toMatchObject({ cityName: "Bengaluru", cityCode: "111124" });
    // Bounded, read-only call (no ActorLocation write path is used).
    expect(H.ipMock).toHaveBeenCalledWith("49.43.246.108", 600);
  });
  it("geo DB unavailable (no MaxMind key) → null", async () => {
    ip({ source: "unresolved", reason: "geo_db_unavailable" });
    expect(await suggestCurrentCity({ ip: "49.43.246.108" }, { deps })).toBeNull();
  });
  it("private / loopback IP → null", async () => {
    ip({ source: "private-ip", reason: "loopback" });
    expect(await suggestCurrentCity({ ip: "127.0.0.1" }, { deps })).toBeNull();
  });
  it("city not in the strict table (rawCity only) → null", async () => {
    ip({ source: "ip", rawCity: "Thane", city: null, reason: "city_not_in_lookup" });
    expect(await suggestCurrentCity({ ip: "1.2.3.4" }, { deps })).toBeNull();
  });
  it("resolver throws → null, never propagates", async () => {
    H.ipMock.mockRejectedValue(new Error("boom"));
    expect(await suggestCurrentCity({ ip: "1.2.3.4" }, { deps })).toBeNull();
  });
});

describe("suggestFlightOrigin — airport city, or the nearest one when there is none", () => {
  const ip = (over: Record<string, any>) =>
    H.ipMock.mockResolvedValue({ city: null, rawCity: null, region: null, country: "IN", source: "unresolved", confidence: 0, accuracyRadiusKm: null, reason: "x", ...over });
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => logSpy.mockRestore());
  const logged = () => logSpy.mock.calls.map((c) => String(c[0])).join("\n");

  it("a city with its own airport → that city, no 'nearest' note", async () => {
    ip({ city: "Bengaluru", rawCity: "Bengaluru", source: "ip", reason: "ok" });
    const s = await suggestFlightOrigin({ ip: "49.43.246.108" }, { deps });
    expect(s).toMatchObject({ iata: "BLR", nearestTo: null, city: { cityName: "Bengaluru" } });
    expect(flightOriginChip(s!)).toBe("Flying from Bengaluru? (based on your current location)");
  });

  it.each([
    // Resolves in the curated table, but has no airport mapped.
    [{ city: "Gurugram", rawCity: "Gurugram", reason: "ok" }, "Delhi", "DEL", "Gurugram"],
    [{ city: "Faridabad", rawCity: "Faridabad", reason: "ok" }, "Delhi", "DEL", "Faridabad"],
    // Not in the curated table at all — only rawCity is known.
    [{ city: null, rawCity: "Noida", reason: "city_not_in_lookup" }, "Delhi", "DEL", "Noida"],
    [{ city: null, rawCity: "Ghaziabad", reason: "city_not_in_lookup" }, "Delhi", "DEL", "Ghaziabad"],
    [{ city: null, rawCity: "Thane", reason: "city_not_in_lookup" }, "Mumbai", "BOM", "Thane"],
  ])("%o → %s (%s), disclosed as nearest airport", async (over, airportCity, iata, nearestTo) => {
    ip({ source: "ip", ...over });
    const s = await suggestFlightOrigin({ ip: "1.2.3.4" }, { deps });
    expect(s).toMatchObject({ iata, nearestTo, city: { cityName: airportCity } });
    expect(flightOriginChip(s!)).toBe(
      `Flying from ${airportCity}? (nearest airport for your current location, ${nearestTo})`,
    );
    // " to " would make the tapped chip read as a new "from X to Y" search.
    expect(flightOriginChip(s!)).not.toMatch(/\sto\s/i);
    // The chip, tapped, answers with the airport city.
    expect(parseCityAnswer(flightOriginChip(s!))).toBe(airportCity);
  });

  it("the nearest-airport map is India-only", async () => {
    ip({ source: "ip", city: null, rawCity: "Thane", country: "US", reason: "city_not_in_lookup" });
    expect(await suggestFlightOrigin({ ip: "1.2.3.4" }, { deps })).toBeNull();
  });

  it("an unmapped city with no airport → null", async () => {
    ip({ source: "ip", city: null, rawCity: "Nowhereville", reason: "city_not_in_lookup" });
    expect(await suggestFlightOrigin({ ip: "1.2.3.4" }, { deps })).toBeNull();
  });

  it.each([
    [{ source: "unresolved", reason: "geo_db_unavailable" }, "public"],
    [{ source: "private-ip", reason: "rfc1918" }, "private"],
  ])("no IP city (%o) → null, and the log says why", async (over, ipKind) => {
    ip(over);
    expect(await suggestFlightOrigin({ ip: "10.0.0.5" }, { deps })).toBeNull();
    expect(logged()).toContain(`"ipKind":"${ipKind}"`);
    expect(logged()).toContain(`"reason":"${over.reason}"`);
  });

  it("logs source/reason/ipKind/outcome — never the IP, never the city", async () => {
    ip({ city: "Gurugram", rawCity: "Gurugram", source: "ip", reason: "ok" });
    await suggestFlightOrigin({ ip: "49.43.246.108" }, { deps });
    const out = logged();
    expect(out).toContain('"outcome":"offered_nearest_airport"');
    expect(out).not.toContain("49.43.246.108");
    expect(out).not.toMatch(/Gurugram|Delhi/);
  });

  it("the no-location ask chip ends in '?' and its completion is the answer", () => {
    expect(FLIGHT_ORIGIN_ASK_CHIP.endsWith("?")).toBe(true);
    expect(parseCityAnswer(`${FLIGHT_ORIGIN_ASK_CHIP} Pune`)).toBe("Pune");
  });
});

describe("parseCityAnswer — how an answer arrives through nextSteps chips", () => {
  it.each([
    ["Flying from Bengaluru? (based on your current location)", "Bengaluru"],
    ["Other city — which one? Pune", "Pune"],
    ["Which city is your office in? Hyderabad", "Hyderabad"],
    ["Pune", "Pune"],
    ["from Pune.", "Pune"],
    ["it's in New Delhi", "New Delhi"],
  ])("%s → %s", (input, want) => expect(parseCityAnswer(input)).toBe(want));

  it.each(["Can you show me hotels in Goa for the long weekend with a pool", "", "12-14 Nov"])(
    "%s → null (not a short place answer)",
    (input) => expect(parseCityAnswer(input)).toBeNull(),
  );
});

describe("spliceFlightAnswer", () => {
  it("adds the origin to an ask that had none", () =>
    expect(spliceFlightAnswer("Find flights to Mumbai next week", "origin", "Bengaluru")).toBe("Find flights to Mumbai next week from Bengaluru"));
  it("replaces an office endpoint", () =>
    expect(spliceFlightAnswer("flights from my office to Mumbai on 20 Nov", "origin", "Pune")).toBe("flights from Pune to Mumbai on 20 Nov"));
  it("replaces an office destination", () =>
    expect(spliceFlightAnswer("flights from Delhi to the office tomorrow", "destination", "Pune")).toBe("flights from Delhi to Pune tomorrow"));
});

describe("officeDisclosure copy", () => {
  it("hotels", () =>
    expect(officeDisclosure("Bengaluru", "hotels")).toBe(
      "Your profile lists your office as Bengaluru — showing hotels in Bengaluru (city-wide, not sorted by distance to your office). ",
    ));
});
