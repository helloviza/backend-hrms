// apps/backend/src/utils/plutoTripIntent.ts
//
// Pure detectors for the concierge chat flight-search path: multi-city intent
// and round-trip intent. Kept dependency-free so they are unit-testable and can
// be reused by the handler without duplicating regexes.

// Same date grammar the handler uses to pull the outbound date, but global so
// we can find a SECOND (return) date in the prompt.
const DATE_RX =
  /(\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?)/gi;

/**
 * isMultiCityIntent — true when the user asks for more than two stops.
 * Triggered by an explicit "multi city"/"multi-city" phrase, or by two or more
 * "to <City>" hops (e.g. "from Delhi to Mumbai to Goa"). The capitalised-city
 * requirement avoids matching filler like "to be confirmed".
 */
export function isMultiCityIntent(prompt: string): boolean {
  if (/\bmulti[\s-]?city\b/i.test(prompt)) return true;
  const hops = prompt.match(/\bto\s+[A-Z][a-z]+/g) || [];
  return hops.length >= 2;
}

export interface RoundTripResolution {
  wantsRoundTrip: boolean;
  /** Raw return-date string (from a 2nd date in the prompt, or context). */
  returnDateRaw: string | null;
}

/**
 * resolveRoundTripIntent — detect a return trip.
 *
 * wantsRoundTrip is true when the user says "round trip"/"return[ing]" OR a
 * usable return date is present (a second date in the prompt, or a locked
 * context return date). The caller decides:
 *   - wantsRoundTrip && returnDateRaw parses  → JourneyType 2 search
 *   - wantsRoundTrip && no usable return date → ask the user (never silent one-way)
 */
export function resolveRoundTripIntent(
  prompt: string,
  contextReturnDate?: string | null,
): RoundTripResolution {
  const wantsKeyword = /\bround[\s-]?trip\b/i.test(prompt) || /\breturn(ing)?\b/i.test(prompt);
  const dates = prompt.match(DATE_RX) || [];
  const secondDate = dates.length >= 2 ? dates[1] : null;
  const returnDateRaw = secondDate || contextReturnDate || null;
  return {
    wantsRoundTrip: wantsKeyword || Boolean(returnDateRaw),
    returnDateRaw,
  };
}
