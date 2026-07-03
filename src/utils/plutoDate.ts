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
