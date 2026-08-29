// apps/backend/src/routes/consumer.mobileOtp.ts
//
// Mobile verification for the D2C consumer. Mounted at
// /api/consumer/mobile behind requireConsumer.
//
// ══════════════════════════════════════════════════════════════════════
// THE NUMBER IS NEVER READ FROM THE REQUEST BODY. NOT ONCE, NOT ANYWHERE.
// ══════════════════════════════════════════════════════════════════════
// Every handler here loads the acting consumer's OWN profile and takes
// contact.mobile off it. The reference implementation this was ported from
// accepted `{ mobile }` from the client, which is correct for a public
// sign-in form and wrong for this: an endpoint that sends an OTP to a
// caller-supplied number is an endpoint that sends SMS anywhere in India on
// our bill, and — worse — an endpoint where verifying a number you control
// could set the verified flag on a profile carrying somebody else's.
//
// The code itself DOES come from the body on /verify. That is the one
// caller-supplied value here, and it is a secret the caller is supposed to
// have; it is checked by MSG91, not by us.
//
// ══════════════════════════════════════════════════════════════════════
// THIS IS THE ONLY WRITER OF contact.mobileVerified IN THE CODEBASE.
// ══════════════════════════════════════════════════════════════════════
// The flag stays off the PATCH allowlist in routes/consumer.profile.ts
// (SECTION_FIELDS.contact), so a client cannot set it by asking. It is
// written in exactly two places, both server-side:
//
//   1. HERE, to true, and only after MSG91 answers `type: "success"`.
//   2. In consumer.profile.ts's contact save, to FALSE, when the number
//      changes — see the reset-on-edit block there.
//
// Anything that reads the flag as an authorisation fact (today: the
// application-submit gate in consumer.applications.ts) depends on that list
// staying two entries long.
import { Router } from "express";

import { requireConsumer } from "../middleware/requireConsumer.js";
import { createTurnstileGate } from "../middleware/turnstile.js";
import {
  consumerOtpSendLimiter,
  consumerOtpVerifyLimiter,
} from "../middleware/rateLimit.js";
import Consumer from "../models/Consumer.js";
import ConsumerProfile from "../models/ConsumerProfile.js";
import {
  MobileOtpNotConfiguredError,
  normaliseIndiaMobile,
  resendMobileOtp,
  sendMobileOtp,
  verifyMobileOtp,
} from "../services/consumerMobileOtp.js";
import logger from "../utils/logger.js";

const router = Router();

const otpRouteLogger = logger.child({ module: "consumer-mobile-otp-route" });

// EVERY route in this file, mounted here rather than per-route so a new
// handler cannot be added unguarded — the same reason and the same shape as
// routes/consumer.profile.ts:59.
//
// It also has to come FIRST for the limiters below to work at all: they key
// on req.consumer.id, which does not exist until this has run.
router.use(requireConsumer);

const verifyTurnstile = createTurnstileGate("consumer-mobile-otp");

/** The ONLY source of the acting consumer's id in this file. */
function me(req: any): string {
  const id = req?.consumer?.id;
  if (!id) {
    throw new Error("consumer.mobileOtp: reached a handler with no req.consumer");
  }
  return String(id);
}

/**
 * The last four digits, for UI copy ("sent to •••••• 3210").
 *
 * The full number is never returned by these endpoints. The client already
 * has it — it is on the profile it just rendered — so echoing it back buys
 * nothing and puts a PII field in another response body and another log
 * line for no reason.
 */
function maskMobile(m: string): string {
  return m.length === 10 ? `•••••• ${m.slice(-4)}` : "••••••";
}

/**
 * The acting consumer's own profile document (hydrated, NOT lean).
 *
 * Hydrated is load-bearing twice over. plugins/fieldEncryption.plugin.ts
 * decrypts contact.mobile in its post('findOne') hook, so this is what turns
 * the stored envelope back into a number MSG91 can be given. And the write
 * path below MUST be .save() — the same plugin THROWS
 * EncryptedFieldUpdateError on any updateOne/findOneAndUpdate that touches
 * an encrypted path, and while mobileVerified is not itself encrypted, it
 * lives under the same `contact` root that the guard checks ancestors of.
 *
 * Deliberately findOne and not the upserting loadOwnProfile() that
 * consumer.profile.ts uses: there is nothing to verify on a profile that
 * does not exist yet, and creating one as a side effect of an OTP request
 * would be a write on a read path.
 */
async function loadOwnProfile(consumerId: string) {
  return ConsumerProfile.findOne({ consumerId });
}

/**
 * Resolves the number to send to, or the error to return instead.
 *
 * Shared by all three handlers so that "which number" is answered in
 * exactly one place — the property this file's header is built on.
 */
async function resolveOwnMobile(
  req: any,
  res: any,
): Promise<{ profile: any; mobile: string } | null> {
  const consumerId = me(req);
  const profile = await loadOwnProfile(consumerId);

  const stored = String(profile?.contact?.mobile ?? "").trim();
  if (!stored) {
    res.status(400).json({
      error: "Add your mobile number to your profile first.",
      code: "MOBILE_NOT_SET",
    });
    return null;
  }

  const mobile = normaliseIndiaMobile(stored);
  if (!mobile) {
    // A number already saved that we cannot send to. Reachable because the
    // profile PATCH does not (and should not) restrict the field to India —
    // the OTP provider is what is India-only, not the person.
    res.status(400).json({
      error:
        "We can only verify 10-digit Indian mobile numbers at the moment. Update your number and try again.",
      code: "MOBILE_UNSUPPORTED",
    });
    return null;
  }

  return { profile, mobile };
}

/** Maps a service-layer failure onto a status code. */
function statusForFailure(reason: string): number {
  if (reason === "not_configured") return 503;
  if (reason === "provider_error") return 502;
  return 400;
}

/**
 * The send and resend handlers differ by ONE function call, so they are
 * built from one factory rather than copy-pasted — a copy would be two
 * places to forget the already-verified short-circuit.
 */
function makeSendHandler(kind: "send" | "resend") {
  return async function handler(req: any, res: any) {
    try {
      const resolved = await resolveOwnMobile(req, res);
      if (!resolved) return; // response already written

      const { profile, mobile } = resolved;

      /* ALREADY VERIFIED — SHORT-CIRCUIT BEFORE SPENDING AN SMS.
       * Not merely tidy: without it, a client bug that re-mounts the verify
       * card in a loop bills us for every render. The response is a success
       * because from the caller's point of view the goal is already met. */
      if (profile.contact?.mobileVerified === true) {
        return res.json({
          ok: true,
          alreadyVerified: true,
          mobileMasked: maskMobile(mobile),
        });
      }

      const result =
        kind === "send" ? await sendMobileOtp(mobile) : await resendMobileOtp(mobile);

      if (!result.ok) {
        return res
          .status(statusForFailure(result.reason))
          .json({ error: result.message, code: result.reason.toUpperCase() });
      }

      // No number, no code, no provider payload in this line.
      otpRouteLogger.info(`${kind} — OTP dispatched`, { consumerId: me(req) });

      return res.json({
        ok: true,
        sent: true,
        mobileMasked: maskMobile(mobile),
      });
    } catch (err: any) {
      if (err instanceof MobileOtpNotConfiguredError) {
        // Production, no key. Logged as the configuration incident it is;
        // the client gets a neutral 503 with no provider detail.
        otpRouteLogger.error(`${kind} — MSG91 credentials absent in production`);
        return res.status(503).json({
          error: "Mobile verification is temporarily unavailable.",
          code: "NOT_CONFIGURED",
        });
      }
      otpRouteLogger.error(`${kind} — unhandled failure`, { error: err?.message });
      return res.status(500).json({ error: "Failed to send verification code" });
    }
  };
}

/* ── POST /send ─────────────────────────────────────────────────────── */
router.post("/otp/send", consumerOtpSendLimiter, verifyTurnstile, makeSendHandler("send"));

/* ── POST /resend ───────────────────────────────────────────────────
 * Same limiter INSTANCE as /send, so the two share one 5-per-hour bucket
 * rather than granting ten. See middleware/rateLimit.ts. */
router.post("/otp/resend", consumerOtpSendLimiter, verifyTurnstile, makeSendHandler("resend"));

/* ── POST /verify — the one path that sets mobileVerified ───────────── */
router.post("/otp/verify", consumerOtpVerifyLimiter, async (req: any, res: any) => {
  try {
    const resolved = await resolveOwnMobile(req, res);
    if (!resolved) return;

    const { profile, mobile } = resolved;

    // Idempotent: verifying an already-verified number is a no-op success,
    // not a second provider call against a code that no longer exists.
    if (profile.contact?.mobileVerified === true) {
      return res.json({ ok: true, verified: true, alreadyVerified: true });
    }

    const code = String(req.body?.code ?? req.body?.otp ?? "").trim();
    if (!code) {
      return res.status(400).json({ error: "Enter the code we sent you.", code: "INVALID_CODE" });
    }

    const result = await verifyMobileOtp(mobile, code);

    if (!result.ok) {
      return res
        .status(statusForFailure(result.reason))
        .json({ error: result.message, code: result.reason.toUpperCase() });
    }

    /* ── THE WRITE ────────────────────────────────────────────────────
     * .save() on a hydrated document, never an update operator — see
     * loadOwnProfile above for why the encryption plugin forces this. */
    profile.contact.mobileVerified = true;
    profile.contact.mobileVerifiedAt = new Date();
    await profile.save();

    /* ── THE MIRROR — the proven number, where a query can find it ─────
     * contact.mobile above is ENCRYPTED, which makes it unsearchable: no
     * findOne({"contact.mobile": x}) can ever work, because every stored
     * value is a distinct envelope. So the moment a number is proven, the
     * plaintext ten digits are copied to Consumer.verifiedPhone, which is
     * indexed and unique and is what a future OTP login will resolve
     * against. Without this line the number is verified but unfindable,
     * and login could not exist.
     *
     * `mobile` is already the normalised bare-ten (resolveOwnMobile ran it
     * through normaliseIndiaMobile before we ever called MSG91), so the two
     * copies cannot drift into two shapes. It is non-empty by construction
     * — an unnormalisable number is refused before any code is sent — so
     * this can never write the "" that would break the sparse index.
     *
     * updateOne is safe HERE and nowhere near the profile: Consumer carries
     * no encrypted paths, so the plugin's EncryptedFieldUpdateError guard
     * does not apply to it.
     *
     * ── WHY THE FAILURE IS SWALLOWED RATHER THAN RAISED ──────────────
     * The verification itself has already SUCCEEDED and been persisted.
     * Turning a mirror failure into a 500 would tell the reader their
     * correct code was wrong and invite them to burn another SMS on a
     * number that is, in fact, already verified. The duplicate-key case is
     * a real one — another account proved the same number first — and it is
     * logged rather than surfaced because there is nothing this endpoint's
     * caller can do about it. Phase 2's login will read it as "no account
     * for this number" and route accordingly, which is the correct outcome
     * for a number whose ownership is genuinely contested. */
    try {
      await Consumer.updateOne({ _id: me(req) }, { $set: { verifiedPhone: mobile } });
    } catch (mirrorErr: any) {
      otpRouteLogger.error("verify — verifiedPhone mirror failed", {
        consumerId: me(req),
        duplicate: mirrorErr?.code === 11000,
        error: mirrorErr?.message,
      });
    }

    otpRouteLogger.info("verify — mobile verified", { consumerId: me(req) });

    return res.json({
      ok: true,
      verified: true,
      mobileVerifiedAt: profile.contact.mobileVerifiedAt,
    });
  } catch (err: any) {
    if (err instanceof MobileOtpNotConfiguredError) {
      otpRouteLogger.error("verify — MSG91 credentials absent in production");
      return res.status(503).json({
        error: "Mobile verification is temporarily unavailable.",
        code: "NOT_CONFIGURED",
      });
    }
    otpRouteLogger.error("verify — unhandled failure", { error: err?.message });
    return res.status(500).json({ error: "Failed to verify code" });
  }
});

export default router;
