// apps/backend/src/services/hotelCatalogSearch.ts
//
// Hotel city + hotel name typeahead over the LOCAL TBO static catalogue
// (tbocities / tbohotelmasters / tbocountries, refreshed off-peak by
// jobs/static-data-refresh.ts). Shared by the SBT hotel search
// (GET /api/sbt/hotels/cities) and the approval request form
// (GET /api/approvals/search/hotel-cities).
//
// Database only: this module never calls TBO. The SBT route keeps its own
// live fallback for a zero-hit query; the approvals route has none.
//
// Hybrid match: prefix-range query on the searchName_1 index (catches "del" →
// "delhi") + a $text query on the searchName text index (catches mid-string
// words like "marina" in "dubai marina"). Results are merged, deduped, and
// ranked deterministically: exact → prefix → contains, then a soft-priority
// boost for the requested country, then shorter/alphabetical. countryCode is
// NEVER used to filter — only to break ranking ties.

import { TBOCity, TBOHotelMaster, TBOCountry, normalizeSearch } from "../jobs/static-data-refresh.js";

const MAX_PREFIX_CHAR = "￿"; // searchName is normalized to [a-z0-9 ], so this caps any prefix range

export type CatalogCity = {
  code: string;
  name: string;
  countryCode: string;
  countryName: string;
};

export type CatalogHotel = {
  hotelCode: string;
  hotelName: string;
  cityCode: string;
  cityName: string;
  /** As stored on the hotel; "" when the catalogue row has none. */
  countryCode: string;
  /** The hotel's city's country — the fallback when countryCode is "". */
  cityCountryCode: string;
  cityCountryName: string;
  countryName: string;
  rating: string;
};

export function rankByMatch<T extends { searchName?: string; countryCode?: string }>(
  docs: T[],
  nq: string,
  priorityCode: string,
  keyOf: (d: T) => string,
): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const d of docs) {
    const k = keyOf(d);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    deduped.push(d);
  }
  const tier = (sn: string) => (sn === nq ? 0 : sn.startsWith(nq) ? 1 : 2);
  return deduped.sort((a, b) => {
    const sa = a.searchName ?? "";
    const sb = b.searchName ?? "";
    const ta = tier(sa);
    const tb = tier(sb);
    if (ta !== tb) return ta - tb; // exact, then prefix, then contains
    const pa = (a.countryCode ?? "").toUpperCase() === priorityCode ? 0 : 1;
    const pb = (b.countryCode ?? "").toUpperCase() === priorityCode ? 0 : 1;
    if (pa !== pb) return pa - pb; // soft-priority boost within the same tier
    if (sa.length !== sb.length) return sa.length - sb.length; // shorter name first
    return sa.localeCompare(sb);
  });
}

export async function searchHotelCatalog(
  q: string,
  opts: { priorityCode: string; cityCap: number; hotelCap: number },
): Promise<{ cities: CatalogCity[]; hotels: CatalogHotel[] }> {
  const nq = normalizeSearch(q);
  if (!nq) return { cities: [], hotels: [] };

  const POOL = 60; // over-fetch per source, then rank and cap
  const upper = nq + MAX_PREFIX_CHAR;

  // Cities — prefix-range (indexed) + text (indexed), in parallel.
  const [cityPrefix, cityText] = await Promise.all([
    (TBOCity as any).find({ searchName: { $gte: nq, $lt: upper } }).limit(POOL).lean(),
    (TBOCity as any)
      .find({ $text: { $search: nq } })
      .limit(POOL)
      .lean()
      .catch(() => [] as any[]),
  ]);
  const rankedCities = rankByMatch(
    [...cityPrefix, ...cityText],
    nq,
    opts.priorityCode,
    (d: any) => d.code,
  ).slice(0, opts.cityCap);

  // Hotels — same hybrid, separate cap so a hotel-name query still surfaces.
  const [hotelPrefix, hotelText] = await Promise.all([
    (TBOHotelMaster as any).find({ searchName: { $gte: nq, $lt: upper } }).limit(POOL).lean(),
    (TBOHotelMaster as any)
      .find({ $text: { $search: nq } })
      .limit(POOL)
      .lean()
      .catch(() => [] as any[]),
  ]);
  const rankedHotels = rankByMatch(
    [...hotelPrefix, ...hotelText],
    nq,
    opts.priorityCode,
    (d: any) => d.hotelCode,
  ).slice(0, opts.hotelCap);

  if (!rankedCities.length && !rankedHotels.length) return { cities: [], hotels: [] };

  // Resolve display labels: CountryName for both, CityName for hotels (the hotel
  // master stores cityCode but not cityName).
  const countryCodes = new Set<string>();
  for (const c of rankedCities) countryCodes.add(c.countryCode);
  for (const h of rankedHotels) countryCodes.add(h.countryCode);
  const hotelCityCodes = [...new Set(rankedHotels.map((h: any) => h.cityCode).filter(Boolean))];

  const hotelCities: any[] = hotelCityCodes.length
    ? await (TBOCity as any).find({ code: { $in: hotelCityCodes } }).lean()
    : [];
  for (const c of hotelCities) countryCodes.add(c.countryCode);
  const countries: any[] = await (TBOCountry as any).find({ code: { $in: [...countryCodes] } }).lean();

  const countryNameByCode = new Map<string, string>(countries.map((c) => [c.code, c.name]));
  const cityByCode = new Map<string, any>(hotelCities.map((c) => [c.code, c]));

  return {
    cities: rankedCities.map((c: any) => ({
      code: c.code,
      name: c.name,
      countryCode: c.countryCode,
      countryName: countryNameByCode.get(c.countryCode) ?? "",
    })),
    hotels: rankedHotels.map((h: any) => {
      const city = cityByCode.get(h.cityCode);
      return {
        hotelCode: h.hotelCode,
        hotelName: h.hotelName,
        cityCode: h.cityCode,
        cityName: city?.name ?? "",
        countryCode: h.countryCode ?? "",
        cityCountryCode: city?.countryCode ?? "",
        cityCountryName: countryNameByCode.get(city?.countryCode) ?? "",
        countryName: countryNameByCode.get(h.countryCode) ?? "",
        rating: h.rating ?? "",
      };
    }),
  };
}
