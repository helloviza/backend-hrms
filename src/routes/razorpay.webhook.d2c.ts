// apps/backend/src/routes/razorpay.webhook.d2c.ts
//
// ══════════════════════════════════════════════════════════════════════
// THE D2C WEBHOOK — ITS OWN ENDPOINT, BECAUSE IT IS ITS OWN ACCOUNT.
// ══════════════════════════════════════════════════════════════════════
// D2C (helloviza visa fees) settles to a separate Razorpay MID from
// B2B/SBT. Two MIDs means two webhook secrets, and one endpoint verifying
// against one secret cannot validate both.
//
// The alternative considered and rejected was ONE endpoint trying both
// secrets. Signature verification answers a precise question — "did the
// account whose secret this is send this event?" — and try-both-secrets
// silently rewrites it as "did EITHER account send this?". That is a
// permanently weaker guarantee on the one check standing between an
// anonymous POST and "mark it paid, issue an invoice": a leak of the B2B
// secret would become sufficient to forge a D2C payment, and vice versa,
// so the two MIDs would stop being independent trust domains at exactly
// the layer meant to keep them independent. It also makes fail-closed
// inexpressible — a missing D2C secret would have to either refuse B2B
// traffic too, or silently reject genuine D2C payments as forgeries.
//
// Two endpoints, two secrets, and a signature that fails against the wrong
// one is REJECTED — which is what signature verification is for.
//
// ── WHAT THIS FILE DOES NOT DO ───────────────────────────────────────
// It does not look up SBT bookings. routes/razorpay.webhook.ts resolves an
// order id through SBTBooking → SBTHotelBooking → VisaApplication, because
// it serves one account carrying all three. This endpoint is registered on
// the D2C MID alone, and that MID cannot mint a B2B order id — so a
// payment arriving here is D2C by construction, not by lookup order. The
// cross-channel resolution isn't merely unnecessary here; it is
// impossible, which is a stronger guarantee than the ordering convention
// the shared endpoint relies on.
//
// ── THE B2B ENDPOINT IS UNCHANGED, AND KEEPS ITS D2C LOOKUP ──────────
// routes/razorpay.webhook.ts is untouched by the split except for two
// `export` keywords (the two handlers below are imported from it — the
// logic did not move, and must not: it is the audited, idempotent, twice-
// tested payment path). It deliberately KEEPS its third VisaApplication
// lookup: any D2C order minted BEFORE the MID cutover lives on the old
// account, and its webhook will arrive at the OLD endpoint. That lookup is
// the drain path for those in-flight orders and can be removed only once
// none remain. See migrations/2026-09-10-clear-d2c-razorpay-order-ids.ts.
import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import VisaApplication from "../models/VisaApplication.js";
import PaymentOrphan from "../models/PaymentOrphan.js";
import { handleD2CPaymentCaptured, handleD2CPaymentFailed } from "./razorpay.webhook.js";
import { webhookLogger } from "../utils/logger.js";

const router = Router();

/* Byte-identical to the B2B endpoint's verifier, deliberately duplicated
 * rather than shared: this is the check that decides whether an anonymous
 * POST gets to mark money received, and a shared helper is a single edit
 * away from changing both accounts' verification at once. The length
 * pre-check is what stops timingSafeEqual from THROWING on a forged
 * signature of the wrong length (which would surface as a 500 and a stack
 * trace instead of a plain rejection); a length comparison is safe to do
 * in variable time because the length of a sha256 hex digest is public. */
function verifyWebhookSignature(
  rawBody: Buffer,
  signature: string,
  secret: string,
): boolean {
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  const expected = Buffer.from(expectedSignature);
  const received = Buffer.from(signature);

  if (expected.length !== received.length) return false;

  return crypto.timingSafeEqual(expected, received);
}

/**
 * The whole resolver. One collection, because one account.
 *
 * Returning null means orphan, exactly as it does on the shared endpoint —
 * and here it carries more information: a captured payment on the D2C MID
 * that matches no application is unambiguously a D2C anomaly, not an
 * unrecognised booking of unknown channel.
 */
async function findD2CApplicationByOrderId(razorpayOrderId: string) {
  if (!razorpayOrderId) return null;
  return VisaApplication.findOne({ razorpayOrderId });
}

// POST /razorpay-d2c (mounted at /api/webhooks/razorpay-d2c)
router.post("/razorpay-d2c", async (req: Request, res: Response) => {
  try {
    const signature = req.headers["x-razorpay-signature"] as string | undefined;
    const secret = process.env.RAZORPAY_D2C_WEBHOOK_SECRET;

    if (!secret) {
      /* ── FAIL CLOSED ────────────────────────────────────────────────
       * Same rule, and the same reasoning, as the B2B endpoint: the skip
       * is an ALLOWLIST of the two values that can only mean a
       * developer's own machine. Everything else — staging, preprod, a
       * container that never set NODE_ENV, "Production" with a capital P,
       * a typo — requires the secret and refuses without it.
       *
       * NOTE the secret this reads. A D2C webhook verified against the
       * B2B secret would be the whole point of the split undone, so there
       * is deliberately no fallback to RAZORPAY_WEBHOOK_SECRET here: an
       * unset D2C secret means this endpoint refuses, loudly, while B2B
       * carries on unaffected. */
      const nodeEnv = process.env.NODE_ENV;
      const isLocalDev = nodeEnv === "development" || nodeEnv === "test";

      if (!isLocalDev) {
        webhookLogger.error(
          "RAZORPAY_D2C_WEBHOOK_SECRET not set — REFUSING to process an unverifiable D2C webhook",
          { nodeEnv: nodeEnv ?? "<unset>" },
        );
        return res.status(500).json({ error: "Webhook secret not configured" });
      }
      webhookLogger.warn(
        "RAZORPAY_D2C_WEBHOOK_SECRET not set — skipping signature verification (local dev only)",
        { nodeEnv },
      );
    } else {
      if (!signature) {
        return res.status(400).json({ error: "Invalid signature" });
      }
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
      if (!verifyWebhookSignature(rawBody, signature, secret)) {
        return res.status(400).json({ error: "Invalid signature" });
      }
    }

    // Parse the payload — body may be raw Buffer or already-parsed JSON
    const payload = Buffer.isBuffer(req.body)
      ? JSON.parse(req.body.toString("utf8"))
      : req.body;

    const event: string = payload?.event || "";
    const paymentEntity = payload?.payload?.payment?.entity || {};

    // ── payment.captured ──────────────────────────────────────────
    if (event === "payment.captured") {
      const razorpayPaymentId: string = paymentEntity.id || "";
      const razorpayOrderId: string = paymentEntity.order_id || "";
      const amount: number = paymentEntity.amount || 0;
      const currency: string = paymentEntity.currency || "INR";

      const application = await findD2CApplicationByOrderId(razorpayOrderId);
      if (application) {
        /* The SAME handler the shared endpoint calls — imported, not
         * reimplemented. Its two idempotency layers (the PAID guard and
         * the unique partial index on razorpayPaymentId), the amount
         * cross-check, the funnel-triple write, the Master Sheet mirror
         * and the invoice are all one audited path, and a second copy of
         * them would be a second thing to keep correct. */
        await handleD2CPaymentCaptured(application as any, paymentEntity);
      } else {
        /* Orphan — same net as the shared endpoint, same collection, so
         * the existing orphan tooling sees D2C anomalies without change. */
        await PaymentOrphan.findOneAndUpdate(
          { razorpayPaymentId },
          {
            razorpayPaymentId,
            razorpayOrderId,
            amount,
            currency,
            webhookPayload: payload,
          },
          { upsert: true, new: true },
        );
        webhookLogger.warn(
          "payment.captured — D2C endpoint: no application found, recorded as orphan",
          { razorpayOrderId },
        );
      }

      return res.status(200).json({ received: true });
    }

    // ── payment.failed ────────────────────────────────────────────
    if (event === "payment.failed") {
      const razorpayOrderId: string = paymentEntity.order_id || "";

      const application = await findD2CApplicationByOrderId(razorpayOrderId);
      if (application) {
        await handleD2CPaymentFailed(application as any, paymentEntity);
      } else {
        // Matches the shared endpoint's posture: an unmatched FAILED
        // payment is not an orphan — no money moved, so there is nothing
        // to reconcile. Logged so it is not invisible.
        webhookLogger.warn(
          "payment.failed — D2C endpoint: no application found for order",
          { razorpayOrderId },
        );
      }

      return res.status(200).json({ received: true });
    }

    // ── refund.processed ──────────────────────────────────────────
    if (event === "refund.processed") {
      const refundEntity = payload?.payload?.refund?.entity || {};
      const razorpayOrderId: string = refundEntity.order_id || paymentEntity.order_id || "";

      /* D2C REFUNDS ARE NOT BUILT — identical to the shared endpoint's D2C
       * branch, and here for the same reason: the SBT refund mutation
       * writes refundId/refundStatus/refundProcessedAt, none of which are
       * schema paths on a VisaApplication. Mongoose would drop all three
       * under strict mode, save() would report success, and a real refund
       * would leave no trace anywhere. Logged loudly rather than
       * half-applied.
       *
       * TODO(milestone-3): a D2C refund needs its own lifecycle values and
       * a Master Sheet mirror. It is not a rename of the SBT one. */
      const application = await findD2CApplicationByOrderId(razorpayOrderId);
      webhookLogger.warn(
        "refund.processed — D2C endpoint: refund handling NOT implemented; no state changed",
        {
          applicationId: application ? String((application as any)._id) : null,
          razorpayOrderId,
          refundId: refundEntity.id,
        },
      );

      return res.status(200).json({ received: true });
    }

    // ── Unhandled event — always acknowledge ─────────────────────
    webhookLogger.info("Unhandled event (D2C endpoint)", { event });
    return res.status(200).json({ received: true });
  } catch (err) {
    webhookLogger.error("Error processing D2C webhook", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

export default router;
