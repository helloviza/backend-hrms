// apps/backend/src/routes/consumer.erasure.ts
//
// D4 — THE REQUEST ENTRY POINT. The consumer's own "delete my account".
//
// ══════════════════════════════════════════════════════════════════════
// THIS ROUTE DELETES NOTHING.
// ══════════════════════════════════════════════════════════════════════
// It creates a ConsumerErasureRequest in state `requested` and returns. No
// row is removed, no field is redacted, no key is shredded. Erasure happens
// only when a Super Admin later reviews, approves and executes it
// (routes/admin.consumerErasure.ts, or scripts/erase-consumer.ts).
//
// That separation is the entire design, and it is not caution for its own
// sake — three concrete things make a one-click self-service delete wrong
// here:
//
//   1. RETENTION IS NOT UNIFORM. A consumer who paid for a visa has a tax
//      invoice that must survive with its number series gapless. Deciding
//      what is kept vs. stripped is a judgement made against a specific
//      person's data, and it is made by a human reading the dry-run plan.
//   2. THE ACT IS IRREVERSIBLE. The cascade crypto-shreds the subject's
//      data key. There is no undo, no soft-delete window, no restore from a
//      backup that would not also restore the erasure it was meant to
//      perform.
//   3. AN IN-FLIGHT CASE. A consumer with an application currently at an
//      embassy cannot have it recalled. The reviewer sees that; a button
//      cannot.
//
// So the consumer's right is honoured by GUARANTEEING THE REQUEST IS
// RECORDED — with an audit trail and a state machine that will not let it
// be quietly dropped — not by executing it inline.
//
// ── OWN-SCOPE, LIKE EVERY OTHER CONSUMER ROUTE ───────────────────────
// consumerId comes from req.consumer.id (requireConsumer), NEVER from the
// body. There is no by-id form of this endpoint and no way to raise a
// request against somebody else.
import { Router } from "express";
import { requireConsumer } from "../middleware/requireConsumer.js";
import Consumer from "../models/Consumer.js";
import ConsumerErasureRequest, {
  raiseConsumerErasureRequest,
  ConsumerErasureAlreadyOpenError,
} from "../models/ConsumerErasureRequest.js";
import logger from "../utils/logger.js";

const erasureLogger = logger.child({ module: "consumerErasure" });
const router = Router();

router.use(requireConsumer);

const MAX_REASON_LENGTH = 1000;

/** Consumer-facing wording for each state. The internal enum is not shown. */
const STATE_LABELS: Record<string, string> = {
  requested: "Received — awaiting review",
  under_review: "Under review",
  approved: "Approved — scheduled for deletion",
  executed: "Completed",
  rejected: "Declined",
};

/* ─────────────────────────────────────────────────────────────────────
 * GET / — does this consumer have a request open, and where is it?
 *
 * Returns the LATEST non-executed request. `executed` is deliberately
 * unreachable through this endpoint for a reason that is not squeamishness:
 * once a request has executed, the Consumer row is gone, so requireConsumer
 * rejects the token and nobody can reach this route as that person at all.
 * The state exists for the admin surface, not for a session that cannot
 * exist.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/", async (req: any, res: any) => {
  try {
    const consumerId = String(req.consumer.id);
    const existing = await ConsumerErasureRequest.findOne({
      consumerId,
      state: { $in: ["requested", "under_review", "approved"] },
    })
      .sort({ requestedAt: -1 })
      .select("state requestedAt decisionNote")
      .lean();

    if (!existing) return res.json({ ok: true, request: null });

    return res.json({
      ok: true,
      request: {
        state: (existing as any).state,
        stateLabel: STATE_LABELS[(existing as any).state] ?? (existing as any).state,
        requestedAt: (existing as any).requestedAt ?? null,
      },
    });
  } catch (err: any) {
    erasureLogger.error("consumer erasure status failed", { error: err?.message });
    return res.status(500).json({ ok: false, error: "Could not load your deletion request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST / — raise the request.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/", async (req: any, res: any) => {
  try {
    const consumerId = String(req.consumer.id);
    const rawReason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (rawReason.length > MAX_REASON_LENGTH) {
      return res.status(400).json({
        ok: false,
        error: `Please keep your note to ${MAX_REASON_LENGTH} characters or fewer`,
        field: "reason",
      });
    }

    // Re-read the row rather than trusting the token's cached copy: the
    // request stores the subject's name and email for the reviewer, and
    // those must be what the database says today, not what was minted into
    // a JWT days ago.
    const consumer: any = await Consumer.findById(consumerId).select("email name").lean();
    if (!consumer) {
      // requireConsumer already proved this row existed a moment ago, so
      // reaching here means it went away mid-request. Nothing to erase.
      return res.status(404).json({ ok: false, error: "Account not found" });
    }

    const doc = await raiseConsumerErasureRequest({
      consumerId,
      subjectEmail: consumer.email,
      subjectName: consumer.name,
      origin: "consumer_account",
      requestedByConsumerId: consumerId,
      requestedByEmail: consumer.email,
      requestReason: rawReason || null,
    });

    erasureLogger.info("consumer raised an erasure request", {
      // The pseudonym, not the address — this log line outlives the account.
      subjectPseudonym: doc.subjectPseudonym,
      requestId: String(doc._id),
    });

    return res.status(201).json({
      ok: true,
      request: {
        state: doc.state,
        stateLabel: STATE_LABELS[doc.state] ?? doc.state,
        requestedAt: doc.requestedAt,
      },
      // Said plainly, because the difference between "we deleted it" and
      // "we recorded that you asked" is exactly what a person needs to know.
      message:
        "We have recorded your request. A member of our team will review it and confirm by email. " +
        "Your account stays active until then, and any invoice we have already issued you is kept " +
        "for tax purposes with your contact details removed.",
    });
  } catch (err: any) {
    if (err instanceof ConsumerErasureAlreadyOpenError) {
      return res.status(409).json({
        ok: false,
        error: "You already have a deletion request in progress.",
        state: err.state,
        stateLabel: STATE_LABELS[err.state] ?? err.state,
      });
    }
    erasureLogger.error("consumer erasure request failed", { error: err?.message });
    return res.status(500).json({ ok: false, error: "Could not record your deletion request" });
  }
});

export default router;
