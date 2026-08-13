// apps/backend/src/services/location.service.ts
//
// "Where does this actor appear to be?" — the shared resolver.
//
// PHASE 1 SHIPS DARK. Nothing in the application calls this file. It exists,
// it compiles, it is tested, and it changes the behaviour of exactly zero
// existing flows. Phase 2 pilots it on ManualBooking.
//
// ─────────────────────────────────────────────────────────────────────────
// THE TRUST-PROXY DEPENDENCY (read this before putting anything in front of
// the app — CloudFront, Cloudflare, a WAF, a second ALB)
//
// server.ts sets `app.set("trust proxy", 1)`. Express then treats exactly one
// hop as trusted, so `req.ip` is the address the immediately-connected proxy
// reported — today the ALB, whose X-Forwarded-For carries ONE entry: the real
// client. That is what makes this service meaningful.
//
// Insert a CDN or WAF and XFF gains a hop ("client, cdn-edge"). With
// `trust proxy` still at 1, req.ip silently becomes the CDN edge address, and
// EVERY user resolves to whichever city that edge sits in. Nothing errors.
// Nothing logs. The data just quietly becomes uniformly wrong — which is the
// worst failure mode an analytics signal can have, because it looks healthy.
//
// Two guards, both in this file: logProxyTrustAssumption() for boot, and
// assertProxyChainDepth() which fires on the first request whose XFF is
// deeper than the setting accounts for. Neither is wired yet (Phase 1 is
// dark); wiring logProxyTrustAssumption() into server.ts is a Phase 2
// one-liner.
// ─────────────────────────────────────────────────────────────────────────
//
// GeoLite2 attribution is required by MaxMind's licence — re-exported from
// geoipProvision.ts as GEOLITE2_ATTRIBUTION for any surface that renders a
// resolved city.

import crypto from "crypto";
import type { Request } from "express";
import type { Reader } from "maxmind";
import { ensureGeoipDatabase, GEOLITE2_ATTRIBUTION } from "./geoipProvision.js";
import { lookupDestination } from "../data/destinationLookup.js";
import {
  upsertCurrentLocation,
  type ActorIdentity,
  type ActorType,
} from "../models/ActorLocation.js";

export { GEOLITE2_ATTRIBUTION };

/* ────────────────────────────────────────────────────────────────────────
 * SHAPE
 * ──────────────────────────────────────────────────────────────────────── */

export type LocationSource =
  /** A public IP was looked up in the geo database. */
  | "ip"
  /** Loopback / RFC1918 / CGNAT / link-local — no lookup was attempted. */
  | "private-ip"
  /** A lookup was possible but produced nothing usable. */
  | "unresolved"
  /** There was no HTTP request context to take an IP from at all. */
  | "unavailable-non-http";

export interface ResolvedLocation {
  /** Canonical city via the STRICT destinationLookup, or null. */
  city: string | null;
  /** What the geo database said, pre-canonicalisation. See rawCity on the model. */
  rawCity: string | null;
  region: string | null;
  /** ISO-3166-1 alpha-2, straight from the geo database. */
  country: string | null;
  source: LocationSource;
  /** 0..1 — see confidenceFromAccuracyRadius. */
  confidence: number;
  accuracyRadiusKm: number | null;
  /** Machine-readable "why this answer", for metrics and for debugging a gap. */
  reason: string;
}

/**
 * The bar a future enforcement rule (e.g. "flag an expense filed from an
 * unexpected city") should clear before it is allowed to act on this data.
 *
 * 0.6 corresponds to a MaxMind accuracy radius of ~50 km or better, which is
 * roughly "the right metro". Anything below is city-shaped noise: good enough
 * to count in aggregate, not good enough to accuse anyone of anything. Kept
 * here so there is ONE definition of "confident" when Phase 3 wants one.
 */
export const LOCATION_CONFIDENCE_ENFORCEABLE = 0.6;

const nothing = (
  source: LocationSource,
  reason: string,
  extra: Partial<ResolvedLocation> = {},
): ResolvedLocation => ({
  city: null,
  rawCity: null,
  region: null,
  country: null,
  source,
  confidence: 0,
  accuracyRadiusKm: null,
  reason,
  ...extra,
});

/* ────────────────────────────────────────────────────────────────────────
 * IP CLASSIFICATION
 *
 * THE PRIVATE-RANGE GUARD IS NOT AN OPTIMISATION. Recon found 62 of 400
 * production rows carrying 127.0.0.1 — local development writing to the
 * production database. A geo lookup on those returns nothing, so without
 * this guard they would land as `unresolved`, indistinguishable from a real
 * user the database simply doesn't know. `private-ip` says the true thing:
 * this address can never resolve, don't count it against coverage.
 * ──────────────────────────────────────────────────────────────────────── */

export type IpKind = "public" | "private" | "invalid";

export interface IpClassification {
  kind: IpKind;
  /** The normalised address (IPv6-mapped IPv4 unwrapped, zone id stripped). */
  normalized: string;
  reason: string;
}

/** IPv4 CIDRs that can never belong to an identifiable end user. */
const PRIVATE_V4: Array<{ base: string; bits: number; reason: string }> = [
  { base: "0.0.0.0", bits: 8, reason: "this_network" },
  { base: "10.0.0.0", bits: 8, reason: "rfc1918" },
  // Carrier-grade NAT. A real person is behind it, but the address belongs to
  // the carrier's shared pool, so geo cannot attribute it to them.
  { base: "100.64.0.0", bits: 10, reason: "cgnat" },
  { base: "127.0.0.0", bits: 8, reason: "loopback" },
  { base: "169.254.0.0", bits: 16, reason: "link_local" },
  { base: "172.16.0.0", bits: 12, reason: "rfc1918" },
  { base: "192.0.0.0", bits: 24, reason: "ietf_assigned" },
  { base: "192.168.0.0", bits: 16, reason: "rfc1918" },
  { base: "198.18.0.0", bits: 15, reason: "benchmark" },
  { base: "224.0.0.0", bits: 4, reason: "multicast" },
  { base: "240.0.0.0", bits: 4, reason: "reserved" },
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = (out << 8) | n;
  }
  return out >>> 0;
}

/**
 * Normalise and classify. Handles the two forms Node actually hands us:
 * a plain dotted quad, and the IPv6-mapped form (`::ffff:127.0.0.1`) that a
 * dual-stack listener produces — the second is the one that would slip past a
 * naive `startsWith("127.")` check and get sent to the geo database.
 */
export function classifyIp(raw: unknown): IpClassification {
  let ip = String(raw ?? "").trim().toLowerCase();
  if (!ip) return { kind: "invalid", normalized: "", reason: "empty" };

  // [::1]:443 → ::1
  if (ip.startsWith("[")) ip = ip.slice(1, ip.indexOf("]") === -1 ? undefined : ip.indexOf("]"));
  // fe80::1%eth0 → fe80::1
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  // ::ffff:127.0.0.1 → 127.0.0.1
  if (ip.startsWith("::ffff:") && ip.includes(".")) ip = ip.slice("::ffff:".length);

  const asInt = v4ToInt(ip);
  if (asInt !== null) {
    for (const r of PRIVATE_V4) {
      const base = v4ToInt(r.base) as number;
      const mask = r.bits === 0 ? 0 : (0xffffffff << (32 - r.bits)) >>> 0;
      if ((asInt & mask) === (base & mask)) {
        return { kind: "private", normalized: ip, reason: r.reason };
      }
    }
    return { kind: "public", normalized: ip, reason: "public_v4" };
  }

  if (ip.includes(":")) {
    if (ip === "::1") return { kind: "private", normalized: ip, reason: "loopback" };
    if (ip === "::") return { kind: "private", normalized: ip, reason: "unspecified" };
    // fc00::/7 — unique local. First byte 0xfc or 0xfd.
    if (/^f[cd]/.test(ip)) return { kind: "private", normalized: ip, reason: "unique_local" };
    // fe80::/10 — link local.
    if (/^fe[89ab]/.test(ip)) return { kind: "private", normalized: ip, reason: "link_local" };
    // ff00::/8 — multicast.
    if (/^ff/.test(ip)) return { kind: "private", normalized: ip, reason: "multicast" };
    // Loose shape check — the geo reader rejects anything genuinely malformed.
    if (!/^[0-9a-f:]+$/.test(ip)) return { kind: "invalid", normalized: ip, reason: "malformed" };
    return { kind: "public", normalized: ip, reason: "public_v6" };
  }

  return { kind: "invalid", normalized: ip, reason: "malformed" };
}

/* ────────────────────────────────────────────────────────────────────────
 * CONFIDENCE
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * MaxMind's `location.accuracy_radius` is the radius in km within which it
 * believes the address actually sits. It is the ONLY honest quality signal in
 * the record: a city name is returned with the same syntax whether MaxMind is
 * sure to within 5 km or guessing at a country's centroid from 800 km away.
 *
 * Collapsing it to 0..1 gives every consumer one comparable number, and keeps
 * the raw radius on the row (accuracyRadiusKm) so the thresholds below can be
 * re-cut later without re-resolving anybody.
 *
 * Anchors, not a formula, because the underlying relationship isn't linear —
 * 5 km vs 20 km is the difference between a neighbourhood and a metro, while
 * 500 km vs 800 km are both just "somewhere in the country".
 */
export function confidenceFromAccuracyRadius(km: number | null | undefined): number {
  if (km == null || !Number.isFinite(km) || km < 0) {
    // A city with no stated radius: believable, unverifiable. Low but not
    // zero — zero is reserved for "no location at all".
    return 0.2;
  }
  if (km <= 5) return 1.0;
  if (km <= 10) return 0.9;
  if (km <= 20) return 0.8;
  if (km <= 50) return 0.6;
  if (km <= 100) return 0.4;
  if (km <= 200) return 0.25;
  if (km <= 500) return 0.1;
  return 0.05;
}

/* ────────────────────────────────────────────────────────────────────────
 * THE READER
 * ──────────────────────────────────────────────────────────────────────── */

let readerPromise: Promise<Reader<any>> | null = null;
let geoLookupAttempts = 0;

/**
 * Observable proof that a geo lookup was (or was not) attempted.
 *
 * Incremented at the moment the geo path is entered — BEFORE the database is
 * opened — so a test can assert that private and loopback addresses
 * short-circuit without touching it, without mocking anything.
 */
export function getGeoLookupAttempts(): number {
  return geoLookupAttempts;
}

/** Test seam: drop the memoized reader, the cache and the counter. */
export function __resetLocationServiceState(): void {
  readerPromise = null;
  geoLookupAttempts = 0;
  cache.clear();
  warnedNoSalt = false;
  warnedProxyDepth = false;
}

function getReader(): Promise<Reader<any>> {
  if (readerPromise) return readerPromise;
  readerPromise = (async () => {
    // Self-heals if the build-time provisioning step was skipped or failed.
    const dbPath = await ensureGeoipDatabase();
    const maxmind = (await import("maxmind")).default;
    return maxmind.open<any>(dbPath);
  })().catch((err) => {
    // Don't poison the memo — the next caller retries. In practice this
    // retries a download, which is why the cache below caches failures too.
    readerPromise = null;
    throw err;
  });
  return readerPromise;
}

/* ────────────────────────────────────────────────────────────────────────
 * CACHE
 *
 * Short-lived and in-process. Its job is the burst: one page load is a
 * handful of requests from one address, and re-deriving the same answer for
 * each is pure waste. It is NOT a persistence layer — ActorLocation is.
 * ──────────────────────────────────────────────────────────────────────── */

const CACHE_TTL_MS = Number(process.env.LOCATION_CACHE_TTL_MS) || 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = Number(process.env.LOCATION_CACHE_MAX) || 5000;

const cache = new Map<string, { at: number; value: ResolvedLocation }>();

function cacheGet(key: string): ResolvedLocation | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key: string, value: ResolvedLocation): void {
  // Map iterates in insertion order, so the first key is the oldest. Evicting
  // one per insert is enough to hold the bound without a real LRU.
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
}

/* ────────────────────────────────────────────────────────────────────────
 * RESOLUTION
 * ──────────────────────────────────────────────────────────────────────── */

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s) return s;
  }
  return null;
}

/**
 * The entry point. NEVER THROWS — every failure degrades to a ResolvedLocation
 * carrying a `source` and a `reason` that say what happened.
 *
 * Pass null/empty for `ip` when there is no HTTP request context (a cron job,
 * a worker): that is `unavailable-non-http`, which is a different fact from
 * "we looked and found nothing" and must not be counted as a miss.
 */
export async function resolveCityFromIp(ip: string | null | undefined): Promise<ResolvedLocation> {
  if (ip == null || String(ip).trim() === "") {
    return nothing("unavailable-non-http", "no_request_context");
  }

  const cls = classifyIp(ip);

  // NO LOOKUP for anything that cannot possibly resolve. Deliberately ahead of
  // the cache, the reader, and the counter.
  if (cls.kind === "private") return nothing("private-ip", cls.reason);
  if (cls.kind === "invalid") return nothing("unresolved", `invalid_ip:${cls.reason}`);

  const cached = cacheGet(cls.normalized);
  if (cached) return cached;

  geoLookupAttempts += 1;

  let record: any;
  try {
    const reader = await getReader();
    record = reader.get(cls.normalized);
  } catch (e: any) {
    // No database (not provisioned, no licence key, download failed) or a
    // reader error. Cached so a cold start doesn't retry a 70 MB download on
    // every single request.
    const miss = nothing("unresolved", "geo_db_unavailable");
    cacheSet(cls.normalized, miss);
    return miss;
  }

  const result = locationFromGeoRecord(record);
  cacheSet(cls.normalized, result);
  return result;
}

/**
 * A MaxMind City record → a ResolvedLocation. Pure, so the two decisions that
 * actually matter — strict canonicalisation and the confidence derivation —
 * are exercisable against fixture records instead of only against a live
 * 70 MB database that CI will not have.
 */
export function locationFromGeoRecord(record: any): ResolvedLocation {
  if (!record) return nothing("unresolved", "ip_not_in_db");

  const rawCity = firstString(record?.city?.names?.en);
  const region = firstString(record?.subdivisions?.[0]?.names?.en);
  // Country comes STRAIGHT from MaxMind, not via destinationLookup: MaxMind's
  // iso_code is authoritative ISO-3166, whereas the lookup table's country is
  // a by-product of a hand-built city list and only covers the cities in it.
  const country = firstString(record?.country?.iso_code, record?.registered_country?.iso_code);

  const radius = record?.location?.accuracy_radius;
  const accuracyRadiusKm = typeof radius === "number" && Number.isFinite(radius) ? radius : null;

  if (!rawCity && !country) return nothing("unresolved", "record_without_place");

  // STRICT canonicalisation. lookupDestination never guesses — an unknown or
  // junk name yields null instead of propagating garbage into a city ranking.
  // rawCity keeps the original so the miss stays MEASURABLE: "MaxMind said
  // Thane, our table doesn't carry Thane" is a table gap, and it must not read
  // as a geo-database failure.
  const city = lookupDestination(rawCity)?.city ?? null;

  return {
    city,
    rawCity,
    region,
    country,
    source: "ip",
    confidence: confidenceFromAccuracyRadius(accuracyRadiusKm),
    accuracyRadiusKm,
    reason: city ? "ok" : rawCity ? "city_not_in_lookup" : "country_only",
  };
}

/* ────────────────────────────────────────────────────────────────────────
 * IP HASHING
 * ──────────────────────────────────────────────────────────────────────── */

const IP_HASH_SALT = (process.env.LOCATION_IP_HASH_SALT || "").trim();
let warnedNoSalt = false;

/**
 * SALTED HMAC-SHA256 of an address. Returns null — never a weaker hash — when
 * no salt is configured.
 *
 * A bare SHA-256 of an IPv4 address is NOT pseudonymous data. The entire
 * address space is 2^32; a full rainbow table is minutes of work on a laptop,
 * so an unsalted digest is the raw IP with extra steps, and storing it would
 * carry every obligation storing the IP does. The salt is the whole control.
 * Refusing to write anything without one is the safe default: a null column
 * costs us an analytics join, a false pseudonym costs a DPDP finding.
 */
export function hashIp(ip: string | null | undefined): string | null {
  const s = String(ip ?? "").trim();
  if (!s) return null;
  if (!IP_HASH_SALT) {
    if (!warnedNoSalt) {
      warnedNoSalt = true;
      console.warn(
        "[location] LOCATION_IP_HASH_SALT is not set — ipHash will be written as null. " +
          "An unsalted hash of an IP is trivially reversible and is not stored.",
      );
    }
    return null;
  }
  // Hash the NORMALISED form so ::ffff:1.2.3.4 and 1.2.3.4 are one identity.
  const normalized = classifyIp(s).normalized || s;
  return crypto.createHmac("sha256", IP_HASH_SALT).update(normalized).digest("hex");
}

/* ────────────────────────────────────────────────────────────────────────
 * PROXY-CHAIN GUARDS  (see the header block)
 * ──────────────────────────────────────────────────────────────────────── */

let warnedProxyDepth = false;

/**
 * Call once at boot. States the assumption out loud so that whoever puts a
 * CDN in front later has a chance of connecting the two.
 */
export function logProxyTrustAssumption(): void {
  console.log(
    '[location] client-IP resolution assumes `trust proxy = 1` and EXACTLY ONE proxy hop ' +
      "(ALB → app, direct CNAME). Adding a CDN/WAF in front adds an X-Forwarded-For hop and " +
      "req.ip silently becomes the edge address — every user would then resolve to one city. " +
      "If you add one, raise `trust proxy` to match the new depth.",
  );
}

/**
 * The runtime half of the same guard: how many hops X-Forwarded-For actually
 * carries on this request. Logs once, loudly, when it is deeper than
 * `trust proxy = 1` accounts for. Cheap enough to sit in a hot path.
 */
export function assertProxyChainDepth(req: Request): number {
  const xff = req?.headers?.["x-forwarded-for"];
  const raw = Array.isArray(xff) ? xff.join(",") : String(xff ?? "");
  const depth = raw.split(",").map((s) => s.trim()).filter(Boolean).length;

  if (depth > 1 && !warnedProxyDepth) {
    warnedProxyDepth = true;
    console.warn(
      `[location] X-Forwarded-For carries ${depth} hops but \`trust proxy\` is 1. ` +
        "req.ip is NOT the client — it is the nearest untrusted proxy, so every resolved " +
        "location is now wrong in the same direction. Raise `trust proxy` in server.ts.",
    );
  }
  return depth;
}

/* ────────────────────────────────────────────────────────────────────────
 * REQUEST → ACTOR → RECORDED LOCATION
 * ──────────────────────────────────────────────────────────────────────── */

/** Everything the recorder needs, derived once so consumers don't each re-derive it. */
export interface RequestActor extends ActorIdentity {
  actorId: string;
  /** From req.ip ONLY — see the comment in actorFromRequest. */
  ip: string | null;
}

function normalizeActorType(v: unknown): ActorType {
  const s = String(v ?? "").trim().toUpperCase();
  if (s === "VENDOR") return "VENDOR";
  // auth.ts already collapses BUSINESS/CLIENT to CUSTOMER; the extra names
  // here are for tokens minted before it did.
  if (s === "CUSTOMER" || s === "BUSINESS" || s === "CLIENT") return "CUSTOMER";
  return "EMPLOYEE";
}

/**
 * Who is making this request, and from where.
 *
 * `req.ip` ALONE — never `req.ip || req.headers["x-forwarded-for"]`. Express
 * has already applied the `trust proxy` policy to produce req.ip; reading the
 * raw header as a fallback throws that policy away and takes a value the
 * CLIENT controls, so anyone could pin their recorded location to any city on
 * earth by sending a header. A missing req.ip must stay missing.
 */
export function actorFromRequest(req: Request): RequestActor | null {
  const user: any = (req as any)?.user;
  const actorId = firstString(user?.sub, user?._id, user?.id);
  if (!actorId) return null;

  // requireWorkspace sets req.workspaceObjectId; routes that don't run it
  // fall back to the ids auth.ts normalised onto the token payload.
  const workspaceId =
    (req as any)?.workspaceObjectId ||
    firstString(user?.workspaceId, user?.customerId, user?.businessId) ||
    null;

  return {
    actorId,
    actorType: normalizeActorType(user?.accountType ?? user?.userType),
    workspaceId,
    ip: firstString(req?.ip),
  };
}

export interface ActorLocationOutcome {
  actor: RequestActor | null;
  location: ResolvedLocation;
  /** False when there was no actor, or the write failed (never a thrown error). */
  recorded: boolean;
}

/**
 * The one call a consumer should need: derive the actor, resolve the city,
 * write the row.
 *
 * NEVER THROWS. An anonymous request, an unresolvable address and a failed
 * write all come back as data. Recording where someone appears to be must
 * never be the reason a booking or an expense fails.
 */
export async function resolveActorFromRequest(req: Request): Promise<ActorLocationOutcome> {
  const actor = actorFromRequest(req);
  assertProxyChainDepth(req);

  const location = await resolveCityFromIp(actor?.ip ?? req?.ip ?? null);
  if (!actor) return { actor: null, location, recorded: false };

  const recorded = await upsertCurrentLocation(actor, location, hashIp(actor.ip));
  return { actor, location, recorded };
}
