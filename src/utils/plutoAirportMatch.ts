// apps/backend/src/utils/plutoAirportMatch.ts
//
// Does a flight row actually serve the airports the traveller asked for?
//
// TBO answers a DXB search with rows that land in Abu Dhabi (AUH), and a BOM
// search with rows that land in Navi Mumbai (NMI). Before this module, those
// rows were tiered as if they were the answer — "Best" and "Fastest" for Dubai
// both landed in another emirate (QC 2026-11-09, F-02).
//
// A row is MATCH when its FIRST departure airport is in the requested origin's
// city group AND its FINAL arrival airport is in the requested destination's
// city group. Anything else is OTHER. The city group comes from the airport
// catalog (data/airports.json) — never from guesswork:
//   - every airport sharing the requested airport's catalog cityCode
//     (DXB + DWC are both cityCode DXB; LHR/LGW/STN… are all LON), plus
//   - every airport with the same catalog city name in the same country
//     (GOI and GOX are both "Goa", IN, under different cityCodes).
// An airport the catalog doesn't know (NMI isn't in it) is only ever its own
// group, so it is OTHER unless it was the airport requested.
//
// Distance to the requested airport is NOT computed: the catalog carries no
// coordinates, and an invented distance would be worse than none.

import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { isAirportCode, nonAirportKind } from "./plutoNonAirports.js";

export type AirportMatch = "MATCH" | "OTHER";

interface CatalogAirport {
  code: string;
  name?: string;
  city?: string;
  cityCode?: string;
  countryCode?: string;
}

/**
 * Display names that must never come from anywhere else. NMI is missing from
 * the catalog and TBO may call it "Mumbai" — which is exactly the confusion
 * the label exists to prevent.
 */
const NAME_OVERRIDES: Record<string, string> = {
  NMI: "Navi Mumbai",
};

let byCode: Map<string, CatalogAirport> | null = null;

function catalog(): Map<string, CatalogAirport> {
  if (byCode) return byCode;
  byCode = new Map();
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../data/airports.json");
    for (const a of JSON.parse(readFileSync(file, "utf-8")) as CatalogAirport[]) {
      if (a?.code) byCode.set(String(a.code).toUpperCase(), a);
    }
  } catch (err: any) {
    console.warn("[plutoAirportMatch] airports.json not readable", { err: err?.message });
  }
  return byCode;
}

const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase();

const groupCache = new Map<string, Set<string>>();

/** Every airport code the catalog puts in the same city as `iata` (always includes `iata`). */
export function cityAirports(iata: string): Set<string> {
  const code = String(iata || "").trim().toUpperCase();
  const cached = groupCache.get(code);
  if (cached) return cached;
  const out = new Set<string>(code ? [code] : []);
  const self = catalog().get(code);
  if (self) {
    const cityCode = String(self.cityCode || "").toUpperCase();
    const cityName = norm(self.city);
    const country = String(self.countryCode || "").toUpperCase();
    for (const a of catalog().values()) {
      // Real airports only: XNB "Dubai Bus Station" shares cityCode DXB, but
      // a coach into it is not a flight into Dubai (plutoNonAirports.ts).
      if (!isAirportCode(a.code)) continue;
      const sameCityCode = cityCode && String(a.cityCode || "").toUpperCase() === cityCode;
      const sameNamedCity =
        cityName && norm(a.city) === cityName && String(a.countryCode || "").toUpperCase() === country;
      if (sameCityCode || sameNamedCity) out.add(String(a.code).toUpperCase());
    }
  }
  groupCache.set(code, out);
  return out;
}

/** Same city per the catalog (symmetric for anything the catalog knows). */
export function isSameCityAirport(requested: string, actual: string): boolean {
  const a = String(actual || "").trim().toUpperCase();
  if (!a) return false;
  return cityAirports(requested).has(a);
}

/**
 * "Abu Dhabi Int'l", "Navi Mumbai". Override → catalog airport name → the name
 * TBO sent → the code itself. Never invented.
 */
export function airportDisplayName(iata: string, tboAirportName?: string | null): string {
  const code = String(iata || "").trim().toUpperCase();
  if (NAME_OVERRIDES[code]) return NAME_OVERRIDES[code];
  const cat = catalog().get(code);
  const name = String(cat?.name || "").trim() || String(tboAirportName || "").trim();
  return name || code;
}

/** "Navi Mumbai (NMI)". */
export function airportLabel(iata: string, tboAirportName?: string | null): string {
  const code = String(iata || "").trim().toUpperCase();
  return `${airportDisplayName(code, tboAirportName)} (${code})`;
}

export interface RowAirports {
  depCode: string;
  arrCode: string;
  depName: string;
  arrName: string;
  /**
   * The real airport the row takes off from / lands at. Differs from
   * depCode / arrCode only when the row starts or ends with a surface leg
   * (a coach, train or ferry to or from a non-airport code): e.g. EY-239
   * BLR → AUH + coach to XNB lands at AUH.
   */
  takeoffCode: string;
  takeoffName: string;
  landingCode: string;
  landingName: string;
}

const segCode = (p: any): string => String(p?.Airport?.AirportCode || "").toUpperCase();
const segName = (p: any): string => String(p?.Airport?.AirportName || "");

/** First departure and FINAL arrival of a raw TBO row (Segments[0]), plus the real take-off / landing airports. */
export function rowAirports(raw: any): RowAirports {
  const segs: any[] = raw?.Segments?.[0] || [];
  const first = segs[0];
  const last = segs[segs.length - 1];
  // Walk in from each end past any segment that touches a non-airport code.
  let landing = last?.Destination;
  for (let i = segs.length - 1; i >= 0; i--) {
    const d = segs[i]?.Destination;
    if (isAirportCode(segCode(d))) { landing = d; break; }
    landing = segs[i]?.Origin; // a surface final leg starts at the landing airport
  }
  let takeoff = first?.Origin;
  for (let i = 0; i < segs.length; i++) {
    const o = segs[i]?.Origin;
    if (isAirportCode(segCode(o))) { takeoff = o; break; }
    takeoff = segs[i]?.Destination;
  }
  return {
    depCode: segCode(first?.Origin),
    arrCode: segCode(last?.Destination),
    depName: segName(first?.Origin),
    arrName: segName(last?.Destination),
    takeoffCode: segCode(takeoff),
    takeoffName: segName(takeoff),
    landingCode: segCode(landing),
    landingName: segName(landing),
  };
}

/**
 * MATCH / OTHER for one raw row against the leg it was searched for. A row
 * with no airport codes at all can't be checked, so it is trusted as MATCH
 * rather than hidden (TBO always sends codes; this only guards fixtures).
 * A row that starts or ends at a NON-airport (a coach / train / ferry leg) is
 * always OTHER, whatever city the catalog files that station under.
 */
export function classifyRow(raw: any, legOrigin: string, legDest: string): AirportMatch {
  const { depCode, arrCode } = rowAirports(raw);
  const depOk = !depCode || (isAirportCode(depCode) && isSameCityAirport(legOrigin, depCode));
  const arrOk = !arrCode || (isAirportCode(arrCode) && isSameCityAirport(legDest, arrCode));
  return depOk && arrOk ? "MATCH" : "OTHER";
}

/**
 * The additive fields a mapped row carries about its airports:
 *  - airportMatch: always.
 *  - arrivalAirportLabel: when the row lands somewhere other than the requested
 *    airport (OTHER rows, and a same-city alternate like DWC), and ALWAYS for
 *    an airport with a name override (NMI is "Navi Mumbai (NMI)" on every card).
 *  - departureAirportLabel: same rule for the first departure.
 * A surface leg is named after the real airport, e.g. the card reads
 * "Arrives Abu Dhabi Int'l (AUH) · coach to Dubai Bus Station (XNB)" and
 * "Departs Abu Dhabi Int'l (AUH) · after coach from Dubai Bus Station (XNB)".
 */
export function airportAnnotation(
  raw: any,
  legOrigin: string,
  legDest: string,
): { airportMatch: AirportMatch; arrivalAirportLabel?: string; departureAirportLabel?: string } {
  const match = classifyRow(raw, legOrigin, legDest);
  const r = rowAirports(raw);
  const out: { airportMatch: AirportMatch; arrivalAirportLabel?: string; departureAirportLabel?: string } = {
    airportMatch: match,
  };
  const wantsLabel = (actual: string, requested: string) =>
    Boolean(actual) && (actual !== String(requested || "").toUpperCase() || Boolean(NAME_OVERRIDES[actual]));

  const arrKind = nonAirportKind(r.arrCode);
  if (arrKind && r.landingCode && r.landingCode !== r.arrCode) {
    out.arrivalAirportLabel =
      `${airportLabel(r.landingCode, r.landingName)} · ${arrKind} to ${airportLabel(r.arrCode, r.arrName)}`;
  } else if (wantsLabel(r.arrCode, legDest)) {
    out.arrivalAirportLabel = airportLabel(r.arrCode, r.arrName);
  }

  const depKind = nonAirportKind(r.depCode);
  if (depKind && r.takeoffCode && r.takeoffCode !== r.depCode) {
    out.departureAirportLabel =
      `${airportLabel(r.takeoffCode, r.takeoffName)} · after ${depKind} from ${airportLabel(r.depCode, r.depName)}`;
  } else if (wantsLabel(r.depCode, legOrigin)) {
    out.departureAirportLabel = airportLabel(r.depCode, r.depName);
  }
  return out;
}

/** Split raw rows into the ones that serve the requested airports and the rest, order preserved. */
export function partitionRowsByAirport(
  rows: any[],
  legOrigin: string,
  legDest: string,
): { match: any[]; other: any[] } {
  const match: any[] = [];
  const other: any[] = [];
  for (const r of rows || []) {
    (classifyRow(r, legOrigin, legDest) === "MATCH" ? match : other).push(r);
  }
  return { match, other };
}
