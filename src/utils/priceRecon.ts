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
