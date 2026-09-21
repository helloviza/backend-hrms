// apps/backend/src/services/plumconnect/flows/parse.ts
//
// PlumConnect Slice 6 — the deterministic answer parsers every qualification
// flow is built from. NO LLM anywhere on the inbound path (the
// prompt-injection boundary set in arrivalInbound.ts:8-9 and plan §9).
// Every parser: trims, strips control characters, collapses whitespace,
// length-caps (the sanitize pattern at routes/leads.ts:258), and inspects
// nothing else. No answer is ever interpreted as an instruction; an
// instruction-shaped answer is just a (capped) string in a field.
//
// sanitize / parseName / parseDestination / parseDates are the Slice 3c
// parsers moved here VERBATIM from bot.ts (the concierge flow's behaviour is
// pinned by bot.parity.test.ts). parseCount / resolveCountry / parseVisaType
// are new for the plumtrips and helloviza flows and follow the same
// discipline.

import { getCountryByIso2, normaliseToIso2 } from "../../../utils/countryCodes.js";

/** routes/leads.ts:258 — trim + cap — plus control-character stripping and whitespace collapse. */
export function sanitize(v: unknown, max = 200): string {
  return String(v ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** A human name: 2–80 chars after sanitising. Nothing else is inspected. */
export function parseName(text: string): string | null {
  const s = sanitize(text, 80);
  if (s.length < 2) return null;
  // Someone answering "my name is Priya" — take what follows the phrase.
  const m = /^(?:my name is|i am|i'm|this is|it's|its)\s+(.+)$/i.exec(s);
  return (m ? sanitize(m[1], 80) : s) || null;
}

/** A destination: 2–120 chars after sanitising. */
export function parseDestination(text: string): string | null {
  const s = sanitize(text, 120);
  return s.length >= 2 ? s : null;
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

// Longest names first so "sept" is not cut to "sep" + "t".
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const DATE_RE = () =>
  new RegExp(
    String.raw`(\d{4})-(\d{1,2})-(\d{1,2})` + // 1-3  yyyy-mm-dd
      String.raw`|(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})` + // 4-6  dd/mm/yyyy (day-first)
      String.raw`|(\d{1,2})(?:st|nd|rd|th)?\s+(${MONTH_ALT})\b(?:\s+(\d{4}))?` + // 7-9  12 oct [2026]
      String.raw`|\b(${MONTH_ALT})\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4}))?`, // 10-12 oct 12[, 2026]
    "g",
  );

function utc(y: number, m: number, d: number): Date | null {
  if (m < 0 || m > 11 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m, d));
  return dt.getUTCMonth() === m && dt.getUTCDate() === d ? dt : null;
}

/**
 * Pull up to two dates out of free text, deterministically. Accepts
 * yyyy-mm-dd, dd/mm/yyyy, dd-mm-yyyy (day-first — India), "12 Oct [2026]",
 * "Oct 12[, 2026]". A date with no year gets the next occurrence from `now`.
 * Returns { start, end } (end null when only one date), or null.
 */
export function parseDates(text: string, now: Date = new Date()): { start: Date; end: Date | null } | null {
  const s = sanitize(text, 200).toLowerCase();
  const found: Date[] = [];

  const push = (d: Date | null) => {
    if (d && found.length < 2) found.push(d);
  };
  const withYear = (y: number, m: number, d: number) => push(utc(y < 100 ? 2000 + y : y, m, d));
  const noYear = (m: number, d: number) => {
    let dt = utc(now.getUTCFullYear(), m, d);
    if (dt && dt.getTime() < now.getTime() - 86_400_000) dt = utc(now.getUTCFullYear() + 1, m, d);
    push(dt);
  };

  // Scan left to right so "12 oct to 19 oct" keeps its order. The month
  // slots are the real month names only, so a stray word next to a number
  // ("around 5", "and 12") can never swallow the digits.
  const re = DATE_RE();
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) && found.length < 2) {
    if (m[1]) withYear(+m[1], +m[2] - 1, +m[3]);
    else if (m[4]) withYear(+m[6], +m[5] - 1, +m[4]);
    else if (m[7]) m[9] ? withYear(+m[9], MONTHS[m[8]], +m[7]) : noYear(MONTHS[m[8]], +m[7]);
    else if (m[10]) m[12] ? withYear(+m[12], MONTHS[m[10]], +m[11]) : noYear(MONTHS[m[10]], +m[11]);
  }

  if (found.length === 0) return null;
  if (found.length === 2 && found[1].getTime() < found[0].getTime()) found.reverse();
  return { start: found[0], end: found[1] ?? null };
}

/* ───────────────────────────── Slice 6 — new parsers ───────────────────────────── */

/** A company name: 2–120 chars after sanitising; a leading "we are …" style phrase is dropped. */
export function parseCompany(text: string): string | null {
  const s = sanitize(text, 120);
  if (s.length < 2) return null;
  const m = /^(?:we are|we're|i work at|i work for|i am from|i'm from|from|company is|company name is|our company is|it's|its)\s+(.+)$/i.exec(s);
  return (m ? sanitize(m[1], 120) : s) || null;
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100, thousand: 1000,
};
const COUNT_MAX = 10_000_000;

/**
 * The first whole number in free text: "50", "about 50 people", "1,200",
 * "5k", "50-60" (→ 50), or a small number word ("twenty"). Bounded to
 * 0…10,000,000. Nothing else in the text is read. Null when no number.
 */
export function parseCount(text: string): number | null {
  const s = sanitize(text, 200).toLowerCase();
  const digits = /(\d[\d,]*)\s*(k)?\b/.exec(s);
  if (digits) {
    const n = Number(digits[1].replace(/,/g, "")) * (digits[2] ? 1000 : 1);
    return Number.isFinite(n) && n >= 0 && n <= COUNT_MAX ? Math.round(n) : null;
  }
  for (const word of s.split(" ")) {
    if (word in NUMBER_WORDS) return NUMBER_WORDS[word];
  }
  return null;
}

/**
 * A country in free text → ISO-2 through utils/countryCodes.ts (the same
 * resolver lineage as TravelBooking.destinationCountry). Tries the whole
 * answer, then the answer with a leading "to / for / visa for / going to"
 * dropped, then every 1–3 word window left to right. Table lookup only.
 */
export function resolveCountry(text: string): { iso2: string; name: string } | null {
  const s = sanitize(text, 120);
  if (!s) return null;
  const stripped = s.replace(/^(?:a |an |the )?(?:visa (?:for|to) |going to |travelling to |traveling to |to |for )/i, "");
  const words = stripped.replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter(Boolean);
  const candidates: string[] = [s, stripped];
  for (let size = 3; size >= 1; size -= 1) {
    for (let i = 0; i + size <= words.length; i += 1) candidates.push(words.slice(i, i + size).join(" "));
  }
  for (const c of candidates) {
    const iso2 = normaliseToIso2(c);
    if (iso2) return { iso2, name: getCountryByIso2(iso2)?.name ?? iso2 };
  }
  return null;
}

/** The visa categories the helloviza desk works with; matched by keyword, in this order. */
export const VISA_TYPES: ReadonlyArray<{ label: string; terms: readonly string[] }> = [
  { label: "Transit", terms: ["transit", "layover"] },
  { label: "Student", terms: ["student", "study", "studies", "university", "college"] },
  { label: "Work", terms: ["work", "employment", "job", "work permit"] },
  { label: "Medical", terms: ["medical", "treatment", "hospital"] },
  { label: "Business", terms: ["business", "conference", "meeting", "exhibition"] },
  { label: "Family", terms: ["family", "dependent", "dependant", "spouse", "relative", "relatives"] },
  { label: "Tourist", terms: ["tourist", "tourism", "visit", "visitor", "holiday", "vacation", "travel", "trip", "leisure"] },
];

/** A visa type: the first category whose keyword appears (word-bounded). Null = ask again. */
export function parseVisaType(text: string): string | null {
  const s = sanitize(text, 200).toLowerCase();
  if (!s) return null;
  for (const { label, terms } of VISA_TYPES) {
    for (const term of terms) {
      if (new RegExp(`(^|[^a-z])${term}([^a-z]|$)`).test(s)) return label;
    }
  }
  return null;
}
