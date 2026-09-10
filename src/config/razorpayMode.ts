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
// ── THERE ARE NOW TWO KEYS, AND THEY DO NOT SHARE A FATE ─────────────
// D2C (helloviza visa fees) settles to its own Razorpay MID; B2B/SBT
// (flights, hotels) keeps the original. Two accounts, two key ids, two
// webhook secrets. Both must agree with NODE_ENV — a test key in
// production is exactly as wrong for a visa fee as for a flight — so the
// MODE rule below is one rule applied twice, with `label` naming which key
// a message is about.
//
// What the two keys do NOT share is what ABSENCE means, and that is why
// this file exposes two entry points instead of one flag:
//
//   assertRazorpayKeyMatchesEnv()      — B2B. Absence in production is
//                                        FATAL. Unchanged behaviour: this
//                                        key IS the payment system, and a
//                                        deployment that cannot take
//                                        payments is a broken deployment.
//
//   assertRazorpayKeyModeMatchesEnv()  — D2C. Absence is REPORTED, not
//                                        thrown; the caller decides. It
//                                        returns NOT_CONFIGURED and
//                                        config/env.ts logs at error level.
//
// The D2C rule is not a softening of the guard, it is a scoping of it. The
// guard exists to prevent WRONG MONEY, and an absent key cannot move any:
// routes/consumer.applications.ts already answers 503
// GATEWAY_NOT_CONFIGURED when it finds no key, so the failure is loud,
// contained, and moves nobody's card. Making it fatal instead would take
// down flights, hotels and HRMS because a visa-fee variable was unset —
// trading a small, correct failure for a large, unrelated one. A
// MODE MISMATCH stays fatal for both keys, because that one is wrong money.
//
// ── WHY AN ABSENT B2B KEY IS ALLOWED OUTSIDE PRODUCTION ──────────────
// Not an oversight — it is the posture the call sites already take. Every
// one of them checks `if (!keyId || !keySecret)` and returns a clean 503
// (`GATEWAY_NOT_CONFIGURED`) instead of crashing, with the comment "so
// this ships before the test keys are in .env and starts working the
// moment they are". A fresh clone, CI, and every test that never sets the
// variable rely on that. Throwing on absence outside production would
// break all three to prevent a charge that cannot happen — there is no
// key, so there is no gateway. In PRODUCTION the same absence is fatal
// for the B2B key, and reported for the D2C one, per the split above.
// ══════════════════════════════════════════════════════════════════════

/** Razorpay's own mode markers. These are the only two it issues. */
const TEST_PREFIX = "rzp_test_";
const LIVE_PREFIX = "rzp_live_";

/** The env var this guard was originally written for. Keeping it as the
 *  default is what lets the B2B call site stay a two-argument call. */
const DEFAULT_KEY_LABEL = "RAZORPAY_KEY_ID";

/**
 * Whether a key was present at all. Returned rather than thrown so the
 * caller owns the absence decision — see the header.
 */
export type RazorpayKeyStatus = "CONFIGURED" | "NOT_CONFIGURED";

/**
 * THE MODE RULE, and only the mode rule. Throws when a key's declared mode
 * contradicts the runtime environment; returns NOT_CONFIGURED, silently and
 * without judgement, when there is no key to have a mode.
 *
 * Pure and total: it reads nothing from process.env and either returns or
 * throws, so the boot behaviour can be proved from a test without booting
 * anything. config/env.ts supplies the real values exactly once per key.
 *
 * @param keyId   the key id as configured, or undefined if unset
 * @param nodeEnv the resolved NODE_ENV ("production" | anything else)
 * @param label   the env var name, used in every message so that with two
 *                keys in play a boot failure says WHICH one is wrong
 */
export function assertRazorpayKeyModeMatchesEnv(
  keyId: string | undefined,
  nodeEnv: string,
  label: string = DEFAULT_KEY_LABEL,
): RazorpayKeyStatus {
  const key = String(keyId ?? "").trim();
  const isProduction = nodeEnv === "production";

  /* ── ABSENCE IS NOT THIS FUNCTION'S CALL ─────────────────────────────
   * A key that does not exist has no mode to contradict anything. What an
   * absent key MEANS differs per key (fatal for B2B, reported for D2C), so
   * it is reported upward rather than decided here. Blank and whitespace
   * are absent — a variable set to "" in App Runner is not a key. */
  if (!key) return "NOT_CONFIGURED";

  if (isProduction) {
    // Production takes real money or it does not run. An unrecognised
    // prefix is refused alongside the test prefix: neither is a key we can
    // confirm will actually charge, and "probably fine" is not a standard
    // to apply to somebody's card.
    if (!key.startsWith(LIVE_PREFIX)) {
      const declared = key.startsWith(TEST_PREFIX) ? TEST_PREFIX : "an unrecognised prefix";
      throw new Error(
        `Razorpay key ${label} is ${declared} but NODE_ENV=production — refusing to start. ` +
          "Production must use a live key (rzp_live_…); a test key accepts checkouts " +
          "and marks them paid while no money moves.",
      );
    }
    return "CONFIGURED";
  }

  // The one genuinely dangerous case outside production: a live key loaded
  // somewhere that is not production. Anyone exercising the checkout flow
  // here is spending real money against the live account.
  if (key.startsWith(LIVE_PREFIX)) {
    throw new Error(
      `Razorpay key ${label} is ${LIVE_PREFIX} but NODE_ENV=${nodeEnv} — refusing to start. ` +
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
      `[razorpay] ${label} does not begin with ${TEST_PREFIX} or ${LIVE_PREFIX} — ` +
        "its mode cannot be verified. Payment calls will fail against Razorpay. " +
        `(NODE_ENV=${nodeEnv})`,
    );
  }

  return "CONFIGURED";
}

/**
 * THE B2B RULE: the mode rule, plus fail-closed on absence in production.
 *
 * Behaviour is unchanged from before the D2C split — same throws, same
 * non-throws, same single console.warn. Only the message text gained the
 * env var name, because with two keys configured "Razorpay key is
 * rzp_test_ but NODE_ENV=production" no longer identifies which key to go
 * and fix.
 *
 * @param label defaults to RAZORPAY_KEY_ID so the B2B call site in
 *              config/env.ts stays exactly the two-argument call it was.
 */
export function assertRazorpayKeyMatchesEnv(
  keyId: string | undefined,
  nodeEnv: string,
  label: string = DEFAULT_KEY_LABEL,
): void {
  const status = assertRazorpayKeyModeMatchesEnv(keyId, nodeEnv, label);

  // ── FAIL CLOSED ────────────────────────────────────────────────────
  // Production takes real money or it does not run.
  if (status === "NOT_CONFIGURED" && nodeEnv === "production") {
    throw new Error(
      `Razorpay key ${label} is not configured but NODE_ENV=production — refusing to start. ` +
        `Set ${label} to the live key (rzp_live_…).`,
    );
  }

  // Outside production, no key at all is a supported state — the gateway is
  // simply off and every call site already answers 503.
}
