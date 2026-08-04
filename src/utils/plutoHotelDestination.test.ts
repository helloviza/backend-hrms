import { describe, it, expect } from "vitest";
import { classifyHotelDestination, tidyCatalogCityName } from "./plutoHotelDestination.js";
import { extractNamedPlaceCandidate, extractHotelCity } from "./plutoHotelSearch.js";

/**
 * The three-way split. Before this, "the user named somewhere we can't serve"
 * and "the user named nothing" were the same null, so an unresolvable city fell
 * to the model and came back as a question about dates that were ALREADY in
 * context — a dead end no answer could clear.
 *
 * classifyHotelDestination is pure, so every case below is asserted without a
 * database. The lookups it consumes are exercised live.
 */

const DUBAI = {
  tableCity: "Dubai",
  named: { raw: "Dubai", capitalised: true },
  catalog: null,
  tableCountry: "AE",
  tableCityCode: "115936",
  lockedName: null,
};

describe("extractNamedPlaceCandidate — what did the user actually name?", () => {
  it("finds a LOWER-CASE city the city extractor cannot see", () => {
    // The live failure. extractHotelCity requires a capital as a proper-noun
    // heuristic, so "london" produced nothing at all and the turn fell to the AI.
    const p = "show me some hotels in london for same duration";
    expect(extractHotelCity(p)).toBeNull();
    expect(extractNamedPlaceCandidate(p)).toEqual({ raw: "london", capitalised: false });
  });

  it("trims trailing filler rather than swallowing it into the name", () => {
    expect(extractNamedPlaceCandidate("hotels in london for same duration")?.raw).toBe("london");
    expect(extractNamedPlaceCandidate("hotels in Tokyo for two nights")?.raw).toBe("Tokyo");
  });

  it("does NOT invent a place out of filler", () => {
    for (const p of [
      "hotels for same duration",
      "hotels for two nights",
      "show me hotels",
      "somewhere refundable please",
      "hotels for the best rates",
    ]) {
      expect(extractNamedPlaceCandidate(p)).toBeNull();
    }
  });

  it("reports capitalisation, which decides unsupported vs no-city", () => {
    expect(extractNamedPlaceCandidate("hotels in Bangkok")?.capitalised).toBe(true);
    expect(extractNamedPlaceCandidate("hotels in bangkok")?.capitalised).toBe(false);
  });
});

describe("tidyCatalogCityName — catalog names are not display copy", () => {
  it("collapses TBO's duplicated, padded names", () => {
    // Real row: the reply would otherwise read "Hotels in Bangkok,   Bangkok".
    expect(tidyCatalogCityName("Bangkok,   Bangkok")).toBe("Bangkok");
    expect(tidyCatalogCityName("London")).toBe("London");
    expect(tidyCatalogCityName("New  York,  NY")).toBe("New York");
  });

  it("never returns empty for a non-empty input", () => {
    expect(tidyCatalogCityName(",")).toBe(",");
  });
});

describe("classifyHotelDestination", () => {
  it("(a) curated table + code → RESOLVED (the Dubai path, unchanged)", () => {
    expect(classifyHotelDestination(DUBAI)).toEqual({
      status: "RESOLVED", cityName: "Dubai", countryCode: "AE", cityCode: "115936",
    });
  });

  it("(a2) catalog hit → RESOLVED — London is servable, so we must not decline it", () => {
    expect(
      classifyHotelDestination({
        tableCity: null,
        named: { raw: "london", capitalised: false },
        catalog: { code: "126632", name: "London", countryCode: "GB" },
        tableCountry: null,
        tableCityCode: null,
        lockedName: null,
      }),
    ).toEqual({ status: "RESOLVED", cityName: "London", countryCode: "GB", cityCode: "126632" });
  });

  it("(b) named, in NEITHER source → UNSUPPORTED, echoing what they typed", () => {
    expect(
      classifyHotelDestination({
        tableCity: null,
        named: { raw: "Bangkok", capitalised: true },
        catalog: null,
        tableCountry: null,
        tableCityCode: null,
        lockedName: null,
      }),
    ).toEqual({ status: "UNSUPPORTED", cityName: "Bangkok" });
  });

  it("(b) fires even with a locked destination available — no silent substitution", () => {
    // The dangerous case: a prior Dubai turn locked "Dubai". Answering a
    // Bangkok request with Dubai hotels would be worse than declining.
    expect(
      classifyHotelDestination({
        tableCity: null,
        named: { raw: "Bangkok", capitalised: true },
        catalog: null,
        tableCountry: null,
        tableCityCode: null,
        lockedName: "Dubai",
      }),
    ).toEqual({ status: "UNSUPPORTED", cityName: "Bangkok" });
  });

  it("(c) nothing named → NO_CITY, so the ordinary 'which city?' still happens", () => {
    expect(
      classifyHotelDestination({
        tableCity: null, named: null, catalog: null,
        tableCountry: null, tableCityCode: null, lockedName: null,
      }),
    ).toEqual({ status: "NO_CITY" });
  });

  it("(c) an unknown LOWER-CASE word is not called a city", () => {
    // Too weak a signal to name back at the user as an unsupported destination.
    expect(
      classifyHotelDestination({
        tableCity: null,
        named: { raw: "somewhere warm", capitalised: false },
        catalog: null,
        tableCountry: null, tableCityCode: null, lockedName: null,
      }),
    ).toEqual({ status: "NO_CITY" });
  });

  it("a curated city whose CODE will not resolve is UNSUPPORTED, not a search", () => {
    expect(
      classifyHotelDestination({
        tableCity: "Alibaug",
        named: { raw: "Alibaug", capitalised: true },
        catalog: null,
        tableCountry: "IN",
        tableCityCode: null,
        lockedName: null,
      }),
    ).toEqual({ status: "UNSUPPORTED", cityName: "Alibaug" });
  });

  it("falls back to a locked destination only when nothing was named", () => {
    expect(
      classifyHotelDestination({
        tableCity: null, named: null, catalog: null,
        tableCountry: null, tableCityCode: null, lockedName: "Dubai",
      }),
    ).toEqual({ status: "UNSUPPORTED", cityName: "Dubai" });
  });
});

describe("the reported turns, end to end through the pure layer", () => {
  const run = (prompt: string, catalog: any, lockedName: string | null = null) => {
    const tableCity = extractHotelCity(prompt);
    return classifyHotelDestination({
      tableCity,
      named: extractNamedPlaceCandidate(prompt),
      catalog,
      tableCountry: tableCity === "Dubai" ? "AE" : null,
      tableCityCode: tableCity === "Dubai" ? "115936" : null,
      lockedName,
    });
  };

  it("'show me some hotels in london for same duration' → RESOLVED, not a date question", () => {
    const r = run("show me some hotels in london for same duration",
      { code: "126632", name: "London", countryCode: "GB" }, "Dubai");
    expect(r).toEqual({ status: "RESOLVED", cityName: "London", countryCode: "GB", cityCode: "126632" });
    // Critically NOT the locked Dubai.
    expect((r as any).cityName).not.toBe("Dubai");
  });

  it("'hotels in Tokyo 25-26 Sept' → RESOLVED via catalog", () => {
    expect(run("hotels in Tokyo 25-26 Sept", { code: "148251", name: "Tokyo", countryCode: "JP" }))
      .toEqual({ status: "RESOLVED", cityName: "Tokyo", countryCode: "JP", cityCode: "148251" });
  });

  it("'hotels in Bangkok 25-26 Sept' → UNSUPPORTED (absent from both sources)", () => {
    expect(run("hotels in Bangkok 25-26 Sept", null))
      .toEqual({ status: "UNSUPPORTED", cityName: "Bangkok" });
  });

  it("'Hotel Options for Dubai Stay on 25-26 September 2026' → RESOLVED (no regress)", () => {
    expect(run("Hotel Options for Dubai Stay on 25-26 September 2026", null))
      .toEqual({ status: "RESOLVED", cityName: "Dubai", countryCode: "AE", cityCode: "115936" });
  });

  it("'hotels' with no city → NO_CITY (unchanged ask)", () => {
    expect(run("show me hotels", null)).toEqual({ status: "NO_CITY" });
  });
});
