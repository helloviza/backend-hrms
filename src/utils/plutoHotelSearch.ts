// apps/backend/src/utils/plutoHotelSearch.ts
//
// Phase 2 — the LIVE hotel lane for the concierge chat turn.
//
// Before this, a hotel question was answered entirely by the model:
// reply.hotels[] was {name, area, approxPrice, whyGood} invented text with no
// HotelCode, no dates, no occupancy — so nothing on the card could be booked and
// the price was fiction. copilot.travel.ts said as much in a comment
// ("intentionally NOT wired … the honest move is to acknowledge + hand off").
//
// This module is the hotel counterpart of plutoFlightSearch: it extracts the
// search from the prompt + locked context, calls the SAME searchHotels service
// that SBT uses, annotates each result with the SAME policy evaluator flights
// use, and returns real, bookable rows. Extracted from the route for unit
// testing, exactly like the flight helper.
//
// Honesty rules baked in here (not left to the caller):
//  - an upstream error / no availability NEVER falls back to invented hotels;
//    the caller renders the honest acknowledge-and-handoff instead
//  - occupancy we had to assume is reported back so the user can correct it
//  - rating is passed through only when the source actually carries one

import { searchHotels, isHotelSearchError } from "../services/tbo.hotel.search.service.js";
import { evaluateHotelPolicy, hotelForPolicyFromResult, type PolicyRules } from "../services/policyEvaluator.js";

/** Compact, bookable hotel row carried on the reply. */
export interface HotelListing {
  // ── Booking identity (what made the old AI cards unbookable) ──
  HotelCode: string;
  HotelName: string;
  Address: string;
  CityName: string;
  /** Kept in the TBO shape so buildHotelItem / the SBT detail page read it directly. */
  HotelRating: string;
  StarRating: number | null;
  Rooms: Array<{
    RoomTypeName: string;
    TotalFare: number;
    _displayTotalFare: number;
    isRefundable: boolean | null;
  }>;
  // ── Derived display fields (all from real data; null when absent) ──
  rating: number | null;
  perNightINR: number | null;
  totalINR: number | null;
  nights: number;
  policy?: { status: string; reasons: string[] };
}

export interface ChatHotelSearchResult {
  ok: boolean;
  /** Why the search could not run / returned nothing. Null on success. */
  reason: "NO_AVAILABILITY" | "UPSTREAM_ERROR" | "BAD_REQUEST" | null;
  hotels: HotelListing[];
  cityName: string;
  searchId: string;
}

/** Whole nights between two ISO dates; 0 when unparseable. */
export function nightsBetween(checkIn?: string, checkOut?: string): number {
  if (!checkIn || !checkOut) return 0;
  const a = Date.parse(checkIn);
  const b = Date.parse(checkOut);
  if (isNaN(a) || isNaN(b) || b <= a) return 0;
  return Math.round((b - a) / 86400000);
}

/** Does this turn ask about somewhere to stay? */
export function isHotelRequest(prompt: string): boolean {
  if (!prompt) return false;
  return /\b(hotels?|stay|stays|accommodations?|accomodations?|resort|lodging|place\s+to\s+stay|where\s+to\s+stay)\b/i.test(
    prompt,
  );
}

/** "5-star", "budget", "boutique" … → a TBO StarRating filter where it maps. */
export function extractStarFilter(prompt: string): number | null {
  if (/\bfive[\s-]?star\b|\b5[\s-]?star\b/i.test(prompt)) return 5;
  if (/\bfour[\s-]?star\b|\b4[\s-]?star\b/i.test(prompt)) return 4;
  if (/\bthree[\s-]?star\b|\b3[\s-]?star\b/i.test(prompt)) return 3;
  if (/\bluxury\b|\bpremium\b/i.test(prompt)) return 5;
  return null;
}

/** "hotels in Dubai", "stay in Tokyo" → the city the user named, else null. */
export function extractHotelCity(prompt: string): string | null {
  const m =
    prompt.match(
      /\b(?:hotels?|stay|stays|accommodations?|resort|lodging)\s+(?:in|at|near|around)\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)/,
    ) || prompt.match(/\bin\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)\s*$/);
  return m ? m[1].trim() : null;
}

/**
 * Trim a raw TBO HotelResult to the compact bookable row above. Keeps the TBO
 * field NAMES (HotelCode/HotelName/HotelRating/Address/Rooms[]) so the existing
 * buildHotelItem and the SBT detail handoff consume it with no adaptation, and
 * drops the IsDetailedResponse bulk that would bloat a chat reply.
 */
export function mapHotelForChat(h: any, nights: number): HotelListing {
  const rooms: any[] = Array.isArray(h?.Rooms) ? h.Rooms : [];
  const cheapest = rooms
    .slice()
    .sort(
      (a, b) =>
        (a?._displayTotalFare ?? a?.TotalFare ?? Infinity) -
        (b?._displayTotalFare ?? b?.TotalFare ?? Infinity),
    )[0];

  const total =
    typeof cheapest?._displayTotalFare === "number"
      ? cheapest._displayTotalFare
      : typeof cheapest?.TotalFare === "number"
        ? cheapest.TotalFare
        : null;

  // Rating ONLY when the source carries one. A missing rating stays null and the
  // card renders nothing — same rule that removed the hardcoded 5 gold stars.
  const numericStar =
    typeof h?.StarRating === "number" && h.StarRating > 0 ? h.StarRating : null;
  const parsedRating = Number.parseFloat(String(h?.HotelRating ?? ""));
  const rating =
    numericStar ?? (Number.isFinite(parsedRating) && parsedRating > 0 ? parsedRating : null);

  return {
    HotelCode: String(h?.HotelCode ?? ""),
    HotelName: String(h?.HotelName ?? "Hotel"),
    Address: String(h?.Address ?? ""),
    CityName: String(h?.CityName ?? ""),
    HotelRating: String(h?.HotelRating ?? ""),
    StarRating: numericStar,
    Rooms: cheapest
      ? [
          {
            RoomTypeName: String(cheapest.RoomTypeName ?? ""),
            TotalFare: Number(cheapest.TotalFare ?? 0) || 0,
            _displayTotalFare: Number(total ?? 0) || 0,
            isRefundable:
              typeof cheapest.isRefundable === "boolean" ? cheapest.isRefundable : null,
          },
        ]
      : [],
    rating,
    perNightINR: total != null && nights > 0 ? Math.round(total / nights) : null,
    totalINR: total,
    nights,
    policy: h?.policy,
  };
}

export interface ChatHotelSearchArgs {
  cityName: string;
  countryCode: string;
  checkIn: string;
  checkOut: string;
  adults: number;
  rooms: number;
  starRating?: number | null;
  guestNationality?: string;
  policyRules?: PolicyRules | null;
  limit?: number;
}

/**
 * Run the live hotel search for a chat turn. NEVER throws: any failure comes
 * back as ok:false with a reason, so the caller can render the honest
 * acknowledge-and-handoff rather than invented hotels.
 */
export async function searchHotelsForChat(
  args: ChatHotelSearchArgs,
): Promise<ChatHotelSearchResult> {
  const nights = nightsBetween(args.checkIn, args.checkOut);
  const empty = (reason: ChatHotelSearchResult["reason"]): ChatHotelSearchResult => ({
    ok: false,
    reason,
    hotels: [],
    cityName: args.cityName,
    searchId: "",
  });

  let result: any;
  try {
    result = await searchHotels({
      CityName: args.cityName,
      CountryCode: args.countryCode,
      CheckIn: args.checkIn,
      CheckOut: args.checkOut,
      GuestNationality: args.guestNationality || "IN",
      Rooms: Array.from({ length: Math.max(1, args.rooms) }, () => ({
        Adults: Math.max(1, args.adults),
        Children: 0,
        ChildrenAges: null,
      })),
      Filters: {
        Refundable: false,
        NoOfRooms: 0,
        MealType: "All",
        ...(args.starRating ? { StarRating: args.starRating } : {}),
      },
    });
  } catch (err: any) {
    console.error("[ConciergeHotels] search threw", { message: err?.message, city: args.cityName });
    return empty("UPSTREAM_ERROR");
  }

  if (isHotelSearchError(result)) {
    if (result.status === 400) return empty("BAD_REQUEST");
    if (result.status === 404) return empty("NO_AVAILABILITY");
    return empty("UPSTREAM_ERROR");
  }

  const raw: any[] = Array.isArray(result.hotels) ? result.hotels : [];
  if (raw.length === 0) return empty("NO_AVAILABILITY");

  // Policy annotation is ADDITIVE and never filters — identical to flights.
  const annotated = raw.map((h) => ({
    ...h,
    policy: evaluateHotelPolicy(hotelForPolicyFromResult(h, nights), args.policyRules ?? null),
  }));

  return {
    ok: true,
    reason: null,
    hotels: annotated.slice(0, args.limit ?? 12).map((h) => mapHotelForChat(h, nights)),
    cityName: result.cityName || args.cityName,
    searchId: result.searchId || "",
  };
}
