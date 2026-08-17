// Coverage for the two things config/consumerAuth.ts exists to guarantee:
// the secret is FAIL-CLOSED (and provably not JWT_SECRET), and the cookie
// domain is a function of the ISSUING PATH.
//
// Every test sets process.env itself and restores it afterwards. That is only
// possible because getConsumerJwtSecret() reads per call instead of caching
// the value in a module-level const at import time — the deliberate
// divergence from utils/emailActionToken.ts documented in that file's header.
// If someone "optimises" this into a cached const, these tests stop testing
// anything and that is the signal.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  assertConsumerSecretIsolated,
  cookieDomainForPath,
  getConsumerJwtSecret,
  CONSUMER_COOKIE_SAMESITE,
} from "./consumerAuth.js";

const ENV_KEYS = [
  "CONSUMER_JWT_SECRET",
  "JWT_SECRET",
  "CONSUMER_COOKIE_DOMAIN",
  "COOKIE_DOMAIN",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("getConsumerJwtSecret — fail-closed", () => {
  it("throws when CONSUMER_JWT_SECRET is unset", () => {
    delete process.env.CONSUMER_JWT_SECRET;
    process.env.JWT_SECRET = "b2b-secret";
    expect(() => getConsumerJwtSecret()).toThrow(/Missing env: CONSUMER_JWT_SECRET/);
  });

  it("throws when CONSUMER_JWT_SECRET is empty or whitespace — not treated as set", () => {
    process.env.JWT_SECRET = "b2b-secret";
    process.env.CONSUMER_JWT_SECRET = "   ";
    expect(() => getConsumerJwtSecret()).toThrow(/Missing env: CONSUMER_JWT_SECRET/);
  });

  it("THROWS when CONSUMER_JWT_SECRET equals JWT_SECRET — the wall would not exist", () => {
    process.env.JWT_SECRET = "identical-secret";
    process.env.CONSUMER_JWT_SECRET = "identical-secret";
    expect(() => getConsumerJwtSecret()).toThrow(/must not equal JWT_SECRET/);
  });

  it("returns the secret when it is set and distinct", () => {
    process.env.JWT_SECRET = "b2b-secret";
    process.env.CONSUMER_JWT_SECRET = "consumer-secret";
    expect(getConsumerJwtSecret()).toBe("consumer-secret");
  });

  it("never falls back to JWT_SECRET — the emailActionToken failure mode", () => {
    // The pattern this must NOT have is
    //   process.env.CONSUMER_JWT_SECRET || process.env.JWT_SECRET || "dev-secret"
    // With CONSUMER_JWT_SECRET absent, a fallback implementation would return
    // "b2b-secret" here instead of throwing.
    delete process.env.CONSUMER_JWT_SECRET;
    process.env.JWT_SECRET = "b2b-secret";
    expect(() => getConsumerJwtSecret()).toThrow();
    let leaked: string | null = null;
    try {
      leaked = getConsumerJwtSecret();
    } catch {
      /* expected */
    }
    expect(leaked).toBeNull();
  });
});

describe("assertConsumerSecretIsolated — boot assertion", () => {
  it("refuses to boot when the secret is unset", () => {
    delete process.env.CONSUMER_JWT_SECRET;
    process.env.JWT_SECRET = "b2b-secret";
    expect(() => assertConsumerSecretIsolated()).toThrow(/Missing env: CONSUMER_JWT_SECRET/);
  });

  it("refuses to boot when the secret equals JWT_SECRET", () => {
    process.env.JWT_SECRET = "same";
    process.env.CONSUMER_JWT_SECRET = "same";
    expect(() => assertConsumerSecretIsolated()).toThrow(/must not equal JWT_SECRET/);
  });

  it("boots when the secrets are distinct", () => {
    process.env.JWT_SECRET = "b2b-secret";
    process.env.CONSUMER_JWT_SECRET = "consumer-secret";
    expect(() => assertConsumerSecretIsolated()).not.toThrow();
  });
});

describe("cookieDomainForPath — domain is a function of the issuing path", () => {
  it("uses CONSUMER_COOKIE_DOMAIN for a consumer path", () => {
    process.env.CONSUMER_COOKIE_DOMAIN = ".helloviza.ai";
    process.env.COOKIE_DOMAIN = ".plumtrips.com";
    expect(cookieDomainForPath("/api/consumer")).toEqual({ domain: ".helloviza.ai" });
    expect(cookieDomainForPath("/api/consumer/auth/refresh")).toEqual({ domain: ".helloviza.ai" });
  });

  it("defaults a consumer path to .helloviza.ai when the env var is unset", () => {
    delete process.env.CONSUMER_COOKIE_DOMAIN;
    process.env.COOKIE_DOMAIN = ".plumtrips.com";
    expect(cookieDomainForPath("/api/consumer")).toEqual({ domain: ".helloviza.ai" });
  });

  it("omits the domain attribute for a consumer path when CONSUMER_COOKIE_DOMAIN is set but EMPTY", () => {
    // ABSENT and PRESENT-BUT-EMPTY are different answers here. Absent means
    // "nobody configured this, use the production default" (asserted by the
    // test above). Empty means "deliberately host-only", which is the only
    // thing that works on localhost — a browser discards a cookie scoped to
    // .helloviza.ai when the page is on 127.0.0.1, so before this the local
    // consumer session could not be established at all: /login returned 200
    // with a Set-Cookie the browser then threw away.
    process.env.CONSUMER_COOKIE_DOMAIN = "";
    process.env.COOKIE_DOMAIN = ".plumtrips.com";
    expect(cookieDomainForPath("/api/consumer")).toEqual({});
    expect(cookieDomainForPath("/api/consumer/auth/refresh")).toEqual({});
  });

  it("treats a whitespace-only CONSUMER_COOKIE_DOMAIN as empty, not as a domain", () => {
    process.env.CONSUMER_COOKIE_DOMAIN = "   ";
    expect(cookieDomainForPath("/api/consumer")).toEqual({});
  });

  it("uses the B2B COOKIE_DOMAIN for every non-consumer path", () => {
    process.env.CONSUMER_COOKIE_DOMAIN = ".helloviza.ai";
    process.env.COOKIE_DOMAIN = ".plumtrips.com";
    // The B2B cookie domain must never pick up the consumer value.
    expect(cookieDomainForPath("/api/auth/refresh")).toEqual({ domain: ".plumtrips.com" });
    expect(cookieDomainForPath("/api")).toEqual({ domain: ".plumtrips.com" });
    expect(cookieDomainForPath("/api/visa")).toEqual({ domain: ".plumtrips.com" });
  });

  it("omits the domain attribute entirely for a B2B path when COOKIE_DOMAIN is unset", () => {
    // Reproduces routes/auth.ts:212-216's semantics exactly — host-only
    // cookies in local dev, rather than an empty `domain=` attribute.
    delete process.env.COOKIE_DOMAIN;
    expect(cookieDomainForPath("/api/auth/refresh")).toEqual({});
  });

  it("does not mistake a lookalike prefix for a consumer path", () => {
    process.env.CONSUMER_COOKIE_DOMAIN = ".helloviza.ai";
    process.env.COOKIE_DOMAIN = ".plumtrips.com";
    expect(cookieDomainForPath("/api/consumers-report")).toEqual({ domain: ".helloviza.ai" });
    // ^ documents current behaviour: the check is a prefix match, so a future
    //   sibling route literally starting "/api/consumer" would inherit the
    //   consumer domain. No such route exists; recorded so it is a decision
    //   rather than a surprise.
    expect(cookieDomainForPath("/api/customer/users")).toEqual({ domain: ".plumtrips.com" });
  });
});

describe("SameSite decision", () => {
  it("is Lax — helloviza.ai and api.helloviza.ai share an eTLD+1, so they are same-site", () => {
    expect(CONSUMER_COOKIE_SAMESITE).toBe("lax");
  });
});
