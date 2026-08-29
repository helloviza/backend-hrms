// apps/backend/src/routes/consumer.mobileAuth.ts
//
// SIGN IN AND SIGN UP WITH A MOBILE NUMBER. Mounted PUBLIC at
// /api/consumer/auth/mobile — no requireConsumer anywhere in this file.
//
// ══════════════════════════════════════════════════════════════════════
// WHY THIS IS A NEW FILE AND NOT A LOOSENED consumer.mobileOtp.ts
// ══════════════════════════════════════════════════════════════════════
// That file's header states the rule it is built on: THE NUMBER IS NEVER
// READ FROM THE REQUEST BODY. Every handler there loads the acting
// consumer's own profile and takes contact.mobile off it, precisely so an
// endpoint cannot be talked into sending an SMS to an arbitrary number on
// our bill, or into setting a verified flag on somebody else's profile.
//
// A public sign-in form is the exact opposite case: there is no session, so
// the number MUST come from the body — there is nowhere else it could come
// from. Relaxing the old file to allow that would delete a deliberate
// safety property from the path that still needs it. So the two live apart:
// that file keeps its rule, this one takes the number from the body and
// pays for it with a Turnstile gate, per-number rate limits, and the fact
// that possessing the number is the entire thing being proven here.
//
// What IS shared is everything below the routing layer — the MSG91 client,
// the normaliser, the session issuer, the B2B gate, the consent builder,
// the location stamp. Imported, never re-implemented: two copies of "how a
// consumer account is created" is how the two doors drift into producing
// two different kinds of account.
//
// ══════════════════════════════════════════════════════════════════════
// THE THREE ENDPOINTS
// ══════════════════════════════════════════════════════════════════════
//   POST /start     { mobile }                     -> send an OTP
//   POST /verify    { mobile, code }               -> log in, OR hand back
//                                                     a proof-of-phone token
//   POST /complete  { proofToken, email, name }    -> create the account
//
// /start is identical for signup and login by design; see the enumeration
// note on it. The fork happens at /verify, after the caller has proved they
// hold the number.
//
// ══════════════════════════════════════════════════════════════════════
// NO OTP IS STORED BY US. NOT HASHED, NOT ANYWHERE.
// ══════════════════════════════════════════════════════════════════════
// MSG91's OTP product generates the code, delivers it, owns the expiry and
// answers the verification (services/consumerMobileOtp.ts). We hold no
// code, no expiry and no attempt counter, so there is no OTP table to leak,
// no clock of ours to get wrong, and nothing to clean up. The one piece of
// state that has to survive between "phone proved" and "account created" is
// the proof token below, which is signed rather than stored.
import { Router } from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";

import Consumer from "../models/Consumer.js";
import ConsumerProfile from "../models/ConsumerProfile.js";
import { createTurnstileGate } from "../middleware/turnstile.js";
import {
  mobileAuthIpLimiter,
  mobileAuthResendCooldown,
  mobileAuthSendLimiter,
  mobileAuthVerifyLimiter,
} from "../middleware/rateLimit.js";
import {
  MobileOtpNotConfiguredError,
  normaliseIndiaMobile,
  sendMobileOtp,
  verifyMobileOtp,
} from "../services/consumerMobileOtp.js";
import {
  B2B_MARKER,
  B2B_MESSAGE,
  b2bAccountExists,
  buildSignupConsent,
  issueConsumerSession,
  normalizeEmail,
  publicConsumer,
  resolveRegistrationLocation,
  stampConsumerActorLocation,
} from "./consumer.auth.js";
import { CONSUMER_AUDIENCE, getConsumerJwtSecret } from "../config/consumerAuth.js";
import { d2cWorkspaceObjectId } from "../services/consumerWorkspace.js";
import logger from "../utils/logger.js";

const router = Router();
const log = logger.child({ module: "consumer-mobile-auth" });

const verifyTurnstile = createTurnstileGate("consumer-mobile-auth");

/* ══════════════════════════════════════════════════════════════════════
 * THE PROOF-OF-PHONE TOKEN
 * ══════════════════════════════════════════════════════════════════════
 * A signed assertion, valid for ten minutes, that says: "the holder of this
 * token proved control of THIS number, at THIS time, for the purpose of
 * signing up."
 *
 * ── WHY A TOKEN AT ALL, RATHER THAN CREATING THE ACCOUNT AT /verify ──
 * Because an account needs an email, and we do not have one yet. Every
 * consumer is email-keyed (models/Consumer.ts), so creating a row at
 * /verify would mean either inventing a placeholder address — a lie in the
 * unique index — or allowing phone-only accounts, which this product has
 * explicitly ruled out.
 *
 * ── WHY A TOKEN RATHER THAN A SERVER-SIDE PENDING RECORD ─────────────
 * A "pending signups" collection would be a second store to write, expire
 * and clean up, and its rows are exactly the OTP state this design avoids
 * having. A signed token carries the same fact with no storage: the
 * signature is the integrity, and `exp` is the expiry.
 *
 * ── WHY THE PHONE IS READ FROM THE TOKEN AND NEVER FROM THE BODY ─────
 * THIS IS THE SECURITY PROPERTY OF THE WHOLE FLOW. /complete takes the
 * number out of the verified token and ignores any `mobile` in its body. If
 * it trusted the body, the OTP would be decorative: anyone could verify a
 * number they own, then post somebody else's at /complete and have it
 * written to `verifiedPhone` — the unique key a future OTP login resolves
 * against. Reading it from the token makes "the account's verified number"
 * and "the number an OTP was proved against" the same value by
 * construction, not by convention.
 *
 * ── THE SAME SECRET AS THE SESSION, DELIBERATELY ─────────────────────
 * getConsumerJwtSecret() — the one the access and refresh tokens use. No
 * new secret is invented, because a new secret is a new thing to provision,
 * rotate and forget; and this token is strictly weaker than a session (ten
 * minutes, one purpose, no consumerId). The `purpose` claim below is what
 * keeps it from being usable as one.
 */
const PROOF_TTL_SECONDS = 10 * 60;
const PROOF_PURPOSE = "mobile_signup";

interface ProofClaims {
  phone: string;
  purpose: typeof PROOF_PURPOSE;
}

function mintProofToken(phone: string): string {
  return jwt.sign({ phone, purpose: PROOF_PURPOSE }, getConsumerJwtSecret(), {
    expiresIn: PROOF_TTL_SECONDS,
    audience: CONSUMER_AUDIENCE,
  });
}

/**
 * Returns the claims, or null for anything that is not a live proof token.
 *
 * The `purpose` check is not ceremony. Without it, a CONSUMER ACCESS TOKEN
 * — same secret, same audience, longer life — would satisfy this function
 * and let an already-signed-in caller mint accounts for arbitrary numbers.
 * The claim is what makes the two token families disjoint, so it is
 * verified as strictly as the signature.
 */
function readProofToken(raw: unknown): ProofClaims | null {
  const token = String(raw ?? "").trim();
  if (!token) return null;
  try {
    const claims: any = jwt.verify(token, getConsumerJwtSecret(), {
      audience: CONSUMER_AUDIENCE,
    });
    if (claims?.purpose !== PROOF_PURPOSE) return null;
    // Re-normalised on the way out. The token was minted from a normalised
    // number, so this is belt-and-braces — but it is the value that becomes
    // the unique key, and re-deriving it costs nothing.
    const phone = normaliseIndiaMobile(claims?.phone);
    if (!phone) return null;
    return { phone, purpose: PROOF_PURPOSE };
  } catch {
    // Expired, wrong signature, wrong audience, malformed. All one answer
    // to the caller: start again. Distinguishing them would tell an
    // attacker which half of a forged token was wrong.
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════════════
 * VALIDATE THE NUMBER BEFORE THE RATE LIMITERS, NOT AFTER.
 * ══════════════════════════════════════════════════════════════════════
 * Ordering that looks cosmetic and is not. The per-number limiters key on
 * the normalised number and fall back to the IP when there isn't one — so
 * if junk reached them, every unusable request from one address would share
 * a single bucket, and a reader who mistyped their number twice in a row
 * would get "too many requests" instead of "that number looks wrong". The
 * second message is the true one and the only actionable one.
 *
 * Running the check first also means the limiter buckets contain only real
 * numbers, which is what makes "5 per hour per number" mean what it says.
 *
 * It is safe to answer this before the Turnstile gate: it is a local regex
 * over the caller's own input, it touches no store, and it reveals nothing
 * — an attacker learns only that ten digits look like ten digits.
 */
function requireNormalisedMobile(req: any, res: any, next: any) {
  const mobile = normaliseIndiaMobile(req.body?.mobile);
  if (!mobile) {
    /* Rejected BEFORE any provider call, so junk never costs an SMS.
     * India-only is a product decision (v1) and a safety one: the normaliser
     * refuses a +1 rather than truncating it to ten digits and billing a
     * message to the wrong country. */
    return res.status(400).json({
      error: "Enter a valid Indian mobile number.",
      code: "INVALID_MOBILE",
    });
  }
  // Stashed so handlers and limiters agree on ONE derivation of the number.
  req.normalisedMobile = mobile;
  return next();
}

/** Enough to recognise your own number, not enough to learn one. */
function maskMobile(m: string): string {
  return m.length === 10 ? `${m.slice(0, 2)}••••••${m.slice(-2)}` : "••••••";
}

/** The typed answer for a provider failure, mapped to a status. */
function statusForOtpFailure(reason: string): number {
  if (reason === "not_configured") return 503;
  if (reason === "invalid_mobile") return 400;
  if (reason === "provider_error") return 502;
  return 400;
}

/* ══ POST /start ══════════════════════════════════════════════════════
 * Send a code to a number. The SAME request and the SAME response whether
 * the number belongs to an account or not.
 *
 * ── NO ENUMERATION HERE, AND THAT IS WHY THIS ENDPOINT IS SHARED ─────
 * A separate /login-start and /signup-start, or one endpoint that answered
 * "no such account", would turn this into a free oracle for "is this phone
 * number registered with Helloviza?" — answerable for any number, by
 * anybody, without proving anything. So /start looks up nothing at all. It
 * does not know, and does not need to know, which flow the caller is in;
 * the fork happens at /verify, once they have proved they hold the number.
 * ──────────────────────────────────────────────────────────────────── */
router.post(
  "/start",
  mobileAuthIpLimiter,
  requireNormalisedMobile,
  verifyTurnstile,
  mobileAuthResendCooldown,
  mobileAuthSendLimiter,
  async (req: any, res: any) => {
    try {
      const mobile: string = req.normalisedMobile;

      const result = await sendMobileOtp(mobile);
      if (!result.ok) {
        log.warn("start — provider refused", { reason: result.reason });
        return res
          .status(statusForOtpFailure(result.reason))
          .json({ error: result.message, code: result.reason.toUpperCase() });
      }

      // The number is echoed MASKED, never in full: the caller typed it, so
      // they can recognise it, but a response that repeated it in full would
      // be a small confirmation oracle for anyone watching the wire.
      return res.json({ ok: true, mobileMasked: maskMobile(mobile) });
    } catch (err: any) {
      if (err instanceof MobileOtpNotConfiguredError) {
        log.error("start — MSG91 credentials absent in production");
        return res
          .status(503)
          .json({ error: "Mobile sign-in is temporarily unavailable.", code: "NOT_CONFIGURED" });
      }
      log.error("start — unhandled failure", { error: err?.message });
      return res.status(500).json({ error: "Could not send the code." });
    }
  },
);

/* ══ POST /verify ═════════════════════════════════════════════════════
 * Check the code with MSG91, then fork on whether the number is known.
 *
 * ── THE RESPONSE DOES DIFFER HERE, AND THAT IS ACCEPTABLE ────────────
 * `mode: "login"` versus `mode: "signup_required"` tells the caller whether
 * an account exists for this number — which /start deliberately refuses to
 * say. The difference is that reaching this branch requires a correct OTP,
 * so the caller has already PROVED they control the number. Telling
 * somebody whether their own number is registered is not a leak; it is the
 * answer they came for, and withholding it would mean the client could not
 * know which screen to draw next.
 * ──────────────────────────────────────────────────────────────────── */
router.post(
  "/verify",
  mobileAuthIpLimiter,
  requireNormalisedMobile,
  mobileAuthVerifyLimiter,
  async (req: any, res: any) => {
    try {
      const mobile: string = req.normalisedMobile;
      const code = String(req.body?.code ?? req.body?.otp ?? "").trim();

      if (!code) {
        return res.status(400).json({ error: "Enter the code we sent you.", code: "INVALID_CODE" });
      }

      const result = await verifyMobileOtp(mobile, code);
      if (!result.ok) {
        /* ONE MESSAGE FOR WRONG AND FOR EXPIRED. MSG91 owns the expiry and
         * distinguishes the two in its payload, but the reader's next
         * action is identical either way — ask for a new code — and a
         * response that separated them would tell an attacker whether a
         * live code currently exists for this number. */
        const status = statusForOtpFailure(result.reason);
        return res.status(status).json({
          error:
            status === 400
              ? "That code is incorrect or has expired. Request a new one."
              : result.message,
          code: status === 400 ? "INVALID_CODE" : result.reason.toUpperCase(),
        });
      }

      /* ── THE FORK. verifiedPhone is the Phase 1 unique key, so this
       * resolves to at most one account by construction. */
      const consumer: any = await Consumer.findOne({ verifiedPhone: mobile });

      if (consumer) {
        // ── LOGIN ──
        if (consumer.status !== "ACTIVE") {
          // Mirrors /login's guard exactly. A disabled account must not be
          // reachable through a second door.
          return res.status(403).json({ error: "Account is not active." });
        }
        issueConsumerSession(res, consumer);
        log.info("verify — login", { consumerId: String(consumer._id) });
        return res.json({ ok: true, mode: "login", consumer: publicConsumer(consumer) });
      }

      /* ── SIGNUP — AND NOTHING IS WRITTEN YET ──────────────────────
       * No account, no profile, no pending row. The only thing that
       * crosses to /complete is the signed proof below, which is why a
       * caller who abandons here leaves nothing behind to clean up. */
      log.info("verify — signup required", { mobileMasked: maskMobile(mobile) });
      return res.json({
        ok: true,
        mode: "signup_required",
        proofToken: mintProofToken(mobile),
        mobileMasked: maskMobile(mobile),
      });
    } catch (err: any) {
      if (err instanceof MobileOtpNotConfiguredError) {
        log.error("verify — MSG91 credentials absent in production");
        return res
          .status(503)
          .json({ error: "Mobile sign-in is temporarily unavailable.", code: "NOT_CONFIGURED" });
      }
      log.error("verify — unhandled failure", { error: err?.message });
      return res.status(500).json({ error: "Could not verify the code." });
    }
  },
);

/* ══ POST /complete ═══════════════════════════════════════════════════
 * Finish an OTP signup: proof token + email + name -> account + session.
 *
 * The account this produces is the SAME KIND of account /signup and
 * /google produce — same collection, same email key, same consent record,
 * same registration location, same session — differing only in
 * authProvider and in the fact that its phone arrives already verified.
 * ──────────────────────────────────────────────────────────────────── */
router.post("/complete", mobileAuthIpLimiter, async (req: any, res: any) => {
  try {
    /* ── THE PHONE COMES FROM HERE AND NOWHERE ELSE ────────────────
     * req.body.mobile is not read in this handler. See the token notes
     * above for why that is the whole security property of the flow. */
    const proof = readProofToken(req.body?.proofToken);
    if (!proof) {
      return res.status(400).json({
        error: "That verification has expired. Please start again.",
        code: "PROOF_INVALID",
      });
    }
    const phone = proof.phone;

    const email = normalizeEmail(req.body?.email);
    const name = String(req.body?.name ?? "").trim();

    // Same validation and same wording as /signup, minus the password —
    // there is none on this door, by design.
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    if (!name) {
      return res.status(400).json({ error: "Name is required" });
    }

    // CONSUMERS FIRST, then B2B — the same order /signup uses, so an
    // address that is already a consumer never reaches the B2B lookup and
    // this endpoint reveals nothing about B2B for an address it knows.
    if (await Consumer.exists({ email })) {
      return res.status(409).json({ error: "An account with this email already exists" });
    }
    if (await b2bAccountExists(email)) {
      return res.status(409).json({ error: B2B_MESSAGE, code: B2B_MARKER });
    }

    /* ── THE RACE CHECK ───────────────────────────────────────────────
     * Between /verify (which found no account) and this request, somebody
     * could have completed a signup on the same number — two tabs, or two
     * people over a recycled number. The unique index on verifiedPhone is
     * the REAL guard and would reject the insert regardless; this exists so
     * the caller gets a sentence they can act on instead of a duplicate-key
     * 500. The window is small, not zero, and the catch below still handles
     * the case where it closes between this line and the insert. */
    if (await Consumer.exists({ verifiedPhone: phone })) {
      return res.status(409).json({
        error: "This number is already registered. Please sign in instead.",
        code: "PHONE_ALREADY_REGISTERED",
      });
    }

    const marketingConsent = buildSignupConsent(req.body);
    // Bounded and non-throwing, exactly as on /signup: worst case it costs
    // this request 1500ms and writes no field. It cannot fail the signup.
    const registrationLocation = await resolveRegistrationLocation(req);

    let consumer: any;
    try {
      consumer = await Consumer.create({
        email,
        name,
        /* BOTH fields, and both are correct here. `phone` is the
         * signup-captured hint every account carries; `verifiedPhone` is
         * the unique login key. On this door alone they are the same value
         * on the first day, because the number was proved before the
         * account existed — which is exactly the state Phase 1's two-field
         * split was built to represent. */
        phone,
        verifiedPhone: phone,
        /* No passwordHash — not a placeholder, not a random unusable hash.
         * The Google path's reasoning applies unchanged: authProvider
         * carries the truth, and a fabricated credential would be a lie
         * every later reader has to work around. */
        authProvider: "mobile",
        ...(marketingConsent ? { marketingConsent } : {}),
        ...(registrationLocation ? { registrationLocation } : {}),
      });
    } catch (createErr: any) {
      // The race closed between the check above and this insert. The unique
      // index did its job; turn it into the same sentence.
      if (createErr?.code === 11000) {
        return res.status(409).json({
          error: "This number is already registered. Please sign in instead.",
          code: "PHONE_ALREADY_REGISTERED",
        });
      }
      throw createErr;
    }

    /* ── THE PROFILE, WITH THE NUMBER ALREADY VERIFIED ────────────────
     * Written here rather than left to the lazy upsert in
     * consumer.profile.ts, because that path's seedMobileFromSignup seeds
     * the number UNVERIFIED — correct when the number is a typed claim, and
     * wrong here, where MSG91 has already confirmed it. Writing it now also
     * makes the lazy seed a no-op later: it never overwrites an existing
     * mobile.
     *
     * new + .save(), NEVER an update operator. contact.mobile is in
     * ENCRYPTED_PII_FIELDS and plugins/fieldEncryption.plugin.ts throws
     * EncryptedFieldUpdateError on an updateOne/findOneAndUpdate touching an
     * encrypted path — the same rule Phase 1's mirror had to respect.
     *
     * Non-fatal: the account and the session are already real, and a
     * profile that failed to write will be created empty by the lazy upsert
     * on the consumer's first profile read. Failing the signup over it would
     * throw away a verified account for a recoverable side record. */
    try {
      const profile = new ConsumerProfile({
        consumerId: consumer._id as mongoose.Types.ObjectId,
        workspaceId: d2cWorkspaceObjectId(),
        contact: { mobile: phone, mobileVerified: true, mobileVerifiedAt: new Date() },
      });
      await profile.save();
    } catch (profileErr: any) {
      log.error("complete — profile seed failed", {
        consumerId: String(consumer._id),
        error: profileErr?.message,
      });
    }

    // Side record, deliberately not awaited into the response path.
    void stampConsumerActorLocation(String(consumer._id), req?.ip, registrationLocation);

    issueConsumerSession(res, consumer);
    log.info("complete — account created", { consumerId: String(consumer._id) });

    return res.status(201).json({
      ok: true,
      mode: "signup",
      created: true,
      consumer: publicConsumer(consumer),
    });
  } catch (err: any) {
    log.error("complete — unhandled failure", { error: err?.message });
    return res.status(500).json({ error: "Could not complete signup." });
  }
});

export default router;
