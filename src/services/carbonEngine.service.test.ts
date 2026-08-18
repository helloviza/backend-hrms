// apps/backend/src/services/carbonEngine.service.test.ts
import { describe, it, expect } from "vitest";
import {
  haversineKm,
  resolveCabin,
  resolveHaulBand,
  calculateSegment,
  DEFAULT_RF_VARIANT,
  type AirportLike,
  type FactorLike,
} from "./carbonEngine.service.js";

/**
 * These tests exercise the PURE half of the engine — the half that decides
 * whether a number exists and what it is. No database, no mocks of our own
 * code: the airports and factors below are the real published values, so an
 * assertion failing here means the arithmetic or the sourcing changed, not that
 * a stub drifted.
 *
 * Airport coordinates are exactly as seeded from OpenFlights; factor values are
 * exactly as published by DEFRA 2026 (With RF).
 */

const DEL: AirportLike = { iata: "DEL", name: "Indira Gandhi International Airport", city: "Delhi", country: "India", countryIso3: "IND", lat: 28.5665, lon: 77.103104 };
const BLR: AirportLike = { iata: "BLR", name: "Kempegowda International Airport", city: "Bangalore", country: "India", countryIso3: "IND", lat: 13.1979, lon: 77.706299 };
const LHR: AirportLike = { iata: "LHR", name: "London Heathrow Airport", city: "London", country: "United Kingdom", countryIso3: "GBR", lat: 51.4706, lon: -0.461941 };
const EDI: AirportLike = { iata: "EDI", name: "Edinburgh Airport", city: "Edinburgh", country: "United Kingdom", countryIso3: "GBR", lat: 55.95000076, lon: -3.372499943 };
const ATH: AirportLike = { iata: "ATH", name: "Eleftherios Venizelos", city: "Athens", country: "Greece", countryIso3: "GRC", lat: 37.9364013672, lon: 23.9444999695 };
const IAD: AirportLike = { iata: "IAD", name: "Washington Dulles", city: "Washington", country: "United States", countryIso3: "USA", lat: 38.94449997, lon: -77.45580292 };
/** A real airport in a territory DEFRA's haul table does not list (Bhutan). */
const PBH: AirportLike = { iata: "PBH", name: "Paro", city: "Paro", country: "Bhutan", countryIso3: null, lat: 27.403192, lon: 89.424614 };

/** The published DEFRA 2026 With-RF air factors, verbatim. */
const FACTORS: FactorLike[] = [
  { haulBand: "Domestic, to/from UK", cabin: "Average passenger", rfVariant: "With RF", value: 0.22928, unit: "kg CO2e/passenger.km", version: "DEFRA-2026-v1", sourceRef: "DEFRA 2026" },
  { haulBand: "Short-haul, to/from UK", cabin: "Average passenger", rfVariant: "With RF", value: 0.12786, unit: "kg CO2e/passenger.km", version: "DEFRA-2026-v1", sourceRef: "DEFRA 2026" },
  { haulBand: "Short-haul, to/from UK", cabin: "Economy class", rfVariant: "With RF", value: 0.12576, unit: "kg CO2e/passenger.km", version: "DEFRA-2026-v1", sourceRef: "DEFRA 2026" },
  { haulBand: "Short-haul, to/from UK", cabin: "Business class", rfVariant: "With RF", value: 0.18863, unit: "kg CO2e/passenger.km", version: "DEFRA-2026-v1", sourceRef: "DEFRA 2026" },
  { haulBand: "Long-haul, to/from UK", cabin: "Average passenger", rfVariant: "With RF", value: 0.15282, unit: "kg CO2e/passenger.km", version: "DEFRA-2026-v1", sourceRef: "DEFRA 2026" },
  { haulBand: "Long-haul, to/from UK", cabin: "Economy class", rfVariant: "With RF", value: 0.11704, unit: "kg CO2e/passenger.km", version: "DEFRA-2026-v1", sourceRef: "DEFRA 2026" },
  { haulBand: "Long-haul, to/from UK", cabin: "First class", rfVariant: "With RF", value: 0.46814, unit: "kg CO2e/passenger.km", version: "DEFRA-2026-v1", sourceRef: "DEFRA 2026" },
  { haulBand: "International, to/from non-UK", cabin: "Average passenger", rfVariant: "With RF", value: 0.14253, unit: "kg CO2e/passenger.km", version: "DEFRA-2026-v1", sourceRef: "DEFRA 2026" },
  { haulBand: "International, to/from non-UK", cabin: "Economy class", rfVariant: "With RF", value: 0.10916, unit: "kg CO2e/passenger.km", version: "DEFRA-2026-v1", sourceRef: "DEFRA 2026" },
  { haulBand: "International, to/from non-UK", cabin: "Business class", rfVariant: "With RF", value: 0.31656, unit: "kg CO2e/passenger.km", version: "DEFRA-2026-v1", sourceRef: "DEFRA 2026" },
];

const seg = (over: Partial<Parameters<typeof calculateSegment>[0]>) =>
  calculateSegment({
    originCode: "DEL",
    destinationCode: "BLR",
    origin: DEL,
    destination: BLR,
    cabinInput: "Economy",
    factors: FACTORS,
    ...over,
  });

describe("haversineKm", () => {
  it("matches the published great-circle distance for DEL-BLR", () => {
    // Independently known: Delhi to Bangalore is a little over 1,700 km.
    expect(haversineKm(DEL, BLR)).toBeGreaterThan(1700);
    expect(haversineKm(DEL, BLR)).toBeLessThan(1760);
  });

  it("is symmetric", () => {
    expect(haversineKm(DEL, LHR)).toBeCloseTo(haversineKm(LHR, DEL), 9);
  });

  it("is zero for a point against itself", () => {
    expect(haversineKm(DEL, DEL)).toBe(0);
  });

  it("handles an antimeridian-free long haul (LHR-IAD ~5,900 km)", () => {
    expect(haversineKm(LHR, IAD)).toBeGreaterThan(5800);
    expect(haversineKm(LHR, IAD)).toBeLessThan(6000);
  });
});

describe("resolveCabin — only what the document names", () => {
  it("reads a plain cabin name", () => {
    expect(resolveCabin("Economy")).toBe("Economy class");
    expect(resolveCabin("Business")).toBe("Business class");
    expect(resolveCabin("First")).toBe("First class");
  });

  it("reads a cabin followed by a fare code, which is the common live shape", () => {
    expect(resolveCabin("Economy, Class L")).toBe("Economy class");
    expect(resolveCabin("Economy, Class FL")).toBe("Economy class");
    expect(resolveCabin("Economy, Class ER")).toBe("Economy class");
  });

  it("prefers premium economy over economy", () => {
    expect(resolveCabin("Premium Economy")).toBe("Premium economy class");
    expect(resolveCabin("premium-economy")).toBe("Premium economy class");
  });

  it("does NOT infer a cabin from a bare fare/RBD code", () => {
    // These are all real values from the live corpus. Guessing here would be
    // the exact 'invented number' this engine must not produce.
    for (const code of ["PR", "QR", "RR", "MR", "FL", "GT", "ER", "E", "S", "G"]) {
      expect(resolveCabin(code)).toBeNull();
    }
  });

  it("treats blank and null as not stated", () => {
    expect(resolveCabin(null)).toBeNull();
    expect(resolveCabin("")).toBeNull();
    expect(resolveCabin("   ")).toBeNull();
  });

  it("does not read 'Class F' as First class", () => {
    expect(resolveCabin("Economy, Class F")).toBe("Economy class");
  });
});

describe("resolveHaulBand — looked up from DEFRA's country table, never computed", () => {
  it("both ends in the UK is Domestic", () => {
    expect(resolveHaulBand(LHR, EDI)).toBe("Domestic, to/from UK");
  });

  it("UK to a Short Haul country", () => {
    expect(resolveHaulBand(LHR, ATH)).toBe("Short-haul, to/from UK");
    expect(resolveHaulBand(ATH, LHR)).toBe("Short-haul, to/from UK");
  });

  it("UK to a Long Haul country", () => {
    expect(resolveHaulBand(LHR, DEL)).toBe("Long-haul, to/from UK");
    expect(resolveHaulBand(DEL, LHR)).toBe("Long-haul, to/from UK");
  });

  it("neither end in the UK is International, to/from non-UK — including a non-UK domestic sector", () => {
    expect(resolveHaulBand(DEL, BLR)).toBe("International, to/from non-UK");
    expect(resolveHaulBand(ATH, IAD)).toBe("International, to/from non-UK");
  });

  it("returns null only when a UK-touching flight's other country is not in DEFRA's table", () => {
    expect(resolveHaulBand(LHR, PBH)).toBeNull();
    // ...and never for a flight that does not touch the UK at all.
    expect(resolveHaulBand(DEL, PBH)).toBe("International, to/from non-UK");
  });
});

describe("calculateSegment — the number and its provenance", () => {
  it("computes CO2e as distance x factor x pax and shows the arithmetic", () => {
    const r = seg({});
    const distance = haversineKm(DEL, BLR);
    const factor = 0.10916; // International non-UK, Economy, With RF

    expect(r.status).toBe("calculated");
    expect(r.confidence).toBe("high");
    expect(r.haulBand).toBe("International, to/from non-UK");
    expect(r.resolvedCabin).toBe("Economy class");
    expect(r.cabinResolution).toBe("stated");
    expect(r.distanceKm).toBeCloseTo(Number(distance.toFixed(1)), 5);
    expect(r.factor?.value).toBe(factor);
    expect(r.co2eKg).toBeCloseTo(Number((distance * factor).toFixed(2)), 2);
    expect(r.pax).toBe(1);

    // The methodology must carry the formula, both airports, the factor and its source.
    expect(r.methodology).toContain("CO2e =");
    expect(r.methodology).toContain(String(factor));
    expect(r.methodology).toContain("DEL");
    expect(r.methodology).toContain("BLR");
    expect(r.methodology).toContain("International, to/from non-UK");
    expect(r.methodology).toContain("Economy class");
    expect(r.methodology).toContain("no routing uplift applied");
  });

  it("emits NO number when the origin does not resolve", () => {
    const r = seg({ origin: null, originCode: "NMI" });
    expect(r.status).toBe("insufficient_data");
    expect(r.confidence).toBe("insufficient");
    expect(r.co2eKg).toBeNull();
    expect(r.distanceKm).toBeNull();
    expect(r.factor).toBeNull();
    expect(r.methodology).toContain("NMI");
    expect(r.methodology).toContain("could not be resolved");
  });

  it("emits NO number when the destination does not resolve", () => {
    const r = seg({ destination: null, destinationCode: "DXN" });
    expect(r.status).toBe("insufficient_data");
    expect(r.co2eKg).toBeNull();
    expect(r.methodology).toContain("DXN");
  });

  it("emits NO number when neither end resolves, naming both", () => {
    const r = seg({ origin: null, originCode: "GGN", destination: null, destinationCode: "JP" });
    expect(r.status).toBe("insufficient_data");
    expect(r.co2eKg).toBeNull();
    expect(r.methodology).toContain("GGN");
    expect(r.methodology).toContain("JP");
  });

  it("never reports zero in place of an unknown — the field is null", () => {
    const r = seg({ origin: null, originCode: "NMI" });
    expect(r.co2eKg).not.toBe(0);
    expect(r.co2eKg).toBeNull();
  });

  it("degrades to Medium on a bare fare code and prices with Average passenger", () => {
    const r = seg({ cabinInput: "PR" });
    expect(r.status).toBe("calculated");
    expect(r.confidence).toBe("medium");
    expect(r.resolvedCabin).toBe("Average passenger");
    expect(r.cabinResolution).toBe("not_stated");
    expect(r.factor?.value).toBe(0.14253);
    expect(r.notes).toContain("fare/booking code");
  });

  it("degrades to Medium when no class is on the document at all", () => {
    const r = seg({ cabinInput: null });
    expect(r.confidence).toBe("medium");
    expect(r.cabinResolution).toBe("not_stated");
    expect(r.resolvedCabin).toBe("Average passenger");
  });

  it("degrades to Medium when DEFRA publishes no factor for a stated cabin in that band", () => {
    // There is no UK-domestic business-class factor in the published set.
    const r = seg({
      originCode: "LHR", destinationCode: "EDI", origin: LHR, destination: EDI,
      cabinInput: "Business",
    });
    expect(r.status).toBe("calculated");
    expect(r.confidence).toBe("medium");
    expect(r.haulBand).toBe("Domestic, to/from UK");
    expect(r.cabinResolution).toBe("no_published_factor_for_cabin");
    expect(r.resolvedCabin).toBe("Average passenger");
    expect(r.factor?.value).toBe(0.22928);
    expect(r.notes).toContain("publishes no Business class factor");
  });

  it("keeps High when the stated cabin does have a published factor for the band", () => {
    const r = seg({
      originCode: "LHR", destinationCode: "ATH", origin: LHR, destination: ATH,
      cabinInput: "Business",
    });
    expect(r.confidence).toBe("high");
    expect(r.haulBand).toBe("Short-haul, to/from UK");
    expect(r.factor?.value).toBe(0.18863);
  });

  it("emits no number when a UK-touching flight's other country is off DEFRA's table", () => {
    const r = seg({ originCode: "LHR", destinationCode: "PBH", origin: LHR, destination: PBH });
    expect(r.status).toBe("insufficient_data");
    expect(r.co2eKg).toBeNull();
    // Distance IS known here, and is reported; only the factor is missing.
    expect(r.distanceKm).toBeGreaterThan(0);
    expect(r.methodology).toContain("haul-definition table");
  });

  it("emits no number when the factor library has no row for the band", () => {
    const r = seg({ factors: [] });
    expect(r.status).toBe("insufficient_data");
    expect(r.co2eKg).toBeNull();
    expect(r.methodology).toContain("no active emission factor");
  });

  it("prices a long-haul first-class segment at the published first-class rate", () => {
    const r = seg({
      originCode: "LHR", destinationCode: "DEL", origin: LHR, destination: DEL,
      cabinInput: "First",
    });
    expect(r.confidence).toBe("high");
    expect(r.haulBand).toBe("Long-haul, to/from UK");
    expect(r.factor?.value).toBe(0.46814);
    expect(r.co2eKg).toBeCloseTo(Number((haversineKm(LHR, DEL) * 0.46814).toFixed(2)), 2);
  });

  it("defaults to the With RF variant", () => {
    expect(DEFAULT_RF_VARIANT).toBe("With RF");
    expect(seg({}).factor?.rfVariant).toBe("With RF");
  });
});
