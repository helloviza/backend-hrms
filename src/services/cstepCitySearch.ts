// apps/backend/src/services/cstepCitySearch.ts
//
// City suggestions for the CSTEP city / location fields (GET /api/cstep/cities).
// A hybrid: the database first, Google only when the database is thin.
//
//   1. Mongo, from the first character, free: the shared TBO city catalogue
//      the SBT hotel search reads (services/hotelCatalogSearch.ts, cities
//      only) plus the CSTEP city cache (models/cstep/CstepCityCache.ts).
//   2. Google Places Autocomplete (New), server-side, only when the query is
//      2+ characters, Mongo found fewer than 5 cities and none of them is an
//      exact match for the query (an exact hit — "Mumbai" — means the user is
//      on a known city), and Google has not already been asked this exact
//      query (the cache remembers its cities; models/cstep/CstepCityMiss.ts
//      remembers, for 7 days, a query Google answered with nothing). Cities
//      only, biased to India but not restricted to it, one session token per
//      typing session, a 2.5 s timeout. The clean city name (mainText) is
//      kept, not "City, State, Country".
//   3. New Google cities go into the CSTEP cache only — never into the shared
//      catalogue, so SBT is unaffected — and the next lookup is free.
//
// Fail soft: a Google error, timeout or missing key, or a failed cache read
// or write, only drops that source — the rest still answers, and nothing
// throws. The field is free text either way.
//
// Merged, deduped case-insensitively (name + country), ranked exact → prefix
// → the rest, India first within each, capped at 10.
import { randomUUID } from "crypto";
import CstepCityCache from "../models/cstep/CstepCityCache.js";
import CstepCityMiss, { CSTEP_CITY_MISS_TTL_MS } from "../models/cstep/CstepCityMiss.js";
import { TBOCountry, normalizeSearch } from "../jobs/static-data-refresh.js";
import { rankByMatch, searchHotelCatalog } from "./hotelCatalogSearch.js";
import logger from "../utils/logger.js";

export const CSTEP_CITY_CAP = 10;
export const CSTEP_CITY_GOOGLE_MIN_CHARS = 2;
/** Fewer Mongo matches than this and Google is asked too. */
export const CSTEP_CITY_THIN_BELOW = 5;
export const CSTEP_CITY_GOOGLE_TIMEOUT_MS = 2500;
export const GOOGLE_AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";

const PRIORITY = "IN";
const POOL = 60;
const MAX_PREFIX_CHAR = "￿";
// India's bounding box. A bias, not a restriction: other countries still come back.
const INDIA_BIAS = { rectangle: { low: { latitude: 6.5, longitude: 68.1 }, high: { latitude: 35.7, longitude: 97.4 } } };

export type CstepCity = { name: string; countryCode: string; countryName: string };
type Row = CstepCity & { searchName: string; placeId?: string };

const keyOf = (r: Row) => `${r.name.trim().toLowerCase()}|${r.countryName.trim().toLowerCase()}`;
const row = (c: { name: string; countryCode?: string; countryName?: string; placeId?: string }): Row => ({
  name: c.name,
  countryCode: (c.countryCode || "").toUpperCase(),
  countryName: c.countryName || "",
  searchName: normalizeSearch(c.name),
  placeId: c.placeId,
});

/* ── Session tokens ──────────────────────────────────────────────────────
 * Google groups autocomplete requests into a session by token. The frontend
 * sends only ?q=, so a typing session is tracked here per user: the token is
 * reused while that user keeps typing (a Google call within IDLE of the last
 * one, the whole session within MAX_AGE), and a new one starts after that. */
const SESSION_IDLE_MS = 60_000;
const SESSION_MAX_AGE_MS = 180_000;
const sessions = new Map<string, { token: string; startedAt: number; lastAt: number }>();

export function cstepCitySessionToken(userKey: string, now = Date.now()): string {
  const s = sessions.get(userKey);
  if (s && now - s.lastAt < SESSION_IDLE_MS && now - s.startedAt < SESSION_MAX_AGE_MS) {
    s.lastAt = now;
    return s.token;
  }
  if (sessions.size > 5000) {
    for (const [k, v] of sessions) if (now - v.lastAt >= SESSION_IDLE_MS) sessions.delete(k);
  }
  const token = randomUUID();
  sessions.set(userKey, { token, startedAt: now, lastAt: now });
  return token;
}

/* ── Google ─────────────────────────────────────────────────────────────── */
/** `empty` only when Google answered successfully with zero predictions —
 *  never on an error, timeout, missing key or unreadable reply. */
async function googleCities(q: string, sessionToken: string): Promise<{ rows: Row[]; empty: boolean }> {
  const none = { rows: [] as Row[], empty: false };
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return none;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CSTEP_CITY_GOOGLE_TIMEOUT_MS);
  try {
    const r = await fetch(GOOGLE_AUTOCOMPLETE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
      body: JSON.stringify({
        input: q,
        includedPrimaryTypes: ["(cities)"],
        locationBias: INDIA_BIAS,
        regionCode: "in",
        languageCode: "en",
        sessionToken,
      }),
      signal: ctrl.signal,
    });
    const data: any = await r.json().catch(() => undefined);
    if (!r.ok) {
      logger.warn("[CSTEP cities] Google autocomplete failed", { status: r.status, error: data?.error?.message });
      return none;
    }
    // Google omits `suggestions` when nothing matches; anything else unreadable is a bad reply.
    if (!data || typeof data !== "object" || (data.suggestions !== undefined && !Array.isArray(data.suggestions))) {
      logger.warn("[CSTEP cities] Google autocomplete replied unreadably");
      return none;
    }
    const suggestions: any[] = data.suggestions ?? [];
    const out: Row[] = [];
    for (const s of suggestions) {
      const p = s?.placePrediction;
      const name = String(p?.structuredFormat?.mainText?.text || "").trim();
      if (!name) continue;
      // secondaryText reads "Maharashtra, India" or "Dubai - United Arab Emirates": the country is last.
      const secondary = String(p?.structuredFormat?.secondaryText?.text || "");
      const countryName = secondary.split(/,| - /).pop()!.trim();
      out.push(row({ name, countryName, placeId: String(p?.placeId || "") }));
    }
    return { rows: out, empty: suggestions.length === 0 };
  } catch (err: any) {
    logger.warn("[CSTEP cities] Google autocomplete unavailable", { error: ctrl.signal.aborted ? "timeout" : err?.message });
    return none;
  } finally {
    clearTimeout(timer);
  }
}

/** Google names a country; the catalogue knows its code ("India" → "IN"). */
async function withCountryCodes(rows: Row[]): Promise<Row[]> {
  const names = [...new Set(rows.map((r) => r.countryName).filter(Boolean))];
  if (!names.length) return rows;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const found: any[] = await (TBOCountry as any)
    .find({ $or: names.map((n) => ({ name: new RegExp(`^${escape(n)}$`, "i") })) })
    .lean()
    .catch(() => []);
  const byName = new Map(found.map((c) => [String(c.name).toLowerCase(), c]));
  return rows.map((r) => {
    const c = byName.get(r.countryName.toLowerCase());
    return c ? { ...r, countryCode: String(c.code).toUpperCase(), countryName: c.name } : r;
  });
}

async function cacheGoogleCities(rows: Row[], nq: string): Promise<void> {
  if (!rows.length) return;
  try {
    await CstepCityCache.bulkWrite(
      rows.map((r) => ({
        updateOne: {
          filter: { searchName: r.searchName, countryKey: r.countryName.toLowerCase() },
          update: {
            $setOnInsert: { name: r.name, countryCode: r.countryCode, countryName: r.countryName, placeId: r.placeId || "" },
            $addToSet: { queries: nq },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  } catch (err: any) {
    logger.warn("[CSTEP cities] cache write failed", { error: err?.message });
  }
}

/** Google answered this query with nothing within the TTL. A failed read just asks Google. */
async function googleSaidNothing(nq: string): Promise<boolean> {
  // expiresAt is checked too: Mongo's TTL monitor sweeps only once a minute.
  return CstepCityMiss.exists({ query: nq, expiresAt: { $gt: new Date() } })
    .then((r) => !!r)
    .catch((err: any) => {
      logger.warn("[CSTEP cities] miss-cache read failed", { error: err?.message });
      return false;
    });
}

async function rememberNothing(nq: string): Promise<void> {
  try {
    await CstepCityMiss.updateOne(
      { query: nq },
      { $set: { expiresAt: new Date(Date.now() + CSTEP_CITY_MISS_TTL_MS) } },
      { upsert: true },
    );
  } catch (err: any) {
    logger.warn("[CSTEP cities] miss-cache write failed", { error: err?.message });
  }
}

export async function searchCstepCities(q: string, opts: { sessionKey: string }): Promise<CstepCity[]> {
  const nq = normalizeSearch(q);
  if (!nq) return [];

  const [catalogue, cached] = await Promise.all([
    searchHotelCatalog(q, { priorityCode: PRIORITY, cityCap: CSTEP_CITY_CAP, hotelCap: 0 })
      .then((r) => r.cities.map(row))
      .catch((err: any) => {
        logger.warn("[CSTEP cities] catalogue read failed", { error: err?.message });
        return [] as Row[];
      }),
    CstepCityCache.find({ $or: [{ searchName: { $gte: nq, $lt: nq + MAX_PREFIX_CHAR } }, { queries: nq }] })
      .limit(POOL)
      .lean()
      .catch((err: any) => {
        logger.warn("[CSTEP cities] cache read failed", { error: err?.message });
        return [] as any[];
      }),
  ]);
  const fromMongo = [...catalogue, ...cached.map(row)];
  let ranked = rankByMatch(fromMongo, nq, PRIORITY, keyOf);

  const exactHit = ranked.some((r) => r.searchName === nq);
  const askedBefore = cached.some((c: any) => Array.isArray(c.queries) && c.queries.includes(nq));
  if (
    nq.length >= CSTEP_CITY_GOOGLE_MIN_CHARS &&
    ranked.length < CSTEP_CITY_THIN_BELOW &&
    !exactHit &&
    !askedBefore &&
    !(await googleSaidNothing(nq))
  ) {
    const answer = await googleCities(q, cstepCitySessionToken(opts.sessionKey));
    if (answer.empty) await rememberNothing(nq);
    const google = await withCountryCodes(answer.rows);
    await cacheGoogleCities(google, nq);
    ranked = rankByMatch([...fromMongo, ...google], nq, PRIORITY, keyOf);
  }

  return ranked.slice(0, CSTEP_CITY_CAP).map((r) => ({ name: r.name, countryCode: r.countryCode, countryName: r.countryName }));
}
