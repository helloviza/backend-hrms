import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt.js';

/* ── GLOBAL LIMITS — tune here ────────────────────────────────────────
 * Logged-in traffic is keyed per USER, anonymous traffic per IP.
 *
 * The old single 500/15min per-IP bucket was shared by everyone behind one
 * office NAT, so one tab stuck in a reconnect loop locked a whole company
 * out. A user ID is the honest unit for signed-in traffic: two colleagues
 * on one egress are two buckets, and one user on many IPs is still one.
 *
 * 1,500 is a ceiling for runaway clients, not a pacing control: an active
 * staff session (bell + activity + chat polls, dashboards, a hotel search's
 * image fan-out) stays well under ~100/min. Expensive routes carry their
 * own tighter caps below.
 */
export const API_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const API_LIMIT_PER_USER = 1500;
export const API_LIMIT_PER_IP_ANON = 500;

/**
 * The verified user ID behind the request's Bearer token, or null.
 *
 * Same check middleware/auth.ts runs — a signature verify against
 * JWT_SECRET, no DB lookup — so a forged or expired token cannot claim a
 * user's bucket; it falls back to the IP like any anonymous caller.
 * Memoised on the request because several limiters may ask.
 */
export function rateLimitUserId(req: Request): string | null {
  const r = req as any;
  if (r.__rateLimitUserId !== undefined) return r.__rateLimitUserId;
  let id: string | null = null;
  const hdr = req.headers.authorization;
  if (hdr && hdr.startsWith('Bearer ')) {
    const token = hdr.slice('Bearer '.length).trim();
    if (token) {
      try {
        const sub = (verifyToken(token) as any)?.sub;
        if (sub) id = String(sub);
      } catch {
        id = null;
      }
    }
  }
  r.__rateLimitUserId = id;
  return id;
}

const ipKey = (req: Request) => ipKeyGenerator(req.ip || 'unknown');

/**
 * Per-user key when the Bearer token verifies, else the client IP.
 * Reads the token rather than req.user because every limiter using it is
 * mounted in server.ts BEFORE the routers' requireAuth runs.
 */
export const userOrIpKey = (req: Request) => {
  const id = rateLimitUserId(req);
  return id ? `user:${id}` : ipKey(req);
};

/**
 * 429 handler that also logs. Logs the FIRST block of a bucket and then
 * every 100th, so a client hammering in a loop leaves a trail without
 * flooding the log. Records user ID, req.ip and the raw X-Forwarded-For —
 * the last two side by side are what settles whether req.ip is the real
 * client or a proxy hop (see `trust proxy` in server.ts).
 */
function loggingHandler(name: string) {
  return (req: Request, res: Response, _next: NextFunction, options: any) => {
    const info = (req as any).rateLimit;
    const over = info ? info.used - info.limit : 1;
    if (over === 1 || over % 100 === 0) {
      console.warn(
        `[rate-limit] 429 limiter=${name} user=${rateLimitUserId(req) || '-'} ip=${req.ip || '-'} ` +
          `xff=${String(req.headers['x-forwarded-for'] || '-')} ${req.method} ${req.originalUrl.split('?')[0]} ` +
          `used=${info?.used ?? '?'}/${info?.limit ?? '?'}`
      );
    }
    res.status(options.statusCode).json(options.message);
  };
}

// General API limiter — all routes. Per user when signed in, per IP otherwise.
export const apiLimiter = rateLimit({
  windowMs: API_LIMIT_WINDOW_MS,
  max: (req) => (rateLimitUserId(req) ? API_LIMIT_PER_USER : API_LIMIT_PER_IP_ANON),
  keyGenerator: userOrIpKey,
  handler: loggingHandler('api'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

// Auth limiter — login, register, forgot-password
// login, refresh and me are skipped here; they're still covered by apiLimiter.
// /me is session restore on every boot/tab, not a brute-force target.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  skip: (req) =>
    req.path.includes('/login') ||
    req.path.includes('/refresh') ||
    req.path === '/me',
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  handler: loggingHandler('auth'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many auth attempts, please try again later.' },
});

// TBO flight search limiter — expensive external API call — per user (IP when anonymous)
export const flightSearchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30,
  keyGenerator: userOrIpKey,
  handler: loggingHandler('flightSearch'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many search requests, please slow down.' },
});

// TBO hotel search limiter — per user (IP when anonymous)
export const hotelSearchLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 20,
  keyGenerator: userOrIpKey,
  handler: loggingHandler('hotelSearch'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many hotel search requests, please slow down.' },
});

// Copilot AI limiter — Gemini API calls — per user (IP when anonymous)
export const copilotLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  keyGenerator: userOrIpKey,
  handler: loggingHandler('copilot'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many AI requests, please slow down.' },
});

/* ── SBT HOTEL IMAGES — GET /api/sbt/hotels/images ───────────────────
 * Each call can cost a TBO HotelDetails request (cache misses only). The
 * search page fans out one call per 10 hotel codes, and a search returns
 * at most 400 hotels (SEARCH_TOP_N in tbo.hotel.search.service.ts), so one
 * full search costs at most 40 calls. 200 per 10 minutes covers five full
 * searches back to back; the ~2,000x repeat seen in the logs is stopped
 * at 200. Per user, so colleagues on one NAT don't share it.
 */
export const hotelImagesLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 200,
  keyGenerator: userOrIpKey,
  handler: loggingHandler('hotelImages'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many image requests, please slow down.' },
});

/* ── TRAVEL CONCIERGE — /api/v1/copilot/travel ───────────────────────
 * Every POST is a Gemini turn and/or a live TBO search, and this mount had
 * no cap of its own. 20 POSTs a minute per user is well past a human
 * typing or clicking Search; GETs (itinerary, conversation, watches) are
 * plain reads and are not counted.
 */
export const travelCopilotLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  skip: (req) => req.method === 'GET',
  keyGenerator: userOrIpKey,
  handler: loggingHandler('travelCopilot'),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many concierge requests, please slow down.' },
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

// Partner lead links (routes/public.partnerRequest.ts). Their own counters, not
// travelRequestLimiter's: a student on a partner's page and a visitor on the
// public travel-request form are different doors, and sharing a counter would
// let one spend the other's budget. Submit is as tight as the travel-request
// form (one real submit per visit); resolve runs once per page load, so 60.
// A per-code daily cap (PartnerLink.dailyCap) sits on top, in Mongo.
export const partnerRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

// The form's hotel city typeahead (one call per pause in typing, a database read).
export const partnerHotelCityLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 120,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

// Student "Track my case" (routes/public.partnerTrack.ts). Asking for a code
// sends an email, so it is tight; verifying allows a few typos on top of the
// per-code limit of 5; reading the list runs once per page view.
export const partnerTrackRequestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

export const partnerTrackVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

export const partnerTrackCasesLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

export const partnerLinkResolveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

/* ── CONSUMER PASSPORT AUTOFILL (2026-09-06) ──────────────────────────
 * POST /api/consumer/profile/documents/:id/extract — reading a passport
 * so the apply form can fill itself in.
 *
 * KEYED ON THE CONSUMER, NOT THE IP. The route is behind requireConsumer,
 * so a caller always has an identity, and that identity is the honest unit
 * of the budget: two people on one office NAT are two people, and one
 * person cycling addresses is still one person. The other limiters in this
 * file key on IP because their routes are reached BEFORE anyone is signed
 * in, which is not the case here.
 *
 * WHY 12 IN 15 MINUTES. One upload costs one call — two when the first
 * transcription fails the TD3 parse and the engine takes its one plain
 * retry. The honest ceiling for one sitting is a passport, a re-photograph
 * after a glare failure, and a co-traveller's passport: three uploads, so
 * at most six calls. Twelve leaves room for a bad-lighting afternoon
 * without letting anyone turn the endpoint into a free Gemini vision
 * budget, which is the actual thing being rationed — the extraction stores
 * nothing, so there is no data-shaped abuse to price, only spend.
 */
export const consumerPassportExtractLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 12,
  keyGenerator: (req: any) =>
    req?.consumer?.id ? `consumer:${req.consumer.id}` : ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "You've read a lot of passports just now — please try again in a few minutes." },
});

/* ── VISA PROFILE SCORE (2026-09-02) ──────────────────────────────────
 * POST /api/public/visa-score/score — unauthenticated COMPUTE endpoint.
 *
 * This limit is not a spam control, it is the anti-model-extraction
 * control, and it is sized from that threat rather than from politeness.
 *
 * The response deliberately withholds every weight (routes/public.visaScore
 * .ts §12.2 firewall), but hiding them is not the same as making them
 * unrecoverable: hold every answer fixed, vary ONE question across its
 * options, and diff the returned scores, and that question's deltas fall
 * out in about five calls. The full 15-question table costs roughly 75
 * calls per corridor. The firewall raises the price from "read the JS
 * bundle" — which is how the competitor this was modelled against got
 * cloned — to "run a few hundred requests"; this limiter is what keeps
 * that price real.
 *
 * WHY 60 AND NOT travelRequestLimiter's 8. The enquiry form is submitted
 * once per visit. An assessment is not: someone comparing three
 * destinations legitimately scores three times, and if the Phase 3 UI
 * re-scores as each answer is chosen (as the reference UI does, to animate
 * its gauge) one assessment costs ~15 calls on its own. Eight would break
 * the honest case on the first visit. Sixty leaves room for roughly four
 * live-updating assessments per window while still putting full extraction
 * of even one corridor over multiple windows.
 *
 * ── DECIDED, PHASE 3b: SIXTY STAYS. ─────────────────────────────────
 * The open question above was "does Phase 3 score once on submit, or per
 * answer?", because a score-once UI would make 15 or 20 generous. It
 * scores PER ANSWER — the live gauge is the product — so the looser
 * number is not a default left standing, it is the sized one: ~15 calls
 * for one assessment, four assessments per window.
 *
 * This also became the ONLY control on /score in the same phase. The
 * endpoint's Turnstile gate was removed because a per-submission token
 * cannot cover a per-answer gauge (routes/public.visaScore.ts states the
 * full reasoning at the route). Cutting this to 20 now would break an
 * honest reader's second assessment AND leave nothing else standing.
 */
export const visaScoreLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many scoring requests, please try again later.' },
});

/* ── VISA PROFILE SCORE — LEAD CAPTURE (2026-09-02) ───────────────────
 * POST /api/public/visa-score/lead — the email gate on the breakdown.
 *
 * A DIFFERENT limit from visaScoreLimiter above, and deliberately its own
 * budget rather than a share of one. /score computes and writes nothing;
 * this endpoint CREATES A TICKET in the queue ops actually works, so the
 * cost of abuse is somebody's inbox rather than some CPU.
 *
 * WHY 5. The honest ceiling is one submission per assessment, and a reader
 * comparing three destinations submits three. Five leaves room for a retry
 * after a transport failure — which the submissionId dedupe absorbs
 * anyway — and puts a scripted flood of ops tickets out of reach at four
 * per hour per address. travelRequestLimiter's 8 is NOT reused: the two
 * doors would then share one counter, and an enquiry form submission would
 * eat a score submission's budget for no reason a user could understand.
 */
export const visaScoreLeadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  keyGenerator: (req) => ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests, please try again later.' },
});

/* ── CONSUMER VISA SCORE (Phase C, 2026-09-08) ────────────────────────
 * POST /api/consumer/visa-score/score — a signed-in consumer scoring
 * their own profile, which also PERSISTS the assessment to their account.
 *
 * ITS OWN COUNTER, NOT A SHARE OF visaScoreLimiter's 60. Two reasons.
 * The public budget is keyed on IP and sized against weight extraction;
 * this one is keyed on a consumer and sized against ordinary use. Folding
 * them together would mean a household behind one NAT exhausting each
 * other's assessments, and it would let a signed-in caller spend the
 * anonymous budget as well as their own.
 *
 * WHY 30. The gauge re-scores PER ANSWER — that is the product, and it is
 * why the public limit is 60 rather than 8 — so one complete in-account
 * assessment costs roughly 15 calls. Thirty covers an assessment plus a
 * round of corrections, or two assessments back to back for someone
 * comparing corridors. Below about 20 the honest second assessment starts
 * failing; far above 30 and a signed-up scraper gets a bigger allowance
 * than an anonymous one, which would make free signup the cheapest way
 * around the firewall.
 *
 * ── AND WHY AN IDENTITY IS NOT ITSELF A MOAT ─────────────────────────
 * Consumer signup is self-service, so "logged in" costs an attacker one
 * email address. What the identity buys is attribution and revocability —
 * a scraping account can be disabled, an IP cannot — not a licence to
 * raise the ceiling. The §12.2 extraction cost is unchanged by
 * authentication: the weights are recovered by differencing scores, and
 * that arithmetic does not care who is asking.
 *
 * (The impact firewall since 2026-09-07 means factors carry a bucket
 * rather than a raw delta, so a single response no longer hands over a
 * per-question weight at all. That lowered the risk this number is
 * defending against; it did not remove it, which is why 30 is sized for
 * real use rather than opened up.)
 */
export const consumerVisaScoreLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  keyGenerator: (req: any) =>
    req?.consumer?.id ? `consumer:${req.consumer.id}` : ipKeyGenerator(req.ip || "unknown"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "You've scored a lot of profiles just now — please try again in a few minutes." },
});
