// apps/backend/src/services/placeAttractions.service.ts
//
// Server-side cache for the Pluto right panel's "For you in <city>" and "Get
// inspired" carousels. Places (New) bills per call, so a city is only ever
// queried live once per TTL window — every render, every user, every chat
// landing on the same city reads the same cached rows.
//
// Cache shape mirrors cityImage.service.ts's SBTConfig key/value pattern, but
// with a TTL: an attraction roster (unlike a resolved photo) can legitimately
// go stale — a place closes, a rating drifts — so 7 days is "sensible" rather
// than "forever".

import SBTConfig from "../models/SBTConfig.js";
import { placesLogger } from "../utils/logger.js";

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const REGION_CODE = (process.env.GOOGLE_PLACES_REGION || "IN").toUpperCase();
const LANGUAGE_CODE = process.env.GOOGLE_PLACES_LANGUAGE || "en";

const CACHE_KEY = "place-attractions";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Flat placeId → photoName index, written alongside the per-city cache.
// This is what lets the PHOTO be served over a PUBLIC route (an <img> cannot
// send the Authorization header this router requires — see
// places.photo.public.ts's own note on why the hotel photo endpoint had to
// become public) without that public route accepting an arbitrary Places
// photo name from the caller. It only ever resolves a placeId we already
// looked up ourselves; it can never trigger a fresh Places call, so an
// unauthenticated caller cannot spend our Places budget on a place we never
// searched for.
const PHOTO_INDEX_KEY = "place-attraction-photos";

export interface AttractionItem {
  id: string;
  name: string;
  /** Human-readable Places type, e.g. "Tourist attraction", "Brewery". Null when Google didn't return one. */
  category: string | null;
  /** Raw Places photo resource name ("places/{id}/photos/{photoId}") — NOT a URL. The route builds the proxy URL per-request. */
  photoName: string | null;
  rating: number | null;
}

export interface CityAttractions {
  forYou: AttractionItem[];
  inspired: AttractionItem[];
  fetchedAt: number;
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const inFlight = new Map<string, Promise<CityAttractions | null>>();

async function readCache(slug: string): Promise<CityAttractions | null> {
  const doc = await SBTConfig.findOne({ key: CACHE_KEY }).lean();
  const map = (doc?.value as Record<string, CityAttractions>) ?? {};
  const entry = map[slug];
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null; // stale — refetch as a miss
  return entry;
}

async function writeCache(slug: string, data: CityAttractions): Promise<void> {
  await SBTConfig.findOneAndUpdate(
    { key: CACHE_KEY },
    { $set: { [`value.${slug}`]: data } },
    { upsert: true },
  );
}

async function writePhotoIndex(items: AttractionItem[]): Promise<void> {
  const withPhotos = items.filter((i) => i.id && i.photoName);
  if (withPhotos.length === 0) return;
  const set: Record<string, string> = {};
  for (const i of withPhotos) set[`value.${i.id}`] = i.photoName as string;
  await SBTConfig.findOneAndUpdate({ key: PHOTO_INDEX_KEY }, { $set: set }, { upsert: true });
}

/**
 * CACHE ONLY — the public photo route's one allowed lookup. Never triggers a
 * Places call; a miss here just means "we haven't looked this place up",
 * which the route treats as a normal 404.
 */
export async function getCachedAttractionPhotoName(placeId: string): Promise<string | null> {
  const id = String(placeId || "").trim();
  if (!id) return null;
  const doc = await SBTConfig.findOne({ key: PHOTO_INDEX_KEY }).lean();
  const map = (doc?.value as Record<string, string>) ?? {};
  return map[id] ?? null;
}

async function searchText(textQuery: string, includedType?: string): Promise<any[]> {
  if (!API_KEY) return [];
  const body: Record<string, unknown> = {
    textQuery,
    regionCode: REGION_CODE,
    languageCode: LANGUAGE_CODE,
  };
  if (includedType) body.includedType = includedType;

  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": API_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.primaryTypeDisplayName,places.photos,places.rating",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    placesLogger.warn("attractions searchText failed", { textQuery, status: r.status });
    return [];
  }
  const data: any = await r.json();
  return Array.isArray(data?.places) ? data.places : [];
}

function toItem(p: any): AttractionItem {
  const photos: any[] = Array.isArray(p?.photos) ? p.photos : [];
  return {
    id: String(p?.id || ""),
    name: String(p?.displayName?.text || ""),
    category: p?.primaryTypeDisplayName?.text || null,
    photoName: typeof photos[0]?.name === "string" ? photos[0].name : null,
    rating: typeof p?.rating === "number" ? p.rating : null,
  };
}

async function fetchAndStore(city: string, slug: string): Promise<CityAttractions | null> {
  try {
    // Two DIFFERENT Places queries, not one list split in two:
    //  · "For you"      — the tourist_attraction type filter, Google's own
    //                      category for sightseeing spots.
    //  · "Get inspired" — an unfiltered, landmark/experience-worded query,
    //                      which in practice surfaces museums, monuments,
    //                      parks and neighbourhoods the type filter alone
    //                      misses.
    // Both still draw on the same underlying Places corpus for a city, so a
    // well-known attraction can legitimately show up in both raw result
    // sets — the seen-id filter below is what actually guarantees two
    // non-overlapping top-10s, not the differently-worded query alone.
    const [forYouRaw, inspiredRaw] = await Promise.all([
      searchText(`Top attractions in ${city}`, "tourist_attraction"),
      searchText(`Iconic landmarks and must-see experiences in ${city}`),
    ]);

    const forYou = forYouRaw.map(toItem).filter((i) => i.id && i.name).slice(0, 10);
    const seen = new Set(forYou.map((i) => i.id));
    const inspired = inspiredRaw
      .map(toItem)
      .filter((i) => i.id && i.name && !seen.has(i.id))
      .slice(0, 10);

    const data: CityAttractions = { forYou, inspired, fetchedAt: Date.now() };
    await Promise.all([writeCache(slug, data), writePhotoIndex([...forYou, ...inspired])]);
    return data;
  } catch (err: any) {
    placesLogger.warn("attractions resolve error", { city, error: err?.message });
    return null;
  }
}

/**
 * Resolve top-10 "for you" + "get inspired" attraction cards for a city.
 * Cache-first (7-day TTL); collapses concurrent misses for the same city into
 * one live fetch.
 */
export async function resolveCityAttractions(city: string): Promise<CityAttractions | null> {
  const name = (city || "").trim();
  if (!name) return null;
  const slug = slugify(name);
  if (!slug) return null;

  const cached = await readCache(slug);
  if (cached) {
    // Keep the photo index in sync even on a cache HIT — cheap, idempotent
    // upsert — so the index can never drift out of sync with the 7-day
    // attraction cache (e.g. if it were ever cleared independently).
    await writePhotoIndex([...cached.forYou, ...cached.inspired]);
    return cached;
  }

  const existing = inFlight.get(slug);
  if (existing) return existing;

  const p = fetchAndStore(name, slug).finally(() => inFlight.delete(slug));
  inFlight.set(slug, p);
  return p;
}
