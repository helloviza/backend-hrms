// apps/backend/src/services/travelMirrorAnalytics.ts
//
// Pure helpers the TravelBooking mirror builders use for Travel Spend's
// analytics fields (Phase B, 2026-11-18):
//   - destinationCity / destinationCountry / isInternational (audit N3)
//   - metadata.carrierShares   Airline share, split by booking
//   - metadata.departTimeIST   Departure time slot, first leg, IST
//
// No I/O — models/ManualBooking.ts, models/SBTBooking.ts and the resync
// script's dry run all call these, so a row written live and one rebuilt by
// the backfill land on identical values.
// The Travel Spend table (base + Phase B additions). Pluto and the location
// service keep using the base table — see TRAVEL_SPEND_EXTRA.
import {
  travelLookup as lookupDestination,
  travelLookupFuzzy as lookupDestinationFuzzy,
  travelCountryFuzzy as lookupCountryFuzzy,
  travelCountryOf as countryOf,
  visaCountryCode,
  railStationCity,
} from "../data/destinationLookup.js";
import { carrierShares, type CarrierShare } from "../utils/airlineNormalize.js";
import { parseClockTime, fmtClock, sbtClockMinutes } from "../utils/flightTime.js";

export type ResolvedDestination = {
  destinationCity: string | null;
  destinationCountry: string | null;
  /** How it was resolved — for the dry-run report only, never stored. */
  tier: "T3" | "route" | "T4" | "visa" | "rail" | "T5-country" | "T6-hotelName" | "none";
};

const VISA_TYPES = new Set(["VISA", "US_VISA_EARLY_APPOINTMENT_FEE"]);
const HOTEL_TYPES = new Set(["HOTEL", "DUMMY_HOTEL"]);
const FLIGHT_TYPES = new Set(["FLIGHT", "FLIGHT_RESCHEDULE", "DUMMY_FLIGHT"]);

export const isManualFlightType = (t: unknown) => FLIGHT_TYPES.has(String(t || "").toUpperCase());

/** Last stop of a route string: "GRU-CDG-AMS" → "AMS", "Delhi-Dubai" → "Dubai". */
export function routeEnd(raw: unknown): string {
  const parts = String(raw ?? "").split(/\s*(?:-|–|,|\/|>|→|\bto\b)\s*/i).map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

/**
 * City / country for a manual booking. Tiers, first hit wins:
 *   visa  VISA rows: country from itinerary.visaCountry (else sector) —
 *         a country ONLY, never a city (decision 2026-11-18). The US visa
 *         early-appointment fee is a US visa by definition.
 *   T3    exact lookup of the mirror's free-text `destination`
 *   route flights: the last stop of a route string ("GRU-CDG-AMS" → AMS)
 *   T4    whole-word city match in itinerary.destination, then sector
 *   rail  TRAIN rows: Indian Railways station code (NDLS, RNC …)
 *   T5    country / state / region name in itinerary.destination or sector
 *   T6    hotels: a city named in the hotel name ("Hilton London")
 */
export function resolveManualDestination(doc: any, destination: string): ResolvedDestination {
  const type = String(doc?.type || "").toUpperCase();
  const it = doc?.itinerary || {};
  if (VISA_TYPES.has(type)) {
    const ctry =
      visaCountryCode(it.visaCountry) ??
      visaCountryCode(it.destination) ??
      visaCountryCode(doc?.sector) ??
      visaCountryCode(routeEnd(doc?.sector)) ??
      (type === "US_VISA_EARLY_APPOINTMENT_FEE" ? "US" : null);
    return { destinationCity: null, destinationCountry: ctry, tier: ctry ? "visa" : "none" };
  }
  const t3 = lookupDestination(destination);
  if (t3 && (t3.city || t3.country)) return { destinationCity: t3.city, destinationCountry: t3.country, tier: "T3" };
  // Flights typed as a route ("GRU-CDG-AMS", "DEL,JAI", "BLR - JFK"): the
  // last stop, exact-matched — never a fuzzy word inside the text.
  if (FLIGHT_TYPES.has(type)) {
    for (const cand of [destination, doc?.sector]) {
      const hit = lookupDestination(routeEnd(cand));
      if (hit && (hit.city || hit.country) && routeEnd(cand) !== String(cand ?? "").trim()) {
        return { destinationCity: hit.city, destinationCountry: hit.country, tier: "route" };
      }
    }
  }
  for (const cand of [it.destination, doc?.sector]) {
    const hit = lookupDestinationFuzzy(cand);
    if (hit?.city) return { destinationCity: hit.city, destinationCountry: hit.country, tier: "T4" };
  }
  if (type === "TRAIN") {
    const city = railStationCity(destination) ?? railStationCity(it.destination);
    if (city) return { destinationCity: city, destinationCountry: "IN", tier: "rail" };
  }
  for (const cand of [it.destination, doc?.sector]) {
    const c = lookupCountryFuzzy(cand);
    if (c) return { destinationCity: null, destinationCountry: c, tier: "T5-country" };
  }
  if (HOTEL_TYPES.has(type) && it.hotelName) {
    const hit = lookupDestinationFuzzy(it.hotelName);
    if (hit?.city) return { destinationCity: hit.city, destinationCountry: hit.country, tier: "T6-hotelName" };
  }
  return { destinationCity: null, destinationCountry: null, tier: "none" };
}

/**
 * International = any leg starts or ends outside India (decision
 * 2026-11-18), so SAN→EWR→DEL counts even though it lands in Delhi.
 * `endpoints` are the codes/names of every leg's origin and destination;
 * `fallbackCountry` is the row's resolved destinationCountry. Unknown
 * endpoints are ignored; if nothing is known the answer is null.
 */
export function internationalFrom(endpoints: unknown[], fallbackCountry: string | null): boolean | null {
  const known = endpoints.map((e) => countryOf(e)).filter((c): c is string => !!c);
  if (fallbackCountry) known.push(fallbackCountry);
  if (!known.length) return null;
  return known.some((c) => c !== "IN");
}

export type FlightAnalytics = {
  carrierShares: CarrierShare[];
  /** First leg's departure, IST clock "HH:MM", or null when not captured. */
  departTimeIST: string | null;
  departMinutesIST: number | null;
  /** The operator ticked "Unknown" for the first leg's time. */
  departTimeUnknown: boolean;
};

/** Manual flight: carriers by leg (or the flat text) + first leg's time. */
export function manualFlightAnalytics(doc: any): FlightAnalytics {
  const it = doc?.itinerary || {};
  const legs = Array.isArray(it.legs) ? it.legs : [];
  const first = legs[0];
  const min = first ? parseClockTime(first.departTime) : null;
  return {
    carrierShares: carrierShares({ airline: it.airline, flightNo: it.flightNo, legs }),
    departTimeIST: min == null ? null : fmtClock(min),
    departMinutesIST: min,
    departTimeUnknown: first?.departTimeUnknown === true && min == null,
  };
}

/** SBT flight: one carrier (airlineName, else code / flight number); IST clock. */
export function sbtFlightAnalytics(doc: any): FlightAnalytics {
  const min = sbtClockMinutes(doc?.departureTime);
  return {
    carrierShares: carrierShares({ airline: doc?.airlineName || doc?.airlineCode, flightNo: doc?.flightNumber }),
    departTimeIST: min == null ? null : fmtClock(min),
    departMinutesIST: min,
    departTimeUnknown: false,
  };
}
