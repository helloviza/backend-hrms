// TBO hotel search service. Single source of truth for the hotel search flow
// — called by both /api/sbt/hotels/search and /api/v1/copilot/travel/hotels/search
// so concierge and SBT see byte-for-byte identical TBO results.
//
// Output is margin-applied. The route layer is responsible for any side-effects
// like writing to a search cache or registering BookingCode timestamps.

import { randomUUID } from "crypto";
import { logTBOCall } from "../utils/tboFileLogger.js";
import {
  type HotelCity,
} from "../shared/cities.js";
import {
  resolveCityCode as resolveCityCodeAgainstCatalog,
  TBOHotelMaster,
} from "../jobs/static-data-refresh.js";
import {
  type HotelCodeEntry,
  cityCache,
  fetchCityList,
  fetchHotelCodeList,
  hotelAuthHeader,
  hotelNameIndex,
  validatePaxRooms,
  normalizeRoom,
  chunk,
  CITY_CACHE_TTL,
} from "./tbo.hotel.shared.js";
import {
  getMarginConfig,
  applyMargin,
  applyMarginWithFloor,
} from "../utils/margin.js";
import { sbtLogger } from "../utils/logger.js";
import { TBO_URLS } from "../config/tboUrls.js";

// Re-export the cityCache for backward compat if anything imports it from here.
// Anything new should import directly from tbo.hotel.shared.
export { cityCache, CITY_CACHE_TTL };

export interface HotelSearchInput {
  CityCode?: string;
  CityName?: string;
  CheckIn: string;
  CheckOut: string;
  Rooms?: any[];
  GuestNationality?: string;
  CountryCode?: string;
  HotelCodes?: string[];
  Filters?: {
    Refundable?: boolean;
    NoOfRooms?: number;
    MealType?: string;
    StarRating?: number;
  };
}

export interface HotelSearchOutput {
  ok: true;
  hotels: any[];
  searchId: string;
  searchTs: number;
  cityName: string;
  countryCode: string;
  apiErrorBatches: number;
  totalBatches: number;
  marginPct: number;
}

export type HotelSearchError =
  | { ok: false; status: 400; error: string }
  | { ok: false; status: 404; code: "NO_HOTELS_FOUND"; message: string }
  | { ok: false; status: 502; code: "HOTEL_API_ERROR"; message: string };

export function isHotelSearchError(
  r: HotelSearchOutput | HotelSearchError,
): r is HotelSearchError {
  return r.ok === false;
}

const ALLOWED_MEAL_TYPES = new Set([
  "All", "Room_Only", "BreakFast", "Half_Board",
  "Full_Board", "All_Inclusive_All_Meal",
]);

// Phase 4 perf fix: price only the top-N best hotels (by star rating) read from
// the local catalog, instead of the full live city code list (3.5k–13k codes →
// ~49–134 serial batches). 400 codes → ~4 batches → ~1 wave. Tunable.
// NOTE: hotels ranked below SEARCH_TOP_N do NOT appear until pagination lands.
const SEARCH_TOP_N = 400;

// Phase 4 perf lever 1: how many TBO /Search pricing calls run in parallel.
// Each pricing call is TBO-server-bound (p50 ~1.5s, p90 ~11s), NOT network-bound,
// so overlapping more of them shrinks wall-clock. 400 codes / 100 per batch = 4
// batches, so anything >=4 prices Dubai in a single wave. Kept env-tunable so we
// can dial it up/down WITHOUT a redeploy if TBO rate-limits (watch logs for 429 /
// throttle). Start moderate (16); do not max out blindly.
const SEARCH_MAX_CONCURRENT = (() => {
  const n = Number(process.env.SBT_SEARCH_MAX_CONCURRENT);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 16;
})();

// Guardrail: retry a pricing batch that TBO throttles (HTTP 429/503) instead of
// silently dropping those ~100 hotels. Small exponential backoff with jitter.
const SEARCH_BATCH_MAX_RETRIES = (() => {
  const n = Number(process.env.SBT_SEARCH_BATCH_MAX_RETRIES);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 2;
})();

// TBO stores star rating as an enum string ("FiveStar".."OneStar", "All" =
// unrated) in the static catalog, but some rows/sources carry a bare integer.
// Normalize both to 0–5 (unknown → 0, sorts last) for top-N ranking.
const RATING_WORD: Record<string, number> = {
  fivestar: 5, fourstar: 4, threestar: 3, twostar: 2, onestar: 1,
};
function ratingToInt(r: unknown): number {
  if (typeof r === "number" && Number.isFinite(r)) return r;
  const s = String(r ?? "").trim().toLowerCase();
  if (!s) return 0;
  const n = Number(s);
  if (Number.isFinite(n) && n > 0) return n;
  return RATING_WORD[s] ?? 0;
}

/**
 * Run a TBO hotel search end-to-end:
 *  1. Resolve hotel codes (direct list, or city → fetchHotelCodeList)
 *  2. Drift-correct CityCode against TBO's live CityList if CityName given
 *  3. Validate PaxRooms + Filters
 *  4. Fan out parallel batched TBO Search calls (chunks of 100, max 5 concurrent)
 *  5. Dedupe by HotelCode, merge metadata, sort by cheapest TotalFare
 *  6. Apply workspace margin (RSP-floor aware) and return
 *
 * No side-effects on shared caches — the caller decides whether to register
 * BookingCode timestamps for session-age validation.
 */
export async function searchHotels(
  input: HotelSearchInput,
): Promise<HotelSearchOutput | HotelSearchError> {
  const {
    CityCode,
    CityName,
    CheckIn,
    CheckOut,
    Rooms,
    GuestNationality = "IN",
    CountryCode = "IN",
    HotelCodes: directHotelCodes,
    Filters,
  } = input;

  const directCodes: string[] = Array.isArray(directHotelCodes) ? directHotelCodes : [];

  if (!directCodes.length && !CityCode) {
    return { ok: false, status: 400, error: "CityCode or HotelCodes required" };
  }
  if (!CheckIn || !CheckOut) {
    return { ok: false, status: 400, error: "CheckIn and CheckOut required" };
  }

  // 1. Build hotel metadata map and collect codes to search
  const hotelMeta = new Map<string, HotelCodeEntry>();
  let allCodes: string[];

  if (directCodes.length) {
    for (const entry of hotelNameIndex) {
      if (directCodes.includes(entry.HotelCode)) hotelMeta.set(entry.HotelCode, entry);
    }
    allCodes = directCodes;
  } else {
    let resolvedCityCode = CityCode!;
    const requestCityName = String(CityName || "").trim();
    if (requestCityName) {
      try {
        const cities = await fetchCityList(CountryCode);
        const tboCities = cities.map((c) => ({ Code: c.CityId, Name: c.CityName }));
        const resolved = resolveCityCodeAgainstCatalog(
          { cityName: requestCityName, countryCode: CountryCode, cityId: CityCode } as HotelCity,
          tboCities,
        );
        if (resolved && resolved !== CityCode) {
          sbtLogger.info(
            `[SEARCH] Resolved ${CountryCode}/${requestCityName} → CityCode ${resolved} (request had ${CityCode} — drift corrected)`,
          );
          resolvedCityCode = resolved;
        }
      } catch (resolveErr) {
        sbtLogger.warn(
          `[SEARCH] resolveCityCode failed for ${CountryCode}/${requestCityName}; using request CityCode ${CityCode}`,
          { err: resolveErr instanceof Error ? resolveErr.message : String(resolveErr) },
        );
      }
    }
    // PRIMARY (Phase 4): read the city's hotel codes from the local catalog
    // (tbohotelmasters), rank by star rating desc, and price only the TOP-N.
    // Step-1 verification confirmed the resolved cityCode equals the cityCode
    // under which the catalog holds each city's hotels.
    let catalogHotels: any[] = [];
    try {
      catalogHotels = await (TBOHotelMaster as any)
        .find({ cityCode: resolvedCityCode })
        .select("hotelCode hotelName rating address latitude longitude countryCode")
        .lean();
    } catch (dbErr) {
      sbtLogger.warn("[SEARCH] tbohotelmasters read failed — using live fallback", {
        cityCode: resolvedCityCode,
        err: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }

    if (catalogHotels.length > 0) {
      catalogHotels.sort((a, b) => ratingToInt(b.rating) - ratingToInt(a.rating));
      const top = catalogHotels.slice(0, SEARCH_TOP_N);
      for (const h of top) {
        hotelMeta.set(String(h.hotelCode), {
          HotelCode: String(h.hotelCode),
          HotelName: h.hotelName || "",
          HotelRating: String(h.rating ?? ""),
          Address: h.address || "",
          Latitude: String(h.latitude ?? ""),
          Longitude: String(h.longitude ?? ""),
          CityName: CityName || "",
          CountryName: "",
          CountryCode: h.countryCode || CountryCode,
        });
      }
      allCodes = top.map((h) => String(h.hotelCode));
      sbtLogger.info(
        `[SEARCH] Catalog top-N: city ${resolvedCityCode} has ${catalogHotels.length} hotels — pricing top ${allCodes.length} (cap ${SEARCH_TOP_N})`,
      );
    } else {
      // FALLBACK: catalog miss (unrefreshed city) → existing live code list.
      sbtLogger.info(
        `[SEARCH] tbohotelmasters returned 0 codes for city ${resolvedCityCode}/${CountryCode} — falling back to live fetchHotelCodeList`,
      );
      const hotelList = await fetchHotelCodeList(resolvedCityCode, CountryCode);
      if (!hotelList.length) {
        return {
          ok: true,
          hotels: [],
          searchId: randomUUID(),
          searchTs: Date.now(),
          cityName: CityName || "",
          countryCode: CountryCode,
          apiErrorBatches: 0,
          totalBatches: 0,
          marginPct: 0,
        };
      }
      // Safety net: the live list is uncapped (dense cities return thousands of
      // codes → many waves → 30s+). Rank by rating desc and price only the
      // top-N, exactly like the catalog path above, so no search ever prices
      // more than SEARCH_TOP_N hotels regardless of catalog coverage.
      const rankedList = [...hotelList].sort(
        (a, b) => ratingToInt(b.HotelRating) - ratingToInt(a.HotelRating),
      );
      const topList = rankedList.slice(0, SEARCH_TOP_N);
      for (const h of topList) hotelMeta.set(h.HotelCode, h);
      allCodes = topList.map((h) => h.HotelCode);
      sbtLogger.info(
        `[SEARCH] Fallback top-N: city ${resolvedCityCode}/${CountryCode} live list has ${hotelList.length} hotels — pricing top ${allCodes.length} (cap ${SEARCH_TOP_N})`,
      );
    }
  }

  // 2. Chunk codes
  const chunks = chunk(allCodes, 100);

  // 3. PaxRooms
  const PaxRooms = (Rooms || [{ Adults: 1, Children: 0, ChildrenAges: null }]).map(
    (r: any) => ({
      Adults: r.Adults ?? r.adults ?? 1,
      Children: r.Children ?? r.children ?? 0,
      ChildrenAges: r.ChildrenAges || r.childrenAges || null,
    }),
  );

  const paxError = validatePaxRooms(PaxRooms);
  if (paxError) {
    return { ok: false, status: 400, error: paxError };
  }

  // 4. Filters
  const reqFilters = Filters ?? {};
  if (reqFilters.MealType && !ALLOWED_MEAL_TYPES.has(reqFilters.MealType)) {
    return { ok: false, status: 400, error: "Invalid meal type filter." };
  }
  const filtersPayload: Record<string, unknown> = {
    Refundable: reqFilters.Refundable === true,
    NoOfRooms: Number.isFinite(Number(reqFilters.NoOfRooms)) ? Number(reqFilters.NoOfRooms) : 0,
    MealType: typeof reqFilters.MealType === "string" && reqFilters.MealType.length > 0
      ? reqFilters.MealType
      : "All",
  };
  if (Number.isFinite(Number(reqFilters.StarRating))) {
    filtersPayload.StarRating = Number(reqFilters.StarRating);
  }

  // 5. Fan-out TBO Search calls (SEARCH_MAX_CONCURRENT in parallel per wave)
  const MAX_CONCURRENT = SEARCH_MAX_CONCURRENT;
  let allResults: any[] = [];
  let apiErrorBatches = 0;
  let totalBatches = 0;
  let throttledRetries = 0;
  const searchTraceId = `hotel-search-${randomUUID().slice(0, 8)}`;

  for (let i = 0; i < chunks.length; i += MAX_CONCURRENT) {
    const batch = chunks.slice(i, i + MAX_CONCURRENT);
    const promises = batch.map(async (hotelCodeChunk, batchIdx) => {
      const tboPayload = {
        CheckIn,
        CheckOut,
        HotelCodes: hotelCodeChunk.join(","),
        GuestNationality,
        PaxRooms,
        ResponseTime: 23,
        IsDetailedResponse: true,
        Filters: filtersPayload,
      };
      const t0 = Date.now();
      let attempt = 0;
      for (;;) {
        try {
          const r = await fetch(TBO_URLS.SEARCH, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: hotelAuthHeader(),
            },
            body: JSON.stringify(tboPayload),
          });
          // Guardrail: TBO throttle → retry with backoff rather than dropping
          // these ~100 hotels into apiErrorBatches. Honor Retry-After if sent.
          if ((r.status === 429 || r.status === 503) && attempt < SEARCH_BATCH_MAX_RETRIES) {
            const retryAfterMs = Number(r.headers.get("retry-after")) * 1000;
            const backoff = Number.isFinite(retryAfterMs) && retryAfterMs > 0
              ? retryAfterMs
              : 400 * 2 ** attempt + Math.floor(Math.random() * 200);
            console.warn(
              `[hotel-search] TBO throttle (HTTP ${r.status}) on batch ${i + batchIdx}, attempt ${attempt + 1}/${SEARCH_BATCH_MAX_RETRIES} — retrying in ${backoff}ms`,
            );
            throttledRetries++;
            attempt++;
            await new Promise((res) => setTimeout(res, backoff));
            continue;
          }
          const data = await r.json();
          logTBOCall({
            method: `HotelSearch_batch${i + batchIdx}`,
            traceId: searchTraceId,
            request: tboPayload,
            response: r.ok ? data : { httpStatus: r.status, body: data },
            durationMs: Date.now() - t0,
          });
          return data;
        } catch {
          logTBOCall({
            method: `HotelSearch_batch${i + batchIdx}`,
            traceId: searchTraceId,
            request: tboPayload,
            response: { error: "fetch failed" },
            durationMs: Date.now() - t0,
          });
          return null;
        }
      }
    });
    const results = await Promise.all(promises);
    for (const r of results) {
      totalBatches++;
      const d = r as any;
      const enrichRooms = (hotel: any) => {
        if (Array.isArray(hotel?.Rooms)) {
          hotel.Rooms = hotel.Rooms.map((rm: any) => normalizeRoom(rm));
        }
        return hotel;
      };
      if (d?.HotelResult) {
        for (const h of d.HotelResult) allResults.push(enrichRooms(h));
      } else if (d?.HotelSearchResult?.HotelResults) {
        for (const h of d.HotelSearchResult.HotelResults) allResults.push(enrichRooms(h));
      } else if (d == null || (d.ResponseStatus !== undefined && d.ResponseStatus !== 1)) {
        apiErrorBatches++;
      }
    }
  }

  console.info(
    `[hotel-search] Fan-out done: ${totalBatches} batch(es), concurrency=${MAX_CONCURRENT}, ` +
      `waves=${Math.ceil(chunks.length / MAX_CONCURRENT)}, throttledRetries=${throttledRetries}, ` +
      `apiErrorBatches=${apiErrorBatches}`,
  );

  // 6. Dedupe by HotelCode (spec line 21)
  {
    const seen = new Set<string>();
    const deduped: any[] = [];
    let duplicateCount = 0;
    for (const hotel of allResults) {
      const code = String(hotel?.HotelCode ?? "");
      if (!code) continue;
      if (seen.has(code)) {
        duplicateCount++;
        continue;
      }
      seen.add(code);
      deduped.push(hotel);
    }
    if (duplicateCount > 0) {
      console.warn(
        `[hotel-search] Deduped ${duplicateCount} duplicate HotelCode(s) across ${chunks.length} parallel batches`,
      );
    }
    allResults = deduped;
  }

  // 7. Merge metadata
  for (const hotel of allResults) {
    const meta = hotelMeta.get(hotel.HotelCode);
    if (meta) {
      hotel.HotelName = meta.HotelName;
      hotel.HotelRating = meta.HotelRating;
      hotel.Address = meta.Address;
      hotel.Latitude = meta.Latitude;
      hotel.Longitude = meta.Longitude;
      hotel.CityName = meta.CityName;
      hotel.CountryName = meta.CountryName;
    }
  }

  // 8. Sort by cheapest room TotalFare
  allResults.sort((a, b) => {
    const fa = a.Rooms?.[0]?.TotalFare ?? a.TotalFare ?? a.MinimumRate ?? Infinity;
    const fb = b.Rooms?.[0]?.TotalFare ?? b.TotalFare ?? b.MinimumRate ?? Infinity;
    return fa - fb;
  });

  // 9. Empty / all-error case
  if (allResults.length === 0) {
    if (apiErrorBatches > 0 && totalBatches > 0 && apiErrorBatches >= totalBatches) {
      return {
        ok: false,
        status: 502,
        code: "HOTEL_API_ERROR",
        message: "Hotel search service is temporarily unavailable. Please try again.",
      };
    }
    return {
      ok: false,
      status: 404,
      code: "NO_HOTELS_FOUND",
      message: "No hotels found for selected dates. Please try different dates or destination.",
    };
  }

  // 10. Margin (RSP-floor aware)
  const margins = await getMarginConfig();
  const isHotelDomestic = (CountryCode || "IN") === "IN";
  const marginPct = margins.enabled
    ? (isHotelDomestic ? margins.hotel.domestic : margins.hotel.international)
    : 0;
  const hotelsWithMargin: any[] = allResults.map((hotel: any) => ({
    ...hotel,
    Rooms: hotel.Rooms?.map((room: any) => {
      const net = room.TotalFare ?? 0;
      const markupAmount = marginPct > 0 ? applyMargin(net, marginPct) - net : 0;
      const _rsp = typeof room.recommendedSellingRate === "number"
        ? room.recommendedSellingRate
        : null;
      const _displayTotalFare = applyMarginWithFloor(net, marginPct, _rsp);
      const _rspClamped = _rsp != null && _rsp > applyMargin(net, marginPct);
      return {
        ...room,
        _netAmount: room.NetAmount ?? net,
        _markupAmount: markupAmount,
        _displayTotalFare,
        _marginPercent: marginPct,
        _rsp,
        _rspClamped,
      };
    }),
  }));

  return {
    ok: true,
    hotels: hotelsWithMargin,
    searchId: randomUUID(),
    searchTs: Date.now(),
    cityName: CityName || "",
    countryCode: CountryCode,
    apiErrorBatches,
    totalBatches,
    marginPct,
  };
}
