// apps/backend/src/utils/plutoCityResolution.integration.test.ts
//
// The batch. findCatalogCity had ZERO tests before this — it needs a database,
// so it never got one, which is exactly why "Visakhapatnam" shipped as
// unresolvable despite 305 bookable hotels.
//
// Runs against a REAL mongod (mongodb-memory-server) so the searchName_1 range
// index and the searchName_text index are the real ones, seeded with rows
// copied verbatim in SHAPE from the live catalog (compound slash names, the
// triple-space comma padding, the duplicate-name rows). Fixtures, never prod.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { TBOCity, TBOHotelMaster, normalizeSearch } from "../jobs/static-data-refresh.js";
import {
  findCatalogMatches,
  pickCatalogCity,
  findCatalogCity,
  cityNameVariants,
  regionOf,
} from "./plutoHotelDestination.js";

let mongod: MongoMemoryServer;

/** Real catalog shapes. `name` is exactly what TBO stores, padding included. */
const CITIES: Array<[string, string, string]> = [
  // ── compound / alternate-lead-name rows (the broken class) ──
  ["142198", "Vizag/Visakhapatnam,   Andhra Pradesh", "IN"],
  ["144100", "Bengaluru/Bangalore,   Karnataka", "IN"],
  ["126632", "Kolkata/Calcutta,   West Bengal", "IN"],
  ["115401", "Mumbai/Bombay,   Maharashtra", "IN"],
  ["130452", "Gurugram/Gurgaon,   Haryana", "IN"],
  ["133301", "Puducherry/Pondicherry,   Tamil Nadu", "IN"],
  ["139900", "Alleppey/Alappuzha,   Kerala", "IN"],
  ["101010", "New Delhi / Delhi,   DELHI", "IN"],

  // ── comma shape (must not regress — city IS the lead token) ──
  ["200001", "Aberdeen,   North Carolina", "US"],
  ["200002", "Abbotsford,   British Columbia", "CA"],

  // ── plain catalog cities ──
  ["115936", "Dubai", "AE"],
  ["126631", "London", "GB"],
  ["148251", "Tokyo", "JP"],
  ["131408", "Paris", "FR"],
  ["300001", "Doha", "QA"],

  // ── genuine ambiguity: 6 byte-identical "Santa Maria" (the findOne bug) ──
  ["400001", "Santa Maria", "BR"],
  ["400002", "Santa Maria", "US"],
  ["400003", "Santa Maria", "PT"],
  ["400004", "Santa Maria", "PH"],
  ["400005", "Santa Maria", "CO"],
  ["400006", "Santa Maria", "MX"],

  // ── genuine ambiguity: many Springfields, plus two that are NOT Springfield ──
  ["500001", "Springfield,   Illinois", "US"],
  ["500002", "Springfield,   Missouri", "US"],
  ["500003", "Springfield,   Massachusetts", "US"],
  ["500004", "Springfield,   Ohio", "US"],
  ["500005", "Springfield", "NZ"],
  ["500006", "East Springfield,   New York", "US"],
  ["500007", "West Springfield,   Massachusetts", "US"],

  // ── same name, different countries, only ONE with inventory ──
  ["600001", "Farville,   Nowhere County", "US"],
  ["600002", "Farville", "AU"],
];

/** cityCode → how many hotel-master rows to seed (the inventory tie-break). */
const INVENTORY: Record<string, number> = {
  "142198": 305, // Vizag — the real number
  "115936": 40,
  "101010": 25,
  "600001": 7, // only this Farville is bookable
  // 600002 deliberately absent → zero inventory
};

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  await (TBOCity as any).insertMany(
    CITIES.map(([code, name, countryCode]) => ({
      code,
      name,
      searchName: normalizeSearch(name),
      countryCode,
    })),
  );

  const hotels: any[] = [];
  for (const [cityCode, n] of Object.entries(INVENTORY)) {
    for (let i = 0; i < n; i++) {
      hotels.push({
        hotelCode: `${cityCode}-${i}`,
        hotelName: `Hotel ${cityCode} ${i}`,
        searchName: normalizeSearch(`Hotel ${cityCode} ${i}`),
        cityCode,
        countryCode: "XX",
      });
    }
  }
  await (TBOHotelMaster as any).insertMany(hotels);

  // The real indexes, including searchName_text — the whole point of using a
  // real mongod rather than stubbing the queries.
  await (TBOCity as any).syncIndexes();
  await (TBOHotelMaster as any).syncIndexes();
}, 180_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod?.stop();
});

/** Resolve a bare name through the ladder, as findCatalogCity does. */
async function resolve(name: string) {
  const rows = await findCatalogMatches(name);
  return pickCatalogCity(rows, name);
}

describe("pure helpers", () => {
  it("cityNameVariants splits the compound the way TBO packs it", () => {
    expect(cityNameVariants("Vizag/Visakhapatnam,   Andhra Pradesh")).toEqual([
      "vizag",
      "visakhapatnam",
    ]);
    expect(cityNameVariants("New Delhi / Delhi,   DELHI")).toEqual(["new delhi", "delhi"]);
    expect(cityNameVariants("Springfield,   Illinois")).toEqual(["springfield"]);
    expect(cityNameVariants("Dubai")).toEqual(["dubai"]);
  });

  it("regionOf keeps the qualifier that tells duplicates apart", () => {
    expect(regionOf("Springfield,   Illinois")).toBe("Illinois");
    expect(regionOf("Vizag/Visakhapatnam,   Andhra Pradesh")).toBe("Andhra Pradesh");
    expect(regionOf("Dubai")).toBeUndefined();
  });
});

describe("BATCH — compound cities resolve on BOTH names", () => {
  const pairs: Array<[string, string, string]> = [
    ["Vizag", "Visakhapatnam", "142198"],
    ["Bengaluru", "Bangalore", "144100"],
    ["Kolkata", "Calcutta", "126632"],
    ["Mumbai", "Bombay", "115401"],
    ["Gurugram", "Gurgaon", "130452"],
    ["Puducherry", "Pondicherry", "133301"],
    ["Alleppey", "Alappuzha", "139900"],
  ];

  it.each(pairs)("%s / %s → one confident city (%s)", async (lead, alt, code) => {
    for (const name of [lead, alt]) {
      const pick = await resolve(name);
      expect(pick.kind, `${name} should resolve, not ask`).toBe("ONE");
      expect((pick as any).city.code).toBe(code);
    }
  });

  it("REGRESSION: the exact reported bug — 'visakhapatnam' was 0 prefix hits", async () => {
    const key = normalizeSearch("Visakhapatnam");
    // Prove the OLD strategy still fails, so this test can never silently pass
    // because the data changed rather than the code.
    const oldPrefix = await (TBOCity as any)
      .find({ searchName: { $gte: key, $lt: key + "￿" } })
      .lean();
    expect(oldPrefix).toHaveLength(0);
    expect(await (TBOCity as any).findOne({ searchName: key }).lean()).toBeNull();

    const city = await findCatalogCity("Visakhapatnam");
    expect(city).not.toBeNull();
    expect(city!.code).toBe("142198");
    expect(city!.countryCode).toBe("IN");
    // Shows the variant that was ASKED FOR, not the raw compound pair —
    // "Hotels in Vizag/Visakhapatnam" is not something a person would write.
    expect(city!.name).toBe("Visakhapatnam");
    expect((await findCatalogCity("Vizag"))!.name).toBe("Vizag");
    expect((await findCatalogCity("Bangalore"))!.name).toBe("Bangalore");
    expect((await findCatalogCity("Bengaluru"))!.name).toBe("Bengaluru");
  });
});

describe("BATCH — no regression on the shapes that already worked", () => {
  it.each([
    ["Aberdeen", "200001"],
    ["Abbotsford", "200002"],
    ["Dubai", "115936"],
    ["London", "126631"],
    ["Tokyo", "148251"],
    ["Paris", "131408"],
    ["Doha", "300001"],
  ])("%s still resolves confidently (%s)", async (name, code) => {
    const pick = await resolve(name);
    expect(pick.kind, `${name} must not become ambiguous`).toBe("ONE");
    expect((pick as any).city.code).toBe(code);
  });
});

describe("BATCH — genuine ambiguity ASKS, never picks", () => {
  it("Santa Maria — 6 byte-identical rows (the old findOne coin flip)", async () => {
    // The old exact stage used findOne() and would have returned one of these
    // arbitrarily. Prove there really are six.
    expect(await (TBOCity as any).countDocuments({ searchName: "santa maria" })).toBe(6);

    const pick = await resolve("Santa Maria");
    expect(pick.kind).toBe("MANY");
    expect((pick as any).candidates.length).toBeGreaterThan(1);
    // Back-compat helper must degrade to null, never to a guess.
    expect(await findCatalogCity("Santa Maria")).toBeNull();
  });

  it("Springfield — several real ones, and NOT the East/West rows", async () => {
    const pick = await resolve("Springfield");
    expect(pick.kind).toBe("MANY");
    const names = (pick as any).candidates.map((c: any) => c.cityName);
    expect(names.every((n: string) => !/East|West/.test(n))).toBe(true);
  });

  it("candidates carry the region that tells them apart", async () => {
    const pick = await resolve("Springfield");
    const regions = (pick as any).candidates.map((c: any) => c.region).filter(Boolean);
    expect(regions.length).toBeGreaterThan(0);
    expect(regions).toContain("Illinois");
  });

  it("the ask is capped — a list of 15 is not a question", async () => {
    const pick = await resolve("Springfield");
    expect((pick as any).candidates.length).toBeLessThanOrEqual(5);
  });
});

describe("BATCH — tie-breaks that legitimately resolve", () => {
  it("curated country narrows same-name cities to one", async () => {
    // "Santa Maria" with no curated country is ambiguous (above); with one it
    // is not — the hand-verified table is evidence, not a cosmetic sort.
    const rows = await findCatalogMatches("Santa Maria");
    const pick = await pickCatalogCity(rows, "Santa Maria", { curatedCountry: "PT" });
    expect(pick.kind).toBe("ONE");
    expect((pick as any).city.countryCode).toBe("PT");
  });

  it("inventory breaks a tie when only ONE candidate is bookable", async () => {
    const pick = await resolve("Farville");
    expect(pick.kind).toBe("ONE");
    expect((pick as any).city.code).toBe("600001"); // the one with hotels
  });
});

describe("BATCH — genuinely unsupported stays unsupported", () => {
  it.each(["Nowhereville", "Atlantis", "asdfghjkl"])("%s → no match, no invention", async (name) => {
    expect(await findCatalogMatches(name)).toHaveLength(0);
    expect(await findCatalogCity(name)).toBeNull();
  });
});
