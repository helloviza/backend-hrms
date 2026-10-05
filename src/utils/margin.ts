import SBTConfig from "../models/SBTConfig.js";

export interface MarginConfig {
  enabled: boolean;
  flight: { domestic: number; international: number };
  hotel: { domestic: number; international: number };
  /** +1 on every change to the defaults; stamped on each quote. */
  version?: number;
}

export const DEFAULT_MARGINS: MarginConfig = {
  enabled: false,
  flight: { domestic: 0, international: 0 },
  hotel: { domestic: 0, international: 0 },
  version: 0,
};

/** Allowed range for every margin percent the admin API accepts. */
export const MARGIN_MIN_PCT = -10;
export const MARGIN_MAX_PCT = 50;

/** A margin percent the admin API accepts: a real number in [MIN, MAX]. */
export function isValidMarginPct(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= MARGIN_MIN_PCT && v <= MARGIN_MAX_PCT;
}

/**
 * Validate a margin settings body. Each of the four percents must be a real
 * number within [MARGIN_MIN_PCT, MARGIN_MAX_PCT] and `enabled` a boolean —
 * anything else is refused, never coerced (a "" or "abc" used to become 0/NaN).
 */
export function parseMarginInput(
  body: any,
): { ok: true; value: MarginConfig } | { ok: false; error: string } {
  if (typeof body?.enabled !== "boolean") {
    return { ok: false, error: "enabled must be true or false" };
  }
  const value: MarginConfig = {
    enabled: body.enabled,
    flight: { domestic: 0, international: 0 },
    hotel: { domestic: 0, international: 0 },
  };
  for (const product of ["flight", "hotel"] as const) {
    for (const region of ["domestic", "international"] as const) {
      const v = body?.[product]?.[region];
      if (!isValidMarginPct(v)) {
        return {
          ok: false,
          error: `${product} ${region} margin must be a number between ${MARGIN_MIN_PCT} and ${MARGIN_MAX_PCT}`,
        };
      }
      value[product][region] = v;
    }
  }
  return { ok: true, value };
}

let marginCache: MarginConfig | null = null;
let marginCacheTime = 0;
// Short on purpose: a save on one App Runner instance reaches every other
// instance within this window (the admin page says "within a minute").
export const MARGIN_CACHE_TTL_MS = 30 * 1000;

// Safety guard: margins only apply in a process started with
// NODE_ENV=production. Local dev may opt in with SBT_MARGINS_LOCAL=1 (off by
// default) to exercise margins against a LOCAL database — never set it on a
// machine whose MONGO_URI points at production.
let nonProdGuardLogged = false;

export function marginsLiveHere(): boolean {
  return process.env.NODE_ENV === "production" || process.env.SBT_MARGINS_LOCAL === "1";
}

export async function getMarginConfig(): Promise<MarginConfig> {
  if (!marginsLiveHere()) {
    if (!nonProdGuardLogged) {
      // eslint-disable-next-line no-console
      console.info(
        `[MARGIN] Non-production environment (NODE_ENV=${
          process.env.NODE_ENV ?? "<unset>"
        }) — margins force-disabled (SBT_MARGINS_LOCAL=1 turns them on locally)`
      );
      nonProdGuardLogged = true;
    }
    return {
      enabled: false,
      flight: { domestic: 0, international: 0 },
      hotel: { domestic: 0, international: 0 },
      version: 0,
    };
  }

  const now = Date.now();
  if (marginCache && now - marginCacheTime < MARGIN_CACHE_TTL_MS) {
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

/** Whole rupee, rounded UP (paise first, so 11000.000000002 stays 11000). */
export function ceilRupee(n: number): number {
  return Math.ceil(Math.round(n * 100) / 100);
}

/**
 * The selling price for a net price: net × (1 + pct/100), rounded UP to the
 * whole rupee. Every percent applies — 0 sells at net, a negative percent
 * sells below net (Plumtrips absorbs the difference).
 */
export function applyMargin(netPrice: number, marginPercent: number): number {
  const p = Number(marginPercent) || 0;
  return ceilRupee(netPrice * (1 + p / 100));
}

/**
 * applyMargin, never below a floor (hotels: the supplier's recommended selling
 * price, itself rounded up to the whole rupee). No floor when null / <= 0.
 */
export function applyMarginWithFloor(
  netPrice: number,
  marginPercent: number,
  floor?: number | null
): number {
  const withMargin = applyMargin(netPrice, marginPercent);
  if (floor == null || floor <= 0) return withMargin;
  return Math.max(withMargin, Math.ceil(floor));
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
