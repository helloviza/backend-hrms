// apps/backend/src/utils/flightDesignator.ts
//
// Flight-designator detection for the concierge turn. Mirror of
// apps/frontend/src/pages/concierge/flightDesignator.ts (separate packages, so
// the module is duplicated rather than shared) — keep the two in sync.
//
// The previous pattern — /\b(\d?[A-Z]{1,2})[-\s]?(\d{2,4})\b/gi — was
// case-INSENSITIVE, so ordinary prose matched: "trip in 2026" read as carrier
// "IN" flight 2026. On this side that meant a plain planning prompt got a
// flight-status "[FLIGHT DATA UNAVAILABLE FOR IN2026] … NO-HALLUCINATE" block
// injected into the model prompt, plus a paid FlightAware lookup.
//
// Fix: match case-SENSITIVELY and require a genuine 2-character IATA carrier
// code — letter+letter, letter+digit or digit+letter, never two digits.

/**
 * IATA flight designator: 2-char carrier code + 2-4 digit number, optionally
 * separated by a hyphen or a single space. Case-SENSITIVE by design.
 * Matches: 6E-2582 · 6E 2582 · 6E2582 · AI0865 · UK 995 · 9W123 · I5 754
 */
export const FLIGHT_DESIGNATOR = /\b([A-Z][A-Z0-9]|[0-9][A-Z])[- ]?(\d{2,4})\b/;

/** Words that make a designator a status question rather than an aside. */
export const FLIGHT_STATUS_INTENT =
  /\b(flight|status|delayed?|on\s+time|landed|arriv\w*|depart\w*|track(?:ing)?)\b/i;

/** The whole prompt is a designator and nothing else, e.g. "6E-2582". */
export const BARE_DESIGNATOR = /^\s*(?:[A-Z][A-Z0-9]|[0-9][A-Z])[- ]?\d{2,4}\s*$/;

/**
 * True when the prompt is asking about a specific flight's status.
 * Designator ALONE is not enough — it must carry status intent, or be the
 * entire prompt.
 */
export function isFlightStatusQuery(prompt: string): boolean {
  if (!prompt) return false;
  if (!FLIGHT_DESIGNATOR.test(prompt)) return false;
  return FLIGHT_STATUS_INTENT.test(prompt) || BARE_DESIGNATOR.test(prompt);
}

/**
 * The normalized designator ("6E-2582" → "6E2582") when the prompt is a genuine
 * flight-status query, else null. Normalization matches what
 * flightService.toAeroApiIdent expects before its IATA→ICAO conversion.
 */
export function extractFlightDesignator(prompt: string): string | null {
  if (!isFlightStatusQuery(prompt)) return null;
  const m = prompt.match(FLIGHT_DESIGNATOR);
  if (!m) return null;
  return `${m[1]}${m[2]}`.toUpperCase();
}

/**
 * Date TOKEN in a flight-status prompt ("… AI-4305 on 5 Aug" → "5 Aug"), or
 * null. Deliberately only finds the token — parsing it to ISO is
 * plutoDate.parseDateToISO's job, and there must be exactly one date parser.
 * The token pattern is the same one the flight-search branch uses.
 *
 * The designator is stripped FIRST: a carrier code whose second character is a
 * digit (I5, S5) would otherwise let "I5-754" match the numeric d/m pattern as
 * "5-75" and invent a date out of the flight number.
 */
const DATE_TOKEN =
  /(\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)/i;

export function extractStatusDate(prompt: string): string | null {
  if (!prompt) return null;
  const withoutDesignator = prompt.replace(FLIGHT_DESIGNATOR, " ");
  const m = withoutDesignator.match(DATE_TOKEN);
  return m ? m[0].trim() : null;
}
