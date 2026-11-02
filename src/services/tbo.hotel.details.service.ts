// apps/backend/src/services/tbo.hotel.details.service.ts
//
// TBO HotelDetails (static content: images, facilities, description) and its
// in-memory caches. Moved out of routes/sbt.hotels.ts (/images, /details) so
// the approval hotel-content endpoint can use the same fetch and caches; the
// routes keep their own gates and response shapes.
import { logTBOCall } from "../utils/tboFileLogger.js";
import { TBO_URLS } from "../config/tboUrls.js";
import { hotelStaticAuthHeader } from "./tbo.hotel.shared.js";

const hotelDetailsCache = new Map<string, { data: any; ts: number }>();
const DETAILS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Per-hotel-code image cache (keyed by single hotel code, NOT the batch string).
// Only successful non-empty image URLs are cached — empties/timeouts are never
// stored, so a transient failure can't pin a hotel to "no image" for hours.
const hotelImageCache = new Map<string, { url: string; ts: number }>();
const IMAGE_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours

/** TBO sends Images as strings or {Url}; keep the non-empty URLs. */
export const imageUrlsOf = (imgs: any[]): string[] =>
  imgs.map((img: any) => (typeof img === "string" ? img : (img.Url || img.url || ""))).filter(Boolean);

/**
 * The first image of each hotel, per-code cached. Never throws: a TBO failure
 * (after ONE retry) leaves those hotels out of the map.
 */
export async function fetchHotelImages(codes: string[]): Promise<Record<string, string>> {
  // Serve fresh per-code cache hits immediately; only fetch the misses.
  const imageMap: Record<string, string> = {};
  const now = Date.now();
  const missCodes: string[] = [];
  for (const code of codes) {
    const hit = hotelImageCache.get(code);
    if (hit && now - hit.ts < IMAGE_CACHE_TTL) {
      imageMap[code] = hit.url;
    } else {
      missCodes.push(code);
    }
  }

  if (missCodes.length) {
    const tboPayload = {
      Hotelcodes: missCodes.join(","),
      Language: "en",
      IsRoomDetailRequired: false,
    };

    // Fetch HotelDetails with ONE retry on timeout/throw, so a single
    // transient failure doesn't blank a whole batch of hotels.
    const fetchOnce = async (): Promise<any[] | null> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      try {
        const t0 = Date.now();
        const tboRes = await fetch(TBO_URLS.HOTEL_DETAILS, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: hotelStaticAuthHeader(),
          },
          body: JSON.stringify(tboPayload),
          signal: controller.signal,
        });
        const data: any = await tboRes.json();
        logTBOCall({
          method: "HotelImages",
          traceId: `hotel-images-${missCodes[0]}`,
          request: tboPayload,
          response: { hotelCount: data?.HotelDetails?.length ?? 0 },
          durationMs: Date.now() - t0,
        });
        return data?.HotelDetails || data?.Hotels || [];
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    };

    let hotels = await fetchOnce();
    if (hotels === null) hotels = await fetchOnce(); // single retry

    // Build map from the response and cache only successful non-empty results.
    for (const h of hotels || []) {
      const code = h.HotelCode || h.TBOHotelCode || "";
      const imageUrls = imageUrlsOf(h.Images || []);
      if (code && imageUrls.length > 0) {
        imageMap[code] = imageUrls[0];
        hotelImageCache.set(code, { url: imageUrls[0], ts: Date.now() });
      }
    }
  }

  return imageMap;
}

/**
 * TBO's HotelDetails body for a hotelCodes string (rooms included), Images
 * flattened to URLs, cached per that exact string. Throws on a TBO failure;
 * failures are never cached.
 */
export async function fetchHotelDetails(hotelCodes: string): Promise<any> {
  // Check cache first (keyed by hotelCodes string)
  const cached = hotelDetailsCache.get(hotelCodes);
  if (cached && Date.now() - cached.ts < DETAILS_CACHE_TTL) {
    return cached.data;
  }

  const tboPayload = { Hotelcodes: hotelCodes, Language: "en", IsRoomDetailRequired: true };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  let data: any;
  try {
    const t0 = Date.now();
    const tboRes = await fetch(
      TBO_URLS.HOTEL_DETAILS,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: hotelStaticAuthHeader(),
        },
        body: JSON.stringify(tboPayload),
        signal: controller.signal,
      }
    );
    data = await tboRes.json();
    logTBOCall({ method: "HotelDetails", traceId: `hotel-details-${hotelCodes.split(",")[0]}`, request: tboPayload, response: data, durationMs: Date.now() - t0 });
  } finally {
    clearTimeout(timeout);
  }

  // Normalize Images arrays to string URLs
  const hotelList: any[] = data?.HotelDetails || data?.Hotels || [];
  for (const h of hotelList) {
    if (Array.isArray(h.Images)) {
      h.Images = imageUrlsOf(h.Images);
    }
  }

  hotelDetailsCache.set(hotelCodes, { data, ts: Date.now() });
  return data;
}

// Per-hotel-code static content (no rooms) for the approval hotel-content
// endpoint. Like the image cache: only hotels TBO actually returned are cached.
const hotelContentCache = new Map<string, { hotel: any; ts: number }>();

/**
 * TBO's HotelDetails entry per hotel code, without room details, per-code
 * cached. Never throws: a TBO failure (after ONE retry) leaves those hotels
 * out of the map.
 */
export async function fetchHotelContent(codes: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  const now = Date.now();
  const missCodes: string[] = [];
  for (const code of codes) {
    const hit = hotelContentCache.get(code);
    if (hit && now - hit.ts < DETAILS_CACHE_TTL) out.set(code, hit.hotel);
    else missCodes.push(code);
  }
  if (!missCodes.length) return out;

  const tboPayload = { Hotelcodes: missCodes.join(","), Language: "en", IsRoomDetailRequired: false };
  const fetchOnce = async (): Promise<any[] | null> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const t0 = Date.now();
      const tboRes = await fetch(TBO_URLS.HOTEL_DETAILS, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: hotelStaticAuthHeader() },
        body: JSON.stringify(tboPayload),
        signal: controller.signal,
      });
      const data: any = await tboRes.json();
      logTBOCall({
        method: "HotelContent",
        traceId: `hotel-content-${missCodes[0]}`,
        request: tboPayload,
        response: { hotelCount: data?.HotelDetails?.length ?? 0 },
        durationMs: Date.now() - t0,
      });
      return data?.HotelDetails || data?.Hotels || [];
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };

  let hotels = await fetchOnce();
  if (hotels === null) hotels = await fetchOnce(); // single retry

  const wanted = new Set(missCodes);
  for (const h of hotels || []) {
    const code = String(h?.HotelCode || h?.TBOHotelCode || "");
    if (!wanted.has(code)) continue;
    out.set(code, h);
    hotelContentCache.set(code, { hotel: h, ts: Date.now() });
  }
  return out;
}
