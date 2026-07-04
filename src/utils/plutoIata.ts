// apps/backend/src/utils/plutoIata.ts
//
// City/country → IATA resolution for the concierge chat flight search.
// Extracted from routes/copilot.travel.ts. The key change vs. the old inline
// `toIATA`: we NO LONGER guess an airport code from the first three letters of
// an unknown city (which silently searched the wrong route, e.g. "Zermatt" →
// "ZER"). Unknown cities now resolve to null so the handler can ask the user to
// clarify instead of searching a fabricated code.

/** IATA map — extended city/country list for Indian travellers */
export const IATA_MAP: Record<string, string> = {
  // India
  "delhi": "DEL", "new delhi": "DEL", "mumbai": "BOM", "bombay": "BOM",
  "bangalore": "BLR", "bengaluru": "BLR", "chennai": "MAA", "madras": "MAA",
  "hyderabad": "HYD", "kolkata": "CCU", "calcutta": "CCU",
  "pune": "PNQ", "ahmedabad": "AMD", "goa": "GOI", "kochi": "COK",
  "jaipur": "JAI", "lucknow": "LKO", "amritsar": "ATQ", "varanasi": "VNS",
  "srinagar": "SXR", "chandigarh": "IXC", "indore": "IDR", "bhopal": "BHO",
  // Japan
  "tokyo": "NRT", "osaka": "KIX", "kyoto": "KIX", "nagoya": "NGO",
  "sapporo": "CTS", "fukuoka": "FUK", "okinawa": "OKA", "hiroshima": "HIJ",
  "japan": "NRT",
  // SE Asia
  "singapore": "SIN", "bangkok": "BKK", "phuket": "HKT", "bali": "DPS",
  "kuala lumpur": "KUL", "jakarta": "CGK", "ho chi minh": "SGN", "hanoi": "HAN",
  "manila": "MNL", "colombo": "CMB", "kathmandu": "KTM", "dhaka": "DAC",
  // Middle East
  "dubai": "DXB", "abu dhabi": "AUH", "doha": "DOH", "muscat": "MCT",
  "riyadh": "RUH", "jeddah": "JED", "kuwait": "KWI",
  // Europe
  "london": "LHR", "paris": "CDG", "amsterdam": "AMS", "frankfurt": "FRA",
  "rome": "FCO", "milan": "MXP", "madrid": "MAD", "barcelona": "BCN",
  "zurich": "ZRH", "vienna": "VIE", "istanbul": "IST", "athens": "ATH",
  // Americas / Oceania
  "new york": "JFK", "los angeles": "LAX", "chicago": "ORD", "toronto": "YYZ",
  "vancouver": "YVR", "sydney": "SYD", "melbourne": "MEL", "auckland": "AKL",
};

/**
 * resolveIATA — map a city/country name to an IATA code, or accept an
 * explicit 3-letter code the user typed directly (e.g. "DEL"). Returns null
 * when the input cannot be resolved — the caller MUST NOT search a guessed code.
 */
export function resolveIATA(city: string | null | undefined): string | null {
  if (!city) return null;
  const key = city.toLowerCase().trim();
  if (IATA_MAP[key]) return IATA_MAP[key];
  // Accept an explicit IATA code the user typed directly.
  const up = city.trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(up)) return up;
  return null;
}
