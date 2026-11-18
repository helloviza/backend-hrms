// apps/backend/src/utils/airlineNormalize.ts
//
// Airline names → one canonical carrier (Travel Spend Phase B, "Airline
// share"). Manual bookings carry the airline as free text: IndiGo is typed
// "Indigo", "IndiGo", "INDIGO", "INdigo"; combinations are typed "Air India &
// Indigo", "Akasa/ Air India", "Indigo Air India Express" (no separator at
// all); junk like "NA", "0000", "TEST", a PNR or flight numbers turns up too.
//
// splitCarriers() scans the text for the longest known alias at each
// position, so it splits with or without a separator and never invents a
// carrier: text that matches nothing is "Unknown". When the airline text has
// no carrier, the flight number's IATA prefix (6E-5217 → IndiGo) is tried.

export const UNKNOWN_CARRIER = "Unknown";

/** Canonical name → its aliases (lower-case, letters/digits/spaces only). */
const CARRIERS: Record<string, { code?: string; aliases: string[] }> = {
  "IndiGo": { code: "6E", aliases: ["indigo", "indigo airlines", "6e"] },
  "Air India": { code: "AI", aliases: ["air india", "airindia", "air inia", "air indai"] },
  "Air India Express": { code: "IX", aliases: ["air india express", "air india exp", "airindia express", "ix"] },
  "Akasa Air": { code: "QP", aliases: ["akasa air", "akasa", "qp"] },
  "SpiceJet": { code: "SG", aliases: ["spicejet", "spice jet"] },
  "Fly91": { code: "IC", aliases: ["fly91", "fly 91"] },
  "Star Air": { code: "S5", aliases: ["star air", "starair"] },
  "Etihad Airways": { code: "EY", aliases: ["etihad airways", "etihad"] },
  "Emirates": { code: "EK", aliases: ["emirates airlines", "emirates airline", "emirates"] },
  "flydubai": { code: "FZ", aliases: ["fly dubai fz", "fly dubai", "flydubai"] },
  "Qatar Airways": { code: "QR", aliases: ["qatar airways", "qatar"] },
  "Gulf Air": { code: "GF", aliases: ["gulf air"] },
  "flynas": { code: "XY", aliases: ["flynas", "fly nas"] },
  "flyadeal": { code: "F3", aliases: ["flyadeal", "fly adeal"] },
  "Royal Jordanian": { code: "RJ", aliases: ["royal jordanian"] },
  "Turkish Airlines": { code: "TK", aliases: ["turkish airlines", "turkish"] },
  "Egyptair": { code: "MS", aliases: ["egyptair", "egypt air"] },
  "Ethiopian Airlines": { code: "ET", aliases: ["ethiopianairlines", "ethiopian airlines", "ethiopian"] },
  "Kenya Airways": { code: "KQ", aliases: ["kenya airways"] },
  "Airlink": { code: "4Z", aliases: ["airlink"] },
  "Air Seychelles": { code: "HM", aliases: ["air seychelles"] },
  "KLM": { code: "KL", aliases: ["klm royal dutch airlines", "klm royal dutch", "klm"] },
  "British Airways": { code: "BA", aliases: ["british airways"] },
  "Virgin Atlantic": { code: "VS", aliases: ["virgin atlantic airways", "virgin atlantic"] },
  "Lufthansa": { code: "LH", aliases: ["lufthansa", "luftansa"] },
  "SWISS": { code: "LX", aliases: ["swiss swiss", "swiss international air lines", "swiss"] },
  "Brussels Airlines": { code: "SN", aliases: ["sn brussels airlines", "brussels airlines"] },
  "LOT Polish Airlines": { code: "LO", aliases: ["lot polish airlines", "lot polish"] },
  "airBaltic": { code: "BT", aliases: ["bt air baltic", "air baltic", "airbaltic"] },
  "Finnair": { code: "AY", aliases: ["finnair"] },
  "Icelandair": { code: "FI", aliases: ["icelandair"] },
  "Iberia": { code: "IB", aliases: ["iberia airlines", "iberia"] },
  "Vueling": { code: "VY", aliases: ["vueling airlines", "vueling"] },
  "TAP Air Portugal": { code: "TP", aliases: ["tap air portugal", "air portugal", "tap portugal"] },
  "Eurowings": { code: "EW", aliases: ["eurowings", "euro wings"] },
  "Transavia": { code: "HV", aliases: ["transavia airlines", "transavia"] },
  "Wizz Air": { code: "W6", aliases: ["wizz air", "wizzair"] },
  "Luxair": { code: "LG", aliases: ["luxair"] },
  "Delta Air Lines": { code: "DL", aliases: ["delta air lines", "delta airlines", "delta"] },
  "United Airlines": { code: "UA", aliases: ["united airlines"] },
  "American Airlines": { code: "AA", aliases: ["american airlines"] },
  "Alaska Airlines": { code: "AS", aliases: ["alaska airlines"] },
  "Southwest Airlines": { code: "WN", aliases: ["southwest airlines"] },
  "LATAM Airlines": { code: "LA", aliases: ["latam airlines", "latam"] },
  "Singapore Airlines": { code: "SQ", aliases: ["singapore airlines"] },
  "Scoot": { code: "TR", aliases: ["scoot"] },
  "Cathay Pacific": { code: "CX", aliases: ["cathay pacific"] },
  "Malaysia Airlines": { code: "MH", aliases: ["malaysia airlines"] },
  "AirAsia": { code: "AK", aliases: ["airasia berhad", "air asia", "airasia"] },
  "Batik Air": { code: "OD", aliases: ["batik air"] },
  "Thai Airways": { code: "TG", aliases: ["thai airways international", "thai airways"] },
  "Vietnam Airlines": { code: "VN", aliases: ["vietnam airlines"] },
  "Philippine Airlines": { code: "PR", aliases: ["philippine airlines", "phillippine airline", "philippine airline"] },
  "Cebu Pacific": { code: "5J", aliases: ["cebu pacific"] },
  "SriLankan Airlines": { code: "UL", aliases: ["srilankan airlines", "sri lankan airlines"] },
  "Japan Airlines": { code: "JL", aliases: ["japan airlines"] },
  "China Eastern": { code: "MU", aliases: ["china eastern airlines", "china eastern"] },
  "China Southern": { code: "CZ", aliases: ["china southern airlines", "chinasouthern", "china southern"] },
  "Shenzhen Airlines": { code: "ZH", aliases: ["shenzhen airlines"] },
  "Air Astana": { code: "KC", aliases: ["air astana"] },
  "Jetstar": { code: "JQ", aliases: ["jetstar airways", "jetstar", "jet star"] },
  "Virgin Australia": { code: "VA", aliases: ["virgin australia", "v australia"] },
  // Defunct since 2007 — kept so the one prod row is shown as typed, not "Unknown".
  "Air Sahara": { aliases: ["air sahara"] },
};

const norm = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// [alias tokens, canonical] longest first, so "air india express" beats "air india".
const ALIASES: { tokens: string[]; name: string }[] = Object.entries(CARRIERS)
  .flatMap(([name, c]) => c.aliases.map((a) => ({ tokens: a.split(" "), name })))
  .sort((a, b) => b.tokens.join(" ").length - a.tokens.join(" ").length);

const BY_CODE = new Map(
  Object.entries(CARRIERS).filter(([, c]) => c.code).map(([name, c]) => [c.code!.toUpperCase(), name]),
);

// Single-token aliases that are only codes ("6e", "ix", "qp"): accepted only
// when the whole text is that code, never as a word inside longer text.
const CODE_ONLY = new Set(["6e", "ix", "qp"]);

/** Canonical carriers named in the text, in order of appearance, deduped. */
export function carriersInText(raw: unknown): string[] {
  const tokens = norm(raw).split(" ").filter(Boolean);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let hit: { len: number; name: string } | null = null;
    for (const a of ALIASES) {
      const n = a.tokens.length;
      if (n === 1 && CODE_ONLY.has(a.tokens[0]) && tokens.length !== 1) continue;
      if (tokens.slice(i, i + n).join(" ") === a.tokens.join(" ")) { hit = { len: n, name: a.name }; break; }
    }
    if (hit) {
      if (!out.includes(hit.name)) out.push(hit.name);
      i += hit.len;
    } else {
      i += 1;
    }
  }
  return out;
}

/** Carrier from a flight number's IATA prefix: "6E-5217", "AI 302", "EK328". */
export function carrierFromFlightNo(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toUpperCase();
  const m = s.match(/^([A-Z0-9]{2})[\s-]*\d{1,4}[A-Z]?\b/);
  if (!m || /^\d{2}$/.test(m[1])) return null;
  return BY_CODE.get(m[1]) ?? null;
}

/** Carriers for one airline text, falling back to the flight number. */
export function splitCarriers(airline: unknown, flightNo?: unknown): string[] {
  const named = carriersInText(airline);
  if (named.length) return named;
  const byNo = carrierFromFlightNo(flightNo) ?? carrierFromFlightNo(airline);
  return byNo ? [byNo] : [];
}

export type CarrierShare = { name: string; share: number };

/**
 * How one flight booking divides across carriers — shares sum to 1, so the
 * Airline share panel's count and spend add up to 100% of bookings.
 *   - With legs: each leg weighs 1/legs and goes to its leg's carrier(s)
 *     (a leg typed with two airlines splits its weight equally).
 *   - Without legs: the flat airline text, split equally across the carriers
 *     it names ("Air India & Indigo" → ½ each).
 *   - Nothing recognisable → one share of 1 for "Unknown".
 */
export function carrierShares(input: {
  airline?: unknown;
  flightNo?: unknown;
  legs?: { airline?: unknown; flightNo?: unknown }[] | null;
}): CarrierShare[] {
  const acc = new Map<string, number>();
  const add = (name: string, w: number) => acc.set(name, (acc.get(name) ?? 0) + w);
  const legs = Array.isArray(input.legs) ? input.legs : [];
  if (legs.length) {
    const w = 1 / legs.length;
    for (const l of legs) {
      let names = splitCarriers(l.airline, l.flightNo);
      if (!names.length) names = splitCarriers(input.airline, input.flightNo);
      if (!names.length) names = [UNKNOWN_CARRIER];
      for (const n of names) add(n, w / names.length);
    }
  } else {
    const names = splitCarriers(input.airline, input.flightNo);
    if (!names.length) add(UNKNOWN_CARRIER, 1);
    for (const n of names) add(n, 1 / names.length);
  }
  return [...acc.entries()].map(([name, share]) => ({ name, share: Math.round(share * 1e6) / 1e6 }));
}
