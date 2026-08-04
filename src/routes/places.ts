// apps/backend/src/routes/places.ts
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  getHotelPhotoName,
  isValidPlacesPhotoName,
  clampPhotoWidth,
} from "../services/hotelPhotoService.js";

// EVERY ROUTE IN THIS FILE IS AUTHENTICATED. The one public Places endpoint —
// the hotel photo an <img> loads — lives in routes/places.photo.public.ts,
// deliberately separated so this router can keep the billable searchText and
// Details proxies behind requireAuth. Do not add a public route here.
const router = Router();
router.use(requireAuth);

const API_KEY = process.env.GOOGLE_PLACES_API_KEY;
const REGION_CODE = (process.env.GOOGLE_PLACES_REGION || "IN").toUpperCase(); // IN
const LANGUAGE_CODE = process.env.GOOGLE_PLACES_LANGUAGE || "en"; // en

if (!API_KEY) {
  console.warn("⚠️ GOOGLE_PLACES_API_KEY is not set");
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`Missing or invalid param: ${name}`);
  }
  return v.trim();
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOrEmpty(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function bool(v: unknown): boolean {
  return Boolean(v);
}

function safeEncode(v: string) {
  return encodeURIComponent(v);
}

/**
 * Build a URL that works regardless of how this router is mounted
 * e.g. app.use("/api/places", router) => req.baseUrl = "/api/places"
 */
function buildPhotoProxyUrl(req: any, photoName: string, maxWidth = 800) {
  const base = String(req?.baseUrl || "");
  return `${base}/hotels/photo?name=${safeEncode(photoName)}&maxWidth=${maxWidth}`;
}

/**
 * POST /api/places/hotels/search
 * Proxy for Places API (New): places:searchText
 *
 * Body: { query: "Mumbai" }
 * Returns: { hotels: [...] }
 */
router.post("/hotels/search", async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ message: "Places key not configured" });

    const queryRaw = req.body?.query;
    const query = requireString(queryRaw, "query");

    // Force "hotels in <city>" behavior when user types just city name.
    const textQuery = /hotel/i.test(query) ? query : `Hotels in ${query}`;

    const url = "https://places.googleapis.com/v1/places:searchText";

    const body = {
      textQuery,
      includedType: "hotel",
      regionCode: REGION_CODE,
      languageCode: LANGUAGE_CODE,
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": API_KEY,
        // ✅ include location so we can get lat/lng for many results already
        "X-Goog-FieldMask":
          "places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.photos,places.addressComponents,places.location,places.googleMapsUri",
      },
      body: JSON.stringify(body),
    });

    const data: any = await r.json();

    if (!r.ok) {
      return res.status(400).json({
        message: data?.error?.message || "Places searchText failed",
        raw: data?.error || data,
      });
    }

    const places: any[] = Array.isArray(data?.places) ? data.places : [];

    const hotels = places.slice(0, 12).map((p: any) => {
      const photos: any[] = Array.isArray(p?.photos) ? p.photos : [];
      const firstPhoto = photos[0];

      const photoUrl =
        firstPhoto?.name && typeof firstPhoto.name === "string"
          ? buildPhotoProxyUrl(req, firstPhoto.name, 800)
          : "";

      const addressComponents: any[] = Array.isArray(p?.addressComponents) ? p.addressComponents : [];

      const lat = typeof p?.location?.latitude === "number" ? p.location.latitude : null;
      const lng = typeof p?.location?.longitude === "number" ? p.location.longitude : null;

      return {
        id: strOrEmpty(p?.id),
        name: strOrEmpty(p?.displayName?.text),
        formattedAddress: strOrEmpty(p?.formattedAddress),
        rating: numOrNull(p?.rating),
        userRatingCount: numOrNull(p?.userRatingCount),
        lat,
        lng,
        googleMapsUrl: strOrEmpty(p?.googleMapsUri),
        photoUrl,
        addressComponents,
      };
    });

    return res.json({ hotels });
  } catch (e: any) {
    return res.status(400).json({ message: e?.message || "Bad request" });
  }
});

/**
 * GET /api/places/hotels/details?id=<placeId>
 * Fetch full details for the selected hotel (phone, website, maps URL, lat/lng etc.)
 *
 * This is what you should call AFTER user selects a hotel from search list.
 */
router.get("/hotels/details", async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).json({ message: "Places key not configured" });

    const id = requireString(req.query.id, "id"); // placeId

    const url = `https://places.googleapis.com/v1/places/${safeEncode(id)}`;

    const r = await fetch(url, {
      method: "GET",
      headers: {
        "X-Goog-Api-Key": API_KEY,
        // ✅ Details field mask: include only what you need (cost + privacy)
        "X-Goog-FieldMask":
          "id,displayName,formattedAddress,location,rating,userRatingCount,googleMapsUri,websiteUri,nationalPhoneNumber,internationalPhoneNumber,regularOpeningHours,addressComponents",
      },
    });

    const data: any = await r.json();

    if (!r.ok) {
      return res.status(400).json({
        message: data?.error?.message || "Places details failed",
        raw: data?.error || data,
      });
    }

    const place = data || {};

    const lat = typeof place?.location?.latitude === "number" ? place.location.latitude : null;
    const lng = typeof place?.location?.longitude === "number" ? place.location.longitude : null;

    return res.json({
      hotel: {
        placeId: strOrEmpty(place?.id),
        name: strOrEmpty(place?.displayName?.text),
        address: strOrEmpty(place?.formattedAddress),
        lat,
        lng,
        rating: numOrNull(place?.rating),
        userRatingCount: numOrNull(place?.userRatingCount),
        phone: strOrEmpty(place?.nationalPhoneNumber || place?.internationalPhoneNumber),
        website: strOrEmpty(place?.websiteUri),
        googleMapsUrl: strOrEmpty(place?.googleMapsUri),
        openingHours: place?.regularOpeningHours || null,
        addressComponents: Array.isArray(place?.addressComponents) ? place.addressComponents : [],
      },
    });
  } catch (e: any) {
    return res.status(400).json({ message: e?.message || "Bad request" });
  }
});

/**
 * GET /api/places/hotels/photo-for
 *   ?hotelCode=1234567&name=Canal%20Central%20Hotel&city=Dubai&lat=25.18&lon=55.26
 *
 * Resolves ONE TBO hotel row to a usable photo URL, for the /concierge cards.
 *
 * Why a resolver instead of reusing /hotels/search: that route answers "what
 * hotels are in this city", which is a different question and would re-rank the
 * concierge's own TBO results against Google's. This one starts from a property
 * we have ALREADY chosen and only asks Google for its picture — and refuses to
 * answer unless it can verify the two are the same building (see
 * utils/hotelPhotoMatch).
 *
 * Always 200 with `photoUrl: null` on a miss. A missing photo is a normal,
 * expected outcome, not an error the card should have to handle as one.
 */
router.get("/hotels/photo-for", async (req, res) => {
  try {
    const hotelCode = strOrEmpty(req.query.hotelCode).trim();
    const name = strOrEmpty(req.query.name).trim();
    if (!hotelCode || !name) {
      return res.json({ ok: true, photoUrl: null, reason: "bad_request" });
    }

    const toNum = (v: unknown): number | null => {
      const n = Number.parseFloat(strOrEmpty(v));
      return Number.isFinite(n) ? n : null;
    };

    const result = await getHotelPhotoName({
      hotelCode,
      hotelName: name,
      city: strOrEmpty(req.query.city).trim() || null,
      lat: toNum(req.query.lat),
      lon: toNum(req.query.lon),
    });

    // The URL handed back is the PUBLIC by-code image endpoint, never a photo
    // reference. Two reasons, and the second is the security one:
    //   · an <img> cannot authenticate cross-origin, so the image URL must be
    //     public or every photo 401s in production
    //   · handing the browser a photo REFERENCE would mean the public endpoint
    //     had to accept one back, which is an open proxy. The reference stays
    //     server-side; the browser only ever quotes a HotelCode we already
    //     resolved and verified.
    // This endpoint itself stays authed — it is the one that can spend a Places
    // Text Search, so resolution remains behind login.
    const photoUrl = result.photoName
      ? `${String(req.baseUrl || "")}/hotels/photo-by-code?hotelCode=${safeEncode(hotelCode)}&w=640`
      : null;

    // Short on purpose. The durable cache is Mongo's (30 days) and the IMAGE
    // itself is cached for 24h by the public endpoint — this response is just a
    // pointer, and caching a pointer for a day means any change to the URL
    // shape stays wrong in every browser that saw the old one for a day. Ten
    // minutes keeps the within-session win without that.
    res.setHeader("Cache-Control", "private, max-age=600");
    return res.json({ ok: true, photoUrl, reason: result.reason, source: result.source });
  } catch (e: any) {
    // Never fail the card: a photo is an enhancement, never a gate.
    return res.json({ ok: true, photoUrl: null, reason: e?.message || "error" });
  }
});

/**
 * GET /api/places/hotels/photo?name=places/.../photos/...&maxWidth=800
 * Proxy for Places Photo (New)
 *
 * Keeps API key on backend only.
 */
router.get("/hotels/photo", async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).send("Places key not configured");

    const name = requireString(req.query.name, "name");

    // The caller-supplied `name` is interpolated into a googleapis URL below,
    // so it MUST be shape-checked: without this, `../../` walks the path and
    // reaches other Google endpoints with our API key attached. Authenticated
    // is not the same as trusted.
    if (!isValidPlacesPhotoName(name)) {
      return res.status(400).send("Invalid photo name");
    }
    const maxWidth = clampPhotoWidth(req.query.maxWidth ?? 800);

    // New photo media endpoint:
    // GET https://places.googleapis.com/v1/{name=places/*/photos/*/media}?maxWidthPx=...
    const url = new URL(`https://places.googleapis.com/v1/${name}/media`);
    url.searchParams.set("maxWidthPx", String(maxWidth));

    const r = await fetch(url.toString(), {
      method: "GET",
      headers: { "X-Goog-Api-Key": API_KEY },
      redirect: "manual",
    });

    // Google often responds with 302 redirect to the actual image URL
    const location = r.headers.get("location");
    if (location) {
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.redirect(location);
    }

    // If not redirect, stream body as-is
    res.setHeader("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    const buf = Buffer.from(await r.arrayBuffer());
    return res.send(buf);
  } catch (e: any) {
    return res.status(400).send(e?.message || "Bad request");
  }
});

export default router;
