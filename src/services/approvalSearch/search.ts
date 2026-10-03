// apps/backend/src/services/approvalSearch/search.ts
//
// Live TBO search for the approval request form. Calls the SAME exported
// services SBT and the concierge use (searchFlights, searchHotels) and
// returns ONLY the price-free shapes from ./selection.ts. Raw results (prices
// included) are stored in ApprovalSearchSession; each option carries an
// opaque optionRef the request form attaches to a cart item.
//
// Outcomes:
//   200 { ok: true, ... }                         real results, or a real empty
//                                                 result with a "No ... found" message
//   400 { error, code }                           bad input / city not found
//   503 { error: UNAVAILABLE, code }              TBO error, exception or 30 s timeout
// A TBO failure is never reported as "no results".
//
// Order is never TBO's (TBO sorts by price): flights by departure time,
// hotels by stars then name, rooms by name.

import type { Types } from "mongoose";
import { searchFlights } from "../tbo.flight.service.js";
import { searchHotels } from "../tbo.hotel.search.service.js";
import { TBOCity, TBOHotelMaster, normalizeSearch } from "../../jobs/static-data-refresh.js";
import { createSearchSession, optionRefFor } from "./optionRef.js";
import {
  toFlightSelection,
  toInboundOption,
  toHotelSearchResult,
  parseStars,
  type FlightSelection,
  type FlightTripKind,
  type HotelSearchResult,
} from "./selection.js";

export const SEARCH_TIMEOUT_MS = 30_000;
/** Imran D14: a requester's hotel search prices at most 100 hotels. */
export const HOTEL_SEARCH_CAP = 100;
/** Per direction; keeps one session document well under Mongo's 16 MB. */
export const FLIGHT_OPTIONS_CAP = 200;

export const UNAVAILABLE = "Live search unavailable — enter details manually";

export type SearchReply = { status: number; body: Record<string, any> };

type Caller = { userId: string; workspaceId: Types.ObjectId | string };

const unavailable = (code: string): SearchReply => ({ status: 503, body: { error: UNAVAILABLE, code } });
const bad = (error: string, code = "BAD_REQUEST"): SearchReply => ({ status: 400, body: { error, code } });

class SearchTimeout extends Error {}

// APPROVAL_SEARCH_TIMEOUT_MS exists for tests only.
const timeoutMs = () => Number(process.env.APPROVAL_SEARCH_TIMEOUT_MS) || SEARCH_TIMEOUT_MS;

async function withTimeout<T>(p: Promise<T>, ms = timeoutMs()): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SearchTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const IATA = /^[A-Za-z]{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const int = (v: unknown, dflt: number, min: number, max: number) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

// Form cabin names → TBO FlightCabinClass.
const CABIN_CODE: Record<string, number> = {
  economy: 2,
  "premium economy": 3,
  business: 4,
  "premium business": 5,
  first: 6,
};

const firstDeparture = (r: any): string => String(r?.Segments?.[0]?.[0]?.Origin?.DepTime ?? "");
const byDeparture = (a: any, b: any) => firstDeparture(a).localeCompare(firstDeparture(b));

/* ── flights ─────────────────────────────────────────────────────────────── */

export async function searchFlightsForApproval(input: any, caller: Caller): Promise<SearchReply> {
  const origin = String(input?.origin ?? "").trim().toUpperCase();
  const destination = String(input?.destination ?? "").trim().toUpperCase();
  const departDate = String(input?.departDate ?? "").trim();
  const tripType = String(input?.tripType ?? "oneway").toLowerCase();
  const returnDate = String(input?.returnDate ?? "").trim();

  if (tripType === "multicity") {
    return bad("Live search covers one-way and return trips. Describe multi-city legs in the notes.", "MULTICITY_NOT_SUPPORTED");
  }
  if (!IATA.test(origin) || !IATA.test(destination)) return bad("Pick the origin and destination airports from the list.");
  if (origin === destination) return bad("Origin and destination must be different.");
  if (!DAY.test(departDate)) return bad("Enter a departure date.");
  const isReturn = tripType === "roundtrip";
  if (isReturn && (!DAY.test(returnDate) || returnDate < departDate)) {
    return bad("Enter a return date on or after the departure date.");
  }

  const adults = int(input?.adults, 1, 1, 9);
  const children = int(input?.children, 0, 0, 8);
  const infants = int(input?.infants, 0, 0, adults);
  const cabinClass = CABIN_CODE[String(input?.cabinClass ?? "").trim().toLowerCase()] ?? 2;
  const params = { origin, destination, departDate, ...(isReturn ? { returnDate } : {}), adults, children, infants, cabinClass };

  let result: any;
  try {
    result = await withTimeout(
      searchFlights({ ...params, JourneyType: isReturn ? 2 : 1 }),
    );
  } catch (err) {
    return unavailable(err instanceof SearchTimeout ? "SEARCH_TIMEOUT" : "TBO_ERROR");
  }

  const resp = result?.Response;
  const status = resp?.ResponseStatus ?? resp?.Status;
  const resultsArr: any[] = Array.isArray(resp?.Results) ? resp.Results : [];
  if (!resp || (status !== undefined && status !== 1)) {
    // TBO answers "no flights" with a non-success status and a "No Result" message.
    const msg = String(resp?.Error?.ErrorMessage ?? "");
    if (!/no\s*result/i.test(msg) || resultsArr.length) return unavailable("TBO_ERROR");
    return { status: 200, body: { ok: true, tripKind: isReturn ? "RT_DOM" : "OW", outbound: [], inbound: [], message: "No flights found" } };
  }

  const flat = (x: any): any[] => (Array.isArray(x) ? x.flatMap((i: any) => (Array.isArray(i) ? i : [i])) : []);
  const isDomesticReturn = isReturn && resultsArr.length >= 2 && Array.isArray(resultsArr[1]);
  const outRaw = (isDomesticReturn ? flat(resultsArr[0]) : flat(resultsArr)).sort(byDeparture).slice(0, FLIGHT_OPTIONS_CAP);
  const inRaw = isDomesticReturn ? flat(resultsArr[1]).sort(byDeparture).slice(0, FLIGHT_OPTIONS_CAP) : [];

  const tripKind: FlightTripKind = isDomesticReturn ? "RT_DOM" : isReturn ? "RT_INTL" : "OW";

  if (!outRaw.length) {
    return { status: 200, body: { ok: true, tripKind, outbound: [], inbound: [], message: "No flights found" } };
  }

  const session = await createSearchSession({
    workspaceId: caller.workspaceId,
    userId: caller.userId,
    kind: "flight",
    params,
    traceId: String(resp?.TraceId ?? ""),
    results: [...outRaw, ...inRaw],
  });
  const searchedAt = session.createdAt ?? new Date();

  const outbound: FlightSelection[] = outRaw.map((raw, i) =>
    toFlightSelection({ out: raw, optionRef: optionRefFor(session.sid, i), searchedAt }),
  );
  const inbound: FlightSelection[] = inRaw.map((raw, j) =>
    toInboundOption({ raw, optionRef: optionRefFor(session.sid, outRaw.length + j), searchedAt }),
  );

  return {
    status: 200,
    body: {
      ok: true,
      tripKind,
      outbound,
      inbound,
      searchedAt: searchedAt.toISOString(),
      ...(isDomesticReturn && !inbound.length ? { message: "No return flights found" } : {}),
    },
  };
}

/* ── hotels ──────────────────────────────────────────────────────────────── */

type CatalogCityRef = { code: string; name: string; countryCode: string };

/**
 * Typed city → TBO city from the local catalog (exact name first, then
 * prefix; shortest name wins). countryCode null = any country.
 */
export async function findCatalogCity(cityText: string, countryCode: string | null): Promise<CatalogCityRef | null> {
  const q = normalizeSearch(cityText);
  if (!q) return null;
  const inCountry = countryCode ? { countryCode } : {};
  const exact: any = await (TBOCity as any).findOne({ ...inCountry, searchName: q }).select("code name countryCode").lean();
  if (exact) return { code: String(exact.code), name: String(exact.name), countryCode: String(exact.countryCode) };
  const prefixed: any[] = await (TBOCity as any)
    .find({ ...inCountry, searchName: { $gte: q, $lt: `${q}￿` } })
    .select("code name searchName countryCode")
    .limit(20)
    .lean();
  if (!prefixed.length) return null;
  prefixed.sort((a, b) => String(a.searchName).length - String(b.searchName).length);
  return { code: String(prefixed[0].code), name: String(prefixed[0].name), countryCode: String(prefixed[0].countryCode) };
}

/**
 * The city to search: a picked catalogue city (cityCode) or the picked
 * hotel's city (hotelCode), else the typed text — an older draft's free-text
 * city — in the given country, or India first and then any country.
 */
async function resolveSearchCity(input: any): Promise<{ city: CatalogCityRef; hotelCode: string } | SearchReply> {
  const notFound = bad("City not found — check spelling", "CITY_NOT_FOUND");
  const hotelCode = String(input?.hotelCode ?? "").trim();
  let cityCode = String(input?.cityCode ?? "").trim();

  if (hotelCode) {
    const hotel: any = await (TBOHotelMaster as any).findOne({ hotelCode }).select("cityCode").lean();
    if (!hotel) return bad("That hotel isn't in our catalogue — pick it again from the list.", "HOTEL_NOT_FOUND");
    cityCode ||= String(hotel.cityCode || "");
  }

  if (cityCode) {
    const c: any = await (TBOCity as any).findOne({ code: cityCode }).select("code name countryCode").lean();
    if (!c) return notFound;
    return { city: { code: String(c.code), name: String(c.name), countryCode: String(c.countryCode) }, hotelCode };
  }

  const cityText = String(input?.city ?? "").trim();
  if (!cityText) return bad("Enter a city.");
  const given = String(input?.countryCode ?? "").trim().toUpperCase();
  const city = given
    ? await findCatalogCity(cityText, given)
    : (await findCatalogCity(cityText, "IN")) || (await findCatalogCity(cityText, null));
  return city ? { city, hotelCode } : notFound;
}

function paxRooms(rooms: number, adults: number, children: number) {
  const out = Array.from({ length: rooms }, () => ({ Adults: 1, Children: 0, ChildrenAges: null as number[] | null }));
  for (let a = rooms; a < adults; a++) out[a % rooms].Adults++;
  if (children > 0) {
    out[0].Children = children;
    out[0].ChildrenAges = Array.from({ length: children }, () => 8);
  }
  return out;
}

export async function searchHotelsForApproval(input: any, caller: Caller): Promise<SearchReply> {
  const checkIn = String(input?.checkIn ?? "").trim();
  const checkOut = String(input?.checkOut ?? "").trim();

  if (!["city", "cityCode", "hotelCode"].some((k) => String(input?.[k] ?? "").trim())) return bad("Enter a city.");
  if (!DAY.test(checkIn) || !DAY.test(checkOut) || checkOut <= checkIn) {
    return bad("Enter a check-out date after the check-in date.");
  }
  const rooms = int(input?.rooms, 1, 1, 6);
  const adults = Math.max(rooms, int(input?.adults, 1, 1, 24));
  const children = int(input?.children, 0, 0, 6);

  const resolved = await resolveSearchCity(input);
  if ("status" in resolved) return resolved;
  const { city, hotelCode: pickedCode } = resolved;
  const countryCode = city.countryCode;

  // Top 100 of the city's catalog hotels by stars → priced by TBO. Same catalog
  // the SBT search ranks from; the cap is applied before TBO is called. A
  // picked hotel is always priced, even when it is outside the top 100.
  const catalog: any[] = await (TBOHotelMaster as any)
    .find({ cityCode: city.code })
    .select("hotelCode hotelName rating address")
    .lean();
  catalog.sort((a, b) => (parseStars(b.rating) ?? 0) - (parseStars(a.rating) ?? 0));
  const top = catalog.slice(0, HOTEL_SEARCH_CAP);
  const picked = pickedCode ? catalog.find((h) => String(h.hotelCode) === pickedCode) : undefined;
  if (picked && !top.includes(picked)) top.splice(HOTEL_SEARCH_CAP - 1, 1, picked);
  const meta = new Map(top.map((h) => [String(h.hotelCode), h]));

  const params = {
    CityCode: city.code,
    CityName: city.name,
    CountryCode: countryCode,
    CheckIn: checkIn,
    CheckOut: checkOut,
    GuestNationality: "IN",
    Rooms: paxRooms(rooms, adults, children),
  };

  let result: any;
  try {
    result = await withTimeout(
      searchHotels(top.length ? { ...params, HotelCodes: [...meta.keys()] } : params),
    );
  } catch (err) {
    return unavailable(err instanceof SearchTimeout ? "SEARCH_TIMEOUT" : "TBO_ERROR");
  }

  if (!result?.ok) {
    if (result?.status === 404) {
      return { status: 200, body: { ok: true, city: { name: city.name, countryCode }, hotels: [], message: "No hotels found" } };
    }
    if (result?.status === 400) return bad(String(result.error || "Check the search details."));
    return unavailable("TBO_ERROR");
  }

  const hotels: any[] = (Array.isArray(result.hotels) ? result.hotels : [])
    .map((h: any) => {
      const m = meta.get(String(h?.HotelCode));
      return m
        ? { ...h, HotelName: m.hotelName || h.HotelName, HotelRating: m.rating || h.HotelRating, Address: m.address || h.Address, CityName: city.name }
        : { ...h, CityName: h.CityName || city.name };
    })
    .filter((h: any) => Array.isArray(h?.Rooms) && h.Rooms.length)
    .sort(
      (a: any, b: any) =>
        (parseStars(b.HotelRating) ?? 0) - (parseStars(a.HotelRating) ?? 0) ||
        String(a.HotelName ?? "").localeCompare(String(b.HotelName ?? "")),
    );
  // The picked hotel goes first; the rest of its city follows.
  const pinnedAt = pickedCode ? hotels.findIndex((h: any) => String(h?.HotelCode) === pickedCode) : -1;
  if (pinnedAt > 0) hotels.unshift(...hotels.splice(pinnedAt, 1));
  hotels.splice(HOTEL_SEARCH_CAP);
  const pin = !pickedCode
    ? {}
    : pinnedAt >= 0
      ? { pinnedHotelCode: pickedCode }
      : { message: `${picked?.hotelName || "The hotel you picked"} has no rooms for these dates — showing other hotels in ${city.name}.` };

  if (!hotels.length) {
    return { status: 200, body: { ok: true, city: { name: city.name, countryCode }, hotels: [], message: "No hotels found" } };
  }

  const session = await createSearchSession({
    workspaceId: caller.workspaceId,
    userId: caller.userId,
    kind: "hotel",
    params: { ...params, checkIn, checkOut },
    results: hotels,
  });

  const out: HotelSearchResult[] = hotels.map((hotel, i) =>
    toHotelSearchResult({ hotel, refFor: (j) => optionRefFor(session.sid, i, j), checkIn, checkOut }),
  );

  return {
    status: 200,
    body: { ok: true, city: { name: city.name, countryCode }, hotels: out, ...pin, searchedAt: (session.createdAt ?? new Date()).toISOString() },
  };
}
