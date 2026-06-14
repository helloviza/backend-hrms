// Shared TBO hotel helpers: caches, city/country resolution, code list, name
// index, pax validation, room normalization. Used by sbt.hotels.ts routes and
// by the concierge hotel search endpoint via tbo.hotel.search.service.ts.
//
// State (cityCache, countryListCache, hotelNameIndex, hotelIndexedCities) is
// module-scoped so it survives across requests and is shared across both
// routes — that's the whole point of extracting this module.

import { logTBOCall } from "../utils/tboFileLogger.js";
import { sbtLogger } from "../utils/logger.js";
import { tboFetchFailed } from "../utils/tboFetchGuard.js";
import {
  HOTEL_INDEX_CITIES as SHARED_HOTEL_INDEX_CITIES,
  HOTEL_CITIES as SHARED_HOTEL_CITIES,
  type HotelCity,
} from "../shared/cities.js";
import { resolveCityCode as resolveCityCodeAgainstCatalog } from "../jobs/static-data-refresh.js";
import { TBO_URLS } from "../config/tboUrls.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CityEntry {
  CityId: string;
  CityName: string;
  CountryCode: string;
  CountryName: string;
}

export interface HotelCodeEntry {
  HotelCode: string;
  HotelName: string;
  Latitude: string;
  Longitude: string;
  HotelRating: string;
  Address: string;
  CityName: string;
  CountryName: string;
  CountryCode: string;
}

export interface HotelIndexEntry extends HotelCodeEntry {
  CityCode: string;
}

// ─── Caches ──────────────────────────────────────────────────────────────────

export const cityCache = new Map<string, { data: CityEntry[]; ts: number }>();
export const CITY_CACHE_TTL = 24 * 60 * 60 * 1000;

export const HOTEL_SESSION_TTL_MS = 40 * 60 * 1000; // TBO Op Rule 7

let countryListCache: { Code: string; Name: string }[] = [];
let countryListCacheTime = 0;
const COUNTRY_LIST_TTL = 24 * 60 * 60 * 1000;

export const hotelNameIndex: HotelIndexEntry[] = [];
export const hotelIndexedCities = new Set<string>();

export const PRIORITY_COUNTRY_CODES = new Set(
  SHARED_HOTEL_CITIES
    .filter((c) => c.countryCode !== "IN")
    .map((c) => c.countryCode),
);

// ─── Auth headers ────────────────────────────────────────────────────────────

export function hotelAuthHeader(): string {
  const creds = Buffer.from(
    `${process.env.TBO_HOTEL_USERNAME}:${process.env.TBO_HOTEL_PASSWORD}`,
  ).toString("base64");
  return `Basic ${creds}`;
}

export function hotelStaticAuthHeader(): string {
  const creds = Buffer.from(
    `${process.env.TBO_HOTEL_STATIC_USERNAME}:${process.env.TBO_HOTEL_STATIC_PASSWORD}`,
  ).toString("base64");
  return `Basic ${creds}`;
}

// ─── Room normalization (TBO spec lines 1415-1432) ───────────────────────────

export function normalizeRoom(room: any) {
  return {
    ...room,
    recommendedSellingRate:
      room?.RecommendedSellingRate != null
        ? Number(room.RecommendedSellingRate) || null
        : null,
    supplements: Array.isArray(room?.Supplements) ? room.Supplements : [],
    cancelPolicies: Array.isArray(room?.CancelPolicies) ? room.CancelPolicies : [],
    isRefundable:
      typeof room?.IsRefundable === "boolean" ? room.IsRefundable : null,
  };
}

// ─── Chunk ───────────────────────────────────────────────────────────────────

export function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

// ─── Pax rooms validation (TBO certified limits) ─────────────────────────────

export function validatePaxRooms(paxRooms: unknown): string | null {
  if (!Array.isArray(paxRooms) || paxRooms.length === 0) {
    return "At least one room is required.";
  }
  if (paxRooms.length > 4) {
    return "Maximum 4 rooms per booking.";
  }
  for (let i = 0; i < paxRooms.length; i++) {
    const r: any = paxRooms[i];
    const adults = Number(r?.Adults ?? r?.adults ?? 0);
    const children = Number(r?.Children ?? r?.children ?? 0);

    if (!Number.isFinite(adults) || adults < 1) {
      return `Room ${i + 1}: at least 1 adult is required.`;
    }
    if (adults > 4) {
      return `Room ${i + 1}: maximum 4 adults per room.`;
    }
    if (!Number.isFinite(children) || children < 0) {
      return `Room ${i + 1}: children count is invalid.`;
    }
    if (children > 3) {
      return `Room ${i + 1}: maximum 3 children per room.`;
    }

    const ages = r?.ChildrenAges ?? r?.childrenAges;
    if (ages !== null && ages !== undefined) {
      if (!Array.isArray(ages)) {
        return `Room ${i + 1}: children ages must be a list.`;
      }
      if (children > 0 && ages.length !== children) {
        return `Room ${i + 1}: please provide an age for each child.`;
      }
      for (const age of ages) {
        const n = Number(age);
        if (!Number.isFinite(n) || n < 2 || n > 12) {
          return `Room ${i + 1}: child age must be between 2 and 12.`;
        }
      }
    }
  }
  return null;
}

// ─── TBO calls ───────────────────────────────────────────────────────────────

export async function getCachedCountryList(): Promise<{ Code: string; Name: string }[]> {
  const now = Date.now();
  if (countryListCache.length > 0 && now - countryListCacheTime < COUNTRY_LIST_TTL) {
    return countryListCache;
  }
  // TBO spec: CountryList is GET-only. POST returns 405 with plain text body
  // that crashes res.json(). Do not poison cache on failure — return last value
  // (or [] on cold start) so the caller can retry on the next request.
  const url = TBO_URLS.COUNTRY_LIST;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: hotelStaticAuthHeader() },
  });
  if (await tboFetchFailed("CountryList", url, res)) return countryListCache;
  const data = (await res.json()) as { CountryList?: { Code: string; Name: string }[] };
  countryListCache = data?.CountryList ?? [];
  countryListCacheTime = now;
  return countryListCache;
}

export async function fetchCityList(countryCode: string): Promise<CityEntry[]> {
  const cached = cityCache.get(countryCode);
  if (cached && Date.now() - cached.ts < CITY_CACHE_TTL) return cached.data;

  const tboPayload = { CountryCode: countryCode };
  const t0 = Date.now();
  const res = await fetch(
    `${TBO_URLS.CITY_LIST}?CountryCode=${countryCode}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: hotelStaticAuthHeader(),
      },
      body: JSON.stringify(tboPayload),
    },
  );
  // TEMP DIAG (revert after) — surface raw static-catalog response in CloudWatch.
  const bodyText = await res.text();
  sbtLogger.error("TBO_STATIC_DIAG", {
    call: "CityList",
    url: `${TBO_URLS.CITY_LIST}?CountryCode=${countryCode}`,
    status: res.status,
    statusText: res.statusText,
    ok: res.ok,
    body: bodyText.slice(0, 500),
  });
  const data = JSON.parse(bodyText) as { CityList?: { Code: string; Name: string }[] };
  logTBOCall({
    method: "HotelCityList",
    traceId: `city-${countryCode}`,
    request: tboPayload,
    response: data,
    durationMs: Date.now() - t0,
  });
  const countryList = await getCachedCountryList();
  const countryNameByCode = new Map<string, string>(
    (countryList || []).map((c: any) => [String(c.Code).toUpperCase(), String(c.Name)]),
  );

  const cities: CityEntry[] = (data?.CityList || []).map((c: any) => ({
    CityId: c.Code,
    CityName: c.Name,
    CountryCode: countryCode,
    CountryName: countryNameByCode.get(String(countryCode).toUpperCase()) ?? "",
  }));
  cityCache.set(countryCode, { data: cities, ts: Date.now() });
  return cities;
}

export async function fetchHotelCodeList(
  cityCode: string,
  countryCode: string,
): Promise<HotelCodeEntry[]> {
  const tboPayload = { CityCode: cityCode, CountryCode: countryCode };
  const t0 = Date.now();
  const res = await fetch(
    TBO_URLS.TBO_HOTEL_CODE_LIST,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: hotelStaticAuthHeader(),
      },
      body: JSON.stringify(tboPayload),
    },
  );
  // TEMP DIAG (revert after) — surface raw static-catalog response in CloudWatch.
  const bodyText = await res.text();
  sbtLogger.error("TBO_STATIC_DIAG", {
    call: "TBOHotelCodeList",
    url: TBO_URLS.TBO_HOTEL_CODE_LIST,
    status: res.status,
    statusText: res.statusText,
    ok: res.ok,
    body: bodyText.slice(0, 500),
  });
  const data = JSON.parse(bodyText) as { Hotels?: HotelCodeEntry[] };
  logTBOCall({
    method: "HotelCodeList",
    traceId: `codes-${cityCode}`,
    request: tboPayload,
    response: { hotelCount: data?.Hotels?.length ?? 0 },
    durationMs: Date.now() - t0,
  });
  return data?.Hotels || [];
}

// ─── Hotel name index ────────────────────────────────────────────────────────

export async function ensureHotelIndexed(
  cityCode: string,
  countryCode: string,
  cityName?: string,
): Promise<void> {
  // Drift-safe resolve: if cityName is known, ask TBO's current CityList for
  // the live cityCode (mirrors the boot job's resolveCityCode flow that
  // surfaced the Dubai 118924→115936 drift).
  let resolvedCityCode = cityCode;
  if (cityName) {
    try {
      const cities = await fetchCityList(countryCode);
      const tboCities = cities.map((c) => ({ Code: c.CityId, Name: c.CityName }));
      const resolved = resolveCityCodeAgainstCatalog(
        { cityName, countryCode, cityId: cityCode } as HotelCity,
        tboCities,
      );
      if (resolved && resolved !== cityCode) {
        sbtLogger.info(
          `[HOTEL-INDEX] Resolved ${countryCode}/${cityName} → CityCode ${resolved} (catalog had ${cityCode} — drift corrected)`,
        );
        resolvedCityCode = resolved;
      }
    } catch (resolveErr) {
      sbtLogger.warn(
        `[HOTEL-INDEX] resolveCityCode failed for ${countryCode}/${cityName}; falling back to catalog ${cityCode}`,
        { err: resolveErr instanceof Error ? resolveErr.message : String(resolveErr) },
      );
    }
  }

  if (hotelIndexedCities.has(resolvedCityCode)) return;
  hotelIndexedCities.add(resolvedCityCode);
  try {
    const hotels = await fetchHotelCodeList(resolvedCityCode, countryCode);
    for (const h of hotels) hotelNameIndex.push({ ...h, CityCode: resolvedCityCode });
  } catch (err) {
    console.error(
      `[HOTEL-INDEX] Failed to index city ${resolvedCityCode}:`,
      err instanceof Error ? err.message : String(err),
    );
    hotelIndexedCities.delete(resolvedCityCode);
  }
}

export async function resolveCityCode(cityName: string): Promise<string | null> {
  try {
    const cities = await fetchCityList("IN");
    const lc = cityName.toLowerCase();
    const match = cities.find((c) => c.CityName.toLowerCase() === lc)
      || cities.find((c) => c.CityName.toLowerCase().includes(lc));
    return match?.CityId ?? null;
  } catch {
    return null;
  }
}

// ─── Startup preload (runs once when this module is first imported) ──────────

(async () => {
  try {
    await fetchCityList("IN");
    sbtLogger.info("Indian city list cached on startup");

    for (const c of SHARED_HOTEL_INDEX_CITIES) {
      await ensureHotelIndexed(c.cityId, c.countryCode, c.cityName);
    }

    const additionalCityNames = ["Goa", "Jaipur", "Agra", "Kolkata", "Pune", "Ahmedabad"];
    for (const cityName of additionalCityNames) {
      const code = await resolveCityCode(cityName);
      if (code) {
        await ensureHotelIndexed(code, "IN");
      } else {
        sbtLogger.warn(`[HOTEL-INDEX] Could not resolve CityCode for: ${cityName}`);
      }
    }

    sbtLogger.info(`Hotel name index built: ${hotelNameIndex.length} hotels`);
  } catch (e) {
    sbtLogger.warn("Failed to pre-load hotel data", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
})();
