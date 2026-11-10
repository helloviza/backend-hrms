// resolveHotelDestination with the REAL resolution ladder and a stubbed
// catalogue (the TBO city / country / hotel-master collections). Covers the
// v2 strict mode (QC F-24) and proves the default (v1) path is unchanged.
import { describe, it, expect, vi, beforeAll } from "vitest";

const CITIES = [
  { code: "126632", name: "London", countryCode: "GB", searchName: "london" },
  { code: "115936", name: "Dubai", countryCode: "AE", searchName: "dubai" },
  { code: "120806", name: "Goa", countryCode: "IN", searchName: "goa" },
];
const COUNTRIES = [{ code: "QA", name: "Qatar", searchName: "qatar" }];

function chain(rows: any[]) {
  const q: any = { select: () => q, limit: () => q, lean: () => Promise.resolve(rows) };
  return q;
}

vi.mock("../jobs/static-data-refresh.js", () => {
  const normalizeSearch = (s: string) =>
    String(s ?? "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
  return {
    normalizeSearch,
    TBOCity: {
      find: (q: any) => {
        if (q.$text) return chain([]);
        if (typeof q.searchName === "string") return chain(CITIES.filter((c) => c.searchName === q.searchName));
        const { $gte, $lt } = q.searchName;
        return chain(CITIES.filter((c) => c.searchName >= $gte && c.searchName < $lt));
      },
    },
    TBOCountry: {
      findOne: (q: any) => {
        const row = COUNTRIES.find((c) => c.searchName === q.searchName) || null;
        const r: any = { select: () => r, lean: () => Promise.resolve(row) };
        return r;
      },
    },
    TBOHotelMaster: { aggregate: async () => [] },
  };
});
vi.mock("./plutoCityNormalize.js", () => ({
  normalizeCityNameWithLLM: vi.fn(async (s: string) => (/londn/i.test(s) ? "London" : null)),
}));

import mongoose from "mongoose";
import { resolveHotelDestination } from "./plutoHotelDestination.js";

beforeAll(() => {
  Object.defineProperty(mongoose.connection, "readyState", { get: () => 1, configurable: true });
});

const DUBAI_LOCK = { destination: { name: "Dubai", source: "user" } };

describe("resolveHotelDestination — strict (PLUTO_STATE_V2, QC F-24)", () => {
  it("v1 (default) reproduces the bug: an unresolved named place falls back to the locked Dubai", async () => {
    expect(await resolveHotelDestination("Executive stay in London Soho", DUBAI_LOCK)).toMatchObject({
      status: "RESOLVED",
      cityName: "Dubai",
    });
  });

  it("strict: never the locked city — UNSUPPORTED, named, with the closest city and the rest", async () => {
    expect(await resolveHotelDestination("Executive stay in London Soho", DUBAI_LOCK, { strictNamed: true })).toEqual({
      status: "UNSUPPORTED",
      cityName: "London Soho",
      named: true,
      suggestion: { cityName: "London", countryCode: "GB", cityCode: "126632", rest: "Soho" },
    });
  });

  it("strict: a misspelling is only SUGGESTED (the LLM rename is never searched silently)", async () => {
    expect(await resolveHotelDestination("hotels in Londn", DUBAI_LOCK, { strictNamed: true })).toEqual({
      status: "UNSUPPORTED",
      cityName: "Londn",
      named: true,
      suggestion: { cityName: "London", countryCode: "GB", cityCode: "126632" },
    });
    // v1 resolved it silently (unchanged).
    expect(await resolveHotelDestination("hotels in Londn", {})).toMatchObject({ status: "RESOLVED", cityName: "London" });
  });

  it("strict: no close match → UNSUPPORTED, named, no suggestion (the route asks which city)", async () => {
    expect(await resolveHotelDestination("hotels in Wakanda", DUBAI_LOCK, { strictNamed: true })).toEqual({
      status: "UNSUPPORTED",
      cityName: "Wakanda",
      named: true,
    });
  });

  it("strict: a LANDMARK ('near Burj Khalifa') still means the locked city", async () => {
    expect(await resolveHotelDestination("hotels near Burj Khalifa for 3 nights", DUBAI_LOCK, { strictNamed: true })).toMatchObject({
      status: "RESOLVED",
      cityName: "Dubai",
    });
  });

  it("strict: a resolvable named city resolves as before", async () => {
    expect(await resolveHotelDestination("hotels in London", DUBAI_LOCK, { strictNamed: true })).toMatchObject({
      status: "RESOLVED",
      cityName: "London",
    });
  });

  it("strict: nothing named → the locked city, and a model-written 'Goa, India' lock resolves as Goa (F-07c)", async () => {
    expect(await resolveHotelDestination("ok show hotels for this, 12 to 14 dec", { destination: { name: "Goa, India" } }, { strictNamed: true }))
      .toMatchObject({ status: "RESOLVED", cityName: "Goa", cityCode: "120806" });
  });

  it("strict: a COUNTRY is not intercepted (today's country handling)", async () => {
    const r = await resolveHotelDestination("hotels in Qatar", DUBAI_LOCK, { strictNamed: true });
    expect(r.status).toBe("UNSUPPORTED");
    expect((r as any).named).toBeUndefined();
  });
});
