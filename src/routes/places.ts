// apps/backend/src/routes/places.ts
import { Router } from "express";

const router = Router();

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
 * GET /api/places/hotels/photo?name=places/.../photos/...&maxWidth=800
 * Proxy for Places Photo (New)
 *
 * Keeps API key on backend only.
 */
router.get("/hotels/photo", async (req, res) => {
  try {
    if (!API_KEY) return res.status(500).send("Places key not configured");

    const name = requireString(req.query.name, "name");
    const maxWidth = typeof req.query.maxWidth === "string" ? req.query.maxWidth : "800";

    // New photo media endpoint:
    // GET https://places.googleapis.com/v1/{name=places/*/photos/*/media}?maxWidthPx=...
    const url = new URL(`https://places.googleapis.com/v1/${name}/media`);
    url.searchParams.set("maxWidthPx", String(Number(maxWidth) || 800));

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
