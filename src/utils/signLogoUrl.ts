// apps/backend/src/utils/signLogoUrl.ts
import { presignGetObject } from "./s3Presign.js";
import { env } from "../config/env.js";

type LogoUrlCacheEntry = { url: string; expAt: number };

const SIGN_TTL_SECONDS = 900; // S3 signature valid 15 min
const CACHE_TTL_MS = 14 * 60 * 1000; // refresh 1 min before expiry

const LOGO_URL_CACHE = new Map<string, LogoUrlCacheEntry>();

export async function signLogoUrl(key?: string): Promise<string> {
  if (!key) return "";
  const now = Date.now();
  const cached = LOGO_URL_CACHE.get(key);
  if (cached && cached.expAt > now + 30_000) return cached.url;
  const url = await presignGetObject({
    bucket: env.S3_BUCKET,
    key,
    expiresInSeconds: SIGN_TTL_SECONDS,
  });
  LOGO_URL_CACHE.set(key, { url, expAt: now + CACHE_TTL_MS });
  return url;
}
