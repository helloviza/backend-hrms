/**
 * routes/public.travelRequest.ts
 * ---------------------------------------------------------------------------
 * Native, browser-facing public travel-request form endpoint. Replaces the
 * Google Form -> Apps Script -> HMAC-webhook path (routes/intake.travel.ts,
 * left mounted but dormant) with a direct submit from the PlumTrips public
 * site. Creates the exact same HOUSE-tenant ManualBooking rows via the shared
 * services/travelIntake.create.ts — this endpoint owns only its own channel
 * concerns (bot defenses, its own field-requiredness rules, its own
 * intakeRef namespace) and none of the creation logic itself.
 *
 * Mounted at /api/public/travel-request (server.ts), unauthenticated, added
 * to WORKSPACE_EXEMPT. NOT behind /api/admin/manual-bookings.
 *
 * Protections, applied in this order (see router.post below):
 *   1. Honeypot — a hidden field real users never fill. If non-empty, the
 *      submission is silently discarded: we respond with the SAME 201 shape
 *      a legitimate submit gets (using the client's own submissionId as the
 *      reference) but never touch the DB. This is deliberate — a hard reject
 *      (4xx) teaches a scripted bot which field to leave blank; a fake-success
 *      teaches it nothing while still protecting the data.
 *   2. Per-IP rate limit — middleware/rateLimit.ts's travelRequestLimiter
 *      (reused, not reinvented).
 *   3. Cloudflare Turnstile server-side verify — plain HTTPS POST to
 *      siteverify, no SDK. FAIL-CLOSED ALWAYS: missing/unset TURNSTILE_SECRET
 *      is treated as a hard 400, never a skip. The only bypass is the
 *      explicit TURNSTILE_DEV_BYPASS=true flag, and only when
 *      NODE_ENV !== "production" (see verifyTurnstile below).
 *   4. Field validator — contact name + (phone OR email) + >=1 recognized
 *      service + travelDate. Stricter than the HMAC endpoint's validator
 *      (which doesn't require phone/email) because this is the only contact
 *      channel — if the visitor gave no way to reach them, staff can't
 *      qualify the lead at all.
 *
 * Dedup: the client generates a uuid v4 (submissionId) on page load and
 * resends the same one on retry/refresh; stored as
 * metadata.intakeRef = "public:<submissionId>" — namespaced separately from
 * the HMAC endpoint's "gform:<responseId>" so the two channels can never
 * false-dedupe against each other in the shared metadata.intakeRef field.
 *
 * Response never includes internal Mongo ids or stack traces — only a
 * client-supplied reference and a generic message.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { travelRequestLimiter } from "../middleware/rateLimit.js";
import { createTurnstileGate } from "../middleware/turnstile.js";
import { createIntakeBookings, recognizedServicesOf, parseIntakeDate } from "../services/travelIntake.create.js";
import { travelRequestLogger } from "../utils/logger.js";

const router = Router();

function isUuidV4(v: unknown): boolean {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

// ── 1. Honeypot ─────────────────────────────────────────────────────────────
function honeypotGate(req: Request, res: Response, next: NextFunction) {
  const trap = (req.body as any)?.hpField;
  if (typeof trap === "string" && trap.trim().length > 0) {
    const submissionId = String((req.body as any)?.submissionId ?? "").trim();
    travelRequestLogger.warn("travel-request — honeypot triggered, discarding silently", {
      ip: req.ip,
      hasSubmissionId: Boolean(submissionId),
    });
    // Fake success — see file header for why we don't hard-reject here.
    return res.status(201).json({ ok: true, reference: submissionId || undefined });
  }
  next();
}

// ── 3. Turnstile verify ──────────────────────────────────────────────────────
// EXTRACTED 2026-08-16 to middleware/turnstile.ts so /api/public/visa/lead
// (Phase 2a) uses the SAME fail-closed gate rather than a second copy of it.
// Behaviour here is unchanged — the extracted factory is the original body
// verbatim, with the log label as its one parameter.
const verifyTurnstile = createTurnstileGate("travel-request");

// ── 4. Field validator ───────────────────────────────────────────────────────
function validatePublicPayload(p: any): { errors: string[] } {
  const errors: string[] = [];

  const fullName = String(p?.fullName ?? "").trim();
  if (!fullName) errors.push("Full name is required");

  const mobile = String(p?.mobile ?? "").trim();
  const email = String(p?.email ?? "").trim();
  if (!mobile && !email) errors.push("A phone number or email address is required");

  const travelDate = parseIntakeDate(p?.travelDate);
  if (!travelDate) errors.push("Expected departure date is required");

  const recognized = recognizedServicesOf(p?.services);
  if (recognized.length === 0) errors.push("Select at least one service");

  if (!isUuidV4(p?.submissionId)) errors.push("Invalid submission");

  return { errors };
}

// POST /api/public/travel-request
router.post(
  "/travel-request",
  honeypotGate,
  travelRequestLimiter,
  verifyTurnstile,
  async (req: Request, res: Response) => {
    try {
      const payload = req.body as any;
      const { errors } = validatePublicPayload(payload);
      if (errors.length) {
        return res.status(400).json({ error: errors.join("; "), details: errors });
      }

      const submissionId = String(payload.submissionId).trim();
      const intakeRef = `public:${submissionId}`;

      const result = await createIntakeBookings({
        intakeRef,
        fullName: payload.fullName,
        mobile: payload.mobile,
        email: payload.email,
        originCity: payload.originCity,
        destination: payload.destination,
        travelDate: payload.travelDate,
        returnDate: payload.returnDate,
        purpose: payload.purpose,
        travelerCount: payload.travelerCount,
        notes: payload.notes,
        services: payload.services,
        submittedAt: new Date().toISOString(),
      });

      travelRequestLogger.info("travel-request — submission processed", {
        deduped: result.deduped,
        count: result.count,
      });

      return res.status(201).json({ ok: true, reference: submissionId });
    } catch (err) {
      travelRequestLogger.error("travel-request — processing failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      // Never leak internal ids/stack traces to a public, unauthenticated caller.
      return res.status(500).json({ error: "We couldn't submit your request. Please try again shortly." });
    }
  }
);

export default router;
