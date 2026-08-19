// apps/backend/src/routes/razorpay.webhook.ts
//
// ══════════════════════════════════════════════════════════════════════
// TWO CHANNELS, ONE WEBHOOK URL. THE B2B PATH IS UNCHANGED.
// ══════════════════════════════════════════════════════════════════════
// Razorpay posts every event for the account to one endpoint, so this
// handler serves B2B (SBT flight/hotel bookings) and D2C (helloviza visa
// applications) alike. Milestone 2 Stage 2 added the D2C half.
//
// The B2B half was not refactored, reordered or "tidied" — including the
// signature function, which is byte-identical. Everything D2C is APPENDED:
// the resolver tries SBT flights, then SBT hotels, exactly as before, and
// only then looks for a visa application. No order id that resolved to an
// SBT booking yesterday can resolve to anything else today, because the
// lookups that could match it still run first and still run unchanged.
//
// ── THE ORPHAN NET WAS NARROWED BY NOTHING ───────────────────────────
// An unmatched order still becomes a PaymentOrphan. The D2C lookup adds a
// way for a payment to be RECOGNISED, never a way for one to be dropped:
// a payment that matches no booking and no application lands in exactly
// the same place it always did.
import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import mongoose from "mongoose";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import PaymentOrphan from "../models/PaymentOrphan.js";
import VisaApplication, { setDiscrepancyFlagged } from "../models/VisaApplication.js";
import VisaD2CLead from "../models/VisaD2CLead.js";
import { logVisaActivity } from "../models/VisaActivityLog.js";
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

/**
 * Resolve the thing a Razorpay order belongs to.
 *
 * ── APPEND-ONLY. THE ORDER OF THESE LOOKUPS IS THE B2B GUARANTEE. ────
 * The two SBT lookups are first and unmodified. The visa lookup is third,
 * so it can only ever see an order id that BOTH SBT collections have
 * already declined — which no existing B2B order id can be. A D2C order id
 * likewise cannot collide upward: it is minted against a VisaApplication
 * and was never written to an SBT booking.
 *
 * Returning null (no match anywhere) still means "orphan" to every caller.
 */
async function findBookingByOrderId(razorpayOrderId: string) {
  const flight = await SBTBooking.findOne({ razorpayOrderId });
  if (flight) return { doc: flight, type: "flight" as const };

  const hotel = await SBTHotelBooking.findOne({ razorpayOrderId });
  if (hotel) return { doc: hotel, type: "hotel" as const };

  // ── D2C (Milestone 2 Stage 2) — appended below the two above ──────
  const visa = await VisaApplication.findOne({ razorpayOrderId });
  if (visa) return { doc: visa, type: "visa_d2c" as const };

  return null;
}

/** True for the D2C branch — every handler below tests this BEFORE touching
 *  `doc`, because a VisaApplication does not share the SBT booking shape and
 *  the SBT mutations would be wrong (or invalid) applied to one. */
function isD2C(match: { type: string } | null): boolean {
  return match?.type === "visa_d2c";
}

/**
 * Mirror the funnel triple onto the Master Sheet row.
 *
 * Best-effort by design, exactly like logVisaActivity: the application is
 * the system of record for whether a case is paid, and the lead row is a
 * REPORTING projection of it. Failing a verified payment because a
 * reporting mirror did not update would be the tail wagging the dog — and
 * Razorpay would then retry a webhook whose real work already landed.
 *
 * Matched by applicationId, which routes/consumer.applications.ts sets on
 * the row at submit. A D2C application always has one; if the row is
 * missing the update simply matches nothing, which is logged, not thrown.
 */
async function mirrorToLead(
  applicationId: mongoose.Types.ObjectId,
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    const result = await VisaD2CLead.updateOne({ applicationId }, { $set: patch });
    if (result.matchedCount === 0) {
      webhookLogger.warn("D2C lead row not found for paid application — Master Sheet not mirrored", {
        applicationId: String(applicationId),
      });
    }
  } catch (err: any) {
    webhookLogger.error("failed to mirror payment onto D2C lead row — application was NOT rolled back", {
      applicationId: String(applicationId),
      error: err?.message,
    });
  }
}

/** MongoDB duplicate-key. The unique partial index on razorpayPaymentId
 *  raises this when the same payment is applied twice concurrently. */
function isDuplicateKeyError(err: any): boolean {
  return err?.code === 11000;
}

/* ─────────────────────────────────────────────────────────────────────
 * D2C — payment.captured
 *
 * ══════════════════════════════════════════════════════════════════════
 * IDEMPOTENT IN TWO LAYERS, BECAUSE ONE IS NOT ENOUGH.
 * ══════════════════════════════════════════════════════════════════════
 * Razorpay redelivers webhooks. It redelivers on our timeout, on our 5xx,
 * and sometimes simply twice. The shared handler above has no replay
 * protection at all — its SBT branch is guarded only incidentally, by
 * `status === "PENDING"` — so the D2C branch brings its own:
 *
 *   1. THE GUARD (in process). Already PAID → return, touch nothing. This
 *      catches the ordinary case: two deliveries, seconds or hours apart.
 *
 *   2. THE UNIQUE INDEX (in the database). The guard is a read followed by
 *      a write, and two concurrent deliveries can both read PENDING before
 *      either writes. The unique partial index on razorpayPaymentId makes
 *      the loser's save() fail with a duplicate key, which is caught below
 *      and treated as what it is — the work already landed.
 *
 * Layer 1 without layer 2 is a race. Layer 2 without layer 1 would make
 * every ordinary replay an exception. Both, or neither is honest.
 * ───────────────────────────────────────────────────────────────────── */
async function handleD2CPaymentCaptured(application: any, paymentEntity: any): Promise<void> {
  const razorpayPaymentId: string = paymentEntity.id || "";
  const capturedPaise = Number(paymentEntity.amount);

  /* ── LAYER 1: THE GUARD ──────────────────────────────────────────
   * A replay is a NO-OP, not an error and not a second application of
   * the same facts. Returning quietly here is what keeps one payment to
   * one activity-log row. */
  if (application.d2cPaymentStatus === "PAID") {
    webhookLogger.info("payment.captured — D2C application already paid, replay ignored", {
      applicationId: String(application._id),
      razorpayOrderId: application.razorpayOrderId,
      razorpayPaymentId,
    });
    return;
  }

  /* ── THE AMOUNT CROSS-CHECK ──────────────────────────────────────
   * The order was priced server-side in Stage 1 from this same snapshot,
   * so this should ALWAYS match. That is exactly why a mismatch is worth
   * stopping for: if it ever fires, either the order was tampered with or
   * we have a pricing bug, and both are conditions where marking a case
   * paid would destroy the evidence.
   *
   * So the case is NOT marked paid. It is flagged for a human, loudly.
   * Under-collecting and stopping is recoverable; auto-confirming a wrong
   * amount and finding out at settlement is not.
   *
   * Deliberately NOT guarded against re-flagging on a redelivery: a
   * mismatch arriving twice is two pieces of evidence, and suppressing the
   * second would make the log quieter about the one thing here that should
   * never be quiet. razorpayPaymentId is left unwritten — claiming the
   * payment id would assert an application that did not happen. */
  const expectedInr = Number(application.indicativeCostSnapshot?.totalInr);
  const expectedPaise = Math.round(expectedInr * 100);

  if (!Number.isFinite(expectedInr) || !Number.isFinite(capturedPaise) || capturedPaise !== expectedPaise) {
    webhookLogger.error("payment.captured — D2C AMOUNT MISMATCH, case flagged and NOT marked paid", {
      applicationId: String(application._id),
      razorpayOrderId: application.razorpayOrderId,
      razorpayPaymentId,
      capturedPaise,
      expectedPaise,
      expectedInr,
    });

    await setDiscrepancyFlagged(
      application._id,
      `Razorpay captured ${capturedPaise} paise but this application is priced at ${expectedPaise} paise (payment ${razorpayPaymentId}). Payment NOT applied — reconcile before proceeding.`,
      // No human found this. See the helper's own note on the null actor.
      null,
    );

    await logVisaActivity({
      applicationId: application._id,
      requestId: application.requestId,
      workspaceId: application.workspaceId,
      eventType: "PAYMENT_AMOUNT_MISMATCH",
      actorUserId: null,
      actorType: "SYSTEM",
      source: "D2C",
      detail: {
        channel: "D2C",
        razorpayPaymentId,
        razorpayOrderId: application.razorpayOrderId ?? null,
        capturedAmountInr: Number.isFinite(capturedPaise) ? capturedPaise / 100 : null,
        expectedAmountInr: Number.isFinite(expectedInr) ? expectedInr : null,
      },
    });
    return;
  }

  /* ── APPLY THE PAYMENT ───────────────────────────────────────────
   * The funnel triple moves together — payment status, stage AND the
   * "Visa Fees Paid" tracking status — for the reason visaD2CLifecycle.ts
   * gives: a case left with two of the three updated is a state no reader
   * expects. The ops `status` is deliberately NOT touched: paying does not
   * advance the concierge pipeline, and rewriting an ops status from a
   * payment webhook is precisely the cross-contamination the two separate
   * vocabularies exist to prevent. */
  application.d2cPaymentStatus = "PAID";
  application.d2cStage = "PAYMENT_DONE";
  application.d2cStatus = "VISA_FEES_PAID";
  application.razorpayPaymentId = razorpayPaymentId;

  try {
    await application.save();
  } catch (err: any) {
    /* ── LAYER 2: THE UNIQUE INDEX ─────────────────────────────────
     * Another delivery of this same payment won the race and already did
     * all of the work below. Nothing left to do, and nothing wrong. */
    if (isDuplicateKeyError(err)) {
      webhookLogger.info("payment.captured — duplicate razorpayPaymentId, concurrent replay already applied", {
        applicationId: String(application._id),
        razorpayPaymentId,
      });
      return;
    }
    throw err;
  }

  await mirrorToLead(application._id, {
    paymentStatus: "PAID",
    stage: "PAYMENT_DONE",
    status: "VISA_FEES_PAID",
  });

  await logVisaActivity({
    applicationId: application._id,
    requestId: application.requestId,
    workspaceId: application.workspaceId,
    eventType: "PAYMENT_DONE",
    actorUserId: null,
    actorType: "SYSTEM",
    source: "D2C",
    detail: {
      channel: "D2C",
      razorpayPaymentId,
      razorpayOrderId: application.razorpayOrderId ?? null,
      amountInr: capturedPaise / 100,
      currency: paymentEntity.currency || "INR",
    },
  });

  webhookLogger.info("payment.captured — D2C application marked Visa Fees Paid", {
    applicationId: String(application._id),
    razorpayOrderId: application.razorpayOrderId,
    razorpayPaymentId,
    amountInr: capturedPaise / 100,
  });
}

/* ─────────────────────────────────────────────────────────────────────
 * D2C — payment.failed
 *
 * A FAILED PAYMENT IS A HOT LEAD, NOT A DEAD CASE. The person chose a
 * corridor, attached documents, submitted, and reached a checkout — they
 * are the most qualified lead the funnel produces. So the case is recorded
 * as failed at the PAYMENT stage and left IN_PROGRESS for someone to chase,
 * never moved to DROPPED.
 *
 * TODO(milestone-3): PAYMENT_DROPPED is the OTHER failure — the person who
 * never came back from the checkout. Razorpay sends no event for that, so
 * it can never be set here; it needs a timeout sweep over applications
 * still PENDING past a cutoff. Not built in this stage, on purpose.
 * ───────────────────────────────────────────────────────────────────── */
async function handleD2CPaymentFailed(application: any, paymentEntity: any): Promise<void> {
  /* Never demote a paid case. Razorpay can deliver a failed attempt AFTER
   * a successful retry on the same order, and applying it in arrival order
   * would un-pay a case whose money we hold. */
  if (application.d2cPaymentStatus === "PAID") {
    webhookLogger.warn("payment.failed — ignored, D2C application is already paid", {
      applicationId: String(application._id),
      razorpayOrderId: application.razorpayOrderId,
    });
    return;
  }

  const failureReason: string =
    paymentEntity.error_description || paymentEntity.error?.description || "Payment failed";

  application.d2cPaymentStatus = "FAILED";
  application.d2cStage = "PAYMENT_FAILED";
  // d2cStatus stays IN_PROGRESS — see the header. razorpayPaymentId stays
  // unwritten: a failed attempt has not been applied to anything, and
  // claiming it would spend this application's one unique payment id on a
  // payment that took no money.
  await application.save();

  await mirrorToLead(application._id, {
    paymentStatus: "FAILED",
    stage: "PAYMENT_FAILED",
  });

  await logVisaActivity({
    applicationId: application._id,
    requestId: application.requestId,
    workspaceId: application.workspaceId,
    eventType: "PAYMENT_FAILED",
    actorUserId: null,
    actorType: "SYSTEM",
    source: "D2C",
    detail: {
      channel: "D2C",
      razorpayOrderId: application.razorpayOrderId ?? null,
      razorpayPaymentId: paymentEntity.id || null,
      amountInr: Number.isFinite(Number(paymentEntity.amount)) ? Number(paymentEntity.amount) / 100 : null,
      reason: failureReason,
    },
  });

  webhookLogger.info("payment.failed — D2C application marked payment failed", {
    applicationId: String(application._id),
    razorpayOrderId: application.razorpayOrderId,
    reason: failureReason,
  });
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
      if (isD2C(booking)) {
        // Branches BEFORE the SBT mutation below: a VisaApplication does
        // not carry `status: "PENDING"`/paymentCapturedAt/webhookProcessed,
        // and its own status enum would reject "CONFIRMED" outright.
        await handleD2CPaymentCaptured(booking!.doc as any, paymentEntity);
      } else if (booking) {
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
      if (isD2C(booking)) {
        await handleD2CPaymentFailed(booking!.doc as any, paymentEntity);
      } else if (booking) {
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
      if (isD2C(booking)) {
        /* D2C REFUNDS ARE NOT BUILT — and this branch exists so that fact
         * stays visible instead of becoming a silent corruption. Without
         * it, the SBT mutation below would write refundId/refundStatus/
         * refundProcessedAt onto a VisaApplication, where none of the three
         * are schema paths: Mongoose would drop all three under strict
         * mode, save() would report success, and a real refund would leave
         * no trace anywhere. Logged loudly rather than half-applied.
         *
         * TODO(milestone-3): a D2C refund needs its own lifecycle values
         * and a Master Sheet mirror. It is not a rename of the SBT one. */
        webhookLogger.warn("refund.processed — D2C application, refund handling NOT implemented; no state changed", {
          applicationId: String((booking!.doc as any)._id),
          razorpayOrderId,
          refundId: refundEntity.id,
        });
      } else if (booking) {
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
