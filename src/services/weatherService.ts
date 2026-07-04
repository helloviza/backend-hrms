// apps/backend/src/services/weatherService.ts
//
// Lightweight weather awareness via Open-Meteo (no API key). 5s timeout,
// in-memory 1h cache keyed by lat/lon + date. Never throws — returns null on
// any failure (silent skip; metric pluto.weather.failed). airports.json carries
// no coordinates, so we keep a minimal IATA → lat/lon map for the IATA_MAP set.

import axios from "axios";
import { emitMetric } from "../utils/plutoMetricsSink.js";
import { watchMetric } from "../utils/plutoMetricsBuilder.js";

const COORDS: Record<string, { lat: number; lon: number; city: string }> = {
  // India
  DEL: { lat: 28.56, lon: 77.10, city: "Delhi" }, BOM: { lat: 19.09, lon: 72.87, city: "Mumbai" },
  BLR: { lat: 13.20, lon: 77.71, city: "Bangalore" }, MAA: { lat: 12.99, lon: 80.17, city: "Chennai" },
  HYD: { lat: 17.24, lon: 78.43, city: "Hyderabad" }, CCU: { lat: 22.65, lon: 88.45, city: "Kolkata" },
  PNQ: { lat: 18.58, lon: 73.92, city: "Pune" }, AMD: { lat: 23.07, lon: 72.63, city: "Ahmedabad" },
  GOI: { lat: 15.38, lon: 73.83, city: "Goa" }, COK: { lat: 10.15, lon: 76.40, city: "Kochi" },
  JAI: { lat: 26.82, lon: 75.81, city: "Jaipur" }, LKO: { lat: 26.76, lon: 80.89, city: "Lucknow" },
  ATQ: { lat: 31.71, lon: 74.80, city: "Amritsar" }, VNS: { lat: 25.45, lon: 82.86, city: "Varanasi" },
  SXR: { lat: 33.99, lon: 74.77, city: "Srinagar" }, IXC: { lat: 30.67, lon: 76.79, city: "Chandigarh" },
  IDR: { lat: 22.72, lon: 75.80, city: "Indore" }, BHO: { lat: 23.29, lon: 77.34, city: "Bhopal" },
  // Asia / ME
  NRT: { lat: 35.77, lon: 140.39, city: "Tokyo" }, KIX: { lat: 34.43, lon: 135.24, city: "Osaka" },
  SIN: { lat: 1.36, lon: 103.99, city: "Singapore" }, BKK: { lat: 13.69, lon: 100.75, city: "Bangkok" },
  HKT: { lat: 8.11, lon: 98.31, city: "Phuket" }, DPS: { lat: -8.75, lon: 115.17, city: "Bali" },
  KUL: { lat: 2.75, lon: 101.71, city: "Kuala Lumpur" }, CGK: { lat: -6.13, lon: 106.66, city: "Jakarta" },
  CMB: { lat: 7.18, lon: 79.88, city: "Colombo" }, KTM: { lat: 27.70, lon: 85.36, city: "Kathmandu" },
  DXB: { lat: 25.25, lon: 55.36, city: "Dubai" }, AUH: { lat: 24.43, lon: 54.65, city: "Abu Dhabi" },
  DOH: { lat: 25.27, lon: 51.61, city: "Doha" }, RUH: { lat: 24.96, lon: 46.70, city: "Riyadh" },
  // Europe / Americas / Oceania
  LHR: { lat: 51.47, lon: -0.45, city: "London" }, CDG: { lat: 49.01, lon: 2.55, city: "Paris" },
  AMS: { lat: 52.31, lon: 4.76, city: "Amsterdam" }, FRA: { lat: 50.04, lon: 8.56, city: "Frankfurt" },
  FCO: { lat: 41.80, lon: 12.24, city: "Rome" }, MAD: { lat: 40.47, lon: -3.56, city: "Madrid" },
  IST: { lat: 41.28, lon: 28.75, city: "Istanbul" }, JFK: { lat: 40.64, lon: -73.78, city: "New York" },
  LAX: { lat: 33.94, lon: -118.41, city: "Los Angeles" }, ORD: { lat: 41.98, lon: -87.90, city: "Chicago" },
  YYZ: { lat: 43.68, lon: -79.63, city: "Toronto" }, SYD: { lat: -33.94, lon: 151.18, city: "Sydney" },
  MEL: { lat: -37.67, lon: 144.84, city: "Melbourne" }, AKL: { lat: -37.01, lon: 174.79, city: "Auckland" },
};

export interface WeatherSummary {
  tempMaxC: number;
  tempMinC: number;
  precipMm: number;
  code: number;
  severe: boolean;
  summary: string;
  city: string;
}

// Open-Meteo WMO weather codes that warrant a severe-weather flag, plus a heavy
// precipitation threshold.
const SEVERE_CODES = new Set([65, 67, 75, 82, 86, 95, 96, 99]);
const HEAVY_PRECIP_MM = 25;

/** PURE severe-weather threshold. */
export function isSevereWeather(code: number, precipMm: number): boolean {
  return SEVERE_CODES.has(code) || (typeof precipMm === "number" && precipMm >= HEAVY_PRECIP_MM);
}

function codeSummary(code: number): string {
  if (code >= 95) return "thunderstorms";
  if (code >= 80) return "heavy showers";
  if (code >= 71) return "snow";
  if (code >= 61) return "rain";
  if (code >= 51) return "drizzle";
  if (code >= 45) return "fog";
  if (code >= 1) return "partly cloudy";
  return "clear skies";
}

const cache = new Map<string, { at: number; val: WeatherSummary | null }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Test hook: clear the in-memory cache. */
export function _resetWeatherCache(): void {
  cache.clear();
}

export async function getDestinationWeather(
  iata: string,
  dateISO: string,
): Promise<WeatherSummary | null> {
  const c = COORDS[String(iata || "").toUpperCase()];
  if (!c || !/^\d{4}-\d{2}-\d{2}$/.test(dateISO || "")) return null;

  const key = `${c.lat},${c.lon}:${dateISO}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.val;

  try {
    const { data } = await axios.get("https://api.open-meteo.com/v1/forecast", {
      params: {
        latitude: c.lat,
        longitude: c.lon,
        daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,weathercode",
        start_date: dateISO,
        end_date: dateISO,
        timezone: "UTC",
      },
      timeout: 5000,
    });
    const d = data?.daily;
    const tempMaxC = Number(d?.temperature_2m_max?.[0]);
    const tempMinC = Number(d?.temperature_2m_min?.[0]);
    const precipMm = Number(d?.precipitation_sum?.[0] ?? 0);
    const code = Number(d?.weathercode?.[0] ?? 0);
    if (!Number.isFinite(tempMaxC)) {
      cache.set(key, { at: Date.now(), val: null });
      return null;
    }
    const val: WeatherSummary = {
      tempMaxC,
      tempMinC,
      precipMm,
      code,
      severe: isSevereWeather(code, precipMm),
      summary: codeSummary(code),
      city: c.city,
    };
    cache.set(key, { at: Date.now(), val });
    return val;
  } catch (e: any) {
    void emitMetric(watchMetric("pluto.weather.failed", { reason: e?.message || "fetch_failed" }, "error"));
    cache.set(key, { at: Date.now(), val: null }); // brief negative cache
    return null;
  }
}
