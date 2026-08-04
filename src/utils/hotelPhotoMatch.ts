// apps/backend/src/utils/hotelPhotoMatch.ts
//
// The confidence gate between a TBO hotel row and a Google Places result.
//
// WHY THIS EXISTS. Places `searchText` ALWAYS returns something for a plausible
// query — ask it for "Elite Byblos Hotel Dubai" and, if that property is not in
// its index, it will happily hand back a different Dubai hotel. Rendering that
// photo on the card would caption someone else's building with the name and the
// price of the property the user is about to book. That is a worse lie than the
// gradient placeholder, and it is the same class of fiction the 5-star default
// and the stock-photo ban were about.
//
// So a photo is only ever used when the match is CHECKABLE:
//   · the names agree on their distinctive words, AND
//   · where TBO gave us the property's own coordinate, the Places result is
//     physically at the same address
//
// Anything else resolves to "no photo" and the card keeps its placeholder.
//
// Pure — no network, no Places SDK — so the gate is unit-testable without a key.

/** Words that carry no identity: every second hotel has them. */
const GENERIC = new Set([
  "hotel", "hotels", "resort", "resorts", "the", "by", "and", "a", "an", "of",
  "at", "in", "spa", "inn", "suites", "suite", "apartments", "apartment",
  "residences", "residence", "tower", "towers", "collection", "group",
]);

/**
 * Lowercase, strip diacritics and punctuation, collapse whitespace.
 * "Mövenpick Hotel & Apartments — Bur Dubai" → "movenpick hotel apartments bur dubai"
 */
export function normalizeHotelName(raw: string): string {
  return String(raw || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The tokens that actually identify a property (generic words removed). */
export function distinctiveTokens(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of normalizeHotelName(raw).split(" ")) {
    if (!t || GENERIC.has(t) || t.length < 2) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export interface NameMatch {
  /** 0..1 containment over distinctive tokens. */
  score: number;
  /** How many distinctive tokens the two names share. */
  shared: number;
}

/**
 * Containment rather than Jaccard, on purpose.
 *
 * TBO and Places disagree about how much of the address belongs in the name —
 * "Radisson Blu Hotel, Dubai Deira Creek" vs "Radisson Blu Dubai Deira Creek".
 * Jaccard punishes the longer string for being more specific; containment asks
 * the question we actually care about: does the shorter name appear inside the
 * longer one?
 */
export function nameSimilarity(a: string, b: string): NameMatch {
  const ta = distinctiveTokens(a);
  const tb = distinctiveTokens(b);
  if (ta.length === 0 || tb.length === 0) return { score: 0, shared: 0 };

  const setB = new Set(tb);
  let shared = 0;
  for (const t of ta) if (setB.has(t)) shared++;

  return { score: shared / Math.min(ta.length, tb.length), shared };
}

/** Great-circle distance in metres. */
export function haversineMeters(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export interface MatchInput {
  /** The name on the TBO row — what the card will display. */
  tboName: string;
  /** The property's own coordinate, when TBO carried one. */
  tboLat?: number | null;
  tboLon?: number | null;
  /** The candidate from Places. */
  placeName: string;
  placeLat?: number | null;
  placeLon?: number | null;
}

export interface MatchVerdict {
  confident: boolean;
  score: number;
  distanceM: number | null;
  /** Why it was rejected — logged and returned, never guessed at later. */
  reason: string;
}

/** A coordinate TBO/Places could actually mean. (0,0) is the classic null sentinel. */
function usableCoord(lat?: number | null, lon?: number | null): boolean {
  if (typeof lat !== "number" || typeof lon !== "number") return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat === 0 && lon === 0) return false;
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/* Thresholds. Deliberately asymmetric: a verified coordinate buys tolerance on
 * the name, and the absence of one costs it. */
const NEAR_M = 400;          // same address, allowing for rooftop-vs-entrance
const SAME_AREA_M = 1500;    // same block; needs a much better name agreement
const SCORE_NEAR = 0.5;
const SCORE_SAME_AREA = 0.75;
const SCORE_NO_COORD = 0.85; // nothing to verify against — name must be near-exact

/**
 * The gate. `confident: false` means the card keeps its placeholder.
 *
 * The no-coordinate branch also demands two shared distinctive tokens, so a
 * single-word property ("Armani") cannot clear the bar on one lucky token.
 */
export function isConfidentMatch(input: MatchInput): MatchVerdict {
  const { score, shared } = nameSimilarity(input.tboName, input.placeName);

  const haveBoth =
    usableCoord(input.tboLat, input.tboLon) && usableCoord(input.placeLat, input.placeLon);

  const distanceM = haveBoth
    ? haversineMeters(
        input.tboLat as number, input.tboLon as number,
        input.placeLat as number, input.placeLon as number,
      )
    : null;

  if (distanceM != null) {
    if (distanceM > SAME_AREA_M) {
      return { confident: false, score, distanceM, reason: "too_far" };
    }
    const needed = distanceM <= NEAR_M ? SCORE_NEAR : SCORE_SAME_AREA;
    if (score < needed) {
      return { confident: false, score, distanceM, reason: "name_mismatch" };
    }
    return { confident: true, score, distanceM, reason: "ok" };
  }

  // No coordinate to check against — the name has to carry the whole burden.
  if (score < SCORE_NO_COORD || shared < 2) {
    return { confident: false, score, distanceM: null, reason: "name_mismatch_no_coord" };
  }
  return { confident: true, score, distanceM: null, reason: "ok_no_coord" };
}
