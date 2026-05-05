import SBTConfig from "../models/SBTConfig.js";

export interface MarginConfig {
  enabled: boolean;
  flight: { domestic: number; international: number };
  hotel: { domestic: number; international: number };
}

export const DEFAULT_MARGINS: MarginConfig = {
  enabled: false,
  flight: { domestic: 0, international: 0 },
  hotel: { domestic: 0, international: 0 },
};

let marginCache: MarginConfig | null = null;
let marginCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

export async function getMarginConfig(): Promise<MarginConfig> {
  const now = Date.now();
  if (marginCache && now - marginCacheTime < CACHE_TTL) {
    return marginCache;
  }
  try {
    const doc = await SBTConfig.findOne({ key: "margins" });
    marginCache = (doc?.value as MarginConfig) || DEFAULT_MARGINS;
    marginCacheTime = now;
    return marginCache;
  } catch {
    return DEFAULT_MARGINS;
  }
}

export function invalidateMarginCache() {
  marginCache = null;
  marginCacheTime = 0;
}

export function applyMargin(netPrice: number, marginPercent: number): number {
  if (!marginPercent || marginPercent <= 0) return netPrice;
  return Math.round(netPrice * (1 + marginPercent / 100) * 100) / 100;
}

/**
 * Apply margin to a net price, then clamp to a floor if provided.
 * Returns the greater of (net + margin) and floor.
 *
 * @param netPrice     TBO TotalFare for the rate
 * @param marginPercent Configured markup percent (may be 0 or negative)
 * @param floor         Optional minimum selling price (e.g. RSP).
 *                      When null/undefined/<=0, behaves identically to
 *                      applyMargin.
 */
export function applyMarginWithFloor(
  netPrice: number,
  marginPercent: number,
  floor?: number | null
): number {
  const withMargin = applyMargin(netPrice, marginPercent);
  if (floor == null || floor <= 0) return withMargin;
  return Math.max(withMargin, floor);
}

/**
 * Returns true if the customer-charged amount violates the RSP floor.
 * False when no floor is configured (RSP not present on the rate).
 */
export function violatesRspFloor(
  customerChargedAmount: number,
  rsp?: number | null
): boolean {
  if (rsp == null || rsp <= 0) return false;
  // Use a tiny epsilon to avoid floating-point false positives on
  // values that are mathematically equal (e.g. 541.6 vs 541.5999...).
  const EPSILON = 0.01;
  return customerChargedAmount + EPSILON < rsp;
}

export function removeMargin(displayPrice: number, marginPercent: number): number {
  if (!marginPercent || marginPercent <= 0) return displayPrice;
  return Math.round((displayPrice / (1 + marginPercent / 100)) * 100) / 100;
}

export function isDomestic(originCountry?: string, destCountry?: string): boolean {
  return (originCountry || "IN") === "IN" && (destCountry || "IN") === "IN";
}
