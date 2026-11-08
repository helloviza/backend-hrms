// apps/backend/src/utils/plutoDate.ts
//
// Natural-language date parsing for the concierge (Pluto) chat flight search.
// Extracted from routes/copilot.travel.ts so the year-resolution logic is
// unit-testable and no longer hardcodes a literal year.

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * resolveFutureYear — when the user gives a day/month with no year, pick the
 * nearest FUTURE occurrence: if that day/month has already passed this year,
 * roll to next year; otherwise use this year (today counts as "not passed").
 *
 * Compared by calendar date only (time-of-day ignored).
 */
function resolveFutureYear(month: string, day: string, now: Date): number {
  const y = now.getFullYear();
  const mo = parseInt(month, 10); // 1-12
  const d = parseInt(day, 10);
  const candidate = new Date(y, mo - 1, d);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return candidate.getTime() < today.getTime() ? y + 1 : y;
}

/**
 * parseDateToISO — convert a natural-language or numeric date to YYYY-MM-DD.
 *
 * Supported inputs (unchanged from the previous inline implementation):
 *  - Already-ISO "YYYY-MM-DD"                → returned as-is
 *  - "12th June 2026" / "June 12 2026" / "12 Jun 26"
 *  - "DD/MM/YYYY" / "DD-MM-YYYY" (Indian standard)
 *
 * The ONLY behavioural change: a word-form date with a MISSING year no longer
 * defaults to a hardcoded "2026" — it resolves to the nearest future year via
 * resolveFutureYear(). Fully-specified dates are untouched.
 *
 * `now` is injectable for deterministic testing; defaults to the current time.
 */
export function parseDateToISO(raw: string | null, now: Date = new Date()): string {
  if (!raw) return "";

  // Already ISO format YYYY-MM-DD — return as-is
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw.trim())) return raw.trim();

  // "12th June 2026" / "June 12 2026" / "12 Jun 26"
  const m = raw.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*(?:\s+(\d{2,4}))?/i)
          || raw.match(/([a-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{2,4}))?/i);
  if (m) {
    // Determine which capture group is day vs month
    const isWordFirst = /^[a-z]/i.test(raw.trim());
    const day   = isWordFirst ? m[2].padStart(2, "0") : m[1].padStart(2, "0");
    const mon   = isWordFirst ? m[1] : m[2];
    const month = MONTHS[mon.toLowerCase().slice(0, 3)] || "01";
    const rawY  = m[3];
    const year  = !rawY
      ? String(resolveFutureYear(month, day, now))
      : rawY.length === 2 ? "20" + rawY : rawY;
    return `${year}-${month}-${day}`;
  }

  // DD/MM/YYYY or DD-MM-YYYY (Indian standard) — only if first segment ≤ 31.
  // Year is always present in this form, so no future-year resolution needed.
  const p = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (p && parseInt(p[1]) <= 31 && parseInt(p[2]) <= 12) {
    const day   = p[1].padStart(2, "0");
    const month = p[2].padStart(2, "0");
    const year  = p[3].length === 2 ? "20" + p[3] : p[3];
    return `${year}-${month}-${day}`;
  }

  return "";
}

/* ───────── Relative dates ("today", "tomorrow", "next week", "this weekend") ─────────
 *
 * Resolved against the IST calendar date (Asia/Kolkata, UTC+5:30, no DST) —
 * the platform's working timezone — never the server's local clock.
 *
 * The rules, stated so the reply can say them back to the user:
 *   today              → today (IST)
 *   tomorrow           → today + 1
 *   day after tomorrow → today + 2
 *   next week          → the Monday of next week (today is a Monday → +7;
 *                        Sunday → tomorrow)
 *   this weekend       → the coming Saturday (today if Saturday; on a Sunday,
 *                        today — the weekend is still on)
 *   next weekend       → the Saturday of next week
 * A relative phrase is a SINGLE departure date; it never invents a return.
 */
export interface RelativeDate {
  /** YYYY-MM-DD */
  iso: string;
  /** "16 Nov 2026" — day-first so parseDateToISO reads it back unchanged. */
  display: string;
  /** The phrase the user typed, lower-case ("next week"). */
  phrase: string;
  /** Plain-English rule, for saying it back ("the Monday of next week"). */
  rule: string;
}

const SHORT_MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WEEKDAYS = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

/** IST calendar date of `now` as a UTC-midnight Date (so arithmetic is DST-free). */
function istToday(now: Date): Date {
  const ist = new Date(now.getTime() + 330 * 60 * 1000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400000);
}

export function resolveRelativeDate(text: string | null | undefined, now: Date = new Date()): RelativeDate | null {
  if (!text) return null;
  const p = String(text).toLowerCase();
  const today = istToday(now);
  const dow = today.getUTCDay(); // 0 = Sunday … 6 = Saturday

  let phrase: string | null = null;
  let date: Date | null = null;
  let rule = "";

  if (/\bday\s+after\s+tomorrow\b/.test(p)) {
    phrase = "day after tomorrow"; date = addDays(today, 2); rule = "two days from today";
  } else if (/\btomorrow\b/.test(p)) {
    phrase = "tomorrow"; date = addDays(today, 1); rule = "tomorrow";
  } else if (/\b(?:today|tonight)\b/.test(p)) {
    phrase = /\btonight\b/.test(p) ? "tonight" : "today"; date = today; rule = "today";
  } else if (/\bnext\s+weekend\b/.test(p)) {
    phrase = "next weekend";
    const toSat = (6 - dow + 7) % 7; // this week's Saturday (0 if today)
    // Mon-start weeks: on a Sunday, "next week" starts tomorrow → its Saturday is +6.
    date = addDays(today, dow === 0 ? 6 : toSat + 7);
    rule = "the Saturday of next week";
  } else if (/\bthis\s+weekend\b|\b(?:on\s+)?the\s+weekend\b/.test(p)) {
    phrase = "this weekend";
    date = dow === 0 ? today : addDays(today, (6 - dow + 7) % 7);
    rule = dow === 0 ? "today (the weekend is still on)" : "the coming Saturday";
  } else if (/\bnext\s+week\b/.test(p)) {
    phrase = "next week";
    const isoDow = dow === 0 ? 7 : dow; // Mon=1 … Sun=7
    date = addDays(today, 8 - isoDow);
    rule = "the Monday of next week";
  }

  if (!phrase || !date) return null;
  const iso = date.toISOString().slice(0, 10);
  const display = `${date.getUTCDate()} ${SHORT_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  return { iso, display, phrase, rule: `${rule} — ${WEEKDAYS[date.getUTCDay()]} ${display}` };
}

/* ───────── Prompt date-range extraction (the "locked facts" parser) ─────────
 *
 * Lifted VERBATIM out of copilot.travel.ts's locked-facts block so the hotel
 * ownership gate and the locker read dates through ONE parser. They used to
 * disagree by construction: the gate ran ~240 lines before the locker, so a
 * first-turn "hotels in Dubai 25th Sept … 26th Sept 2026" was invisible to the
 * gate and the live lane could not fire until the user repeated themselves.
 *
 * Behaviour is deliberately unchanged, including the missing-year rule below —
 * this extraction is not the place to alter what already ships.
 */

const LOOSE_MONTHS = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

/**
 * "25th Sept" / "26th Sept 2026" → YYYY-MM-DD, else null.
 *
 * NOTE (pre-existing, intentionally preserved): a MISSING year resolves to the
 * CURRENT year, not the nearest future one like parseDateToISO does. Changing it
 * here would silently move every already-locked conversation, so it stays as-is;
 * the divergence is tracked separately.
 */
export function parseLooseDate(token: string, now: Date = new Date()): string | null {
  const m = token.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:\s+(\d{4}))?/i);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const monthIdx = LOOSE_MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
  if (monthIdx < 0) return null;
  const year = m[3] ? parseInt(m[3], 10) : now.getFullYear();
  const d = new Date(Date.UTC(year, monthIdx, day));
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * One or two natural-language dates in a free-text prompt.
 *
 * Handles both shapes the locker handled:
 *   - compact, sharing one month: "12-15 Sep", "12 to 15 September"
 *   - two separate tokens:        "25th Sept Check-in and 26th Sept 2026 Checkout"
 *
 * Returns null when no date is found; `end` is null when only one was given.
 * The surrounding words ("Check-in", "Checkout", "and") are irrelevant — tokens
 * are scanned, not parsed as a sentence.
 */
export function extractPromptDateRange(
  prompt: string,
  now: Date = new Date(),
): { start: string; end: string | null } | null {
  if (!prompt) return null;

  const compact = prompt.match(
    /\b(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+(\d{4}))?/i,
  );
  if (compact) {
    const yr = compact[4] ? ` ${compact[4]}` : "";
    const start = parseLooseDate(`${compact[1]} ${compact[3]}${yr}`, now);
    const end = parseLooseDate(`${compact[2]} ${compact[3]}${yr}`, now);
    return start ? { start, end } : null;
  }

  const tokens =
    prompt.match(
      /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{4})?/gi,
    ) || [];
  if (tokens.length === 0) return null;

  const start = parseLooseDate(tokens[0], now);
  if (!start) return null;
  return { start, end: tokens[1] ? parseLooseDate(tokens[1], now) : null };
}
