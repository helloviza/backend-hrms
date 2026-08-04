// apps/backend/src/utils/plutoHotelDestination.ts
//
// WHICH CITY does a hotel-led turn mean, and can we actually serve it?
//
// The hotel lane used to answer that with one nullable string, which collapsed
// three genuinely different situations into one:
//
//   RESOLVED    — we know the city AND can price it. The live lane runs.
//   UNSUPPORTED — the user NAMED somewhere we cannot search. A dead end that no
//                 further question fixes, so say so instead of asking for dates
//                 we already have and failing afterwards anyway.
//   NO_CITY     — nothing was named. Asking which city is the right reply.
//
// Conflating UNSUPPORTED with NO_CITY is what produced the "show me some hotels
// in london for same duration" turn: London extracted as null (it is not in the
// curated destination table, and the extractor also required a capital letter),
// the turn fell through to the model, and the model asked for travel dates that
// were already locked from the previous turn. Two failures in one reply — it
// lost context it held, and it asked a question that could not unblock anything.
//
// COUNTRY RESOLUTION, and why it widened. The ownership gate asked countryFor()
// — the ~280-entry curated destinationLookup built from historical bookings.
// searchHotels, meanwhile, prices against `tbocities`: 53,943 rows carrying a
// code AND a countryCode. London/GB/126632, Tokyo/JP/148251 and Paris/FR/131408
// were all sitting in the collection the search already queries, so "we cannot
// serve London" would have been false. The curated table is still consulted
// FIRST (it canonicalises spelling and is hand-checked); the catalog is the
// fallback that makes the rest of the world reachable.
//
// The honest handoff is therefore reserved for what genuinely does not resolve
// in EITHER source, which is where it is a true statement.

import mongoose from "mongoose";
import {
  TBOCity,
  TBOCountry,
  TBOHotelMaster,
  normalizeSearch,
} from "../jobs/static-data-refresh.js";
import { countryFor } from "../data/destinationLookup.js";
import { extractHotelCity, extractNamedPlaceCandidate } from "./plutoHotelSearch.js";

export type HotelDestination =
  | {
      status: "RESOLVED";
      cityName: string;
      countryCode: string;
      cityCode: string;
      /**
       * Set when the user named a COUNTRY and we picked its main city for them.
       * The reply MUST disclose it — silently turning "hotels in Qatar" into a
       * Doha result is the same class of answer-for-the-wrong-place this module
       * exists to stop, just a smaller version of it.
       */
      viaCountry?: string;
    }
  | { status: "UNSUPPORTED"; cityName: string }
  | { status: "NO_CITY" };

/** A `tbocities` row, trimmed to what resolution needs. */
export interface CatalogCity {
  code: string;
  name: string;
  countryCode: string;
}

/**
 * Catalog names are not display copy: TBO stores things like
 * "Bangkok,   Bangkok" (duplicated, padded). Take the part before the comma and
 * collapse the whitespace so the reply reads "Hotels in Bangkok". Trimming
 * presentation only — the CODE we search with is untouched.
 */
export function tidyCatalogCityName(raw: string): string {
  const first = String(raw || "").split(",")[0];
  return first.replace(/\s+/g, " ").trim() || String(raw || "").trim();
}

/**
 * Look a named place up in the global TBO city catalog. Exact normalised name
 * first, then shortest prefix match so "Dubai" beats "Dubai Marina". Returns
 * null rather than a guess.
 */
export async function findCatalogCity(name: string): Promise<CatalogCity | null> {
  const key = normalizeSearch(name);
  if (!key) return null;

  // No live connection → do NOT issue the query. Mongoose would buffer it for
  // its 10s default and the chat turn would hang behind a database that is not
  // there, which is a far worse answer than the honest handoff this returns.
  if (mongoose.connection?.readyState !== 1) return null;

  try {
    const exact = await (TBOCity as any)
      .findOne({ searchName: key })
      .select("code name countryCode")
      .lean();
    if (exact?.code && exact?.countryCode) {
      return {
        code: String(exact.code),
        name: tidyCatalogCityName(String(exact.name)),
        countryCode: String(exact.countryCode),
      };
    }

    const prefixed = await (TBOCity as any)
      .find({ searchName: { $gte: key, $lt: key + "￿" } })
      .select("code name countryCode searchName")
      .limit(20)
      .lean();
    const best = (Array.isArray(prefixed) ? prefixed : [])
      .filter((r: any) => r?.code && r?.countryCode)
      .sort(
        (a: any, b: any) =>
          String(a.searchName ?? "").length - String(b.searchName ?? "").length,
      )[0];
    if (best) {
      return {
        code: String(best.code),
        name: tidyCatalogCityName(String(best.name)),
        countryCode: String(best.countryCode),
      };
    }
  } catch {
    // A catalog outage must not turn into a fabricated city. Fall through to
    // null and let the caller hand off honestly.
  }
  return null;
}

/* Country lookups are static reference data refreshed by a daily job, so both
 * are memoised for the process. A country-only turn is rare; the aggregate
 * behind findPrimaryCityForCountry should not run twice for it. */
const countryCache = new Map<string, { code: string; name: string } | null>();
const primaryCityCache = new Map<string, CatalogCity | null>();

/** "Qatar" → { code: "QA" }. Name only — no ISO guessing, no abbreviations. */
export async function findCountryByName(
  name: string,
): Promise<{ code: string; name: string } | null> {
  const key = normalizeSearch(name);
  if (!key) return null;
  if (countryCache.has(key)) return countryCache.get(key) ?? null;
  if (mongoose.connection?.readyState !== 1) return null;
  try {
    const row = await (TBOCountry as any)
      .findOne({ searchName: key })
      .select("code name")
      .lean();
    const hit = row?.code ? { code: String(row.code), name: String(row.name) } : null;
    countryCache.set(key, hit);
    return hit;
  } catch {
    return null;
  }
}

/**
 * A country's main city, ranked by HOW MANY BOOKABLE HOTELS the catalog holds
 * there.
 *
 * Deliberately not "the capital": capital-ness is not in this data and would
 * have to come from a new dependency, and it is the wrong question anyway — we
 * are choosing where a hotel search will actually find inventory. The signal is
 * emphatic where it matters (QA: Doha 296 and nothing else; TH: Bangkok 5,232
 * vs 2; AE: Dubai 4,905 vs Abu Dhabi 341), so this is a ranking, not a guess.
 * Null when the country has no cities carrying hotels, and then the caller
 * hands off honestly rather than inventing a destination.
 */
export async function findPrimaryCityForCountry(
  countryCode: string,
): Promise<CatalogCity | null> {
  const cc = String(countryCode || "").trim().toUpperCase();
  if (!cc) return null;
  if (primaryCityCache.has(cc)) return primaryCityCache.get(cc) ?? null;
  if (mongoose.connection?.readyState !== 1) return null;
  try {
    const top = await (TBOHotelMaster as any).aggregate([
      { $match: { countryCode: cc } },
      { $group: { _id: "$cityCode", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 1 },
    ]);
    const cityCode = top?.[0]?._id ? String(top[0]._id) : null;
    if (!cityCode) {
      primaryCityCache.set(cc, null);
      return null;
    }
    const city = await (TBOCity as any).findOne({ code: cityCode }).select("code name").lean();
    const hit = city?.code
      ? { code: String(city.code), name: tidyCatalogCityName(String(city.name)), countryCode: cc }
      : null;
    primaryCityCache.set(cc, hit);
    return hit;
  } catch {
    return null;
  }
}

/**
 * The decision, with every lookup already done. PURE, so the split is
 * testable without a database.
 *
 * `named` is what the user actually typed (null when they named nothing), and
 * it is what decides UNSUPPORTED vs NO_CITY. Note the precedence: a place named
 * in THIS prompt outranks `lockedName`. Without that, a locked "Dubai" from an
 * earlier turn would answer a London request with Dubai hotels — silently the
 * wrong city, which is worse than either failure this module is fixing.
 */
export function classifyHotelDestination(input: {
  /** extractHotelCity — the curated table's canonical city, when it knows one. */
  tableCity: string | null;
  /** The raw place the user named, and whether they capitalised it. */
  named: { raw: string; capitalised: boolean } | null;
  /** The catalog row for whichever name we looked up, when there was one. */
  catalog: CatalogCity | null;
  /** Country for `tableCity`, when the curated table knows it. */
  tableCountry: string | null;
  /** CityCode for `tableCity` + `tableCountry`, when resolvable. */
  tableCityCode: string | null;
  /** locked.destination.name carried in from earlier turns. */
  lockedName: string | null;
  /** The country the user named, when they named one rather than a city. */
  country?: { code: string; name: string } | null;
  /** That country's main city by hotel inventory. */
  countryPrimaryCity?: CatalogCity | null;
}): HotelDestination {
  // 1. The curated table knows this city and it prices — the Dubai path.
  if (input.tableCity && input.tableCountry && input.tableCityCode) {
    return {
      status: "RESOLVED",
      cityName: input.tableCity,
      countryCode: input.tableCountry,
      cityCode: input.tableCityCode,
    };
  }

  // 2. The catalog knows it — London/Tokyo/Paris and ~54k others.
  if (input.catalog) {
    return {
      status: "RESOLVED",
      cityName: input.catalog.name,
      countryCode: input.catalog.countryCode,
      cityCode: input.catalog.code,
    };
  }

  // 3. A COUNTRY was named, not a city. Resolve it to where the inventory
  //    actually is and make the caller disclose the substitution.
  if (input.country && input.countryPrimaryCity) {
    return {
      status: "RESOLVED",
      cityName: input.countryPrimaryCity.name,
      countryCode: input.countryPrimaryCity.countryCode || input.country.code,
      cityCode: input.countryPrimaryCity.code,
      viaCountry: input.country.name,
    };
  }
  // A country we carry no hotels for is a dead end, named honestly.
  if (input.country) {
    return { status: "UNSUPPORTED", cityName: input.country.name };
  }

  // 4. Named, but in NO source — not a city, not a country.
  //
  // UNSUPPORTED regardless of capitalisation. This used to fall through to
  // NO_CITY for a lower-case word, and NO_CITY sends the turn to the model,
  // which reads locked.destination and answers about THAT city — "can you
  // confirm the hotels in qatar" came back as a page of Dubai hotels, an
  // itinerary included. A confidently wrong place is the worst output this lane
  // can produce, so once a place has been named, the turn is answered here and
  // never handed to a model holding a stale destination.
  if (input.named) {
    return { status: "UNSUPPORTED", cityName: input.named.raw };
  }

  // 4. Nothing named this turn. A destination locked earlier still counts, but
  //    only here — never ahead of something the user just said.
  if (input.tableCity || input.lockedName) {
    return { status: "UNSUPPORTED", cityName: (input.tableCity || input.lockedName) as string };
  }

  return { status: "NO_CITY" };
}

/**
 * Full resolution for a hotel-led turn: curated table → global catalog →
 * honest UNSUPPORTED / NO_CITY. Never invents a destination.
 */
export async function resolveHotelDestination(
  prompt: string,
  locked: any,
): Promise<HotelDestination> {
  const tableCity = extractHotelCity(prompt);
  const named = extractNamedPlaceCandidate(prompt);
  const lockedName = locked?.destination?.name ? String(locked.destination.name) : null;

  // ONE local, indexed lookup for whichever name is in play — deliberately NOT
  // resolveCityCodeForCountry, whose live CityList fallback would put a TBO
  // round-trip on the critical path of every hotel-led turn, including ones
  // that go on to fall through to the AI anyway. `tbocities` already holds
  // 53,943 rows; when a name is not in there, a live call would almost never
  // rescue it, and the honest handoff is the right answer regardless.
  // A place named THIS turn is looked up on its own. lockedName is consulted
  // ONLY when nothing was named — otherwise a request for somewhere new would
  // be answered with the city the conversation happens to be holding.
  const lookupName = tableCity || named?.raw || lockedName;
  const catalog = lookupName ? await findCatalogCity(lookupName) : null;

  // Nothing matched as a city — is the named place a COUNTRY? ("hotels in
  // qatar": Qatar is not a city anywhere in the catalog, so every city lookup
  // above misses and the turn used to end up at the model.)
  let country: { code: string; name: string } | null = null;
  let countryPrimaryCity: CatalogCity | null = null;
  if (!catalog && named?.raw) {
    country = await findCountryByName(named.raw);
    if (country) countryPrimaryCity = await findPrimaryCityForCountry(country.code);
  }

  // The curated table stays authoritative for spelling and country when it
  // knows the city; the catalog supplies the code that makes it searchable.
  const tableCountry = tableCity ? countryFor(tableCity) ?? catalog?.countryCode ?? null : null;
  const tableCityCode = tableCity ? catalog?.code ?? null : null;

  return classifyHotelDestination({
    tableCity,
    named,
    // Consumed only when the curated table did not resolve — otherwise branch 1
    // already answered with the canonical name.
    catalog: tableCity && tableCountry && tableCityCode ? null : catalog,
    tableCountry,
    tableCityCode,
    lockedName,
    country,
    countryPrimaryCity,
  });
}
