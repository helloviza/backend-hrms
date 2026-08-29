// apps/backend/src/routes/admin.consumerErasure.ts
//
// D7 + D8 — THE REVIEW AND EXECUTE SURFACE.
//
// D8: this is the CONSOLE arm. scripts/erase-consumer.ts is the CLI arm and
// drives the SAME two cascade functions (planConsumerErasure /
// executeConsumerErasure) with the same guards, so neither can drift into
// being the "real" one. The console is where the work normally happens
// because reviewing an erasure means READING a retention summary and then
// deciding — a thing a terminal renders badly and a reviewer should not
// have to be handed a shell to do.
//
// ══════════════════════════════════════════════════════════════════════
// D7 — THE GATE, ROUTE BY ROUTE
// ══════════════════════════════════════════════════════════════════════
//   GET  /                 visaApplication:READ   the queue
//   GET  /:id              visaApplication:READ   one request + LIVE dry-run
//   POST /                 visaApplication:READ   log a request that arrived
//                                                 by another channel
//   POST /:id/review       visaApplication:READ   -> under_review
//   POST /:id/approve      SUPERADMIN             -> approved
//   POST /:id/reject       SUPERADMIN             -> rejected
//   POST /:id/execute      SUPERADMIN             -> RUNS THE CASCADE
//
// Reading and reviewing sit on the same visaApplication:READ key the
// consumer registry uses — it is the same population, looked at for the
// same purpose, and minting a second key would be one more thing to grant,
// revoke, and forget to revoke.
//
// Everything that DECIDES or DESTROYS is SUPERADMIN, checked with
// isSuperAdmin(req) directly rather than through requirePermission — a
// permission key can be granted to a level; this cannot.
//
// ── WHY APPROVE AND EXECUTE ARE TWO CALLS ────────────────────────────
// Both are SUPERADMIN, so collapsing them would cost no permission and
// save a click. It would also remove the only moment in the flow where a
// person has read the retention summary and can still stop. The dry-run
// plan is re-computed and returned by BOTH the detail read and the review
// step, so "what will be kept" is on screen before the irreversible button
// is available at all.
//
// ── WHY assertModelScope() IS NOT CALLED HERE ────────────────────────
// It sweeps mongoose.modelNames() and process.exit(1)s on anything
// unexpected. Inside the API server every model in the codebase is
// registered, so it would abort the process on the first request. The
// cascade's per-write assertAllowed() is the guard that works in both
// environments and is the one with teeth; see that file's Guard 1 block.
import { Router } from "express";
import mongoose from "mongoose";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/requirePermission.js";
import { isSuperAdmin } from "../middleware/isSuperAdmin.js";
import Consumer from "../models/Consumer.js";
import ConsumerErasureRequest, {
  CONSUMER_ERASURE_STATES,
  ConsumerErasureAlreadyOpenError,
  ConsumerErasureTransitionError,
  raiseConsumerErasureRequest,
  markUnderReview,
  markApproved,
  markRejected,
  markExecuted,
  type ConsumerErasureState,
} from "../models/ConsumerErasureRequest.js";
import {
  planConsumerErasure,
  planToManifest,
  executeConsumerErasure,
} from "../scripts/lib/consumerErasureCascade.js";
import { shouldRedactInvoiceName, ERASURE_REDACT_INVOICE_NAME_ENV } from "../config/erasurePolicy.js";
import logger from "../utils/logger.js";

const erasureLogger = logger.child({ module: "adminConsumerErasure" });
const router = Router();

router.use(requireAuth);

/** SUPERADMIN, and nothing else. Used for approve / reject / execute. */
function requireSuperAdmin(req: any, res: any, next: any) {
  if (!isSuperAdmin(req)) {
    return res.status(403).json({
      error: "Super Admin only. Approving and executing an erasure is not delegable.",
    });
  }
  return next();
}

function actorFrom(req: any): { userId: string; email: string } {
  return {
    userId: String(req.user?._id || req.user?.id || req.user?.sub || ""),
    email: String(req.user?.email || ""),
  };
}

/**
 * The row as the console renders it. subjectEmail/subjectName are null once
 * the request is terminal (models/ConsumerErasureRequest.ts nulls them on
 * execute and on reject) — the client shows the pseudonym instead, and that
 * is the D6 contract made visible rather than hidden behind a fallback that
 * quietly re-derives a name from somewhere else.
 */
function shapeRequest(r: any) {
  return {
    id: String(r._id),
    consumerId: String(r.consumerId),
    subjectPseudonym: r.subjectPseudonym,
    subjectEmail: r.subjectEmail ?? null,
    subjectName: r.subjectName ?? null,
    state: r.state,
    origin: r.origin,
    requestedAt: r.requestedAt ?? null,
    requestReason: r.requestReason ?? null,
    reviewedAt: r.reviewedAt ?? null,
    reviewedByEmail: r.reviewedByEmail ?? null,
    reviewNote: r.reviewNote ?? null,
    decidedAt: r.decidedAt ?? null,
    decidedByEmail: r.decidedByEmail ?? null,
    decisionNote: r.decisionNote ?? null,
    executedAt: r.executedAt ?? null,
    executedByEmail: r.executedByEmail ?? null,
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * GET / — the queue.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/", requirePermission("visaApplication", "READ"), async (req: any, res: any) => {
  try {
    const filter: Record<string, any> = {};
    const state = String(req.query.state || "").trim();
    if (state && (CONSUMER_ERASURE_STATES as readonly string[]).includes(state)) {
      filter.state = state;
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const [rows, counts] = await Promise.all([
      ConsumerErasureRequest.find(filter).sort({ requestedAt: -1 }).limit(limit).lean(),
      ConsumerErasureRequest.aggregate([{ $group: { _id: "$state", n: { $sum: 1 } } }]),
    ]);

    const summary: Record<string, number> = {};
    for (const s of CONSUMER_ERASURE_STATES) summary[s] = 0;
    for (const c of counts as any[]) summary[String(c._id)] = c.n;

    return res.json({
      ok: true,
      rows: (rows as any[]).map(shapeRequest),
      summary,
      // Surfaced so a reviewer can see the live policy without reading
      // config — the flag decides what "erased" will mean for the invoice
      // they are about to approve keeping.
      policy: {
        envVar: ERASURE_REDACT_INVOICE_NAME_ENV,
        redactInvoiceName: shouldRedactInvoiceName(),
      },
      viewer: { canExecute: isSuperAdmin(req) },
    });
  } catch (err: any) {
    erasureLogger.error("erasure queue failed", { error: err?.message });
    return res.status(500).json({ error: "Failed to load the erasure queue" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * GET /:id — the request, plus a LIVE dry run.
 *
 * The plan is re-computed on every read rather than served from the stored
 * reviewManifest. A stored plan goes stale the moment the consumer does
 * anything — uploads a document, pays for a case — and approving against a
 * stale plan would mean approving an erasure whose real blast radius nobody
 * has seen. The stored copy is the AUDIT of what a reviewer saw; this is
 * what is true now.
 * ───────────────────────────────────────────────────────────────────── */
router.get("/:id", requirePermission("visaApplication", "READ"), async (req: any, res: any) => {
  try {
    const id = String(req.params.id || "");
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: "Invalid request id" });

    const row: any = await ConsumerErasureRequest.findById(id).lean();
    if (!row) return res.status(404).json({ error: "Erasure request not found" });

    // An executed request has nothing left to plan against — the subject is
    // gone. Its stored manifest IS the answer, and re-planning would return
    // a near-empty plan that reads like "nothing was ever there".
    if (row.state === "executed") {
      return res.json({
        ok: true,
        request: shapeRequest(row),
        plan: null,
        manifest: row.manifest ?? null,
        viewer: { canExecute: isSuperAdmin(req) },
      });
    }

    const plan = await planConsumerErasure(row.consumerId);
    const preview = planToManifest(plan, {
      actorEmail: actorFrom(req).email,
      reason: row.requestReason || "(pending review)",
    });

    return res.json({
      ok: true,
      request: shapeRequest(row),
      plan: preview,
      manifest: row.manifest ?? null,
      viewer: { canExecute: isSuperAdmin(req) },
    });
  } catch (err: any) {
    erasureLogger.error("erasure request detail failed", { error: err?.message });
    return res.status(500).json({ error: "Failed to load the erasure request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST / — an ops agent logs a request that arrived by another channel
 * (an email, a phone call). Same state machine, different origin, and the
 * origin is recorded because the evidence for it lives elsewhere.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/", requirePermission("visaApplication", "READ"), async (req: any, res: any) => {
  try {
    const consumerId = String(req.body?.consumerId || "");
    if (!mongoose.isValidObjectId(consumerId)) {
      return res.status(400).json({ error: "A valid consumerId is required" });
    }
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

    const consumer: any = await Consumer.findById(consumerId).select("email name").lean();
    if (!consumer) return res.status(404).json({ error: "Consumer not found" });

    const actor = actorFrom(req);
    const doc = await raiseConsumerErasureRequest({
      consumerId,
      subjectEmail: consumer.email,
      subjectName: consumer.name,
      origin: "ops_logged",
      requestedByUserId: actor.userId || null,
      requestedByEmail: actor.email || null,
      requestReason: reason || null,
    });

    return res.status(201).json({ ok: true, request: shapeRequest(doc.toObject()) });
  } catch (err: any) {
    if (err instanceof ConsumerErasureAlreadyOpenError) {
      return res.status(409).json({ error: err.message, existingId: err.existingId, state: err.state });
    }
    erasureLogger.error("ops-logged erasure request failed", { error: err?.message });
    return res.status(500).json({ error: "Failed to log the erasure request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /:id/review — requested -> under_review, capturing the plan.
 *
 * The manifest stored here is the reviewer's own evidence: "this is the
 * blast radius I was shown". It is deleted again when the request executes
 * (markExecuted nulls reviewManifest) because a dry-run plan names the
 * invoice recipient, and an audit record is not allowed to keep that.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/review", requirePermission("visaApplication", "READ"), async (req: any, res: any) => {
  try {
    const id = String(req.params.id || "");
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: "Invalid request id" });

    const row: any = await ConsumerErasureRequest.findById(id).select("consumerId").lean();
    if (!row) return res.status(404).json({ error: "Erasure request not found" });

    const actor = actorFrom(req);
    const plan = await planConsumerErasure(row.consumerId);
    const preview = planToManifest(plan, {
      actorEmail: actor.email,
      reason: "review snapshot",
    });

    const doc = await markUnderReview(
      id,
      { userId: actor.userId, email: actor.email },
      preview as any,
      typeof req.body?.note === "string" ? req.body.note.trim() : null,
    );

    return res.json({ ok: true, request: shapeRequest(doc.toObject()), plan: preview });
  } catch (err: any) {
    if (err instanceof ConsumerErasureTransitionError) {
      return res.status(409).json({ error: err.message });
    }
    erasureLogger.error("erasure review failed", { error: err?.message });
    return res.status(500).json({ error: "Failed to move the request into review" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /:id/approve — SUPERADMIN. A decision, not an action.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/approve", requireSuperAdmin, async (req: any, res: any) => {
  try {
    const id = String(req.params.id || "");
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: "Invalid request id" });

    const actor = actorFrom(req);
    const doc = await markApproved(
      id,
      { userId: actor.userId, email: actor.email },
      typeof req.body?.note === "string" ? req.body.note.trim() : null,
    );
    return res.json({ ok: true, request: shapeRequest(doc.toObject()) });
  } catch (err: any) {
    if (err instanceof ConsumerErasureTransitionError) {
      return res.status(409).json({ error: err.message });
    }
    erasureLogger.error("erasure approve failed", { error: err?.message });
    return res.status(500).json({ error: "Failed to approve the request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /:id/reject — SUPERADMIN, and a note is REQUIRED. A refusal of an
 * erasure right has to say on what basis.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/reject", requireSuperAdmin, async (req: any, res: any) => {
  try {
    const id = String(req.params.id || "");
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: "Invalid request id" });

    const note = typeof req.body?.note === "string" ? req.body.note.trim() : "";
    if (!note) {
      return res.status(400).json({ error: "A reason is required to reject an erasure request." });
    }

    const actor = actorFrom(req);
    const doc = await markRejected(id, { userId: actor.userId, email: actor.email }, note);
    return res.json({ ok: true, request: shapeRequest(doc.toObject()) });
  } catch (err: any) {
    if (err instanceof ConsumerErasureTransitionError) {
      return res.status(409).json({ error: err.message });
    }
    erasureLogger.error("erasure reject failed", { error: err?.message });
    return res.status(500).json({ error: "Failed to reject the request" });
  }
});

/* ─────────────────────────────────────────────────────────────────────
 * POST /:id/execute — SUPERADMIN. THE IRREVERSIBLE ONE.
 *
 * FOUR gates, in this order:
 *   1. SUPERADMIN (requireSuperAdmin, above).
 *   2. The request must be in `approved` — enforced by the state machine,
 *      but checked here first so the failure is a clear 409 rather than a
 *      cascade that ran and then could not be recorded.
 *   3. The body must carry confirm === true — the console's typed
 *      confirmation, and the console arm's equivalent of the CLI's
 *      --confirm-erasure.
 *   4. executeConsumerErasure() itself refuses without {apply, confirmed}.
 *
 * ORDER MATTERS ON THE RECORDING TOO: the state is checked BEFORE the
 * cascade runs, and markExecuted() is called immediately after it returns.
 * An erasure that ran and left no record is the one outcome with no way
 * back, so the window between the two is kept as small as the code allows.
 * ───────────────────────────────────────────────────────────────────── */
router.post("/:id/execute", requireSuperAdmin, async (req: any, res: any) => {
  const id = String(req.params.id || "");
  try {
    if (!mongoose.isValidObjectId(id)) return res.status(400).json({ error: "Invalid request id" });
    if (req.body?.confirm !== true) {
      return res.status(400).json({
        error:
          "Refusing to execute: confirm must be true. This deletes the account and crypto-shreds the data key.",
      });
    }

    const row: any = await ConsumerErasureRequest.findById(id).select("consumerId state").lean();
    if (!row) return res.status(404).json({ error: "Erasure request not found" });
    if (row.state !== "approved") {
      return res.status(409).json({
        error: `This request is "${row.state}". Only an approved request may be executed.`,
      });
    }

    const actor = actorFrom(req);
    const reason =
      (typeof req.body?.reason === "string" && req.body.reason.trim()) ||
      "Consumer erasure request executed from the admin console";

    const plan = await planConsumerErasure(row.consumerId);
    const manifest = await executeConsumerErasure(plan, {
      apply: true,
      confirmed: true,
      actorEmail: actor.email,
      actorUserId: actor.userId || null,
      reason,
    });

    const doc = await markExecuted(id, { userId: actor.userId, email: actor.email }, manifest as any);

    erasureLogger.warn("CONSUMER ERASURE EXECUTED", {
      requestId: id,
      // Pseudonym only — this log line outlives the account it describes.
      subjectPseudonym: manifest.subjectPseudonym,
      actorEmail: actor.email,
      redactInvoiceName: manifest.redactInvoiceName,
      invoicesRetained: manifest.retained.invoices.length,
    });

    return res.json({ ok: true, request: shapeRequest(doc.toObject()), manifest });
  } catch (err: any) {
    if (err instanceof ConsumerErasureTransitionError) {
      return res.status(409).json({ error: err.message });
    }
    // A failure here can mean the cascade ran PARTIALLY. It is re-runnable
    // by design (every motion skips what it already did), so the operator's
    // correct next move is to look at the error and execute again — said
    // explicitly rather than left to be guessed from a 500.
    erasureLogger.error("CONSUMER ERASURE FAILED MID-RUN", { requestId: id, error: err?.message });
    return res.status(500).json({
      error: `The erasure did not complete: ${err?.message || "unknown error"}. The cascade is re-runnable — re-execute this request once the cause is fixed.`,
    });
  }
});

export default router;
