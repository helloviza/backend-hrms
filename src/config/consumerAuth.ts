// apps/backend/src/config/consumerAuth.ts
//
// THE WALL. Everything that keeps a consumer token from ever being a valid
// B2B token lives here.
//
// ══════════════════════════════════════════════════════════════════════
// THE SECRET IS THE WALL. THE `aud` CLAIM IS OBSERVABILITY.
// ══════════════════════════════════════════════════════════════════════
//
// Consumer tokens are signed with CONSUMER_JWT_SECRET, which is required to
// differ from JWT_SECRET. Every B2B verifier in the codebase verifies against
// JWT_SECRET (all six confirmed by reading them — see
// infra/design/helloviza-consumer-identity-wall-2026-08-15.md §0a), so a
// consumer token presented to any of them fails with
// `JsonWebTokenError: invalid signature`, not with a missing-claim check.
//
// That distinction is the whole design. A claim-based wall has to be SET at
// four independent signing sites and ENFORCED at four verifiers, and can be
// regressed by anyone editing a claim allow-list. A signature-based wall
// cannot be forgotten: it already applies everywhere, and it required
// changing zero B2B files to switch on.
//
// requireConsumer still asserts aud === "CONSUMER" — as defence in depth and
// so a decoded token is self-describing in a log line — but nothing depends
// on it. Do not promote it to load-bearing.
//
// ── ON THE READ PATTERN ───────────────────────────────────────────────
// getConsumerJwtSecret() uses the THROW pattern (routes/auth.ts:66's
// safeEnv), never the `|| FALLBACK` pattern. This is deliberate and
// specific: utils/emailActionToken.ts:5-8 reads
//
//     process.env.EMAIL_ACTION_SECRET || process.env.JWT_SECRET || "dev-secret"
//
// resolved ONCE at module load. That is how a secret silently collapses into
// JWT_SECRET with nothing visible at runtime to say it happened. There is no
// fallback here, of any kind, and the value is read PER CALL rather than
// cached in a module-level const — so the boot assertion below is actually
// exercisable by a test instead of being frozen at import time.

/** The audience marker carried by every consumer token. Observability only. */
export const CONSUMER_AUDIENCE = "CONSUMER";

/** Mirrors B2B's ACCESS_EXPIRES_IN (routes/auth.ts:33). */
export const CONSUMER_ACCESS_EXPIRES_IN = "30m";
export const CONSUMER_ACCESS_MAXAGE_MS = 30 * 60 * 1000;

/** Mirrors B2B's REFRESH_EXPIRES_IN (routes/auth.ts:34). */
export const CONSUMER_REFRESH_EXPIRES_IN = "7d";
export const CONSUMER_REFRESH_MAXAGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The mount prefix every consumer route sits under. */
export const CONSUMER_PATH_PREFIX = "/api/consumer";

// Prefixed `hv_` so these can never collide with a cookie name an existing
// B2B verifier scavenges. middleware/auth.ts's getCookieToken reads
// hrms_accessToken / accessToken / token / jwt / auth; routes/workspace.ts's
// own getTokenFromReq reads accessToken / token / jwt / session / hrms_token.
// A collision would mean handing a consumer cookie to a B2B verifier — it
// would still fail on signature, but the wall must not have to rely on that.
export const CONSUMER_ACCESS_COOKIE = "hv_consumerAccess";
export const CONSUMER_REFRESH_COOKIE = "hv_consumerRefresh";

export const CONSUMER_ACCESS_COOKIE_PATH = CONSUMER_PATH_PREFIX;
// Narrow, mirroring B2B's /api/auth/refresh scoping: the refresh cookie is
// not sent on ordinary API calls, only to the one endpoint that consumes it.
export const CONSUMER_REFRESH_COOKIE_PATH = `${CONSUMER_PATH_PREFIX}/auth/refresh`;

/**
 * SameSite for consumer cookies.
 *
 * "Lax" is correct because SameSite is computed on the REGISTRABLE DOMAIN
 * (eTLD+1), not the origin:
 *
 *     helloviza.ai      -> eTLD+1 = helloviza.ai
 *     api.helloviza.ai  -> eTLD+1 = helloviza.ai      => SAME-SITE
 *
 * so a fetch from the consumer web app to the consumer API is cross-ORIGIN
 * but same-SITE, and a Lax cookie is sent with credentials:"include".
 *
 * ⚠ THE ONE CONDITION THAT FLIPS THIS TO "none" (which then also requires
 * Secure, including in local dev over http, where browsers reject it):
 * the consumer web app being served from a DIFFERENT REGISTRABLE DOMAIN than
 * the API — an Amplify preview URL (*.amplifyapp.com), a Vercel preview, or
 * helloviza.com fronting the .ai API. If that becomes true, this constant is
 * the single place to change.
 *
 * Not changed here, noted only: B2B uses sameSite "none" for
 * plumbox.plumtrips.com -> api.hrms.plumtrips.com, which are ALSO same-site
 * by eTLD+1. That may be stricter than it needs to be. B2B cookie behaviour
 * is out of scope for this phase.
 */
export const CONSUMER_COOKIE_SAMESITE = "lax" as const;

const DEFAULT_CONSUMER_COOKIE_DOMAIN = ".helloviza.ai";

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  if (v == null) return undefined;
  const trimmed = String(v).trim();
  return trimmed || undefined;
}

/**
 * The consumer signing secret. FAIL-CLOSED — no fallback, ever.
 *
 * Throws when unset, and throws when it equals JWT_SECRET: if the two are
 * equal the wall does not exist, because a consumer token would then verify
 * against requireAuth. There is no degraded mode worth having here.
 */
export function getConsumerJwtSecret(): string {
  const secret = readEnv("CONSUMER_JWT_SECRET");
  if (!secret) {
    throw new Error(
      "Missing env: CONSUMER_JWT_SECRET — the consumer identity wall cannot be enforced without it",
    );
  }
  if (secret === readEnv("JWT_SECRET")) {
    throw new Error(
      "CONSUMER_JWT_SECRET must not equal JWT_SECRET — identical secrets collapse the consumer/B2B wall",
    );
  }
  return secret;
}

/**
 * Boot assertion — called from server.ts before any router is mounted.
 * Refuses to start on an unset secret or one equal to JWT_SECRET.
 *
 * Deliberately just calls getConsumerJwtSecret() and discards the value, so
 * the boot check and the per-request check can never diverge into two
 * different notions of "valid".
 */
export function assertConsumerSecretIsolated(): void {
  getConsumerJwtSecret();
}

/**
 * Cookie domain, as a function of the ISSUING PATH.
 *
 * A consumer-path cookie is scoped to the consumer registrable domain
 * (CONSUMER_COOKIE_DOMAIN, default ".helloviza.ai"); anything else falls
 * through to the B2B COOKIE_DOMAIN with the exact semantics
 * routes/auth.ts:212-216 already has — including "empty/unset means omit the
 * `domain` attribute entirely", which is what keeps local dev host-only.
 *
 * routes/auth.ts is NOT edited and does not call this: B2B keeps calling its
 * own untouched cookieDomainOption(). This function reproduces that branch so
 * the path-driven rule is expressible and testable in one place, without
 * putting a single line of this phase's diff into a B2B file.
 */
export function cookieDomainForPath(path: string): { domain?: string } {
  const isConsumerPath = String(path || "").startsWith(CONSUMER_PATH_PREFIX);

  if (!isConsumerPath) {
    return domainOption(readEnv("COOKIE_DOMAIN"));
  }

  /* ── ABSENT vs PRESENT-BUT-EMPTY ───────────────────────────────────
   *
   * These are DIFFERENT answers on the consumer branch, and conflating
   * them made local development impossible.
   *
   *   ABSENT            -> ".helloviza.ai"  (the production default)
   *   PRESENT AND EMPTY -> omit `domain=`   (a host-only cookie)
   *
   * The bug this fixes: readEnv() maps "" to undefined, so
   * `readEnv(...) ?? DEFAULT` treated an explicitly-emptied variable as if
   * nobody had set it and reinstated ".helloviza.ai". A browser on
   * localhost silently DISCARDS a cookie scoped to a domain it is not on,
   * so the failure was invisible in the worst way — /login returned 200
   * with Set-Cookie, and the very next request was a 401. There was no
   * value of CONSUMER_COOKIE_DOMAIN that produced a working local session.
   *
   * Production is unaffected: an unset variable still yields the default,
   * which is the case every deployed environment is in. Only an operator
   * who deliberately writes `CONSUMER_COOKIE_DOMAIN=` gets host-only
   * cookies — which is exactly what .env.development.example now does, and
   * what the B2B COOKIE_DOMAIN branch above has always done.
   * ────────────────────────────────────────────────────────────────── */
  const declared = process.env.CONSUMER_COOKIE_DOMAIN;
  if (declared != null && String(declared).trim() === "") {
    return {};
  }

  return domainOption(readEnv("CONSUMER_COOKIE_DOMAIN") ?? DEFAULT_CONSUMER_COOKIE_DOMAIN);
}

function domainOption(raw: string | undefined): { domain?: string } {
  return raw ? { domain: raw } : {};
}
