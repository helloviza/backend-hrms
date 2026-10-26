// apps/backend/src/routes/razorpay.webhook.links.ts
//
// POST /api/webhooks/razorpay-links — Payment Links events for the Plumtrips
// (B2B) MID, on its own webhook URL with its own secret,
// RAZORPAY_LINKS_WEBHOOK_SECRET. Razorpay lets one account register several
// webhooks; this one is subscribed to payment_link.* only, so the audited B2B
// endpoint (routes/razorpay.webhook.ts) keeps its own events and secret.
//
//   payment_link.paid / .expired / .cancelled  → services/paymentRequests.ts
//   payment_link.partially_paid                → logged as an alarm (links are
//                                                created with accept_partial
//                                                false, so this should never
//                                                happen), state untouched
//
// The link is found by its Razorpay id, never by notes, and its amount and
// reference_id are checked before anything moves. Moves are guarded
// (CREATED → PAID / EXPIRED / CANCELLED only; PAID never demotes) and a replay
// is a no-op. Status only: no booking or invoice is changed.
//
// Same verification posture as the other two Razorpay endpoints: HMAC-SHA256
// over the raw body (express.raw in server.ts, before express.json), and fail
// closed without the secret everywhere except NODE_ENV development / test.
import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { applyPaymentLinkWebhook } from "../services/paymentRequests.js";
import { webhookLogger } from "../utils/logger.js";

const router = Router();

/* A copy of the B2B endpoint's verifier, deliberately not shared — see
 * routes/razorpay.webhook.d2c.ts for why each endpoint owns its check. */
function verifyWebhookSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const expectedSignature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expected = Buffer.from(expectedSignature);
  const received = Buffer.from(signature);
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

const HANDLED = new Set(["payment_link.paid", "payment_link.expired", "payment_link.cancelled"]);

// POST /razorpay-links (mounted at /api/webhooks/razorpay-links)
router.post("/razorpay-links", async (req: Request, res: Response) => {
  try {
    const signature = req.headers["x-razorpay-signature"] as string | undefined;
    const secret = process.env.RAZORPAY_LINKS_WEBHOOK_SECRET;

    if (!secret) {
      // No fallback to RAZORPAY_WEBHOOK_SECRET: a separate secret is the point.
      const nodeEnv = process.env.NODE_ENV;
      const isLocalDev = nodeEnv === "development" || nodeEnv === "test";
      if (!isLocalDev) {
        webhookLogger.error("RAZORPAY_LINKS_WEBHOOK_SECRET not set — REFUSING to process an unverifiable payment-links webhook", {
          nodeEnv: nodeEnv ?? "<unset>",
        });
        return res.status(500).json({ error: "Webhook secret not configured" });
      }
      webhookLogger.warn("RAZORPAY_LINKS_WEBHOOK_SECRET not set — skipping signature verification (local dev only)", { nodeEnv });
    } else {
      if (!signature) return res.status(400).json({ error: "Invalid signature" });
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
      if (!verifyWebhookSignature(rawBody, signature, secret)) return res.status(400).json({ error: "Invalid signature" });
    }

    const payload = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString("utf8")) : req.body;
    const event: string = payload?.event || "";

    if (event === "payment_link.partially_paid") {
      webhookLogger.error("payment_link.partially_paid — links are created with accept_partial=false; NOT applied", {
        razorpayLinkId: payload?.payload?.payment_link?.entity?.id,
        referenceId: payload?.payload?.payment_link?.entity?.reference_id,
        amountPaid: payload?.payload?.payment_link?.entity?.amount_paid,
      });
      return res.status(200).json({ received: true });
    }

    if (!HANDLED.has(event)) {
      webhookLogger.info("Unhandled event (payment-links endpoint)", { event });
      return res.status(200).json({ received: true });
    }

    const result = await applyPaymentLinkWebhook(event, payload);
    if (result.outcome === "VERSION_CONFLICT") {
      // Kept losing a write race; let Razorpay redeliver rather than drop it.
      webhookLogger.error(`${event} — payment request kept changing, asking Razorpay to retry`, {
        razorpayLinkId: payload?.payload?.payment_link?.entity?.id,
      });
      return res.status(500).json({ error: "Retry" });
    }
    if (!result.handled) {
      // A link we don't know: made by hand on the dashboard, or not ours.
      webhookLogger.warn(`${event} — no matching payment request link`, {
        razorpayLinkId: payload?.payload?.payment_link?.entity?.id,
        outcome: result.outcome,
      });
    } else {
      webhookLogger.info(`${event} — payment request updated`, { requestId: result.requestId, outcome: result.outcome });
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    webhookLogger.error("Error processing payment-links webhook", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

export default router;
