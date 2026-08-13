// apps/backend/src/utils/exchangeRate.ts
//
// CSTEP arrangement Amount column — live FX pre-fill (additive). Talks to
// ExchangeRate-API (https://www.exchangerate-api.com/) purely to PRE-FILL a
// manual exchange-rate field; it is never authoritative and never
// recomputed on read — whatever rate ends up on a CstepArrangement row is
// frozen at write time (see routes/cstep.ts's arrangement PATCH/POST
// handlers, which compute+store amountInr once and never touch it again).
//
// The API key is read ONLY from env.EXCHANGERATE_API_KEY (config/env.ts),
// which itself is process.env.EXCHANGERATE_API_KEY — back-filled at boot by
// bootstrap/loadSecrets.ts from the single AWS Secrets Manager secret
// (plumtrips/backend/secrets) bundled into the APP_SECRETS env var. Exactly
// the same pattern services/cityImage.service.ts already uses for
// PIXABAY_API_KEY: import { env }, read env.KEY, never touch process.env
// directly, never log the key, never put it in a response.
//
// Never throws — every failure mode (no key configured, network error,
// timeout, rate-limit, malformed response) resolves to `null` so the caller
// always degrades to manual entry. Never blocks arranging.
import { env } from "../config/env.js";

export type FxRateResult = { rate: number; date: string };

/**
 * One cache entry per BASE currency, holding the FULL conversion-rates
 * table from a single /latest/<base> call plus its date — not per (base,
 * quote) pair — so requesting a different quote currency for the same base
 * within the TTL window never re-fetches. CSTEP mostly ever asks for a
 * handful of base currencies (USD/GBP/EUR/...) against INR, so this keeps
 * live calls to roughly one-per-base-per-6h regardless of how many
 * arrangement rows are being edited — comfortably inside the free tier's
 * 1,500/month cap ("one fetch per base currency per short window is
 * plenty" — a handful of currencies × 4/day × 30 days is nowhere near it).
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
type CachedBase = { rates: Record<string, number>; date: string; fetchedAt: number };
const baseCache = new Map<string, CachedBase>();

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function fetchBaseRates(baseCode: string): Promise<CachedBase | null> {
  const apiKey = env.EXCHANGERATE_API_KEY;
  if (!apiKey) return null; // no key configured — degrade silently, never throw

  try {
    const url = `https://v6.exchangerate-api.com/v6/${apiKey}/latest/${baseCode}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null; // rate-limited / bad request / etc.

    const data: any = await res.json();
    if (data?.result !== "success" || !data?.conversion_rates) return null;

    const date =
      typeof data?.time_last_update_utc === "string" && !isNaN(new Date(data.time_last_update_utc).getTime())
        ? new Date(data.time_last_update_utc).toISOString().slice(0, 10)
        : todayIso();

    return { rates: data.conversion_rates, date, fetchedAt: Date.now() };
  } catch {
    // Network error, timeout, JSON parse failure — never surfaces to caller.
    return null;
  }
}

/**
 * Live rate lookup — PRE-FILL ONLY, never authoritative. `base`/`quote` are
 * 3-letter ISO currency codes (case-insensitive). Returns null on ANY
 * failure so the caller (GET /cstep/fx-rate) always degrades to manual
 * entry; never throws.
 */
export async function getLiveRate(base: string, quote: string): Promise<FxRateResult | null> {
  const baseCode = String(base || "").trim().toUpperCase();
  const quoteCode = String(quote || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(baseCode) || !/^[A-Z]{3}$/.test(quoteCode)) return null;
  if (baseCode === quoteCode) return { rate: 1, date: todayIso() };

  let entry = baseCache.get(baseCode);
  if (!entry || Date.now() - entry.fetchedAt >= CACHE_TTL_MS) {
    const fresh = await fetchBaseRates(baseCode);
    // Serve a still-held stale cache entry over a transient refetch failure
    // rather than going straight to null — falls through to the same
    // rate/date extraction below either way.
    if (fresh) {
      entry = fresh;
      baseCache.set(baseCode, entry);
    } else if (!entry) {
      return null;
    }
  }

  const rate = entry.rates[quoteCode];
  if (typeof rate !== "number" || !isFinite(rate)) return null;
  return { rate, date: entry.date };
}
