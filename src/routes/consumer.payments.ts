// apps/backend/src/routes/consumer.payments.ts
//
// THE CONSUMER'S OWN PAYMENT HISTORY — /api/consumer/payments.
//
// ══════════════════════════════════════════════════════════════════════
// THIS ROUTE READS MONEY THAT ACTUALLY MOVED. IT INVENTS NOTHING.
// ══════════════════════════════════════════════════════════════════════
// One row per captured payment, and every field on it is a stored value:
// the amount Razorpay actually captured, the moment our webhook applied
// it, the gateway's own payment id, and the case it paid for.
//
// There is deliberately NO balance, NO wallet, NO credit and NO invoice
// in this response. None of those exist as data anywhere in the system,
// and a zero returned from here would be indistinguishable to a client
// from a real zero balance — which is how a "₹0.00 wallet" ends up on a
// screen for a product that has no wallet. The Payments page states
// those sections are unbuilt in its own copy; the API's contribution is
// to not offer a field they could be faked from.
//
// ── WHERE THE PAID-AT COMES FROM, AND WHY NOT THE APPLICATION ────────
// VisaApplication has no paid-at column. The payment webhook
// (routes/razorpay.webhook.ts) sets the funnel triple and
// razorpayPaymentId and nothing else; the timestamp lives on the
// VisaActivityLog row that same handler writes (eventType PAYMENT_DONE).
// That row IS the record of when we became paid, so it is read rather
// than a second field being added that would be null for every payment
// taken before it existed.
//
// The same row also carries the CAPTURED amount, which is the honest
// figure for a receipt: `indicativeCostSnapshot.totalInr` is what we
// quoted, and the two are equal today only because the webhook refuses a
// mismatch. Preferring the captured figure means this page reports what
// was taken from the card rather than what we meant to take.
//
// ── OWN-SCOPE ────────────────────────────────────────────────────────
// { consumerId, workspaceId }, both LITERAL, exactly as every other
// consumer read states them. The workspaceScope plugin cannot help: it
// injects only when a query carries `_workspaceId` in its options and
// otherwise fails OPEN, and workspaceId alone is not a boundary anyway
// because every consumer shares the one synthetic D2C workspace.
// consumerId is the real fence.
//
// A payment history is a particularly bad thing to get wrong here: it
// names amounts, dates and gateway ids. There is no by-id route in this
// file at all — the only query is "mine", so there is nothing to probe.
import { Router } from "express";
import mongoose from "mongoose";

import { requireConsumer } from "../middleware/requireConsumer.js";
import VisaApplication from "../models/VisaApplication.js";
import VisaRequest from "../models/VisaRequest.js";
import VisaActivityLog from "../models/VisaActivityLog.js";
import { d2cWorkspaceObjectId } from "../services/consumerWorkspace.js";
import logger from "../utils/logger.js";

const router = Router();
router.use(requireConsumer);

const paymentsLogger = logger.child({ module: "consumerPayments" });

function me(req: any): mongoose.Types.ObjectId {
  return new mongoose.Types.ObjectId(String(req.consumer.id));
}

/* ─────────────────────────────────────────────────────────────────────
 * GET / — every captured payment this consumer has made.
 *
 * Newest first, because a payment history is read from the top.
 * ───────────────────────────────────────────────────────────────────── */

router.get("/", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const workspaceId = d2cWorkspaceObjectId();

    /* PAID is the gate, and it is the webhook's own word — nothing else
     * in the codebase writes it. An application that is merely submitted,
     * or that has a live unpaid order sitting on it, is not a payment and
     * must never appear in a payment history. */
    const applications: any[] = await VisaApplication.find({
      consumerId,
      workspaceId,
      d2cPaymentStatus: "PAID",
    })
      .select(
        "requestId razorpayPaymentId razorpayOrderId destinationIso2 ruleSnapshot.destinationName indicativeCostSnapshot.totalInr createdAt",
      )
      .lean();

    if (applications.length === 0) {
      // An honest empty list, not an empty list with a zero total beside
      // it. The page renders its own "nothing yet" copy from this.
      return res.json({ ok: true, payments: [] });
    }

    const applicationIds = applications.map((a) => a._id);

    /* The PAYMENT_DONE rows carry the date and the captured amount. One
     * query for all of them rather than one per application — the list is
     * small, but the N+1 shape is the one that stops being small quietly. */
    const paidLogs: any[] = await VisaActivityLog.find({
      applicationId: { $in: applicationIds },
      eventType: "PAYMENT_DONE",
    })
      .select("applicationId at detail")
      .sort({ at: 1 })
      .lean();

    // FIRST row wins per application: the webhook is idempotent, so a
    // replayed delivery could in principle add a second, and the earliest
    // is the moment we actually became paid.
    const logByApplication = new Map<string, any>();
    for (const row of paidLogs) {
      const key = String(row.applicationId);
      if (!logByApplication.has(key)) logByApplication.set(key, row);
    }

    const requestIds = applications
      .map((a) => a.requestId)
      .filter((id: any) => mongoose.isValidObjectId(id));
    const requests: any[] = requestIds.length
      ? await VisaRequest.find({ _id: { $in: requestIds } })
          .select("referenceNumber")
          .lean()
      : [];
    const requestById = new Map(requests.map((r) => [String(r._id), r]));

    const payments = applications
      .map((a) => {
        const log = logByApplication.get(String(a._id)) ?? null;
        const request = requestById.get(String(a.requestId)) ?? null;

        /* Captured first, quoted as the fallback. See the header: the two
         * agree today because the webhook rejects a mismatch, and if that
         * ever changes this page should report the money, not the intent. */
        const capturedInr = Number(log?.detail?.amountInr);
        const quotedInr = Number(a.indicativeCostSnapshot?.totalInr);

        return {
          // The gateway's id is the natural key for a payment row. It is
          // already on screen in the tracker's receipt, so this exposes
          // nothing the consumer cannot already see about their own case.
          id: a.razorpayPaymentId ?? String(a._id),
          applicationId: String(a._id),
          referenceNumber: request?.referenceNumber ?? null,
          destinationIso2: a.destinationIso2 ?? null,
          destinationName: a.ruleSnapshot?.destinationName ?? null,
          amountInr: Number.isFinite(capturedInr)
            ? capturedInr
            : Number.isFinite(quotedInr)
              ? quotedInr
              : null,
          currency: log?.detail?.currency ?? "INR",
          // Null when the activity row is missing — which would mean a
          // case marked PAID without the log its own handler writes. The
          // UI shows a dash rather than the application's createdAt,
          // because a submit date presented as a payment date is a wrong
          // fact, not a graceful degradation.
          paidAt: log?.at ?? null,
          razorpayPaymentId: a.razorpayPaymentId ?? null,
        };
      })
      // Newest first. Rows with no timestamp sort last rather than
      // pretending to be the oldest.
      .sort((x, y) => {
        const xt = x.paidAt ? new Date(x.paidAt).getTime() : -Infinity;
        const yt = y.paidAt ? new Date(y.paidAt).getTime() : -Infinity;
        return yt - xt;
      });

    return res.json({ ok: true, payments });
  } catch (err: any) {
    paymentsLogger.error("consumer payment history failed", { error: err?.message });
    return res.status(500).json({ error: "We couldn't load your payments." });
  }
});

export default router;
