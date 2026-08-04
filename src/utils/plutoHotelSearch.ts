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
import { extractPromptDateRange } from "./plutoDate.js";
import { lookupDestination, lookupDestinationFuzzy } from "../data/destinationLookup.js";

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
  /**
   * The property's OWN coordinate, when TBO metadata carried one (step 7 of
   * tbo.hotel.search.service merges HotelCodeEntry.Latitude/Longitude onto every
   * HotelResult). Passing it through is what upgrades a map pin from a city
   * centroid to the real address — no geocoding call, no cost.
   *
   * TBO casing on purpose: coordForHotel reads `Latitude`/`Longitude`, and the
   * rest of this row already keeps TBO field names so buildHotelItem and the SBT
   * detail handoff consume it unchanged.
   *
   * null when absent or unparseable — never a fabricated coordinate, and the map
   * then falls back to the city centroid and labels the pin approximate.
   */
  Latitude: number | null;
  Longitude: number | null;
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
  reason:
    | "NO_AVAILABILITY"
    | "UPSTREAM_ERROR"
    | "BAD_REQUEST"
    /** The city never resolved to a TBO CityCode — we will not guess one. */
    | "CITY_UNRESOLVED"
    | null;
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

/**
 * How many priced properties reach the chat reply — and therefore the tiers,
 * "See all N results" and the reply payload.
 *
 * 12 is the shipped default, kept deliberately: the change here is WHICH twelve
 * (the top of a real ranking, not TBO's first twelve). Raising it widens choice
 * at the cost of reply size; buildHotelTiers surfaces Best + up to 3
 * Alternatives + Not-ideal from whatever it is handed, and the remainder stays
 * reachable behind "See all", so the reconciliation invariant holds at any cap.
 */
export const CHAT_HOTEL_RESULT_CAP = 12;

const POLICY_RANK: Record<string, number> = {
  IN_POLICY: 0,
  NEEDS_APPROVAL: 1,
  OUT_OF_POLICY: 2,
};

/** Cheapest per-night from an ANNOTATED raw TBO row; null when it has no fare. */
function perNightOfRaw(h: any, nights: number): number | null {
  const rooms: any[] = Array.isArray(h?.Rooms) ? h.Rooms : [];
  const fares = rooms
    .map((r) => (typeof r?._displayTotalFare === "number" ? r._displayTotalFare : r?.TotalFare))
    .filter((n) => typeof n === "number" && n > 0) as number[];
  if (fares.length === 0 || nights <= 0) return null;
  return Math.round(Math.min(...fares) / nights);
}

/** Star rating from either the numeric or the string TBO field; null when absent. */
function starOfRaw(h: any): number | null {
  const n = typeof h?.StarRating === "number" ? h.StarRating : Number.parseFloat(String(h?.HotelRating ?? ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Pre-rank the priced pool before it is capped.
 *
 * Order: policy fit first (in-policy → needs-approval → out-of-policy), then
 * cheapest per night, then higher star, then name for a stable sort. Rows with
 * no fare sort last rather than being dropped — the honesty rule is unchanged,
 * a property with no price still reaches the cards and simply renders no price.
 *
 * PURE: no filtering, no mutation, no invented fields.
 */
export function rankHotelsForChat<T extends Record<string, any>>(rows: T[], nights: number): T[] {
  return (Array.isArray(rows) ? rows.slice() : []).sort((a, b) => {
    const pa = POLICY_RANK[String(a?.policy?.status ?? "IN_POLICY")] ?? 1;
    const pb = POLICY_RANK[String(b?.policy?.status ?? "IN_POLICY")] ?? 1;
    if (pa !== pb) return pa - pb;

    const na = perNightOfRaw(a, nights);
    const nb = perNightOfRaw(b, nights);
    if (na !== nb) {
      if (na == null) return 1; // no fare → last
      if (nb == null) return -1;
      return na - nb;
    }

    const sa = starOfRaw(a);
    const sb = starOfRaw(b);
    if ((sa ?? 0) !== (sb ?? 0)) return (sb ?? 0) - (sa ?? 0);

    return String(a?.HotelName ?? "").localeCompare(String(b?.HotelName ?? ""));
  });
}

/**
 * The check-in/check-out pair the hotel ownership gate must decide on.
 *
 * A locked pair wins (set-if-absent semantics: a genuine re-statement does not
 * clobber what the conversation already committed to). Otherwise the dates the
 * user typed THIS turn count — which is the whole first-turn fix: the gate used
 * to read only the locked bag, and the locker runs ~240 lines later, so a
 * first-turn "hotels in Dubai, 25th Sept … 26th Sept 2026" fell through to the
 * AI path and the user had to repeat themselves before the live lane could fire.
 *
 * A single date is NOT enough — a stay needs both ends, and guessing the second
 * would be inventing a fact.
 */
export function resolveHotelSearchWindow(
  prompt: string,
  locked: any,
  now: Date = new Date(),
): { start: string; end: string; source: "locked" | "prompt" } | null {
  const ls = locked?.dates?.start;
  const le = locked?.dates?.end;
  if (ls && le) return { start: String(ls), end: String(le), source: "locked" };

  const fromPrompt = extractPromptDateRange(prompt, now);
  if (fromPrompt?.start && fromPrompt?.end) {
    return { start: fromPrompt.start, end: fromPrompt.end, source: "prompt" };
  }
  return null;
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

/**
 * The city a hotel-led turn is about, else null.
 *
 * Three passes, strongest signal first. The first two are shape-based and the
 * third recognises a known destination anywhere in the sentence:
 *
 *   1. "<hotel word> <connector> <City>" — an explicit, adjacent naming.
 *   2. "… in <City>" anywhere in the prompt.
 *   3. CATALOG FALLBACK — a known city appearing anywhere, whole-word.
 *
 * WHY 3 EXISTS. The two shape patterns alone read only a narrow slice of how
 * people actually write. "Hotel Options for Dubai Stay on 25-26 September 2026"
 * missed BOTH — the connector was "for" (not in the old in|at|near|around list)
 * AND pattern 2 was anchored to end-of-string, so a city followed by dates could
 * never match. The turn returned null, fell back to an empty locked destination,
 * and the whole live lane silently handed the answer to the model, which then
 * invented hotels. Shape-matching free text will always have another hole in it;
 * recognising a KNOWN city does not.
 *
 * EVERY candidate is validated against the destination table, and that is what
 * makes pass 2 safe to unanchor: bare `in <Capitalised>` would otherwise happily
 * return "September". It costs nothing in reach — the ownership gate already
 * requires countryFor() to resolve the city, so a name this table does not know
 * could never have run a search anyway. Validation also canonicalises spelling
 * ("bombay" → "Mumbai") instead of passing raw text to TBO.
 *
 * lookupDestinationFuzzy is reused rather than reimplemented: it is already
 * whole-word, longest-key-wins, and — the property that matters here — it never
 * invents a city that is not in the table. Verified silent on "show me hotels",
 * "hotel options for the best rates", "resort with a spa and a pool".
 *
 * COVERAGE, stated plainly: the table is curated (~280 entries built from real
 * booking destinations). Dubai, Singapore and New York resolve; Tokyo, London,
 * Bangkok and Paris are NOT in it and so resolve to null here — exactly as they
 * already failed at the countryFor() gate. Widening that table is its own task.
 */
export function extractHotelCity(prompt: string): string | null {
  if (!prompt) return null;

  // 1. Adjacent naming. "for"/"to" join the connector list — "hotels for Dubai"
  //    is as explicit as "hotels in Dubai" and used to resolve to nothing.
  const adjacent = prompt.match(
    /\b(?:hotels?|stay|stays|accommodations?|resort|lodging)\s+(?:in|at|near|around|for|to)\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)/,
  );
  // 2. "… in <City>" — no longer anchored to the end of the prompt.
  const loose = prompt.match(/\bin\s+([A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+)?)/);

  for (const m of [adjacent, loose]) {
    const candidate = m?.[1]?.trim();
    if (!candidate) continue;
    // A country/region entry (city:null, e.g. "Vietnam") is NOT a city — skip it
    // rather than sending a region name to TBO as though it were one.
    const known = lookupDestination(candidate);
    if (known?.city) return known.city;
  }

  // 3. Known city anywhere in the sentence. Null when there is none — the
  //    caller then hands off honestly instead of guessing a destination.
  return lookupDestinationFuzzy(prompt)?.city ?? null;
}

/* Words that follow a connector but are never a place. Trailing ones are
 * trimmed ("london for" → "london"); a candidate STARTING with one is not a
 * place at all ("hotels for same duration" → no place was named). */
const NOT_A_PLACE = new Set([
  "for", "on", "from", "to", "with", "and", "the", "a", "an", "in", "at",
  "near", "around", "between", "under", "over", "about", "same", "next",
  "this", "that", "these", "those", "my", "our", "us", "me", "you", "your",
  "please", "some", "any", "all", "more", "less", "cheap", "cheaper",
  "budget", "luxury", "nice", "good", "best", "night", "nights", "day",
  "days", "week", "weekend", "month", "people", "guests", "adults",
  "children", "rooms", "room", "star", "stars", "duration", "dates", "date",
  "there", "here", "somewhere", "anywhere", "options", "option",
  // Counts — "hotels for two nights" trims to "two", which is not a place.
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "couple", "few", "several", "both",
]);

/**
 * The place the user NAMED, whether or not we can serve it — raw text, not a
 * resolved city.
 *
 * extractHotelCity above answers "which city do we search?" and returns null
 * both when the user named nothing AND when they named somewhere we don't
 * know. Those two need different answers: one asks which city, the other says
 * we can't serve that city. This separates them by reporting what was said.
 *
 * Case-INSENSITIVE on purpose. extractHotelCity requires a capital because it
 * uses capitalisation as a proper-noun heuristic, which means a perfectly clear
 * "show me some hotels in london" produced no candidate at all — the exact
 * phrasing that fell through to the model and got answered with a question
 * about dates. `capitalised` is reported separately so the caller can still use
 * that signal where it helps, rather than losing the match outright.
 */
export function extractNamedPlaceCandidate(
  prompt: string,
): { raw: string; capitalised: boolean } | null {
  if (!prompt) return null;

  const patterns = [
    /\b(?:hotels?|stay|stays|accommodations?|accomodations?|resort|lodging)\s+(?:in|at|near|around|for|to)\s+([A-Za-z][A-Za-z]*(?:\s+[A-Za-z][A-Za-z]*)?)/i,
    /\bin\s+([A-Za-z][A-Za-z]*(?:\s+[A-Za-z][A-Za-z]*)?)/i,
  ];

  for (const re of patterns) {
    const m = prompt.match(re);
    const captured = m?.[1]?.trim();
    if (!captured) continue;

    // "london for" → "london";  "same duration" → nothing was named.
    const words = captured.split(/\s+/);
    while (words.length > 0 && NOT_A_PLACE.has(words[words.length - 1].toLowerCase())) {
      words.pop();
    }
    if (words.length === 0) continue;
    if (NOT_A_PLACE.has(words[0].toLowerCase())) continue;

    const raw = words.join(" ");
    return { raw, capitalised: /^[A-Z]/.test(raw) };
  }
  return null;
}

/**
 * Trim a raw TBO HotelResult to the compact bookable row above. Keeps the TBO
 * field NAMES (HotelCode/HotelName/HotelRating/Address/Rooms[]) so the existing
 * buildHotelItem and the SBT detail handoff consume it with no adaptation, and
 * drops the IsDetailedResponse bulk that would bloat a chat reply.
 */
/** TBO sends coordinates as strings. null for anything unparseable. */
function parseCoord(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : null;
}

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
    Latitude: parseCoord(h?.Latitude),
    Longitude: parseCoord(h?.Longitude),
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
  /**
   * TBO CityCode. REQUIRED — searchHotels rejects with HTTP 400 ("CityCode or
   * HotelCodes required") before any network call when it is absent, which is
   * precisely how this lane silently never reached TBO. Resolve it with
   * resolveCityCodeForCountry() and hand off honestly when that returns null,
   * rather than searching with a guessed code.
   */
  cityCode: string;
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

  // No CityCode → searchHotels would return its 400 guard anyway. Fail here so
  // the caller renders the honest handoff instead of burning a TBO round-trip.
  if (!String(args.cityCode || "").trim()) return empty("BAD_REQUEST");

  let result: any;
  try {
    result = await searchHotels({
      CityCode: args.cityCode,
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

  // RANK, then cap. searchHotels prices up to SEARCH_TOP_N (400) codes per city,
  // so the previous unranked `.slice(0, 12)` shipped an ARBITRARY twelve — TBO's
  // batch order — and the tiers below could only re-present that accident.
  // Ranking is OURS to do (TBO returns inventory; deciding what is "best" is the
  // concierge's job, exactly as the flight lane tiers fares TBO merely returned).
  const ranked = rankHotelsForChat(annotated, nights);

  return {
    ok: true,
    reason: null,
    hotels: ranked
      .slice(0, args.limit ?? CHAT_HOTEL_RESULT_CAP)
      .map((h) => mapHotelForChat(h, nights)),
    cityName: result.cityName || args.cityName,
    searchId: result.searchId || "",
  };
}
