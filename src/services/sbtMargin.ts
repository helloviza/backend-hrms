// The one place an SBT margin is decided.
//
//   resolveMargin(workspaceId, product, international)
//     master switch off            → 0 (source OFF) — overrides ignored too
//     company override, still valid → its value for that product / region
//                                     (a value left unset → the default)
//     otherwise / no workspace     → the default (never 0 by accident)
//
// Every pricing path (flight search, calendar, FareQuote, multi-city, PriceRBD,
// reissue, concierge; hotel search, rooms, PreBook) gets its percent here, and
// domestic vs international comes from the server's airport / hotel / city
// data — never from the browser. Both ends in India = domestic; an airport or
// hotel whose country we cannot tell prices as international.
//
// The percent used is recorded on the quote (marginRecord) and carried to the
// payment row and the booking, so reports and invoices read the margin that
// actually priced the sale.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import mongoose from "mongoose";
import SBTMarginOverride from "../models/SBTMarginOverride.js";
import { TBOHotelMaster, TBOCity } from "../jobs/static-data-refresh.js";
import { getMarginConfig, MARGIN_CACHE_TTL_MS, MARGIN_MAX_PCT, MARGIN_MIN_PCT } from "../utils/margin.js";
import { sbtLogger } from "../utils/logger.js";

type AnyObj = Record<string, any>;

export type MarginProduct = "flight" | "hotel";

export interface MarginDecision {
  pct: number;
  source: "DEFAULT" | "OVERRIDE" | "OFF";
  overrideId: string | null;
  defaultsVersion: number;
  international: boolean;
}

/** What a quote / payment row / booking stores about the margin that priced it. */
export interface MarginRecord {
  marginPct: number;
  marginSource: MarginDecision["source"];
  marginOverrideId: string | null;
  marginVersion: number;
  isInternational: boolean;
  /** Selling − the net the percent was applied to (negative when below net). */
  marginAmount: number;
}

/** The two flight percents for a workspace, picked per result by its route. */
export interface RouteMargins {
  domestic: number;
  international: number;
}

const clampPct = (n: number) => Math.min(MARGIN_MAX_PCT, Math.max(MARGIN_MIN_PCT, n));
const round2 = (n: number) => Math.round(n * 100) / 100;

/* ───────────────────────── overrides cache ───────────────────────── */

let overrideCache: Map<string, AnyObj> | null = null;
let overrideCacheTime = 0;

export function invalidateOverrideCache() {
  overrideCache = null;
  overrideCacheTime = 0;
}

/** All override rows by workspace id — a small set, cached like the defaults. */
async function overrides(): Promise<Map<string, AnyObj>> {
  const now = Date.now();
  if (overrideCache && now - overrideCacheTime < MARGIN_CACHE_TTL_MS) return overrideCache;
  // No database connection: price on the defaults rather than wait on a query.
  if (mongoose.connection.readyState !== 1) return new Map();
  try {
    const rows = (await SBTMarginOverride.find({}).lean()) as AnyObj[];
    overrideCache = new Map(rows.map((r) => [String(r.workspaceId), r]));
    overrideCacheTime = now;
    return overrideCache;
  } catch (err: any) {
    sbtLogger.warn("[sbt-margin] overrides not readable — defaults apply", { err: err?.message });
    return overrideCache ?? new Map();
  }
}

/** The override row for a workspace if it applies at `at` (not past validUntil). */
export function liveOverride(row: AnyObj | null | undefined, at: Date = new Date()): AnyObj | null {
  if (!row) return null;
  if (row.validUntil && new Date(row.validUntil).getTime() <= at.getTime()) return null;
  return row;
}

/* ───────────────────────── the resolver ───────────────────────── */

export async function resolveMargin(
  workspaceId: unknown,
  product: MarginProduct,
  international: boolean,
  at: Date = new Date(),
): Promise<MarginDecision> {
  const cfg = await getMarginConfig();
  const defaultsVersion = Number(cfg?.version) || 0;
  if (!cfg?.enabled) {
    return { pct: 0, source: "OFF", overrideId: null, defaultsVersion, international };
  }
  const region = international ? "international" : "domestic";
  const ws = workspaceId != null ? String(workspaceId) : "";
  const row = ws ? liveOverride((await overrides()).get(ws), at) : null;
  const own = row?.[product]?.[region];
  if (typeof own === "number" && Number.isFinite(own)) {
    return { pct: clampPct(own), source: "OVERRIDE", overrideId: String(row!._id), defaultsVersion, international };
  }
  const def = Number(cfg?.[product]?.[region]);
  return { pct: clampPct(Number.isFinite(def) ? def : 0), source: "DEFAULT", overrideId: null, defaultsVersion, international };
}

/** Both flight decisions for a workspace (results are classified one by one). */
export async function flightDecisions(workspaceId: unknown) {
  const [domestic, international] = await Promise.all([
    resolveMargin(workspaceId, "flight", false),
    resolveMargin(workspaceId, "flight", true),
  ]);
  return { domestic, international };
}

export async function flightRouteMargins(workspaceId: unknown): Promise<RouteMargins> {
  const d = await flightDecisions(workspaceId);
  return { domestic: d.domestic.pct, international: d.international.pct };
}

export function marginRecord(d: MarginDecision, amount: number): MarginRecord {
  return {
    marginPct: d.pct,
    marginSource: d.source,
    marginOverrideId: d.overrideId,
    marginVersion: d.defaultsVersion,
    isInternational: d.international,
    marginAmount: round2(amount),
  };
}

/* ───────────────────────── flights: domestic or international ───────────────────────── */

let airportCountry: Map<string, string> | null = null;

/** ISO country of an airport (data/airports.json), "" when unknown. */
export function countryOfAirport(iata: unknown): string {
  if (!airportCountry) {
    airportCountry = new Map();
    try {
      const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../data/airports.json");
      for (const a of JSON.parse(readFileSync(file, "utf-8")) as AnyObj[]) {
        if (a?.code) airportCountry.set(String(a.code).toUpperCase(), String(a.countryCode || ""));
      }
    } catch (err: any) {
      sbtLogger.warn("[sbt-margin] airports.json not readable", { err: err?.message });
    }
  }
  return airportCountry.get(String(iata ?? "").toUpperCase()) || "";
}

/** International unless every airport given is in India. Empty → international. */
export function isInternationalRoute(iatas: unknown[]): boolean {
  const codes = iatas.map((c) => String(c ?? "").trim()).filter(Boolean);
  if (!codes.length) return true;
  return codes.some((c) => countryOfAirport(c) !== "IN");
}

function airportEnd(seg: AnyObj | undefined, side: "Origin" | "Destination"): string {
  const ap = seg?.[side]?.Airport ?? seg?.[side];
  const code = ap?.AirportCode ?? ap?.code;
  return countryOfAirport(code) || String(ap?.CountryCode ?? ap?.countryCode ?? "").toUpperCase();
}

/**
 * A TBO flight result's route from its own segments: each journey's first
 * departure and last arrival. Both ends in India for every journey =
 * domestic; anything else (or no segments) = international.
 */
export function isInternationalFlight(flight: AnyObj | null | undefined): boolean {
  const segs = flight?.Segments;
  if (!Array.isArray(segs) || !segs.length) return true;
  const journeys: AnyObj[][] = Array.isArray(segs[0]) ? (segs as AnyObj[][]) : [segs as AnyObj[]];
  const ends: string[] = [];
  for (const j of journeys) {
    if (!Array.isArray(j) || !j.length) continue;
    ends.push(airportEnd(j[0], "Origin"), airportEnd(j[j.length - 1], "Destination"));
  }
  return !ends.length || ends.some((c) => c !== "IN");
}

/** The percent for one flight result. */
export function pctForFlight(flight: AnyObj | null | undefined, margins: number | RouteMargins): number {
  if (typeof margins === "number") return margins;
  return isInternationalFlight(flight) ? margins.international : margins.domestic;
}

/* ───────────────────────── hotels: domestic or international ───────────────────────── */

/**
 * Country of each hotel: the TBO hotel master by hotel code, else the TBO
 * city master for `cityCode` (the city the server searched), else "".
 */
export async function hotelCountries(hotelCodes: unknown[], cityCode?: unknown): Promise<Map<string, string>> {
  const codes = [...new Set(hotelCodes.map((c) => String(c ?? "")).filter(Boolean))];
  const out = new Map<string, string>();
  try {
    if (codes.length) {
      const rows = (await (TBOHotelMaster as any)
        .find({ hotelCode: { $in: codes } })
        .select("hotelCode countryCode")
        .lean()) as AnyObj[];
      for (const r of rows || []) if (r?.countryCode) out.set(String(r.hotelCode), String(r.countryCode).toUpperCase());
    }
  } catch (err: any) {
    sbtLogger.warn("[sbt-margin] hotel master not readable", { err: err?.message });
  }
  let cityCountry = "";
  if (cityCode != null && String(cityCode) && codes.some((c) => !out.has(c))) {
    try {
      const city = (await (TBOCity as any).findOne({ code: String(cityCode) }).select("countryCode").lean()) as AnyObj | null;
      cityCountry = String(city?.countryCode || "").toUpperCase();
    } catch (err: any) {
      sbtLogger.warn("[sbt-margin] city master not readable", { err: err?.message });
    }
  }
  for (const c of codes) if (!out.has(c)) out.set(c, cityCountry);
  return out;
}

export const isInternationalCountry = (cc: unknown) => String(cc ?? "").toUpperCase() !== "IN";

/** TBO hotel BookingCodes start with the hotel code ("1234567!TB!…"). */
export function hotelCodeOfBookingCode(bookingCode: unknown): string {
  return String(bookingCode ?? "").split("!TB!")[0] || "";
}
