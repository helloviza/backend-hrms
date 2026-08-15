// apps/backend/src/middleware/turnstile.ts
//
// Cloudflare Turnstile server-side verification, as reusable middleware.
//
// EXTRACTED (2026-08-16) from routes/public.travelRequest.ts, where it was a
// module-private function. Phase 2a needed the same gate on
// /api/public/visa/lead, and the alternative was a second copy of a
// FAIL-CLOSED security check — two gates that could drift, where the drift
// would be silent and would only ever fail open. One definition, two callers.
//
// The logic is preserved verbatim from the original; the only change is that
// the log label is now a parameter instead of the hardcoded "travel-request"
// prefix, so each caller's lines stay attributable.
//
// FAIL-CLOSED, ALWAYS. A missing/unset TURNSTILE_SECRET is a hard 400, never
// a skip — an unconfigured environment must not silently accept unverified
// submissions. The ONLY bypass is the explicit TURNSTILE_DEV_BYPASS=true
// flag, and only when NODE_ENV !== "production", so it cannot be turned on in
// prod even by setting the variable.
import type { Request, Response, NextFunction } from "express";
import logger from "../utils/logger.js";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const turnstileLogger = logger.child({ module: "turnstile" });

/**
 * Builds a Turnstile verification middleware.
 *
 * @param label identifies the calling surface in log lines ("travel-request",
 *              "visa-lead"). Never sent to the client — error copy is
 *              deliberately generic so a bot learns nothing about which check
 *              rejected it.
 */
export function createTurnstileGate(label: string) {
  return async function verifyTurnstile(req: Request, res: Response, next: NextFunction) {
    const secret = process.env.TURNSTILE_SECRET;
    const devBypass =
      process.env.TURNSTILE_DEV_BYPASS === "true" && process.env.NODE_ENV !== "production";

    if (!secret) {
      if (devBypass) {
        turnstileLogger.warn(
          `${label} — TURNSTILE_SECRET unset, TURNSTILE_DEV_BYPASS active (non-production only)`,
        );
        return next();
      }
      turnstileLogger.error(`${label} — TURNSTILE_SECRET not configured; rejecting (fail-closed)`);
      return res.status(400).json({ error: "Verification unavailable. Please try again shortly." });
    }

    const token = String((req.body as any)?.turnstileToken ?? "").trim();
    if (!token) {
      return res.status(400).json({ error: "Verification required." });
    }

    try {
      const params = new URLSearchParams();
      params.set("secret", secret);
      params.set("response", token);
      if (req.ip) params.set("remoteip", req.ip);

      const verifyRes = await fetch(TURNSTILE_VERIFY_URL, { method: "POST", body: params });
      const verifyBody: any = await verifyRes.json().catch(() => null);

      if (!verifyRes.ok || !verifyBody?.success) {
        turnstileLogger.warn(`${label} — Turnstile verification failed`, {
          status: verifyRes.status,
          errorCodes: verifyBody?.["error-codes"],
        });
        return res.status(400).json({ error: "Verification failed. Please try again." });
      }

      next();
    } catch (err) {
      turnstileLogger.error(`${label} — Turnstile verify request errored`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(400).json({ error: "Verification unavailable. Please try again shortly." });
    }
  };
}
