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

export function removeMargin(displayPrice: number, marginPercent: number): number {
  if (!marginPercent || marginPercent <= 0) return displayPrice;
  return Math.round((displayPrice / (1 + marginPercent / 100)) * 100) / 100;
}

export function isDomestic(originCountry?: string, destCountry?: string): boolean {
  return (originCountry || "IN") === "IN" && (destCountry || "IN") === "IN";
}
