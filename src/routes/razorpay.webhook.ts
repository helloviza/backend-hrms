import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import PaymentOrphan from "../models/PaymentOrphan.js";
import { webhookLogger } from "../utils/logger.js";

const router = Router();

function verifyWebhookSignature(
  rawBody: Buffer,
  signature: string,
  secret: string,
): boolean {
  const expectedSignature = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(expectedSignature),
    Buffer.from(signature),
  );
}

async function findBookingByOrderId(razorpayOrderId: string) {
  const flight = await SBTBooking.findOne({ razorpayOrderId });
  if (flight) return { doc: flight, type: "flight" as const };

  const hotel = await SBTHotelBooking.findOne({ razorpayOrderId });
  if (hotel) return { doc: hotel, type: "hotel" as const };

  return null;
}

// POST /razorpay (mounted at /api/webhooks/razorpay)
router.post("/razorpay", async (req: Request, res: Response) => {
  try {
    const signature = req.headers["x-razorpay-signature"] as string | undefined;
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!secret) {
      if (process.env.NODE_ENV === "production") {
        webhookLogger.error("RAZORPAY_WEBHOOK_SECRET not set in production!");
        return res.status(500).json({ error: "Webhook secret not configured" });
      }
      webhookLogger.warn("RAZORPAY_WEBHOOK_SECRET not set — skipping signature verification in dev");
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

      const booking = await findBookingByOrderId(razorpayOrderId);
      if (booking) {
        if (booking.doc.status === "PENDING") {
          booking.doc.status = "CONFIRMED";
          (booking.doc as any).paymentCapturedAt = new Date();
          (booking.doc as any).webhookProcessed = true;
          await booking.doc.save();
          webhookLogger.info("payment.captured — booking confirmed", { type: booking.type, razorpayOrderId });
        }
      } else {
        // No matching booking — record as orphan
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
        webhookLogger.warn("payment.captured — no booking found, recorded as orphan", { razorpayOrderId });
      }

      return res.status(200).json({ received: true });
    }

    // ── payment.failed ────────────────────────────────────────────
    if (event === "payment.failed") {
      const razorpayOrderId: string = paymentEntity.order_id || "";
      const failureReason: string =
        paymentEntity.error_description ||
        payload?.payload?.payment?.entity?.error?.description ||
        "Payment failed";

      const booking = await findBookingByOrderId(razorpayOrderId);
      if (booking) {
        booking.doc.status = "FAILED";
        (booking.doc as any).failureReason = failureReason;
        (booking.doc as any).webhookProcessed = true;
        await booking.doc.save();
        webhookLogger.info("payment.failed — booking marked failed", { type: booking.type, razorpayOrderId });
      }

      return res.status(200).json({ received: true });
    }

    // ── refund.processed ──────────────────────────────────────────
    if (event === "refund.processed") {
      const refundEntity = payload?.payload?.refund?.entity || {};
      const razorpayOrderId: string = refundEntity.order_id || paymentEntity.order_id || "";

      const booking = await findBookingByOrderId(razorpayOrderId);
      if (booking) {
        (booking.doc as any).refundId = refundEntity.id || "";
        (booking.doc as any).refundStatus = "PROCESSED";
        (booking.doc as any).refundProcessedAt = new Date();
        (booking.doc as any).webhookProcessed = true;
        await booking.doc.save();
        webhookLogger.info("refund.processed", { type: booking.type, razorpayOrderId, refundId: refundEntity.id });
      }

      return res.status(200).json({ received: true });
    }

    // ── Unhandled event — always acknowledge ─────────────────────
    webhookLogger.info("Unhandled event", { event });
    return res.status(200).json({ received: true });
  } catch (err) {
    webhookLogger.error("Error processing webhook", { error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

export default router;
