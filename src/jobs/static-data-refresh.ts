// BUCKET-C-1: 15-day static data refresh cron (TBO spec rule).
// Refreshes country list, city list, and hotel codes for indexed cities.
// Schedule: 1st and 16th of each month at 9:30 PM UTC (3:00 AM IST).
import cron from "node-cron";
import mongoose, { Schema, model } from "mongoose";
import logger from "../utils/logger.js";
import { tboFetchFailed } from "../utils/tboFetchGuard.js";
import { HOTEL_INDEX_CITIES, type HotelCity } from "../shared/cities.js";

// ── Inline model for refresh log (avoids separate model file) ──────────────

const refreshLogSchema = new Schema(
  {
    refreshedAt: { type: Date, default: Date.now },
    countriesCount: { type: Number, default: 0 },
    citiesCount: { type: Number, default: 0 },
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
  refreshedAt: { type: Date, default: Date.now },
});
const TBOCountry =
  (mongoose.models["TBOCountry"] as ReturnType<typeof model>) ??
  model("TBOCountry", countrySchema);

// Upsert city documents
const citySchema = new Schema({
  code: { type: String, unique: true, required: true },
  name: { type: String, required: true },
  countryCode: { type: String, required: true },
  refreshedAt: { type: Date, default: Date.now },
});
const TBOCity =
  (mongoose.models["TBOCity"] as ReturnType<typeof model>) ??
  model("TBOCity", citySchema);

// Upsert hotel master documents
const hotelMasterSchema = new Schema({
  hotelCode: { type: String, unique: true, required: true },
  hotelName: { type: String, default: "" },
  cityCode: { type: String, default: "" },
  countryCode: { type: String, default: "" },
  latitude: { type: String, default: "" },
  longitude: { type: String, default: "" },
  rating: { type: String, default: "" },
  address: { type: String, default: "" },
  refreshedAt: { type: Date, default: Date.now },
});
const TBOHotelMaster =
  (mongoose.models["TBOHotelMaster"] as ReturnType<typeof model>) ??
  model("TBOHotelMaster", hotelMasterSchema);

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
  const url = "https://api.tbotechnology.in/TBOHolidays_HotelAPI/CountryList";
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: staticAuthHeader() },
    signal: AbortSignal.timeout(30_000),
  });
  if (await tboFetchFailed("CountryList", url, res)) return [];
  const data = (await res.json()) as { CountryList?: { Code: string; Name: string }[] };
  return data?.CountryList ?? [];
}

async function fetchCityList(
  countryCode: string,
): Promise<{ Code: string; Name: string }[]> {
  const url = `https://api.tbotechnology.in/TBOHolidays_HotelAPI/CityList?CountryCode=${countryCode}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: staticAuthHeader(),
    },
    body: JSON.stringify({ CountryCode: countryCode }),
    signal: AbortSignal.timeout(30_000),
  });
  if (await tboFetchFailed(`CityList[${countryCode}]`, url, res)) return [];
  const data = (await res.json()) as {
    CityList?: { Code: string; Name: string }[];
  };
  return data?.CityList ?? [];
}

async function fetchHotelCodes(
  cityCode: string,
  countryCode: string,
): Promise<{ HotelCode: string; HotelName: string; Latitude: string; Longitude: string; HotelRating: string; Address: string }[]> {
  const url = "https://api.tbotechnology.in/TBOHolidays_HotelAPI/TBOHotelCodeList";
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
): Promise<{ countriesCount: number; citiesCount: number; hotelCodesCount: number; errors: string[] }> {
  const errors: string[] = [];
  let countriesCount = 0;
  let citiesCount = 0;
  let hotelCodesCount = 0;
  const now = new Date();

  logger.info(`[StaticRefresh] Starting — triggeredBy=${triggeredBy}`);

  // 1. Countries
  try {
    const countries = await fetchCountryList();
    for (const c of countries) {
      await (TBOCountry as any).findOneAndUpdate(
        { code: c.Code },
        { name: c.Name, refreshedAt: now },
        { upsert: true, new: true },
      );
    }
    countriesCount = countries.length;
    logger.info(`[StaticRefresh] Countries upserted: ${countriesCount}`);
  } catch (err: any) {
    const msg = `Countries fetch failed: ${err?.message}`;
    errors.push(msg);
    logger.error(`[StaticRefresh] ${msg}`);
  }

  // 2. Cities for indexed country codes (derived from HOTEL_INDEX_CITIES)
  const countryCodes = [...new Set(HOTEL_INDEX_CITIES.map((c) => c.countryCode))];
  const cityIndex = new Map<string, { Code: string; Name: string }[]>();
  for (const cc of countryCodes) {
    try {
      const cities = await fetchCityList(cc);
      cityIndex.set(cc, cities);
      for (const city of cities) {
        await (TBOCity as any).findOneAndUpdate(
          { code: city.Code },
          { name: city.Name, countryCode: cc, refreshedAt: now },
          { upsert: true, new: true },
        );
      }
      citiesCount += cities.length;
      logger.info(`[StaticRefresh] Cities upserted for ${cc}: ${cities.length}`);
    } catch (err: any) {
      const msg = `City fetch failed for ${cc}: ${err?.message}`;
      errors.push(msg);
      logger.error(`[StaticRefresh] ${msg}`);
    }
  }

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
      hotelCodesCount,
      errors,
      triggeredBy,
    });
  } catch (err: any) {
    logger.warn("[StaticRefresh] Failed to write refresh log", { err: err?.message });
  }

  logger.info(
    `[StaticRefresh] Complete — countries=${countriesCount} cities=${citiesCount} hotels=${hotelCodesCount} errors=${errors.length}`,
  );
  return { countriesCount, citiesCount, hotelCodesCount, errors };
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
