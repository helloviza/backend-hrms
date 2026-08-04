// apps/backend/src/services/hotelPhotoService.ts
//
// Resolves a TBO hotel row to a Google Places PHOTO REFERENCE — cached, gated,
// and never blocking a hotel answer.
//
// ONE PLACES CALL PER COLD HOTEL, NOT TWO. The obvious shape is Find Place →
// Place Details → photo_reference. It is unnecessary here: Places API (New)
// `places:searchText` returns `places.photos` in the SAME response as the id
// and the location, and routes/places.ts is already on that API. So a cold
// lookup costs exactly one Text Search; the image itself is fetched later by
// the browser through the existing key-safe photo proxy.
//
// The key never leaves this process — same rule, same env var, same reason as
// routes/places.ts: GOOGLE_PLACES_API_KEY is a server-side secret and would be
// readable by every visitor if it were resolved in the frontend bundle.

import HotelPhotoCache, { photoExpiryFor } from "../models/HotelPhotoCache.js";
import { isConfidentMatch } from "../utils/hotelPhotoMatch.js";

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const LANGUAGE_CODE = process.env.GOOGLE_PLACES_LANGUAGE || "en";

/** Places is a dependency, not a gate: it gets one short window, then we fall back. */
const PLACES_TIMEOUT_MS = 4000;
/** How far around the TBO coordinate to bias the text search. */
const BIAS_RADIUS_M = 3000;

export interface HotelPhotoRequest {
  hotelCode: string;
  hotelName: string;
  city?: string | null;
  lat?: number | null;
  lon?: number | null;
}

export interface HotelPhotoResult {
  /** Places photo resource name, or null when nothing usable was found. */
  photoName: string | null;
  /** "cache" | "places" | "disabled" — surfaced so the route can be observed. */
  source: "cache" | "places" | "disabled";
  reason: string;
}

const NOTHING = (reason: string, source: HotelPhotoResult["source"] = "places"): HotelPhotoResult =>
  ({ photoName: null, source, reason });

/**
 * A Places photo resource name and NOTHING else: `places/<id>/photos/<ref>`.
 *
 * This is the anti-SSRF guard. The photo endpoints build a Google URL by
 * interpolating this value, so without a strict shape check a caller could walk
 * the path (`../../`) and reach other googleapis endpoints WITH OUR API KEY
 * attached. Anchored, two segments, no slashes or dots inside a segment, and
 * length-capped.
 *
 * Applied on the way OUT of the cache as well as on the way in — a value that
 * somehow got stored malformed still never reaches fetch().
 */
// Real references run ~330 chars; the cap is a sanity bound, not a filter, so
// it sits well clear of that. Too tight would silently drop valid photos.
const PHOTO_NAME_RE = /^places\/[A-Za-z0-9_-]{1,256}\/photos\/[A-Za-z0-9_-]{1,1024}$/;

export function isValidPlacesPhotoName(name: unknown): name is string {
  return typeof name === "string" && PHOTO_NAME_RE.test(name);
}

/** Bounds the image size a caller may ask Google for. */
export function clampPhotoWidth(v: unknown): number {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return 640;
  return Math.min(1600, Math.max(160, n));
}

/**
 * The cached photo reference for a hotel — CACHE ONLY, never a live lookup.
 *
 * This is what the PUBLIC image endpoint is allowed to do. It cannot trigger a
 * Places Text Search, so no unauthenticated caller can make us spend on
 * resolution; the most an abusive caller can reach is a photo we already
 * resolved and verified for a hotel someone legitimately searched.
 */
export async function getCachedPhotoName(hotelCode: string): Promise<string | null> {
  const code = String(hotelCode || "").trim();
  if (!code) return null;
  try {
    const hit = await HotelPhotoCache.findOne(
      { hotelCode: code, status: "resolved" },
      { photoName: 1 },
    ).lean();
    const name = hit?.photoName;
    return isValidPlacesPhotoName(name) ? name : null;
  } catch (e: any) {
    console.error("[hotelPhoto] cache read failed", e?.message);
    return null;
  }
}

/** Fetches the image bytes for an ALREADY-VALIDATED photo name. */
export async function fetchPlacesPhoto(
  photoName: string,
  maxWidthPx: number,
): Promise<{ redirectTo?: string; body?: Buffer; contentType?: string } | null> {
  if (!API_KEY || !isValidPlacesPhotoName(photoName)) return null;

  const url = new URL(`https://places.googleapis.com/v1/${photoName}/media`);
  url.searchParams.set("maxWidthPx", String(maxWidthPx));

  // Belt and braces: even after the regex, refuse anything that did not stay on
  // the Places host and under the media path.
  if (url.hostname !== "places.googleapis.com" || !url.pathname.endsWith("/media")) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLACES_TIMEOUT_MS);
  try {
    const r = await fetch(url.toString(), {
      method: "GET",
      headers: { "X-Goog-Api-Key": API_KEY },
      redirect: "manual",
      signal: controller.signal,
    });
    const location = r.headers.get("location");
    if (location) return { redirectTo: location };
    if (!r.ok) return null;
    return {
      body: Buffer.from(await r.arrayBuffer()),
      contentType: r.headers.get("content-type") || "image/jpeg",
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * In-flight de-duplication.
 *
 * Twelve cards mount at once and several may ask for the SAME HotelCode (the
 * ranked spine shows one property in more than one tier). Without this, the
 * cache is still cold for all of them and every request issues its own Text
 * Search. Collapsing concurrent callers onto one promise is the difference
 * between one billed call and four for the same property.
 */
const inFlight = new Map<string, Promise<HotelPhotoResult>>();

function usable(n: unknown): number | null {
  const x = typeof n === "number" ? n : Number.parseFloat(String(n ?? ""));
  if (!Number.isFinite(x)) return null;
  return x;
}

/** The Places Text Search. Returns candidates, or [] on any failure. */
async function searchPlaces(req: HotelPhotoRequest): Promise<any[]> {
  const textQuery = [req.hotelName, req.city].filter(Boolean).join(", ");

  const body: any = {
    textQuery,
    includedType: "lodging",
    languageCode: LANGUAGE_CODE,
    maxResultCount: 5,
  };

  // Bias to the property's own coordinate when we have it. This is what makes a
  // one-call lookup accurate: without it, "Marina Hotel" matches a Marina Hotel
  // on another continent.
  const lat = usable(req.lat);
  const lon = usable(req.lon);
  if (lat != null && lon != null && !(lat === 0 && lon === 0)) {
    body.locationBias = {
      circle: { center: { latitude: lat, longitude: lon }, radius: BIAS_RADIUS_M },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLACES_TIMEOUT_MS);
  try {
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": API_KEY as string,
        // Minimal field mask — Places bills by the fields requested.
        "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.photos",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!r.ok) return [];
    const data: any = await r.json();
    return Array.isArray(data?.places) ? data.places : [];
  } catch {
    // Timeout, network, abort — the card keeps its placeholder.
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** The uncached path: search, gate, persist (hit AND miss), return. */
async function resolveFresh(req: HotelPhotoRequest): Promise<HotelPhotoResult> {
  const candidates = await searchPlaces(req);

  if (candidates.length === 0) {
    await persist(req.hotelCode, "none", null, null, null, null, null, "no_candidates");
    return NOTHING("no_candidates");
  }

  // Best CONFIDENT candidate — not simply the first. Places orders by its own
  // relevance, which is not the same question as "is this the same building".
  let best: { place: any; score: number; distanceM: number | null } | null = null;
  let lastReason = "name_mismatch";

  for (const p of candidates) {
    const verdict = isConfidentMatch({
      tboName: req.hotelName,
      tboLat: usable(req.lat),
      tboLon: usable(req.lon),
      placeName: String(p?.displayName?.text || ""),
      placeLat: usable(p?.location?.latitude),
      placeLon: usable(p?.location?.longitude),
    });
    if (!verdict.confident) { lastReason = verdict.reason; continue; }
    if (!best || verdict.score > best.score) {
      best = { place: p, score: verdict.score, distanceM: verdict.distanceM };
    }
  }

  if (!best) {
    // A candidate existed but could not be verified as THIS property. Falling
    // back is the whole point: a confident-looking wrong photo is worse than
    // the placeholder.
    await persist(req.hotelCode, "none", null, null, null, null, null, lastReason);
    return NOTHING(lastReason);
  }

  const photos: any[] = Array.isArray(best.place?.photos) ? best.place.photos : [];
  const photoName = typeof photos[0]?.name === "string" ? photos[0].name : null;
  const placeId = typeof best.place?.id === "string" ? best.place.id : null;
  const matchedName = String(best.place?.displayName?.text || "") || null;

  if (!photoName) {
    // Matched the right building, but Places holds no photo of it.
    await persist(req.hotelCode, "none", null, placeId, matchedName, best.score, best.distanceM, "matched_no_photo");
    return NOTHING("matched_no_photo");
  }

  await persist(req.hotelCode, "resolved", photoName, placeId, matchedName, best.score, best.distanceM, "ok");
  return { photoName, source: "places", reason: "ok" };
}

async function persist(
  hotelCode: string,
  status: "resolved" | "none",
  photoName: string | null,
  placeId: string | null,
  matchedName: string | null,
  matchScore: number | null,
  matchDistanceM: number | null,
  reason: string,
): Promise<void> {
  try {
    await HotelPhotoCache.updateOne(
      { hotelCode },
      {
        $set: {
          status, photoName, placeId, matchedName, matchScore, matchDistanceM, reason,
          resolvedAt: new Date(),
          expiresAt: photoExpiryFor(status),
        },
      },
      { upsert: true },
    );
  } catch (e: any) {
    // A cache write failure must not fail the request — it only costs a repeat
    // lookup next time.
    console.error("[hotelPhoto] cache write failed", e?.message);
  }
}

/**
 * The entry point. Cache first, then one gated Places call, then persist.
 *
 * Never throws: every failure path degrades to `photoName: null`, which the
 * card renders as its styled placeholder.
 */
export async function getHotelPhotoName(req: HotelPhotoRequest): Promise<HotelPhotoResult> {
  if (!API_KEY) return NOTHING("places_key_missing", "disabled");
  const hotelCode = String(req.hotelCode || "").trim();
  if (!hotelCode || !String(req.hotelName || "").trim()) return NOTHING("bad_request", "disabled");

  try {
    const hit = await HotelPhotoCache.findOne({ hotelCode }).lean();
    if (hit) {
      return {
        photoName: hit.status === "resolved" ? hit.photoName ?? null : null,
        source: "cache",
        reason: hit.reason || hit.status,
      };
    }
  } catch (e: any) {
    // Cache unreachable — fall through and ask Places rather than 500.
    console.error("[hotelPhoto] cache read failed", e?.message);
  }

  const pending = inFlight.get(hotelCode);
  if (pending) return pending;

  const p = resolveFresh({ ...req, hotelCode })
    .catch((e: any) => {
      console.error("[hotelPhoto] resolve failed", e?.message);
      return NOTHING("resolve_failed");
    })
    .finally(() => { inFlight.delete(hotelCode); });

  inFlight.set(hotelCode, p);
  return p;
}
