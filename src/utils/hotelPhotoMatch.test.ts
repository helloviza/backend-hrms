// apps/backend/src/utils/hotelPhotoMatch.test.ts
//
// The gate that decides whether a Google Places photo may be shown as THIS
// property. The cases below are the real failure modes, taken from live Dubai
// data: Places always returns something, so "found a candidate" and "found the
// right building" are different questions.

import { describe, it, expect } from "vitest";
import {
  normalizeHotelName,
  distinctiveTokens,
  nameSimilarity,
  haversineMeters,
  isConfidentMatch,
} from "./hotelPhotoMatch.js";

describe("normalizeHotelName", () => {
  it("strips diacritics, punctuation and case", () => {
    expect(normalizeHotelName("Mövenpick Hotel & Apartments — Bur Dubai"))
      .toBe("movenpick hotel apartments bur dubai");
  });
});

describe("distinctiveTokens", () => {
  it("drops the words every hotel shares", () => {
    expect(distinctiveTokens("The Canvas Dubai - MGallery Hotel Collection"))
      .toEqual(["canvas", "dubai", "mgallery"]);
  });

  it("returns nothing for a name made only of generic words", () => {
    expect(distinctiveTokens("The Hotel Suites")).toEqual([]);
  });
});

describe("nameSimilarity", () => {
  it("scores TBO vs Places phrasing of the same property as a full match", () => {
    // The real pair: TBO carries a comma, Places does not.
    const m = nameSimilarity(
      "Radisson Blu Hotel, Dubai Deira Creek",
      "Radisson Blu Hotel Dubai Deira Creek",
    );
    expect(m.score).toBe(1);
  });

  it("does not let a shared chain name carry two different properties", () => {
    // Both are real, both are Radisson Blu, both are in Dubai — and they are
    // 12km apart. The name alone cannot separate them, which is exactly why
    // the coordinate check exists.
    const m = nameSimilarity(
      "Radisson Blu Hotel, Dubai Deira Creek",
      "Radisson Blu Hotel Dubai Waterfront",
    );
    expect(m.score).toBeLessThan(0.85);
  });

  it("is 0 when either side has no distinctive tokens", () => {
    expect(nameSimilarity("The Hotel", "Canal Central Hotel").score).toBe(0);
  });
});

describe("haversineMeters", () => {
  it("measures a known Dubai separation", () => {
    // Canal Central (Business Bay) → Avani Deira.
    const m = haversineMeters(25.180305, 55.266409, 25.270742, 55.33);
    expect(m).toBeGreaterThan(11000);
    expect(m).toBeLessThan(13000);
  });
});

describe("isConfidentMatch", () => {
  const canal = { tboName: "Canal Central Hotel", tboLat: 25.180305, tboLon: 55.266409 };

  it("accepts the same property at the same address", () => {
    const v = isConfidentMatch({
      ...canal,
      placeName: "Canal Central Hotel Business Bay",
      placeLat: 25.18035, placeLon: 55.26645,
    });
    expect(v.confident).toBe(true);
  });

  it("REJECTS a correctly-named result that sits somewhere else", () => {
    // The failure this whole module exists for: Places found the real Elite
    // Byblos, but the row we are decorating is 12km away in Deira. Attaching
    // the photo would caption the wrong building with this hotel's price.
    const v = isConfidentMatch({
      tboName: "Elite Byblos Hotel",
      tboLat: 25.2707, tboLon: 55.33,
      placeName: "Elite Byblos Hotel",
      placeLat: 25.113148, placeLon: 55.200905,
    });
    expect(v.confident).toBe(false);
    expect(v.reason).toBe("too_far");
  });

  it("REJECTS a nearby building with a different name", () => {
    const v = isConfidentMatch({
      ...canal,
      placeName: "Hyatt Regency Creek Heights",
      placeLat: 25.1805, placeLon: 55.2665,
    });
    expect(v.confident).toBe(false);
    expect(v.reason).toBe("name_mismatch");
  });

  it("tolerates a looser name when the coordinate confirms the address", () => {
    const v = isConfidentMatch({
      ...canal,
      placeName: "Canal Central",
      placeLat: 25.18031, placeLon: 55.26641,
    });
    expect(v.confident).toBe(true);
  });

  it("demands a near-exact name when there is no coordinate to check", () => {
    const loose = isConfidentMatch({
      tboName: "Canal Central Hotel", tboLat: null, tboLon: null,
      placeName: "Canal Suites Dubai", placeLat: null, placeLon: null,
    });
    expect(loose.confident).toBe(false);
    expect(loose.reason).toBe("name_mismatch_no_coord");

    const exact = isConfidentMatch({
      tboName: "Canal Central Hotel", tboLat: null, tboLon: null,
      placeName: "Canal Central Hotel", placeLat: null, placeLon: null,
    });
    expect(exact.confident).toBe(true);
  });

  it("needs two distinctive tokens without a coordinate, so one lucky word cannot pass", () => {
    const v = isConfidentMatch({
      tboName: "Armani Hotel", tboLat: null, tboLon: null,
      placeName: "Armani Ristorante", placeLat: null, placeLon: null,
    });
    expect(v.confident).toBe(false);
  });

  it("treats (0,0) as no coordinate rather than a place in the Atlantic", () => {
    const v = isConfidentMatch({
      tboName: "Canal Central Hotel", tboLat: 0, tboLon: 0,
      placeName: "Canal Central Hotel",
      placeLat: 25.180305, placeLon: 55.266409,
    });
    // Falls back to the strict name-only branch and passes on the name alone,
    // rather than computing a 5,000km distance and rejecting a correct match.
    expect(v.confident).toBe(true);
    expect(v.distanceM).toBeNull();
  });
});
