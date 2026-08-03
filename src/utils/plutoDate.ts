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
