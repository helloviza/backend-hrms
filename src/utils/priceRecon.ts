/**
 * Price-reconciliation mode scaffold (step-2 wiring only).
 *
 * PRICE_RECON_MODE controls whether the server compares the client-sent amount
 * against the stored SBTQuote at booking time:
 *   - "OFF"     — no comparison (default)
 *   - "SHADOW"  — compare and log mismatches, but never reject
 *   - "ENFORCE" — compare and reject on mismatch
 *
 * Step 1 (quote persistence) does NOT read this — nothing branches on it yet.
 * Parsed once at module load.
 */
export type PriceReconMode = "OFF" | "SHADOW" | "ENFORCE";

function parseMode(raw: string | undefined): PriceReconMode {
  const v = (raw || "").trim().toUpperCase();
  return v === "SHADOW" || v === "ENFORCE" ? v : "OFF";
}

const PRICE_RECON_MODE: PriceReconMode = parseMode(process.env.PRICE_RECON_MODE);

export function getPriceReconMode(): PriceReconMode {
  return PRICE_RECON_MODE;
}

import SBTQuote from "../models/SBTQuote.js";
import { sbtLogger } from "./logger.js";

// Rupee tolerance: deltas at or below this are treated as clean rounding noise.
const PRICE_RECON_TOLERANCE = 1;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Step 2 SHADOW reconciliation — compare the amounts a booking is about to use
 * against the SBTQuote the server persisted at quote time, and LOG the result.
 *
 * Log-only by contract: this NEVER rejects, throws, or mutates the booking.
 *   - mode OFF        → total no-op (no DB read, no log).
 *   - SHADOW/ENFORCE  → look up the quote and emit one line per call.
 * Fail-OPEN: a missing quote (expired TTL / not persisted) or any error logs an
 * info line and returns — the booking is never blocked. Enforcement arrives in
 * step 3 (see the TODO below); until then ENFORCE behaves identically to SHADOW.
 *
 * Pass only the side(s) actually available at the call site: tboNet where the
 * net sent to TBO is known, chargedTotal where the customer-charged display
 * total is known. The corresponding delta is omitted when its input is absent.
 */
export async function reconcileQuoteShadow(opts: {
  product: "FLIGHT" | "HOTEL";
  sourceRef: string;
  /** Match by `${sourceRef}:` prefix (flight save carries TraceId but not ResultIndex). */
  sourceRefPrefix?: boolean;
  /** Customer-charged display total (margined). Omit where not available. */
  chargedTotal?: number;
  /** Net/cost amount sent to TBO (pre-margin). Omit where not available. */
  tboNet?: number;
}): Promise<void> {
  const mode = getPriceReconMode();
  if (mode === "OFF") return;

  try {
    const query = opts.sourceRefPrefix
      ? { product: opts.product, sourceRef: { $regex: `^${escapeRegExp(opts.sourceRef)}:` } }
      : { product: opts.product, sourceRef: opts.sourceRef };
    // Most recent wins when more than one quote shares the sourceRef.
    const quote = await SBTQuote.findOne(query).sort({ createdAt: -1 }).lean();

    if (!quote) {
      sbtLogger.info("[price-recon] no server quote", {
        product: opts.product,
        sourceRef: opts.sourceRef,
      });
      return;
    }

    const displayDelta =
      typeof opts.chargedTotal === "number"
        ? opts.chargedTotal - quote.serverDisplayFare
        : undefined;
    const netDelta =
      typeof opts.tboNet === "number" ? opts.tboNet - quote.serverNetFare : undefined;

    const payload = {
      product: opts.product,
      quoteId: quote.quoteId,
      sourceRef: opts.sourceRef,
      serverDisplayFare: quote.serverDisplayFare,
      chargedTotal: opts.chargedTotal,
      displayDelta,
      serverNetFare: quote.serverNetFare,
      tboNet: opts.tboNet,
      netDelta,
      mode,
    };

    // For flights, a positive displayDelta is EXPECTED — the FareQuote serverDisplayFare
    // is base-only while chargedTotal includes SSR/seat/meal ancillaries. We read these
    // breaches in review; they are not treated as errors here.
    const breach =
      (typeof displayDelta === "number" && Math.abs(displayDelta) > PRICE_RECON_TOLERANCE) ||
      (typeof netDelta === "number" && Math.abs(netDelta) > PRICE_RECON_TOLERANCE);

    // TODO step 3: enforce here — in ENFORCE mode, reject the booking on breach.
    if (breach) sbtLogger.warn("[price-recon] shadow", payload);
    else sbtLogger.info("[price-recon] shadow", payload);
  } catch (err: any) {
    // Fail-OPEN: reconciliation must never block or error a booking.
    sbtLogger.info("[price-recon] shadow skipped (error)", {
      product: opts.product,
      sourceRef: opts.sourceRef,
      err: err?.message,
    });
  }
}
