// Guard: every catalog code that LOOKS like a station has been classified —
// either as a non-airport (plutoNonAirports.NON_AIRPORTS) or as a reviewed
// real airport. A new bus/rail/ferry code added to data/airports.json fails
// here instead of quietly becoming a "same-city airport" (the XNB bug).
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { NON_AIRPORTS, KNOWN_AIRPORTS_WITH_SURFACE_WORDS, isAirportCode } from "./plutoNonAirports.js";

const catalog: Array<{ code: string; name?: string; city: string; cityCode: string }> = JSON.parse(
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../data/airports.json"), "utf-8"),
);

const SURFACE =
  /\b(bus|coach|rail|railway|railroad|station|stn|train|hbf|hauptbahnhof|bahnhof|gare|stazione|estaci[oó]n|centraal|heliport|helipad|ferry|ferries|seaport|harbou?r|pier|seaplane|metro|hoverport|cornavin|beach|jetty|marina|cruise)\b/i;

describe("non-airport catalog codes", () => {
  it("every surface-named catalog code is classified (non-airport or reviewed airport)", () => {
    const reviewed = new Set([...Object.keys(NON_AIRPORTS), ...KNOWN_AIRPORTS_WITH_SURFACE_WORDS]);
    const unclassified = catalog
      .filter((a) => a.name && SURFACE.test(a.name) && !reviewed.has(a.code))
      .map((a) => `${a.code} ${a.name}`);
    expect(unclassified).toEqual([]);
  });

  it("every listed non-airport exists in the catalog (no typos)", () => {
    const codes = new Set(catalog.map((a) => a.code));
    expect(Object.keys(NON_AIRPORTS).filter((c) => !codes.has(c))).toEqual([]);
  });

  it("the Dubai stations from the prod check are non-airports; Dubai's airports are not", () => {
    for (const c of ["XNB", "XHB", "ZXZ", "ZVJ"]) expect(isAirportCode(c)).toBe(false);
    for (const c of ["DXB", "DWC", "AUH", "BOM", "LHR"]) expect(isAirportCode(c)).toBe(true);
  });
});
