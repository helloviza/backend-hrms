// Cert inventory snapshot — walks TBO static-data tree (Country → City →
// HotelCount) and writes JSON + Markdown evidence files used when discussing
// inventory mapping with TBO.
//
// Run:
//   pnpm cert:inventory               # default scope (cert-relevant countries)
//   pnpm cert:inventory -- --full     # full traversal (slow, hours)
//
// Outputs to apps/backend/cert-evidence/inventory-snapshot/.
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tboFetchFailed } from "../utils/tboFetchGuard.js";

// ── Config ─────────────────────────────────────────────────────────────────

const COUNTRIES_TO_SAMPLE = [
  "IN", "AE", "SA", "QA", "OM", "MY", "SG", "TH", "ID", "JP",
  "LK", "MV", "FR", "GB", "IT", "NL", "US", "AU", "DE", "ES",
];

// Cert-relevant city names per country. Matched against TBO's CityList using
// matchesCurated() below — comma-split (TBO suffixes state, e.g. "Sydney,
// New South Wales"), slash-split (aliases like "Bengaluru/Bangalore"), then
// exact-or-startsWith comparison so e.g. "Delhi" matches "Delhi NCR" but not
// "Delhinagar". Aliases like "Bombay" are listed alongside the modern name in
// case TBO splits them into separate entries.
const CURATED_CITIES: Record<string, string[]> = {
  IN: ["New Delhi", "Delhi", "Mumbai", "Bombay", "Bengaluru", "Bangalore",
       "Chennai", "Madras", "Hyderabad", "Kolkata", "Calcutta", "Jaipur",
       "Pune", "Ahmedabad", "Agra", "Kochi", "Cochin", "Udaipur", "Goa"],
  AE: ["Dubai", "Abu Dhabi", "Sharjah", "Ras Al Khaimah", "Ras al Khaimah", "Fujairah"],
  SA: ["Riyadh", "Jeddah", "Mecca", "Makkah", "Medina", "Madinah", "Dammam"],
  QA: ["Doha"],
  OM: ["Muscat", "Salalah"],
  MY: ["Kuala Lumpur", "Penang", "Langkawi"],
  SG: ["Singapore"],
  TH: ["Bangkok", "Phuket", "Pattaya", "Chiang Mai", "Krabi"],
  ID: ["Bali", "Denpasar", "Jakarta", "Yogyakarta", "Ubud"],
  JP: ["Tokyo", "Osaka", "Kyoto"],
  LK: ["Colombo", "Kandy", "Galle"],
  MV: ["Male", "Maldives"],
  FR: ["Paris", "Nice", "Lyon"],
  GB: ["London", "Edinburgh", "Manchester"],
  IT: ["Rome", "Milan", "Venice", "Florence"],
  NL: ["Amsterdam", "Rotterdam"],
  US: ["New York", "Los Angeles", "Las Vegas", "Miami", "San Francisco"],
  AU: ["Sydney", "Melbourne", "Brisbane", "Gold Coast"],
  DE: ["Berlin", "Munich", "Frankfurt", "Hamburg"],
  ES: ["Madrid", "Barcelona", "Seville"],
};

const TBO_BASE = "https://api.tbotechnology.in/TBOHolidays_HotelAPI";
const OUT_DIR = resolve(process.cwd(), "cert-evidence/inventory-snapshot");

// Polite throttle between TBO calls (ms). Sequential, not concurrent.
const CALL_DELAY_MS = 100;

// ── TBO API helpers (mirror static-data-refresh.ts; stay standalone) ──────

function staticAuthHeader(): string {
  const u = process.env.TBO_HOTEL_STATIC_USERNAME;
  const p = process.env.TBO_HOTEL_STATIC_PASSWORD;
  if (!u || !p) throw new Error("TBO_HOTEL_STATIC_USERNAME / TBO_HOTEL_STATIC_PASSWORD not set");
  return `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
}

async function fetchCountryList(): Promise<{ Code: string; Name: string }[]> {
  const url = `${TBO_BASE}/CountryList`;
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: staticAuthHeader() },
    signal: AbortSignal.timeout(30_000),
  });
  if (await tboFetchFailed("CountryList", url, res)) return [];
  const data = (await res.json()) as { CountryList?: { Code: string; Name: string }[] };
  return data?.CountryList ?? [];
}

async function fetchCityList(countryCode: string): Promise<{ Code: string; Name: string }[]> {
  const url = `${TBO_BASE}/CityList?CountryCode=${countryCode}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: staticAuthHeader() },
    body: JSON.stringify({ CountryCode: countryCode }),
    signal: AbortSignal.timeout(30_000),
  });
  if (await tboFetchFailed(`CityList[${countryCode}]`, url, res)) return [];
  const data = (await res.json()) as { CityList?: { Code: string; Name: string }[] };
  return data?.CityList ?? [];
}

async function fetchHotelCount(cityCode: string, countryCode: string): Promise<number | null> {
  const url = `${TBO_BASE}/TBOHotelCodeList`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: staticAuthHeader() },
    body: JSON.stringify({ CityCode: cityCode, CountryCode: countryCode }),
    signal: AbortSignal.timeout(60_000),
  });
  if (await tboFetchFailed(`TBOHotelCodeList[${cityCode}/${countryCode}]`, url, res)) return null;
  const data = (await res.json()) as { Hotels?: unknown[] };
  return Array.isArray(data?.Hotels) ? data!.Hotels!.length : 0;
}

// ── CLI parsing ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const FULL = args.includes("--full");

// ── Output shapes ──────────────────────────────────────────────────────────

interface CityRow {
  code: string;
  name: string;
  hotelCount: number | null;
}
interface CountryRow {
  code: string;
  name: string;
  citiesQueriedCount: number;
  totalHotels: number;
  cities: CityRow[];
}
interface Snapshot {
  snapshotAt: string;
  tboAccount: string;
  tboEnv: string;
  scope: "default" | "full";
  summary: {
    countriesQueried: number;
    citiesQueried: number;
    totalHotelsCounted: number;
  };
  countries: CountryRow[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fmt(n: number | null): string {
  if (n === null) return "n/a";
  return n.toLocaleString("en-US");
}

function tsForFilename(d: Date): string {
  // 2026-05-07T14-32-11Z (filesystem-safe; no colons)
  return d.toISOString().replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

function tsForDisplay(d: Date): string {
  // 2026-05-07T14:32:11Z
  return d.toISOString().replace(/\.\d+Z$/, "Z");
}

// TBO returns names like "Sydney,   New South Wales" or "Bengaluru/Bangalore,
//   Karnataka". Strip the state suffix, split slash-aliases, then accept exact
// match or startsWith with a trailing space (so "Delhi" hits "Delhi NCR" but
// not "Delhinagar"; "Brisbane" hits "Brisbane" but not "South Brisbane").
function matchesCurated(tboName: string, target: string): boolean {
  const beforeComma = (tboName.split(",")[0] || "").trim().toLowerCase();
  const aliases = beforeComma.split("/").map((s) => s.trim());
  const t = target.toLowerCase();
  return aliases.some((a) => a === t || a.startsWith(t + " "));
}

function pickCitiesForCountry(
  countryCode: string,
  allCities: { Code: string; Name: string }[],
): { Code: string; Name: string }[] {
  if (FULL) return allCities;
  const curated = CURATED_CITIES[countryCode];
  if (!curated || curated.length === 0) {
    // Fallback: top 50 alphabetically.
    return [...allCities].sort((a, b) => a.Name.localeCompare(b.Name)).slice(0, 50);
  }
  return allCities.filter((c) =>
    curated.some((target) => matchesCurated(c.Name || "", target)),
  );
}

// ── Snapshot orchestration ────────────────────────────────────────────────

async function runSnapshot(): Promise<Snapshot> {
  const startedAt = new Date();
  const t0 = Date.now();
  console.log(`[Snapshot] Starting — scope=${FULL ? "full" : "default"}`);

  const allCountries = await fetchCountryList();
  if (allCountries.length === 0) {
    throw new Error("CountryList fetch returned 0 countries (check TBO creds / connectivity)");
  }
  console.log(`[Snapshot] Fetched countries: ${allCountries.length}`);

  const inScope = FULL
    ? allCountries
    : allCountries.filter((c) => COUNTRIES_TO_SAMPLE.includes(c.Code));

  const countryRows: CountryRow[] = [];
  let citiesQueriedTotal = 0;
  let hotelsCountedTotal = 0;

  for (const country of inScope) {
    let cities: { Code: string; Name: string }[] = [];
    try {
      cities = await fetchCityList(country.Code);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[Snapshot] CityList failed for ${country.Code}: ${msg}`);
    }
    console.log(`[Snapshot] ${country.Code} (${country.Name}) — ${cities.length} cities`);
    await sleep(CALL_DELAY_MS);

    const targetCities = pickCitiesForCountry(country.Code, cities);
    const cityRows: CityRow[] = [];
    let countryTotal = 0;

    for (const city of targetCities) {
      let count: number | null = null;
      try {
        count = await fetchHotelCount(city.Code, country.Code);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[Snapshot] HotelCodeList failed for ${country.Code}/${city.Code} (${city.Name}): ${msg}`);
      }
      cityRows.push({ code: city.Code, name: city.Name, hotelCount: count });
      console.log(`[Snapshot] ${country.Code}/${city.Code} (${city.Name}) — ${fmt(count)} hotels`);
      if (typeof count === "number") countryTotal += count;
      citiesQueriedTotal += 1;
      await sleep(CALL_DELAY_MS);
    }

    hotelsCountedTotal += countryTotal;
    countryRows.push({
      code: country.Code,
      name: country.Name,
      citiesQueriedCount: cityRows.length,
      totalHotels: countryTotal,
      cities: cityRows.sort((a, b) => (b.hotelCount ?? -1) - (a.hotelCount ?? -1)),
    });
  }

  countryRows.sort((a, b) => b.totalHotels - a.totalHotels);

  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(
    `[Snapshot] Complete in ${elapsed}s — ${inScope.length} countries, ${citiesQueriedTotal} cities, ${hotelsCountedTotal} hotels`,
  );

  return {
    snapshotAt: tsForDisplay(startedAt),
    tboAccount: process.env.TBO_HOTEL_STATIC_USERNAME ?? "(unknown)",
    tboEnv: "test",
    scope: FULL ? "full" : "default",
    summary: {
      countriesQueried: inScope.length,
      citiesQueried: citiesQueriedTotal,
      totalHotelsCounted: hotelsCountedTotal,
    },
    countries: countryRows,
  };
}

// ── Output writers ────────────────────────────────────────────────────────

function renderMarkdown(snap: Snapshot): string {
  const lines: string[] = [];
  lines.push(`# TBO Cert Inventory Snapshot`);
  lines.push(``);
  lines.push(`**Snapshot taken:** ${snap.snapshotAt}`);
  lines.push(`**TBO account:** ${snap.tboAccount} (${snap.tboEnv} env)`);
  lines.push(`**Scope:** ${snap.scope}`);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(``);
  lines.push(`| | |`);
  lines.push(`|---|---|`);
  lines.push(`| Countries queried | ${fmt(snap.summary.countriesQueried)} |`);
  lines.push(`| Cities queried | ${fmt(snap.summary.citiesQueried)} |`);
  lines.push(`| Total hotels counted | ${fmt(snap.summary.totalHotelsCounted)} |`);
  lines.push(``);
  for (const c of snap.countries) {
    lines.push(`## ${c.name} (${c.code}) — ${fmt(c.totalHotels)} hotels across ${fmt(c.citiesQueriedCount)} cities`);
    lines.push(``);
    if (c.cities.length === 0) {
      lines.push(`_No cities queried._`);
      lines.push(``);
      continue;
    }
    lines.push(`| City | CityCode | Hotel count |`);
    lines.push(`|---|---|---|`);
    for (const city of c.cities) {
      lines.push(`| ${city.name} | ${city.code} | ${fmt(city.hotelCount)} |`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}

async function writeOutputs(snap: Snapshot): Promise<{ jsonPath: string; mdPath: string; jsonLatest: string; mdLatest: string }> {
  await mkdir(OUT_DIR, { recursive: true });
  const stamp = tsForFilename(new Date(snap.snapshotAt));
  const jsonPath = resolve(OUT_DIR, `inventory-${stamp}.json`);
  const mdPath = resolve(OUT_DIR, `inventory-${stamp}.md`);
  const jsonLatest = resolve(OUT_DIR, `inventory-latest.json`);
  const mdLatest = resolve(OUT_DIR, `inventory-latest.md`);

  const jsonBody = JSON.stringify(snap, null, 2);
  const mdBody = renderMarkdown(snap);

  await writeFile(jsonPath, jsonBody, "utf8");
  await writeFile(mdPath, mdBody, "utf8");
  await writeFile(jsonLatest, jsonBody, "utf8");
  await writeFile(mdLatest, mdBody, "utf8");

  return { jsonPath, mdPath, jsonLatest, mdLatest };
}

// ── Entry ─────────────────────────────────────────────────────────────────

(async () => {
  try {
    const snap = await runSnapshot();
    const paths = await writeOutputs(snap);
    console.log(`[Snapshot] Wrote ${paths.jsonPath}`);
    console.log(`[Snapshot] Wrote ${paths.mdPath}`);
    console.log(`[Snapshot] Wrote ${paths.jsonLatest}`);
    console.log(`[Snapshot] Wrote ${paths.mdLatest}`);
    process.exit(0);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Snapshot] FAILED: ${msg}`);
    process.exit(1);
  }
})();
