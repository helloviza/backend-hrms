// City-image resolver for the SBT landing bento.
//
// Pixabay-compliant flow (https://pixabay.com/api/docs/):
//   1. Resolve-once-forever cache (SBTConfig "city-images": { slug: s3Url }) — never
//      re-query a city we've already stored (satisfies the 24h cache requirement).
//   2. On a miss, query Pixabay (key from BACKEND env), DOWNLOAD the top hit to OUR S3
//      (Pixabay forbids permanent hotlinking — webformatURL is only valid 24h), cache
//      our S3 URL, and return it. Only our S3 URL is ever stored/served.
//   3. Any failure (no key, no result, network, 429 rate-limit) → null → the frontend
//      shows its navy placeholder. We never throw to the caller.
//
// Attribution ("Images from Pixabay") is rendered by the frontend when images show.

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "../config/aws.js";
import { env } from "../config/env.js";
import SBTConfig from "../models/SBTConfig.js";
import { sbtLogger } from "../utils/logger.js";

const CACHE_KEY = "city-images";

// Concurrency guard: collapse simultaneous misses for the same slug into one fetch.
const inFlight = new Map<string, Promise<string | null>>();

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function extFromContentType(ct: string | null): { ext: string; ct: string } {
  if (ct?.includes("png")) return { ext: "png", ct: "image/png" };
  if (ct?.includes("webp")) return { ext: "webp", ct: "image/webp" };
  return { ext: "jpg", ct: "image/jpeg" };
}

async function readCache(slug: string): Promise<string | null> {
  const doc = await SBTConfig.findOne({ key: CACHE_KEY }).lean();
  const map = (doc?.value as Record<string, string>) ?? {};
  return map[slug] ?? null;
}

async function writeCache(slug: string, url: string): Promise<void> {
  // Dot-path $set on the Mixed `value` field — upserts the single cache doc.
  await SBTConfig.findOneAndUpdate(
    { key: CACHE_KEY },
    { $set: { [`value.${slug}`]: url } },
    { upsert: true },
  );
}

async function fetchAndStore(cityName: string, slug: string): Promise<string | null> {
  if (!env.PIXABAY_API_KEY) return null;
  try {
    const q = encodeURIComponent(`${cityName} cityscape`);
    const apiUrl =
      `https://pixabay.com/api/?key=${env.PIXABAY_API_KEY}&q=${q}` +
      `&image_type=photo&orientation=horizontal&category=places&safesearch=true&per_page=3`;

    const resp = await fetch(apiUrl);
    if (!resp.ok) {
      sbtLogger.warn("Pixabay query failed", { city: cityName, status: resp.status });
      return null; // includes 429 rate-limit — degrade silently
    }
    const data: any = await resp.json();
    const hit = Array.isArray(data?.hits) ? data.hits[0] : null;
    const srcUrl: string | undefined = hit?.largeImageURL || hit?.webformatURL;
    if (!srcUrl) return null;

    // Download the file to OUR server (no long-term hotlinking of Pixabay URLs).
    const imgResp = await fetch(srcUrl);
    if (!imgResp.ok) return null;
    const buffer = Buffer.from(await imgResp.arrayBuffer());
    const { ext, ct } = extFromContentType(imgResp.headers.get("content-type"));

    // Upload to OUR S3 (same bucket/pipeline as offer images).
    const key = `city-images/${slug}-${Date.now()}.${ext}`;
    await s3.send(new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: ct,
    }));
    const s3Url = `https://${env.S3_BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;

    await writeCache(slug, s3Url);
    sbtLogger.info("Pixabay city image cached", { city: cityName, slug, s3Url });
    return s3Url;
  } catch (err: any) {
    sbtLogger.warn("Pixabay resolve error", { city: cityName, error: err?.message });
    return null;
  }
}

/**
 * Resolve a city name to a cached S3 image URL (downloaded from Pixabay), or null.
 * Cache hit → returns the stored S3 URL with no Pixabay call.
 */
export async function resolveCityImage(cityName: string): Promise<string | null> {
  const name = (cityName || "").trim();
  if (!name) return null;
  const slug = slugify(name);
  if (!slug) return null;

  const cached = await readCache(slug);
  if (cached) return cached;

  const existing = inFlight.get(slug);
  if (existing) return existing;

  const p = fetchAndStore(name, slug).finally(() => inFlight.delete(slug));
  inFlight.set(slug, p);
  return p;
}
