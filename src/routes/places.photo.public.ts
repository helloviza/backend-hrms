// apps/backend/src/routes/places.photo.public.ts
//
// THE ONLY PUBLIC ROUTE IN THE PLACES SURFACE. Deliberately its own file and
// its own router, so "which Places endpoints are unauthenticated" is answerable
// by reading one short file rather than by tracing middleware order inside
// routes/places.ts (which also mounts the authed searchText and Details proxies
// — those stay behind requireAuth and must never end up in here).
//
// WHY IT HAD TO BECOME PUBLIC. A browser loads an image with <img src>, and an
// <img> cannot send an Authorization header and will not send a cookie to a
// different origin. In production the frontend and the API ARE different
// origins, so every hotel photo returned 401 and silently fell back to the
// gradient — the feature worked in dev (same origin, cookie sent) and was dead
// in prod. Authentication was protecting a photograph of a building, and
// breaking the only way to display it.
//
// WHY THAT IS SAFE. This endpoint takes a HotelCode — NOT a URL, and NOT a
// Places photo reference. It resolves the reference from OUR OWN cache and
// refuses anything that is not already there. Consequences:
//   · it cannot be pointed at an arbitrary URL — no open proxy, no SSRF
//   · it cannot trigger a Places TEXT SEARCH, so an unauthenticated caller can
//     never make us pay for resolution; only for a photo we already resolved
//   · it exposes no PII, fare, booking or workspace data — HotelPhotoCache
//     holds a Google photo reference for a public building and nothing else
//
// CORS is a non-issue by construction: an <img> without a crossorigin attribute
// is not a CORS request, so no origin rule can block it. Nothing here reads a
// cookie or a token, so there is no credentialed cross-origin case to allow.

import { Router } from "express";
import { hotelPhotoLimiter } from "../middleware/rateLimit.js";
import {
  getCachedPhotoName,
  fetchPlacesPhoto,
  clampPhotoWidth,
} from "../services/hotelPhotoService.js";

const router = Router();

/**
 * GET /api/places/hotels/photo-by-code?hotelCode=1774500&w=640
 *
 * 302 → the Google-hosted image when we hold a verified photo for this hotel.
 * 404 otherwise. The card treats any non-image response as "no photo" and keeps
 * its styled placeholder, so a miss here is a normal outcome, not an error.
 */
router.get("/hotels/photo-by-code", hotelPhotoLimiter, async (req, res) => {
  try {
    const hotelCode = String(req.query.hotelCode ?? "").trim();

    // A TBO HotelCode is a short alphanumeric id. Anything else is not a
    // lookup we perform — reject before touching the database.
    if (!hotelCode || !/^[A-Za-z0-9_-]{1,64}$/.test(hotelCode)) {
      return res.status(400).json({ ok: false, message: "Invalid hotelCode" });
    }

    // CACHE ONLY. No Places Text Search can be reached from this route.
    const photoName = await getCachedPhotoName(hotelCode);
    if (!photoName) return res.status(404).json({ ok: false, message: "No photo" });

    const photo = await fetchPlacesPhoto(photoName, clampPhotoWidth(req.query.w));
    if (!photo) return res.status(404).json({ ok: false, message: "No photo" });

    // A hotel photo is stable; let the browser and any CDN keep it for a day so
    // the common case never reaches Google at all.
    res.setHeader("Cache-Control", "public, max-age=86400");

    if (photo.redirectTo) return res.redirect(photo.redirectTo);
    res.setHeader("Content-Type", photo.contentType || "image/jpeg");
    return res.send(photo.body);
  } catch {
    // Never leak an internal error through a public endpoint.
    return res.status(404).json({ ok: false, message: "No photo" });
  }
});

export default router;
