/**
 * routes/intake.travel.ts
 * ---------------------------------------------------------------------------
 * Public, HMAC-signed intake endpoint for the "PlumTrips International Travel
 * Information Form" (Google Form → Apps Script → here). DORMANT: this Apps
 * Script path has been superseded by the native public form (see
 * routes/public.travelRequest.ts), but is left mounted, unchanged in
 * behavior, per instruction — no deletion.
 *
 * Creates one or more HOUSE-tenant ManualBooking rows via the shared
 * services/travelIntake.create.ts (both this endpoint and the native public
 * endpoint call the same creation path — see that file's header for why).
 *
 * Shape copied verbatim from routes/razorpay.webhook.ts: express.raw body →
 * HMAC-SHA256 over the raw buffer → crypto.timingSafeEqual → 400 on mismatch;
 * dev-skip only when NODE_ENV!=="production" AND the secret env var is unset.
 *
 * Mounted at /api/intake (server.ts) — NOT behind /api/admin/manual-bookings,
 * unauthenticated, added to server.ts's WORKSPACE_EXEMPT set.
 *
 * ── JSON payload contract (produced by the Apps Script deliverable) ────────
 * {
 *   "intakeRef":     string   // Google Form response id — dedup key (required)
 *   "fullName":      string   // required
 *   "mobile":        string
 *   "email":         string
 *   "originCity":    string   // "Dep. City"
 *   "destination":   string
 *   "travelDate":    string   // "Expected Departure" — ISO or DD-MM-YYYY (required)
 *   "returnDate":    string   // optional
 *   "purpose":       string
 *   "travelerCount": number
 *   "notes":         string   // any additional free text
 *   "services":      string[] // at least one recognized label (required) — see SERVICE_TYPE_MAP
 *   "submittedAt":   string   // optional, ISO timestamp of form submission
 * }
 *
 * Fan-out toggle (server-controlled, not client-controlled — an unauthenticated
 * payload must not choose the internal accounting shape): INTAKE_FANOUT_MODE
 * env var, "fanout" (default) or "single".
 *   fanout: one ManualBooking per selected service (type mapped per SERVICE_TYPE_MAP).
 *   single: one ManualBooking, type=OTHER, full raw service list in metadata.services.
 * All rows in either mode share metadata.intakeRef, contact, dates, HOUSE pin,
 * system identity, status=PENDING, assignmentStatus=PENDING_TO_ASSIGN. givenBy/
 * supplierName/pricing are left blank — filled in later during the internal
 * edit pass (PUT /:id).
 *
 * intakeRef namespacing: this endpoint's dedup key is now "gform:<responseId>"
 * (previously the bare responseId) so it can never collide with the native
 * public form's "public:<uuid>" keys in the shared metadata.intakeRef field.
 * No migration needed — verified 2026-07-08 that zero existing ManualBooking
 * rows had metadata.intakeRef populated (this path never went live).
 */
import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { createIntakeBookings, recognizedServicesOf } from "../services/travelIntake.create.js";
import { webhookLogger } from "../utils/logger.js";

const router = Router();

function verifyWebhookSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const expectedSignature = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature));
}

function parseIntakeDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  const dmy = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (dmy) {
    const d = new Date(`${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}T00:00:00.000Z`);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Own validator — deliberately NOT validateBookingRequired from
 * manualBookings.ts (that function is module-private, and is scoped to the
 * internal admin-create form's stricter rules). Intake only requires contact
 * name + at least one recognized service + travelDate, per the audit's D1
 * feasibility scoping — supplierName/givenBy/pricing are expected blank at
 * intake and filled in later.
 */
function validateIntakePayload(p: any): { errors: string[]; recognizedServices: string[] } {
  const errors: string[] = [];

  const fullName = String(p?.fullName ?? "").trim();
  if (!fullName) errors.push("fullName is required");

  const travelDate = parseIntakeDate(p?.travelDate);
  if (!travelDate) errors.push("travelDate is required and must be a valid date");

  const rawServices: string[] = Array.isArray(p?.services)
    ? p.services.map((s: unknown) => String(s ?? "").trim()).filter(Boolean)
    : [];
  const recognizedServices = recognizedServicesOf(rawServices);
  if (rawServices.length === 0) {
    errors.push("services must include at least one selection");
  } else if (recognizedServices.length === 0) {
    errors.push(`no recognized service in: ${rawServices.join(", ")}`);
  }

  return { errors, recognizedServices };
}

// POST /api/intake/travel
router.post("/travel", async (req: Request, res: Response) => {
  try {
    const signature = req.headers["x-intake-signature"] as string | undefined;
    const secret = process.env.INTAKE_WEBHOOK_SECRET;

    if (!secret) {
      if (process.env.NODE_ENV === "production") {
        webhookLogger.error("INTAKE_WEBHOOK_SECRET not set in production!");
        return res.status(500).json({ error: "Webhook secret not configured" });
      }
      webhookLogger.warn("INTAKE_WEBHOOK_SECRET not set — skipping signature verification in dev");
    } else {
      if (!signature) {
        return res.status(400).json({ error: "Invalid signature" });
      }
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
      if (!verifyWebhookSignature(rawBody, signature, secret)) {
        return res.status(400).json({ error: "Invalid signature" });
      }
    }

    const payload = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString("utf8")) : req.body;

    const { errors } = validateIntakePayload(payload);
    if (errors.length) {
      return res.status(400).json({ error: errors.join("; "), details: errors });
    }

    const rawIntakeRef = String(payload.intakeRef ?? "").trim();
    const intakeRef = rawIntakeRef ? `gform:${rawIntakeRef}` : "";

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
      submittedAt: payload.submittedAt,
    });

    if (result.deduped) {
      webhookLogger.info("travel-intake — duplicate delivery, no-op", { intakeRef, count: result.count });
      return res.status(200).json({ ok: true, deduped: true, bookingIds: result.bookingIds });
    }

    webhookLogger.info("travel-intake — booking(s) created", {
      intakeRef,
      mode: process.env.INTAKE_FANOUT_MODE === "single" ? "single" : "fanout",
      count: result.count,
      bookingIds: result.bookingIds,
    });

    return res.status(201).json({ ok: true, count: result.count, bookingIds: result.bookingIds });
  } catch (err: any) {
    webhookLogger.error("travel-intake — processing failed", {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return res.status(500).json({ error: "Intake processing failed" });
  }
});

export default router;
