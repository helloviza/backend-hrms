// apps/backend/src/config/razorpayMode.ts
//
// ══════════════════════════════════════════════════════════════════════
// DOES THE RAZORPAY KEY AGREE WITH THE ENVIRONMENT IT IS RUNNING IN?
//
// Razorpay key ids carry their own mode in the string: `rzp_test_…` moves
// no money, `rzp_live_…` moves real customer money. Until this file, that
// prefix was never inspected anywhere in the codebase, which left two
// failures that both stay silent until the money is already wrong:
//
//   TEST key in PRODUCTION — checkout succeeds, the webhook fires, the
//   application is marked paid, an invoice is issued. No money ever
//   arrived. Nobody finds out until reconciliation.
//
//   LIVE key in DEV or TEST — a developer clicking through the consumer
//   flow charges a real card against the live account. That one is not
//   recoverable by a redeploy.
//
// So the check runs ONCE at boot (from config/env.ts) and throws rather
// than letting the process serve traffic it cannot charge correctly. A
// startup crash is loud, immediate, and costs nothing; a wrong charge is
// none of those things.
//
// ── THE KEYS ARE SHARED, AND THAT IS WHY THIS IS NOT D2C-ONLY ─────────
// RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are read straight off process.env by
// BOTH the D2C consumer path (routes/consumer.applications.ts) and the B2B
// SBT paths (routes/sbt.flights.ts, routes/sbt.hotels.ts). There is one
// key serving both, so this guard is deliberately about that one key and
// makes no D2C-only assumption. A mismatch is equally wrong for a flight
// booking as for a visa fee.
//
// ── WHY AN ABSENT KEY IS ALLOWED OUTSIDE PRODUCTION ──────────────────
// Not an oversight — it is the posture the call sites already take. Every
// one of them checks `if (!keyId || !keySecret)` and returns a clean 503
// (`GATEWAY_NOT_CONFIGURED`) instead of crashing, with the comment "so
// this ships before the test keys are in .env and starts working the
// moment they are". A fresh clone, CI, and every test that never sets the
// variable rely on that. Throwing on absence outside production would
// break all three to prevent a charge that cannot happen — there is no
// key, so there is no gateway. In PRODUCTION the same absence is fatal:
// a payments deployment that cannot take payments is a broken deployment,
// and failing closed is the whole point.
// ══════════════════════════════════════════════════════════════════════

/** Razorpay's own mode markers. These are the only two it issues. */
const TEST_PREFIX = "rzp_test_";
const LIVE_PREFIX = "rzp_live_";

/**
 * Throws when the key's declared mode contradicts the runtime environment.
 *
 * Pure and total: it reads nothing from process.env and returns void or
 * throws, so the boot behaviour can be proved from a test without booting
 * anything. config/env.ts supplies the two real values exactly once.
 *
 * @param keyId   the RAZORPAY_KEY_ID as configured, or undefined if unset
 * @param nodeEnv the resolved NODE_ENV ("production" | anything else)
 */
export function assertRazorpayKeyMatchesEnv(
  keyId: string | undefined,
  nodeEnv: string,
): void {
  const key = String(keyId ?? "").trim();
  const isProduction = nodeEnv === "production";

  if (isProduction) {
    // ── FAIL CLOSED ──────────────────────────────────────────────────
    // Production takes real money or it does not run. Absent and
    // unrecognised are the same answer here — neither one is a key we can
    // confirm will actually charge, and "probably fine" is not a standard
    // to apply to somebody's card.
    if (!key) {
      throw new Error(
        "Razorpay key is not configured but NODE_ENV=production — refusing to start. " +
          "Set RAZORPAY_KEY_ID to the live key (rzp_live_…).",
      );
    }
    if (!key.startsWith(LIVE_PREFIX)) {
      const declared = key.startsWith(TEST_PREFIX) ? TEST_PREFIX : "an unrecognised prefix";
      throw new Error(
        `Razorpay key is ${declared} but NODE_ENV=production — refusing to start. ` +
          "Production must use a live key (rzp_live_…); a test key accepts checkouts " +
          "and marks them paid while no money moves.",
      );
    }
    return;
  }

  // ── OUTSIDE PRODUCTION ───────────────────────────────────────────────
  // No key at all is a supported state — the gateway is simply off and
  // every call site already answers 503. Nothing to check.
  if (!key) return;

  // The one genuinely dangerous case: a live key loaded somewhere that is
  // not production. Anyone exercising the checkout flow here is spending
  // real money against the live account.
  if (key.startsWith(LIVE_PREFIX)) {
    throw new Error(
      `Razorpay key is ${LIVE_PREFIX} but NODE_ENV=${nodeEnv} — refusing to start. ` +
        "A live key outside production charges real cards during development and testing. " +
        `Use the test key (${TEST_PREFIX}…), or set NODE_ENV=production if this really is production.`,
    );
  }

  // Neither prefix: a malformed or placeholder value. It cannot move money
  // — that takes a live key — so this warns rather than blocking a local
  // boot, following the same posture as the MONGO_URI guardrail in
  // config/env.ts, which shouts about a dangerous non-production setup
  // without refusing to start.
  if (!key.startsWith(TEST_PREFIX)) {
    console.warn(
      `[razorpay] RAZORPAY_KEY_ID does not begin with ${TEST_PREFIX} or ${LIVE_PREFIX} — ` +
        "its mode cannot be verified. Payment calls will fail against Razorpay. " +
        `(NODE_ENV=${nodeEnv})`,
    );
  }
}
