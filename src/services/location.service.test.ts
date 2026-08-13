// Coverage for the shared location resolver.
//
// The two things that must never regress are here: the private-range guard
// short-circuiting BEFORE any database work, and ipHash never being the raw
// address. Both are asserted against real observables (a counter the service
// increments, and the hash value itself), not against a spy on an internal.
//
// ActorLocation is backed by a small in-memory collection with real upsert
// semantics — the house convention (see routes/visa.cancel.test.ts). NOTE:
// that convention is a choice, not a constraint — mongodb-memory-server does
// start here (see utils/visaPredicatePersistence.test.ts), so real
// persistence is available if this test ever needs schema defaults or
// casting to be real.
//
// The geo database is a 70 MB non-redistributable download, so the tests that
// need one are gated on it actually being provisioned. Everything that can be
// pinned WITHOUT it — classification, confidence, the strict city lookup, the
// whole record→result mapping — is pinned with fixtures instead.

import { describe, it, expect, vi, beforeEach } from "vitest";
import mongoose from "mongoose";

const { locationStore, resetStores } = vi.hoisted(() => {
  type Doc = Record<string, any>;
  const store = new Map<string, Doc>();
  const key = (f: Doc) => `${f.actorId}|${f.actorType}|${f.workspaceId ?? "null"}`;
  return {
    locationStore: {
      store,
      // Real upsert-on-unique-key semantics: same key overwrites, it never appends.
      upsert(filter: Doc, update: Doc) {
        const k = key(filter);
        store.set(k, { ...(store.get(k) ?? filter), ...update.$set });
      },
      all: () => Array.from(store.values()),
      clear: () => store.clear(),
    },
    resetStores() {
      store.clear();
    },
  };
});

vi.mock("../models/ActorLocation.js", () => ({
  default: {},
  upsertCurrentLocation: async (actor: any, facts: any, ipHash: string | null) => {
    locationStore.upsert(
      { actorId: String(actor.actorId), actorType: actor.actorType, workspaceId: actor.workspaceId },
      { $set: { ...facts, ipHash } },
    );
    return true;
  },
}));

import {
  classifyIp,
  confidenceFromAccuracyRadius,
  locationFromGeoRecord,
  resolveCityFromIp,
  resolveActorFromRequest,
  actorFromRequest,
  assertProxyChainDepth,
  hashIp,
  getGeoLookupAttempts,
  __resetLocationServiceState,
  LOCATION_CONFIDENCE_ENFORCEABLE,
} from "./location.service.js";
import { isGeoipDatabasePresent } from "./geoipProvision.js";

beforeEach(() => {
  resetStores();
  __resetLocationServiceState();
});

/* ───────────────────────────── classification ───────────────────────────── */

describe("classifyIp", () => {
  it("classifies loopback, RFC1918 and CGNAT as private", () => {
    expect(classifyIp("127.0.0.1")).toMatchObject({ kind: "private", reason: "loopback" });
    expect(classifyIp("10.4.5.6")).toMatchObject({ kind: "private", reason: "rfc1918" });
    expect(classifyIp("192.168.1.20")).toMatchObject({ kind: "private", reason: "rfc1918" });
    expect(classifyIp("100.100.1.1")).toMatchObject({ kind: "private", reason: "cgnat" });
    expect(classifyIp("::1")).toMatchObject({ kind: "private", reason: "loopback" });
  });

  it("gets the 172.16/12 boundary right in both directions", () => {
    // The range is 172.16.0.0 – 172.31.255.255. A naive `startsWith("172.")`
    // would wrongly swallow 172.32.x, which is public space.
    expect(classifyIp("172.16.0.0").kind).toBe("private");
    expect(classifyIp("172.31.255.255").kind).toBe("private");
    expect(classifyIp("172.15.255.255").kind).toBe("public");
    expect(classifyIp("172.32.0.1").kind).toBe("public");
  });

  it("unwraps the IPv6-mapped form before deciding", () => {
    // A dual-stack listener hands us this shape, and it is exactly what a
    // naive string check on "127." would send to the geo database.
    expect(classifyIp("::ffff:127.0.0.1")).toMatchObject({
      kind: "private",
      normalized: "127.0.0.1",
      reason: "loopback",
    });
    expect(classifyIp("::ffff:49.36.1.1")).toMatchObject({ kind: "public", normalized: "49.36.1.1" });
  });

  it("rejects junk rather than passing it on", () => {
    expect(classifyIp("not-an-ip").kind).toBe("invalid");
    expect(classifyIp("999.1.1.1").kind).toBe("invalid");
    expect(classifyIp("").kind).toBe("invalid");
    expect(classifyIp(null).kind).toBe("invalid");
  });
});

/* ───────────────────────────── confidence ───────────────────────────── */

describe("confidenceFromAccuracyRadius", () => {
  it("is monotonically non-increasing as the radius grows", () => {
    const radii = [1, 5, 10, 20, 50, 100, 200, 500, 1000];
    const scores = radii.map(confidenceFromAccuracyRadius);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
    }
  });

  it("puts the enforceable bar at roughly metro accuracy", () => {
    expect(confidenceFromAccuracyRadius(50)).toBeGreaterThanOrEqual(LOCATION_CONFIDENCE_ENFORCEABLE);
    expect(confidenceFromAccuracyRadius(100)).toBeLessThan(LOCATION_CONFIDENCE_ENFORCEABLE);
  });

  it("gives a missing radius a low but non-zero score", () => {
    // Zero means "no location at all" and must stay reserved for that.
    const c = confidenceFromAccuracyRadius(null);
    expect(c).toBeGreaterThan(0);
    expect(c).toBeLessThan(LOCATION_CONFIDENCE_ENFORCEABLE);
  });
});

/* ─────────────────────── record → ResolvedLocation ─────────────────────── */

// MaxMind City record shapes, trimmed to the fields the mapping reads.
const geoRecord = (city: string | null, iso: string | null, radius: number | null) => ({
  city: city ? { names: { en: city } } : undefined,
  country: iso ? { iso_code: iso } : undefined,
  subdivisions: [{ names: { en: "Karnataka" } }],
  location: radius == null ? {} : { accuracy_radius: radius },
});

describe("locationFromGeoRecord", () => {
  it("canonicalises a city the lookup table knows", () => {
    const r = locationFromGeoRecord(geoRecord("Bengaluru", "IN", 5));
    expect(r).toMatchObject({
      city: "Bengaluru",
      rawCity: "Bengaluru",
      country: "IN",
      region: "Karnataka",
      source: "ip",
      accuracyRadiusKm: 5,
      reason: "ok",
    });
    expect(r.confidence).toBe(1);
  });

  it("collapses a variant spelling onto the canonical name", () => {
    // "Bangalore" is what plenty of geo data still says.
    expect(locationFromGeoRecord(geoRecord("Bangalore", "IN", 10)).city).toBe("Bengaluru");
  });

  it("yields city:null — not the raw name — for a real city the table lacks", () => {
    // This is the STRICT rule. Thane is a genuine city; the table is a small,
    // India-travel-shaped list and does not carry it.
    const r = locationFromGeoRecord(geoRecord("Thane", "IN", 20));
    expect(r.city).toBeNull();
    expect(r.rawCity).toBe("Thane"); // kept, so the gap is measurable
    expect(r.country).toBe("IN"); // country is still authoritative
    expect(r.reason).toBe("city_not_in_lookup");
  });

  it("yields city:null for junk rather than propagating garbage", () => {
    const r = locationFromGeoRecord(geoRecord("?? — unknown", "IN", 100));
    expect(r.city).toBeNull();
    expect(r.reason).toBe("city_not_in_lookup");
  });

  it("keeps a country-only record instead of discarding it", () => {
    const r = locationFromGeoRecord(geoRecord(null, "AE", 500));
    expect(r).toMatchObject({ city: null, rawCity: null, country: "AE", source: "ip", reason: "country_only" });
  });

  it("treats a record with neither city nor country as unresolved", () => {
    expect(locationFromGeoRecord(geoRecord(null, null, 50))).toMatchObject({
      source: "unresolved",
      reason: "record_without_place",
      confidence: 0,
    });
  });

  it("treats a null record (IP absent from the database) as unresolved", () => {
    expect(locationFromGeoRecord(null)).toMatchObject({ source: "unresolved", reason: "ip_not_in_db" });
  });
});

/* ─────────────────────────── resolveCityFromIp ─────────────────────────── */

describe("resolveCityFromIp", () => {
  it("short-circuits private and loopback addresses WITHOUT any database work", async () => {
    // 62 of 400 production rows are 127.0.0.1 (local dev writing prod). The
    // counter is the proof: it is incremented the moment the geo path is
    // entered, before the database is even opened.
    expect(getGeoLookupAttempts()).toBe(0);

    for (const ip of ["127.0.0.1", "::1", "10.0.0.7", "192.168.0.5", "::ffff:127.0.0.1", "100.90.1.1"]) {
      const r = await resolveCityFromIp(ip);
      expect(r.source).toBe("private-ip");
      expect(r.city).toBeNull();
      expect(r.confidence).toBe(0);
    }

    expect(getGeoLookupAttempts()).toBe(0);
  });

  it("distinguishes loopback from CGNAT in the reason", async () => {
    expect((await resolveCityFromIp("127.0.0.1")).reason).toBe("loopback");
    expect((await resolveCityFromIp("100.64.0.1")).reason).toBe("cgnat");
  });

  it("reports no HTTP context separately from a failed lookup", async () => {
    // A cron job or worker has no request. That is not a coverage miss and
    // must not be counted as one.
    for (const v of [null, undefined, "", "   "]) {
      const r = await resolveCityFromIp(v);
      expect(r.source).toBe("unavailable-non-http");
      expect(r.reason).toBe("no_request_context");
    }
    expect(getGeoLookupAttempts()).toBe(0);
  });

  it("degrades to unresolved on junk instead of throwing", async () => {
    const r = await resolveCityFromIp("banana");
    expect(r.source).toBe("unresolved");
    expect(r.reason).toContain("invalid_ip");
    expect(getGeoLookupAttempts()).toBe(0);
  });

  it("degrades to unresolved — never throws — when no database is provisioned", async () => {
    if (isGeoipDatabasePresent()) return; // covered by the live-database block below
    const r = await resolveCityFromIp("49.36.1.1");
    expect(r.source).toBe("unresolved");
    expect(r.reason).toBe("geo_db_unavailable");
    expect(getGeoLookupAttempts()).toBe(1);
  });

  it("caches a public-IP answer so a burst costs one lookup", async () => {
    await resolveCityFromIp("49.36.1.1");
    await resolveCityFromIp("49.36.1.1");
    await resolveCityFromIp("49.36.1.1");
    expect(getGeoLookupAttempts()).toBe(1);
  });
});

// Only meaningful once `pnpm build` (or MAXMIND_LICENSE_KEY + a manual run of
// geoipProvision) has put the database on disk.
describe.skipIf(!isGeoipDatabasePresent())("resolveCityFromIp — against the real GeoLite2 database", () => {
  it("resolves a known Indian address to IN with a usable confidence", async () => {
    // 49.36.0.0/14 is Reliance Jio, allocated to India. Asserting the COUNTRY
    // rather than a specific city on purpose: MaxMind re-attributes cities
    // between builds, and a test that breaks twice a week is a test nobody
    // trusts. The city path is pinned by the fixture tests above.
    const r = await resolveCityFromIp("49.36.1.1");
    expect(r.source).toBe("ip");
    expect(r.country).toBe("IN");
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
    // Either a canonical city or an honest null — never a raw uncanonicalised name.
    if (r.city !== null) expect(r.reason).toBe("ok");
  });

  it("still short-circuits loopback with a real database present", async () => {
    const before = getGeoLookupAttempts();
    expect((await resolveCityFromIp("127.0.0.1")).source).toBe("private-ip");
    expect(getGeoLookupAttempts()).toBe(before);
  });
});

/* ─────────────────────────────── ipHash ─────────────────────────────── */

describe("hashIp", () => {
  it("returns null — not a weaker hash — when no salt is configured", () => {
    // An unsalted digest of an IPv4 address is reversible in minutes.
    expect(process.env.LOCATION_IP_HASH_SALT).toBeFalsy();
    expect(hashIp("49.36.1.1")).toBeNull();
  });

  it("is a salted hash and NEVER the address, in any form", async () => {
    process.env.LOCATION_IP_HASH_SALT = "test-salt-not-a-real-one";
    vi.resetModules();
    const { hashIp: salted } = await import("./location.service.js");

    const ip = "49.36.1.1";
    const h = salted(ip) as string;

    expect(h).toBeTruthy();
    expect(h).not.toBe(ip);
    expect(h).not.toContain(ip);
    expect(h).not.toContain("49.36");
    expect(h).toMatch(/^[0-9a-f]{64}$/); // HMAC-SHA256 hex
    expect(salted(ip)).toBe(h); // deterministic

    // Different addresses must not collide onto one bucket.
    expect(salted("49.36.1.2")).not.toBe(h);
    // …and the IPv6-mapped form is the SAME identity, not a second one.
    expect(salted("::ffff:49.36.1.1")).toBe(h);

    delete process.env.LOCATION_IP_HASH_SALT;
    vi.resetModules();
  });

  it("returns null for an empty address", () => {
    expect(hashIp(null)).toBeNull();
    expect(hashIp("")).toBeNull();
  });
});

/* ────────────────────────── request → actor ────────────────────────── */

const reqWith = (over: any = {}) => ({ headers: {}, ip: "49.36.1.1", ...over }) as any;

describe("actorFromRequest", () => {
  it("maps accountType to actorType and takes the id from the token", () => {
    const a = actorFromRequest(reqWith({ user: { sub: "u1", accountType: "CUSTOMER" } }));
    expect(a).toMatchObject({ actorId: "u1", actorType: "CUSTOMER", ip: "49.36.1.1" });
  });

  it("folds legacy BUSINESS/CLIENT onto CUSTOMER and defaults to EMPLOYEE", () => {
    expect(actorFromRequest(reqWith({ user: { sub: "u", accountType: "BUSINESS" } })!)!.actorType).toBe("CUSTOMER");
    expect(actorFromRequest(reqWith({ user: { sub: "u", accountType: "VENDOR" } })!)!.actorType).toBe("VENDOR");
    expect(actorFromRequest(reqWith({ user: { sub: "u" } })!)!.actorType).toBe("EMPLOYEE");
  });

  it("prefers req.workspaceObjectId over the token's ids", () => {
    const wsId = new mongoose.Types.ObjectId();
    const a = actorFromRequest(
      reqWith({ user: { sub: "u1", customerId: "deadbeefdeadbeefdeadbeef" }, workspaceObjectId: wsId }),
    );
    expect(String(a!.workspaceId)).toBe(String(wsId));
  });

  it("is null for an anonymous request", () => {
    expect(actorFromRequest(reqWith({}))).toBeNull();
    expect(actorFromRequest(reqWith({ user: {} }))).toBeNull();
  });

  it("takes the IP from req.ip ONLY — a spoofed X-Forwarded-For cannot win", () => {
    // Express has already applied the trust-proxy policy to produce req.ip.
    // Falling back to the raw header would hand an attacker their own city.
    const a = actorFromRequest(
      reqWith({ user: { sub: "u1" }, ip: undefined, headers: { "x-forwarded-for": "8.8.8.8" } }),
    );
    expect(a!.ip).toBeNull();
  });
});

describe("assertProxyChainDepth", () => {
  it("counts the hops X-Forwarded-For actually carries", () => {
    expect(assertProxyChainDepth(reqWith({ headers: {} }))).toBe(0);
    expect(assertProxyChainDepth(reqWith({ headers: { "x-forwarded-for": "49.36.1.1" } }))).toBe(1);
    // The CDN-inserted-in-front case: trust proxy = 1 would now return the edge.
    expect(assertProxyChainDepth(reqWith({ headers: { "x-forwarded-for": "49.36.1.1, 13.32.0.1" } }))).toBe(2);
  });
});

describe("resolveActorFromRequest", () => {
  it("resolves and records in one call, keyed per actor", async () => {
    const req = reqWith({ user: { sub: "507f1f77bcf86cd799439011", accountType: "CUSTOMER" }, ip: "127.0.0.1" });

    const out = await resolveActorFromRequest(req);
    expect(out.actor).toMatchObject({ actorType: "CUSTOMER" });
    expect(out.location.source).toBe("private-ip");
    expect(out.recorded).toBe(true);

    const rows = locationStore.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "private-ip", city: null });
    // No salt configured in this run, so no pseudonym is written at all.
    expect(rows[0].ipHash).toBeNull();
  });

  it("overwrites the actor's row rather than appending a location history", async () => {
    const req = reqWith({ user: { sub: "507f1f77bcf86cd799439011", accountType: "EMPLOYEE" }, ip: "127.0.0.1" });
    await resolveActorFromRequest(req);
    await resolveActorFromRequest({ ...req, ip: "10.0.0.9" });
    expect(locationStore.all()).toHaveLength(1);
  });

  it("never stores a raw IP in any field of the recorded row", async () => {
    process.env.LOCATION_IP_HASH_SALT = "test-salt-not-a-real-one";
    vi.resetModules();
    const { resolveActorFromRequest: fresh } = await import("./location.service.js");

    const ip = "49.36.1.1";
    await fresh(reqWith({ user: { sub: "507f1f77bcf86cd799439011", accountType: "CUSTOMER" }, ip }));

    const row = locationStore.all()[0];
    expect(JSON.stringify(row)).not.toContain(ip);
    expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/);

    delete process.env.LOCATION_IP_HASH_SALT;
    vi.resetModules();
  });

  it("returns data, not a throw, for an anonymous request", async () => {
    const out = await resolveActorFromRequest(reqWith({ ip: "127.0.0.1" }));
    expect(out.actor).toBeNull();
    expect(out.recorded).toBe(false);
    expect(out.location.source).toBe("private-ip");
    expect(locationStore.all()).toHaveLength(0);
  });
});
