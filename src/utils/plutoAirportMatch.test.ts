// Pluto Hotfix A (F-02) — which airports count as "the city you asked for",
// read from the real airport catalog (data/airports.json), not a fixture.
import { describe, it, expect } from "vitest";
import {
  cityAirports,
  isSameCityAirport,
  classifyRow,
  airportAnnotation,
  airportLabel,
  partitionRowsByAirport,
} from "./plutoAirportMatch.js";

const row = (dep: string, arr: string, via?: string) => ({
  Segments: [
    via
      ? [
          { Origin: { Airport: { AirportCode: dep } }, Destination: { Airport: { AirportCode: via } } },
          { Origin: { Airport: { AirportCode: via } }, Destination: { Airport: { AirportCode: arr } } },
        ]
      : [{ Origin: { Airport: { AirportCode: dep } }, Destination: { Airport: { AirportCode: arr } } }],
  ],
});

describe("cityAirports — the catalog's city grouping", () => {
  it("Dubai: DXB and DWC (both cityCode DXB); Abu Dhabi is NOT Dubai", () => {
    const g = cityAirports("DXB");
    expect(g.has("DXB")).toBe(true);
    expect(g.has("DWC")).toBe(true);
    expect(g.has("AUH")).toBe(false);
    expect(isSameCityAirport("DWC", "DXB")).toBe(true);
  });

  it("Mumbai: BOM only — NMI is not in the catalog, so it is never 'Mumbai'", () => {
    const g = cityAirports("BOM");
    expect(g.has("BOM")).toBe(true);
    expect(g.has("NMI")).toBe(false);
    // …but searching NMI itself still matches NMI rows.
    expect(isSameCityAirport("NMI", "NMI")).toBe(true);
  });

  it("Goa: GOI and GOX share the city name in the same country (different cityCodes)", () => {
    expect(isSameCityAirport("GOI", "GOX")).toBe(true);
    expect(isSameCityAirport("GOX", "GOI")).toBe(true);
  });

  it("London: all LON airports, but not London, Ontario (same name, other country)", () => {
    expect(isSameCityAirport("LHR", "LGW")).toBe(true);
    expect(isSameCityAirport("LHR", "STN")).toBe(true);
    expect(isSameCityAirport("LHR", "YXU")).toBe(false);
  });
});

describe("classifyRow — first departure AND final arrival", () => {
  it("BLR→DXB MATCH, BLR→AUH OTHER, BLR→DWC MATCH", () => {
    expect(classifyRow(row("BLR", "DXB"), "BLR", "DXB")).toBe("MATCH");
    expect(classifyRow(row("BLR", "AUH"), "BLR", "DXB")).toBe("OTHER");
    expect(classifyRow(row("BLR", "DWC"), "BLR", "DXB")).toBe("MATCH");
  });

  it("judges the FINAL arrival, not a connection: BLR→AUH→DXB is MATCH, BLR→DXB→AUH is OTHER", () => {
    expect(classifyRow(row("BLR", "DXB", "AUH"), "BLR", "DXB")).toBe("MATCH");
    expect(classifyRow(row("BLR", "AUH", "DXB"), "BLR", "DXB")).toBe("OTHER");
  });

  it("the departure end counts too: NMI→BLR is OTHER for a BOM→BLR search", () => {
    expect(classifyRow(row("NMI", "BLR"), "BOM", "BLR")).toBe("OTHER");
  });

  it("partition keeps order inside each group", () => {
    const rows = [row("BLR", "AUH"), row("BLR", "DXB"), row("BLR", "AUH"), row("BLR", "DWC")];
    const { match, other } = partitionRowsByAirport(rows, "BLR", "DXB");
    expect(match).toEqual([rows[1], rows[3]]);
    expect(other).toEqual([rows[0], rows[2]]);
  });
});

describe("labels — real names, NMI always 'Navi Mumbai (NMI)'", () => {
  it("AUH label comes from the catalog name", () => {
    expect(airportLabel("AUH")).toBe("Abu Dhabi Int'l (AUH)");
  });

  it("NMI is 'Navi Mumbai (NMI)' whatever TBO calls it", () => {
    expect(airportLabel("NMI", "Mumbai")).toBe("Navi Mumbai (NMI)");
    const a = airportAnnotation(row("BLR", "NMI"), "BLR", "BOM");
    expect(a).toEqual({ airportMatch: "OTHER", arrivalAirportLabel: "Navi Mumbai (NMI)" });
  });

  it("NMI keeps its label even when NMI was the airport searched", () => {
    expect(airportAnnotation(row("BLR", "NMI"), "BLR", "NMI").arrivalAirportLabel).toBe("Navi Mumbai (NMI)");
  });

  it("the requested airport itself carries no label; a same-city alternate does", () => {
    expect(airportAnnotation(row("BLR", "DXB"), "BLR", "DXB")).toEqual({ airportMatch: "MATCH" });
    expect(airportAnnotation(row("BLR", "DWC"), "BLR", "DXB")).toEqual({
      airportMatch: "MATCH",
      arrivalAirportLabel: "Al Maktoum (DWC)",
    });
  });
});
