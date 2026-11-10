// Destination switch (state v2 S3, design §2.2 rules 5 / 5u, §3.5, §3.5b).
// PURE — no I/O. The route resolves the catalogue (hotel codes) itself.
//
//   detectSwitchIntent   pivot cue or trip action + the places named, unless an
//                        add-on connector says it is a second leg ("and then
//                        London", "via Dubai")
//   resolvePlaceSync     "London Soho" → London + sub-area "Soho" (curated table,
//                        then the airport table; never a guess)
//   parseUndoAnswer      "Keep Dubai instead" / "go back to Dubai" / "undo"
//   parseSameDatesAnswer the answer to "same dates?"
import { stripFiller } from "./plutoTripEdit.js";
import { lookupDestination } from "../data/destinationLookup.js";
import { resolveIATA } from "./plutoIata.js";
import { properCityName } from "./plutoPlaces.js";

export type TripAction = "hotel" | "flight" | "trip";

const PIVOT_CUE_RX =
  /\b(?:instead|actually|rather|switch(?:ing)?\s+to|change\s+(?:it\s+|that\s+)?to|what\s+about|how\s+about|let'?s\s+(?:do|try|go\s+(?:to|with)|make\s+it))\b/i;

const FLIGHT_RX = /\b(?:flights?|fly|flying)\b/i;
const HOTEL_RX = /\b(?:stays?|hotels?|accommodations?|accomodations?|resorts?|lodging)\b/i;
// "holiday" / "vacation" as the NOUN naming the trip — never an inferred purpose.
const TRIP_RX = /\b(?:trip|visit|visiting|plan|planning|itinerary|holiday|vacation|getaway)\b/i;

/** Any of these means a second leg or a transit, never a switch (§3.5b 3). */
const ADD_ON_RX =
  /\b(?:and\s+then|then|after\s+that|afterwards|followed\s+by|via|through|stop\s*-?\s*over|layover|connecting|transit|on\s+the\s+way|plus|also|add|as\s+well)\b|\+|→[^→]*→/i;

/** Words that end a place phrase (or are never one). */
const STOP = new Set([
  "instead", "same", "dates", "date", "days", "day", "time", "times", "for", "on", "from", "with",
  "please", "pls", "and", "then", "next", "this", "that", "these", "those", "a", "an", "too", "also", "now",
  "trip", "stay", "stays", "hotel", "hotels", "flight", "flights", "nights", "night", "week", "weekend",
  "month", "tomorrow", "today", "tonight", "there", "here", "it", "me", "us", "my", "our", "your", "rather",
  "ok", "okay", "thanks", "near", "around", "close", "by", "in", "to", "at", "of", "about", "as", "well",
  "under", "budget", "cheap", "cheaper", "luxury", "business", "executive", "premium", "economy", "class",
  "only", "please", "again", "first", "is", "are", "be", "was", "do", "go", "try", "visit", "nice", "good",
  "best", "the", "some", "any", "all", "more", "less", "one", "two", "three", "few", "lets", "let's",
  "november", "december", "january", "february", "march", "april", "june", "july", "august", "september",
  "october", "nov", "dec", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
]);

export function hasPivotCue(prompt: string): boolean {
  return PIVOT_CUE_RX.test(prompt);
}

export function tripActionOf(prompt: string): TripAction | null {
  if (FLIGHT_RX.test(prompt)) return "flight";
  if (HOTEL_RX.test(prompt)) return "hotel";
  if (TRIP_RX.test(prompt)) return "trip";
  return null;
}

export function hasAddOnConnector(prompt: string): boolean {
  return ADD_ON_RX.test(prompt);
}

export function saysSameDates(prompt: string): boolean {
  return /\bsame\s+(?:dates?|time|days|nights|duration|stay)\b/i.test(prompt);
}

/** The words of a place phrase, cut at the first stop word. */
function placeWords(raw: string): string[] {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  // "Keep Dubai instead" (an undo that has expired) still names Dubai.
  while (words[0] && /^(?:the|keep|stick|go|back|switch)$/i.test(words[0])) words.shift();
  const out: string[] = [];
  for (const w of words) {
    const clean = w.replace(/[^A-Za-z'-]/g, "");
    if (!clean || STOP.has(clean.toLowerCase())) break;
    out.push(clean);
    if (out.length === 3) break;
  }
  return out;
}

/**
 * Candidate place phrases in the order they appear: after "in / to / at /
 * for / visit / about …", after a pivot cue ("actually Singapore", "let's do
 * Singapore") and before "instead". A phrase after "from" (the origin) or
 * after "near / around / close to" (a landmark in the trip's city) is never a
 * candidate.
 */
export function extractPlacePhrases(prompt: string): string[] {
  const text = stripFiller(prompt);
  const found: Array<{ at: number; words: string[] }> = [];
  const push = (at: number, raw: string) => {
    const w = placeWords(raw);
    if (w.length) found.push({ at, words: w });
  };
  const prep = /\b(in|to|at|for|visit(?:ing)?|about|of|with|do|try)\s+([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,4})/gi;
  for (const m of text.matchAll(prep)) {
    const before = text.slice(0, m.index ?? 0);
    if (/\b(?:close|next|walking\s+distance)\s*$/i.test(before)) continue; // "close to X" is a landmark
    if (m[1].toLowerCase() === "to" && /\b(?:want|need|like|have|going|how|what)\s*$/i.test(before)) {
      // "want to visit X" — the verb after "to" is matched by its own rule.
      continue;
    }
    push(m.index ?? 0, m[2]);
  }
  const cue = /\b(?:actually|instead|rather|switch(?:ing)?\s+to|change\s+(?:it\s+|that\s+)?to|what\s+about|how\s+about|let'?s\s+(?:do|try|go\s+(?:to|with)|make\s+it))[\s,]+(?:let'?s\s+(?:do|try|go\s+(?:to|with))\s+)?([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*){0,4})/gi;
  for (const m of text.matchAll(cue)) push(m.index ?? 0, m[1]);
  const trailing = /\b([A-Za-z][A-Za-z'-]*(?:\s+[A-Za-z][A-Za-z'-]*)?)\s+instead\b/gi;
  for (const m of text.matchAll(trailing)) push(m.index ?? 0, m[1]);
  return found
    .sort((a, b) => a.at - b.at)
    .map((f) => f.words.join(" "))
    .filter((p, i, arr) => arr.findIndex((o) => o.toLowerCase() === p.toLowerCase()) === i);
}

export interface SyncPlace {
  city: string;
  iata: string | null;
  /** The words after the city ("Soho" in "London Soho"): a sub-area. */
  rest?: string;
}

/**
 * The city a phrase names, by its longest leading part: the curated table,
 * else a real airport for the name (a 3-letter word only when it maps to a
 * DIFFERENT code — "Goa" → GOI, never "now" → NOW). null when nothing does.
 */
export function resolvePlaceSync(phrase: string): SyncPlace | null {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  for (let k = words.length; k >= 1; k--) {
    const key = words.slice(0, k).join(" ");
    if (STOP.has(key.toLowerCase())) continue;
    const rest = words.slice(k).join(" ") || undefined;
    const curated = lookupDestination(key);
    if (curated?.city) {
      return { city: curated.city, iata: resolveIATA(curated.city), ...(rest ? { rest } : {}) };
    }
    if (curated) continue; // a country / region entry is not a city
    const code = resolveIATA(key);
    if (code && code !== key.toUpperCase()) {
      return { city: properCityName(key), iata: code, ...(rest ? { rest } : {}) };
    }
  }
  return null;
}

/** Compare city names loosely ("Goa, India" = "goa"). */
export function sameCity(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (s: string | null | undefined) => String(s || "").split(",")[0].trim().toLowerCase();
  return Boolean(n(a)) && n(a) === n(b);
}

export interface SwitchIntent {
  cue: boolean;
  action: TripAction | null;
  phrases: string[];
}

/**
 * Is this turn possibly a destination switch? Needs a locked destination, a
 * pivot cue OR a trip action, no add-on connector, and at least one place
 * phrase. The route resolves the phrases and decides.
 */
export function detectSwitchIntent(prompt: string, lockedDestination: string | null | undefined): SwitchIntent | null {
  if (!lockedDestination) return null;
  const text = stripFiller(prompt);
  if (!text || hasAddOnConnector(text)) return null;
  const cue = hasPivotCue(text);
  const action = tripActionOf(text);
  if (!cue && !action) return null;
  const phrases = extractPlacePhrases(text);
  if (!phrases.length) return null;
  return { cue, action, phrases };
}

/** "Keep Dubai instead", "go back to Dubai", "stick with Dubai", "undo". */
export function parseUndoAnswer(prompt: string, oldName: string): boolean {
  const t = stripFiller(prompt).toLowerCase().replace(/[.!?]+$/, "").trim();
  if (/^(?:undo|undo (?:that|it|the switch)|switch back|go back|revert)$/.test(t)) return true;
  const m = t.match(/^(?:no,?\s+)?(?:keep|stay\s+with|stick\s+with|go\s+back\s+to|back\s+to|revert\s+to|switch\s+back\s+to)\s+(.+?)(?:\s+instead)?$/);
  if (!m) return false;
  const what = m[1].replace(/^the\s+/, "").trim();
  return sameCity(what, oldName) || /^(?:it|that|the (?:old|previous|original) (?:one|city|destination))$/.test(what);
}

/** The answer to "same dates?": "same" / "different" / null (not an answer). */
export function parseSameDatesAnswer(prompt: string): "same" | "different" | null {
  const t = stripFiller(prompt).toLowerCase().replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (/^(?:yes|yeah|yep|yup|sure|fine|that'?s fine|same|same dates?|keep (?:the )?(?:same )?dates?|keep them|those dates)$/.test(t)) return "same";
  if (/^(?:no|nope|different|different dates?|other dates?|change (?:the )?dates?|new dates?)$/.test(t)) return "different";
  return null;
}
