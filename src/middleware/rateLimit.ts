import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

// General API limiter — all routes
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

// Auth limiter — login, register, forgot-password
// login and refresh are skipped here; they're still covered by apiLimiter (500/15 min)
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  skip: (req) =>
    req.path.includes('/login') ||
    req.path.includes('/refresh'),
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts, please try again later.' },
});

// TBO flight search limiter — expensive external API call
export const flightSearchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many search requests, please slow down.' },
});

// TBO hotel search limiter
export const hotelSearchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many hotel search requests, please slow down.' },
});

// Copilot AI limiter — Gemini API calls
export const copilotLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many AI requests, please slow down.' },
});

// Public hotel-photo image endpoint — UNAUTHENTICATED and billable.
//
// This is the real guard now that the endpoint is public: auth used to be what
// stood between the internet and a Google Places Photo call, and auth was the
// wrong tool (it also broke every <img> in production, which cannot send a
// cookie cross-origin). A per-IP limit is the right tool.
//
// Sized against genuine use, not worst case: a hotel answer shows at most 12
// photos, the response is browser-cached for 24h, and a resolved photo is
// served from our own cache — so a real user costs ~12 requests once a day.
// 120/min leaves an office behind one NAT plenty of room while capping a
// scripted hammer at two orders of magnitude below anything that would matter
// on the bill.
export const hotelPhotoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.HOTEL_PHOTO_RATE_LIMIT) || 120,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many photo requests, please slow down.' },
});

/* ── Consumer mobile OTP ──────────────────────────────────────────────
 *
 * EVERY SEND HERE COSTS A REAL SMS. That is what makes this different from
 * every other limiter in this file: the others protect latency, a quota, or
 * a bot surface. This one protects a bill, and the attacker's goal is
 * simply to make it large.
 *
 * ── KEYED BY CONSUMER, NOT BY IP ─────────────────────────────────────
 * Both limiters below are mounted AFTER requireConsumer, so req.consumer is
 * always populated by the time the key is computed. IP is the wrong key
 * here in both directions: a college hostel or an office behind one NAT
 * would share a bucket, while an attacker with one valid session and a
 * phone tether rotates IPs for free. The session is the thing that costs
 * money, so the session is the key. The ipKeyGenerator fallback exists only
 * so the function is total — it is not the expected path.
 *
 * ── SEND AND RESEND SHARE THIS ONE INSTANCE, DELIBERATELY ────────────
 * express-rate-limit's store is per-instance, so mounting the SAME limiter
 * on both routes gives them ONE bucket. Two separate limiters at 5 each
 * would mean 10 messages per hour per consumer, which is exactly the
 * arithmetic an abuser would do. A resend is a billable SMS just like a
 * send, so it draws from the same allowance.
 *
 * ── WHY 5/HOUR ──────────────────────────────────────────────────────
 * Sized against genuine use: a consumer verifies their number once, ever.
 * The realistic bad-but-honest case is a wrong number typed, corrected, and
 * verified — three sends — plus a resend when the first SMS is slow. Five
 * covers that with room and caps the worst case at 5 SMS per account per
 * hour, which is a rounding error on the bill rather than an incident.
 */
export const consumerOtpSendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  keyGenerator: (req) =>
    (req as any).consumer?.id
      ? `consumer:${(req as any).consumer.id}`
      : ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many verification codes requested. Please try again in an hour.",
    code: "OTP_RATE_LIMITED",
  },
});

/*
 * Verify costs nothing to run, so this is a brute-force guard rather than a
 * cost guard. MSG91 caps attempts against the outstanding code on its own
 * side; this is the second fence, and it exists because that cap is a
 * provider behaviour we do not control and cannot test against.
 *
 * 5/15min is comfortably above a human fat-fingering a 4-digit code twice
 * and well below useful odds against a 10,000-code keyspace.
 *
 * Recalibrated when the codes went 6-digit → 4-digit: the old note said "one
 * in a million", which was the 6-digit keyspace. Four digits is 10,000, so
 * the same 10 attempts bought 100x better odds than that line claimed.
 *
 * The binding fence is actually the SEND limiter above, not this one. A
 * guess is only worth making against an OUTSTANDING code, so the attempts
 * that matter are bounded by how many codes an attacker can cause to exist:
 * 5 sends/hour x 5 attempts each is ~25 guesses/hour against 10,000, and
 * every one of those codes costs a billable SMS. Shortening the expiry to
 * 5 minutes tightens it further, by shrinking the window in which any one
 * code is still guessable.
 */
export const consumerOtpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) =>
    (req as any).consumer?.id
      ? `consumer:${(req as any).consumer.id}`
      : ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many attempts. Please request a new code and try again shortly.",
    code: "OTP_RATE_LIMITED",
  },
});

/* ══════════════════════════════════════════════════════════════════════
 * PUBLIC MOBILE-OTP AUTH (routes/consumer.mobileAuth.ts) — KEYED ON THE
 * PHONE NUMBER, NOT THE IP.
 * ══════════════════════════════════════════════════════════════════════
 * The two limiters above key on `req.consumer?.id` and fall back to the IP.
 * That is right for a session-gated endpoint and USELESS on a public one:
 * with no session, every caller takes the IP branch, which fails in both
 * directions at once. One carrier NAT or office egress throttles hundreds of
 * unrelated people, while anybody with a pool of addresses walks straight
 * around the cap — and the cap is the only thing standing between us and an
 * unbounded SMS bill.
 *
 * So the primary key here is the NORMALISED PHONE NUMBER, because that is
 * the unit that actually costs money and the unit an abuser targets. Five
 * sends against one number is five billable SMS no matter how many hosts
 * asked for them.
 *
 * ⚠ NORMALISE BEFORE KEYING. "+91 98765 43210", "919876543210" and
 * "9876543210" are ONE number; keyed raw they are three buckets and the
 * limit is bypassed by reformatting — a whitespace character would do it.
 * phoneKey() runs the same normaliser the route and the database use, so
 * every spelling of a number lands in one bucket.
 *
 * A caller that sends no usable number at all falls back to the IP: the
 * route rejects it before any provider call, so this only has to stop a
 * flood of junk from one source, and there is no number to key on.
 */
function phoneKey(req: any): string {
  const digits = String(req?.body?.mobile ?? "").replace(/[^\d]/g, "");
  const ten =
    digits.length === 10
      ? digits
      : digits.length === 12 && digits.startsWith("91")
        ? digits.slice(2)
        : "";
  return ten ? `mobile:${ten}` : ipKeyGenerator(req.ip || "unknown");
}

/*
 * SEND — the cost fence. 5 per hour per number.
 *
 * Deliberately the same allowance as the profile-verify path, for a
 * different reason. There, five covered "a consumer verifies once, ever,
 * plus a correction". Here the flow is repeatable — a person logs in with
 * OTP whenever they come back — so the question is how many logins per hour
 * one number could honestly need. Five is generous for that (a login, a
 * mistyped code needing a fresh send, a slow SMS, and two spare) and still
 * caps the bill at five messages per number per hour.
 */
export const mobileAuthSendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  keyGenerator: phoneKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many codes requested for this number. Please try again in an hour.",
    code: "OTP_RATE_LIMITED",
  },
});

/*
 * RESEND COOLDOWN — 1 per 45 seconds per number.
 *
 * Separate from the hourly cap because it answers a different question.
 * The hourly cap stops a sustained drain; this stops the impatient double
 * tap, which is the common case and the one that silently doubles the bill.
 * 45s is longer than an SMS normally takes to arrive and short enough that
 * somebody who genuinely did not get it is not left staring at a dead
 * button. It sits IN FRONT of the hourly cap, so a burst is refused without
 * consuming the hourly allowance the reader may still legitimately need.
 */
export const mobileAuthResendCooldown = rateLimit({
  windowMs: 45 * 1000,
  max: 1,
  keyGenerator: phoneKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "We just sent a code. Give it a moment before asking for another.",
    code: "OTP_COOLDOWN",
  },
});

/*
 * VERIFY — the brute-force fence. 5 per 10 minutes per number.
 *
 * Costs nothing to run, so this is not about money. The codes are 4 digits
 * (10,000 wide) and MSG91 expires them in 5 minutes, so the real bound is
 * how many guesses fit against a LIVE code. The send limiter is the binding
 * fence — a guess is only worth making against an outstanding code — and
 * this is the second one, because MSG91's own per-code attempt cap is
 * provider behaviour we neither control nor test against.
 */
export const mobileAuthVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  keyGenerator: phoneKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many attempts. Request a new code and try again shortly.",
    code: "OTP_RATE_LIMITED",
  },
});

/*
 * IP fence, SECONDARY and deliberately loose.
 *
 * The per-number limiters above are the real control. This one exists only
 * to stop a single host walking a dictionary of NUMBERS — an attack the
 * per-number keys cannot see, because each number gets its own fresh
 * allowance. Loose enough that a shared NAT full of genuine travellers
 * never reaches it; tight enough that one host cannot enumerate.
 *
 * 100/hour, not 30. Thirty would have reproduced the very failure the
 * per-number keys exist to avoid: one office or carrier NAT can easily
 * carry thirty honest sign-ins in an hour, and they would start failing for
 * everyone behind it. A hundred still slows a single-host dictionary walk
 * to a crawl, and it is not the fence that matters anyway — the per-number
 * cap is, and it holds no matter how many addresses an attacker has.
 */
export const mobileAuthIpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 100,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests from this network. Please try again later.",
    code: "OTP_RATE_LIMITED",
  },
});

// Public travel-request form — unauthenticated write endpoint; a real
// applicant submits once per visit, so this stays tight (bot/spam surface).
export const travelRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});
