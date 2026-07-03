// BUCKET-C-1: 15-day static data refresh cron (TBO spec rule).
// Refreshes country list, city list, and hotel codes for indexed cities.
// Schedule: 1st and 16th of each month at 9:30 PM UTC (3:00 AM IST).
import cron from "node-cron";
import mongoose, { Schema, model } from "mongoose";
import logger from "../utils/logger.js";
import { tboFetchFailed } from "../utils/tboFetchGuard.js";
import { HOTEL_INDEX_CITIES, type HotelCity } from "../shared/cities.js";
import { TBO_URLS } from "../config/tboUrls.js";

// ── Inline model for refresh log (avoids separate model file) ──────────────

const refreshLogSchema = new Schema(
  {
    refreshedAt: { type: Date, default: Date.now },
    countriesCount: { type: Number, default: 0 },
    citiesCount: { type: Number, default: 0 },
    citiesSkippedCount: { type: Number, default: 0 }, // countries with no city list (Status 500)
    hotelCodesCount: { type: Number, default: 0 },
    errors: { type: [String], default: [] },
    triggeredBy: { type: String, default: "cron" }, // "cron" | "manual" | "seed"
  },
  { timestamps: false },
);

const TBOStaticRefreshLog =
  (mongoose.models["TBOStaticRefreshLog"] as ReturnType<typeof model>) ??
  model("TBOStaticRefreshLog", refreshLogSchema);

// Upsert country documents
const countrySchema = new Schema({
  code: { type: String, unique: true, required: true },
  name: { type: String, required: true },
  searchName: { type: String, default: "" }, // normalized for future autocomplete
  refreshedAt: { type: Date, default: Date.now },
});
export const TBOCountry =
  (mongoose.models["TBOCountry"] as ReturnType<typeof model>) ??
  model("TBOCountry", countrySchema);

// Upsert city documents
const citySchema = new Schema({
  code: { type: String, unique: true, required: true },
  name: { type: String, required: true },
  searchName: { type: String, default: "", index: true }, // normalized; searchName_1 prefix-range index
  countryCode: { type: String, required: true, index: true }, // "cities of country X" lookup
  refreshedAt: { type: Date, default: Date.now },
});
// Text index for fast word-level "contains" matching on 53k+ rows. Coexists with
// the searchName_1 ascending index above (Mongo allows one text index + many
// btree indexes per collection); the ascending index serves prefix-range
// queries, the text index serves contains/fuzzy.
citySchema.index({ searchName: "text" });
export const TBOCity =
  (mongoose.models["TBOCity"] as ReturnType<typeof model>) ??
  model("TBOCity", citySchema);

// Upsert hotel master documents
const hotelMasterSchema = new Schema({
  hotelCode: { type: String, unique: true, required: true },
  hotelName: { type: String, default: "" },
  searchName: { type: String, default: "", index: true }, // normalized; searchName_1 prefix-range index
  cityCode: { type: String, default: "", index: true }, // "hotels of city X" lookup
  countryCode: { type: String, default: "" },
  latitude: { type: String, default: "" },
  longitude: { type: String, default: "" },
  rating: { type: String, default: "" },
  address: { type: String, default: "" },
  refreshedAt: { type: Date, default: Date.now },
});
// Text index for hotel-name contains matching (coexists with searchName_1).
hotelMasterSchema.index({ searchName: "text" });
export const TBOHotelMaster =
  (mongoose.models["TBOHotelMaster"] as ReturnType<typeof model>) ??
  model("TBOHotelMaster", hotelMasterSchema);

// ── Helpers: search normalization, concurrency pool, index sync ────────────

// Search-friendly form for autocomplete: strip diacritics, lowercase, collapse
// punctuation/whitespace to single spaces. The raw `name` is stored as-is (UTF-8
// from res.json() is already correctly decoded — we never re-encode it), so this
// only affects the derived match field, never the display name. Exported so the
// future autocomplete read-path can normalize the user's query identically.
export function normalizeSearch(s: string): string {
  return String(s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // drop combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Bounded worker pool — runs `worker` over `items` with at most `limit` in
// flight. Keeps the off-peak job polite to TBO instead of firing 249 parallel
// CityList calls.
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

// Build the indexes declared on the schemas (idempotent). Called on boot and at
// the start of every refresh so the future DB read-path never scans.
export async function ensureStaticDataIndexes(): Promise<void> {
  try {
    await Promise.all([
      (TBOCountry as any).syncIndexes(),
      (TBOCity as any).syncIndexes(),
      (TBOHotelMaster as any).syncIndexes(),
    ]);
    logger.info("[StaticRefresh] Indexes synced (tbocountries, tbocities, tbohotelmasters)");
  } catch (err: any) {
    logger.warn("[StaticRefresh] Index sync failed", { err: err?.message });
  }
}

// ── TBOHolidays Hotel Static API helpers ───────────────────────────────────

function staticAuthHeader(): string {
  const creds = Buffer.from(
    `${process.env.TBO_HOTEL_STATIC_USERNAME}:${process.env.TBO_HOTEL_STATIC_PASSWORD}`,
  ).toString("base64");
  return `Basic ${creds}`;
}

async function fetchCountryList(): Promise<{ Code: string; Name: string }[]> {
  // TBO spec (UNIVERSAL_Hotel_API_Technical_Guide §FAQ): CountryList is GET.
  // POST returns 405 "Method Not Allowed" as plain text, which crashes res.json().
  const url = TBO_URLS.COUNTRY_LIST;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: staticAuthHeader() },
    signal: AbortSignal.timeout(30_000),
  });
  if (await tboFetchFailed("CountryList", url, res)) return [];
  const data = (await res.json()) as { CountryList?: { Code: string; Name: string }[] };
  return data?.CountryList ?? [];
}

// CityList always returns HTTP 200; "no cities" is an in-body Status.Code 500
// ("No Destination City List found." — e.g. VA/TK/TV/UM) with no CityList key,
// which the res.ok guard cannot see. Return a discriminated result so the caller
// can treat no-cities as a benign skip and only log genuine failures.
type CityListResult =
  | { status: "ok"; cities: { Code: string; Name: string }[] }
  | { status: "no-cities" }
  | { status: "error"; reason: string };

async function fetchCityList(countryCode: string): Promise<CityListResult> {
  const url = `${TBO_URLS.CITY_LIST}?CountryCode=${countryCode}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: staticAuthHeader(),
      },
      body: JSON.stringify({ CountryCode: countryCode }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err: any) {
    return { status: "error", reason: err?.message || "network error" };
  }
  if (await tboFetchFailed(`CityList[${countryCode}]`, url, res)) {
    return { status: "error", reason: `HTTP ${res.status}` };
  }
  const data = (await res.json()) as {
    Status?: { Code: number; Description: string };
    CityList?: { Code: string; Name: string }[];
  };
  const statusCode = Number(data?.Status?.Code);
  if (statusCode === 500) return { status: "no-cities" }; // no destination city list
  if (statusCode && statusCode !== 200) {
    return { status: "error", reason: `Status ${statusCode} ${data?.Status?.Description ?? ""}`.trim() };
  }
  return { status: "ok", cities: data?.CityList ?? [] };
}

async function fetchHotelCodes(
  cityCode: string,
  countryCode: string,
): Promise<{ HotelCode: string; HotelName: string; Latitude: string; Longitude: string; HotelRating: string; Address: string }[]> {
  const url = TBO_URLS.TBO_HOTEL_CODE_LIST;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: staticAuthHeader(),
    },
    body: JSON.stringify({ CityCode: cityCode, CountryCode: countryCode }),
    signal: AbortSignal.timeout(60_000),
  });
  if (await tboFetchFailed(`TBOHotelCodeList[${cityCode}/${countryCode}]`, url, res)) return [];
  const data = (await res.json()) as { Hotels?: any[] };
  return data?.Hotels ?? [];
}

// ── City name → CityCode resolver ──────────────────────────────────────────
// Mirrors cert-inventory-snapshot.ts's matchesCurated(): TBO returns names
// like "Sydney,   New South Wales" and "Bengaluru/Bangalore,   Karnataka".
// Strip the comma suffix, split slash-aliases, then exact-match → alias-match
// → startsWith-with-trailing-space (so "Delhi" hits "Delhi NCR" but not
// "Delhinagar"). Returns null if no candidate matches.
export function resolveCityCode(
  catalog: HotelCity,
  tboCities: { Code: string; Name: string }[],
): string | null {
  if (tboCities.length === 0) return null;
  const target = catalog.cityName.trim().toLowerCase();
  type Candidate = { code: string; aliases: string[] };
  const candidates: Candidate[] = tboCities.map((c) => {
    const beforeComma = (c.Name.split(",")[0] || "").trim().toLowerCase();
    return { code: c.Code, aliases: beforeComma.split("/").map((s) => s.trim()) };
  });

  let match = candidates.find((c) => c.aliases.includes(target));
  if (!match) match = candidates.find((c) => c.aliases.some((a) => a.startsWith(target + " ")));
  return match?.code ?? null;
}

// ── Core refresh logic ─────────────────────────────────────────────────────

export async function runStaticDataRefresh(
  triggeredBy: "cron" | "manual" | "seed" = "cron",
): Promise<{ countriesCount: number; citiesCount: number; citiesSkipped: number; hotelCodesCount: number; errors: string[] }> {
  const errors: string[] = [];
  let countriesCount = 0;
  let citiesCount = 0;
  let citiesSkipped = 0;
  let hotelCodesCount = 0;
  const now = new Date();

  logger.info(`[StaticRefresh] Starting — triggeredBy=${triggeredBy}`);

  // Make sure the indexes the future read-path needs exist before any write.
  await ensureStaticDataIndexes();

  // 1. Countries — dedupe by code (the live CountryList can repeat a code, e.g.
  // RU as "Russia" and "Russian Federation"; keep the first occurrence so the
  // unique index on tbocountries.code does not reject the upsert).
  let allCountryCodes: string[] = [];
  try {
    const raw = await fetchCountryList();
    const seenCodes = new Set<string>();
    const countries = raw.filter((c) => {
      if (!c?.Code || seenCodes.has(c.Code)) return false;
      seenCodes.add(c.Code);
      return true;
    });
    allCountryCodes = countries.map((c) => c.Code);
    for (const c of countries) {
      await (TBOCountry as any).findOneAndUpdate(
        { code: c.Code },
        { name: c.Name, searchName: normalizeSearch(c.Name), refreshedAt: now },
        { upsert: true, new: true },
      );
    }
    countriesCount = countries.length;
    logger.info(`[StaticRefresh] Countries upserted: ${countriesCount} (deduped from ${raw.length})`);
  } catch (err: any) {
    const msg = `Countries fetch failed: ${err?.message}`;
    errors.push(msg);
    logger.error(`[StaticRefresh] ${msg}`);
  }

  // 2. Cities — FULL global catalog: CityList for EVERY country code, upserted
  // into tbocities. Bounded concurrency keeps this off-peak job polite to TBO.
  // Countries with no city list (Status 500) are a benign skip, not an error.
  // cityIndex retains cities only for the curated countries, so the hotel-code
  // resolver below is unchanged.
  const curatedCountryCodes = new Set(HOTEL_INDEX_CITIES.map((c) => c.countryCode));
  const cityIndex = new Map<string, { Code: string; Name: string }[]>();
  await runWithConcurrency(allCountryCodes, 4, async (cc) => {
    const result = await fetchCityList(cc);
    if (result.status === "no-cities") {
      citiesSkipped++;
      return;
    }
    if (result.status === "error") {
      const msg = `City fetch failed for ${cc}: ${result.reason}`;
      errors.push(msg);
      logger.error(`[StaticRefresh] ${msg}`);
      return;
    }
    const cities = result.cities;
    if (curatedCountryCodes.has(cc)) cityIndex.set(cc, cities);
    if (!cities.length) {
      citiesSkipped++;
      return;
    }
    try {
      await (TBOCity as any).bulkWrite(
        cities.map((city) => ({
          updateOne: {
            filter: { code: city.Code },
            update: {
              $set: {
                name: city.Name,
                searchName: normalizeSearch(city.Name),
                countryCode: cc,
                refreshedAt: now,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
      citiesCount += cities.length;
      logger.info(`[StaticRefresh] Cities upserted for ${cc}: ${cities.length}`);
    } catch (err: any) {
      const msg = `City upsert failed for ${cc}: ${err?.message}`;
      errors.push(msg);
      logger.error(`[StaticRefresh] ${msg}`);
    }
  });
  logger.info(`[StaticRefresh] Cities done — upserted ${citiesCount}, skipped ${citiesSkipped} countries with no city list`);

  // 3. Hotel codes for indexed cities — resolve CityCode dynamically against
  // the freshly-fetched CityList so the boot job is self-healing against TBO
  // CityId drift. Falls back to the catalog cityId only if resolution fails.
  for (const city of HOTEL_INDEX_CITIES) {
    const resolvedCode = resolveCityCode(city, cityIndex.get(city.countryCode) ?? []);
    if (!resolvedCode) {
      const msg = `Could not resolve ${city.countryCode}/${city.cityName} against TBO CityList — falling back to catalog ${city.cityId}`;
      logger.warn(`[StaticRefresh] ${msg}`);
    } else if (resolvedCode !== city.cityId) {
      logger.info(
        `[StaticRefresh] Resolved ${city.countryCode}/${city.cityName} → CityCode ${resolvedCode} (catalog had ${city.cityId} — drift corrected)`,
      );
    } else {
      logger.info(
        `[StaticRefresh] Resolved ${city.countryCode}/${city.cityName} → CityCode ${resolvedCode}`,
      );
    }
    const cityCodeToUse = resolvedCode ?? city.cityId;

    try {
      const hotels = await fetchHotelCodes(cityCodeToUse, city.countryCode);
      for (const h of hotels) {
        await (TBOHotelMaster as any).findOneAndUpdate(
          { hotelCode: h.HotelCode },
          {
            hotelName: h.HotelName || "",
            searchName: normalizeSearch(h.HotelName || ""),
            cityCode: cityCodeToUse,
            countryCode: city.countryCode,
            latitude: String(h.Latitude || ""),
            longitude: String(h.Longitude || ""),
            rating: String(h.HotelRating || ""),
            address: h.Address || "",
            refreshedAt: now,
          },
          { upsert: true, new: true },
        );
      }
      hotelCodesCount += hotels.length;
      logger.info(
        `[StaticRefresh] Hotel codes upserted for ${city.cityName}: ${hotels.length}`,
      );
    } catch (err: any) {
      const msg = `Hotel codes fetch failed for ${city.cityName}: ${err?.message}`;
      errors.push(msg);
      logger.warn(`[StaticRefresh] ${msg}`);
    }
  }

  // 4. Persist refresh log
  try {
    await (TBOStaticRefreshLog as any).create({
      refreshedAt: now,
      countriesCount,
      citiesCount,
      citiesSkippedCount: citiesSkipped,
      hotelCodesCount,
      errors,
      triggeredBy,
    });
  } catch (err: any) {
    logger.warn("[StaticRefresh] Failed to write refresh log", { err: err?.message });
  }

  logger.info(
    `[StaticRefresh] Complete — countries=${countriesCount} cities=${citiesCount} citiesSkipped=${citiesSkipped} hotels=${hotelCodesCount} errors=${errors.length}`,
  );
  return { countriesCount, citiesCount, citiesSkipped, hotelCodesCount, errors };
}

// ── Seed on first deploy (collections empty) ───────────────────────────────

export async function seedStaticDataIfEmpty(): Promise<void> {
  try {
    const count = await (TBOCountry as any).countDocuments();
    if (count > 0) {
      logger.info(`[StaticRefresh] Seed skipped — ${count} countries already in DB`);
      return;
    }
    logger.info("[StaticRefresh] Collections empty — running initial seed");
    await runStaticDataRefresh("seed");
  } catch (err: any) {
    logger.warn("[StaticRefresh] Seed check failed", { err: err?.message });
  }
}

// ── Cron: every 15 days (1st and 16th) at 9:30 PM UTC = 3:00 AM IST ───────

export function startStaticDataRefreshCron(): void {
  // Build/repair the static-data indexes on every boot so the future DB
  // read-path is never left scanning between refreshes.
  ensureStaticDataIndexes().catch(() => {});
  cron.schedule("30 21 1,16 * *", async () => {
    logger.info("[StaticRefresh] Cron triggered");
    try {
      await runStaticDataRefresh("cron");
    } catch (err: any) {
      logger.error("[StaticRefresh] Cron run failed", { err: err?.message });
    }
  });
  logger.info("[StaticRefresh] Cron scheduled — 1st & 16th of each month at 21:30 UTC (3:00 AM IST)");
}
