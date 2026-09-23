// Parse a YYYY-MM-DD string as an IST calendar day boundary.
// The API contract: any YYYY-MM-DD passed between frontend and backend means
// the corresponding IST (Asia/Kolkata, UTC+05:30) calendar day.
export function parseISTStart(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000+05:30`);
}

export function parseISTEnd(dateStr: string): Date {
  return new Date(`${dateStr}T23:59:59.999+05:30`);
}

/* ── "What day is it?" — the other half of the contract ──────────────────
 *
 * The server runs in UTC; every user is in IST. Between 00:00 and 05:30 IST
 * the two disagree on the calendar date, so anything that asks the process
 * clock for "today" — `new Date().toISOString().slice(0,10)`,
 * `dayjs().format("YYYY-MM-DD")`, `setHours(0,0,0,0)`, `new Date(y, m, d)` —
 * answers with YESTERDAY for an IST user in that window (the attendance
 * punch P0). These helpers are the one canonical way to ask, in the same
 * plain-Date + fixed-offset style as the parsers above. `now` is injectable
 * so tests can stand on either side of midnight.
 *
 * IST has no daylight-saving time, so a fixed +05:30 is exact, and shifting
 * the instant by the offset then reading the UTC date is the IST date.
 */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The IST calendar day ("YYYY-MM-DD") that contains the instant `at`. */
export function istDateString(at: Date | number = Date.now()): string {
  const ms = typeof at === "number" ? at : at.getTime();
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Today's IST calendar day as "YYYY-MM-DD". */
export function todayIST(now: Date | number = Date.now()): string {
  return istDateString(now);
}

/** 00:00:00.000 IST of today, as an instant. */
export function startOfTodayIST(now: Date | number = Date.now()): Date {
  return parseISTStart(todayIST(now));
}

/** 23:59:59.999 IST of today, as an instant. */
export function endOfTodayIST(now: Date | number = Date.now()): Date {
  return parseISTEnd(todayIST(now));
}

/** `dateStr` ± `deltaDays`, as an IST calendar day string (pure date arithmetic, no clock). */
export function addDaysIST(dateStr: string, deltaDays: number): string {
  const d = parseISTStart(dateStr);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return istDateString(d);
}

/* ── Range bounds from a query param ──────────────────────────────────────
 *
 * Report/export filters take dateFrom/dateTo in two shapes: "YYYY-MM-DD"
 * (the date inputs — the API contract above: an IST day) and a full ISO
 * timestamp (dashboards that pre-compute browser-local midnight). Either way
 * the bound means a WHOLE IST calendar day: the day the string names, or the
 * IST day containing the instant. `new Date(x).setHours(0,0,0,0)` did this
 * on the server's UTC day instead, so a filtered day lost its 00:00–05:30
 * IST rows to the day before. Unparseable input → null (no bound), as before.
 */
const YMD = /^\d{4}-\d{2}-\d{2}$/;

function istDayOfParam(raw: unknown): string | null {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  // Round-trip, so an impossible day ("2026-02-31") is refused, not rolled into March.
  if (YMD.test(s)) {
    const start = parseISTStart(s);
    return !isNaN(start.getTime()) && istDateString(start) === s ? s : null;
  }
  const at = new Date(s);
  return isNaN(at.getTime()) ? null : istDateString(at);
}

/** 00:00:00.000 IST of the day a dateFrom param names, or null. */
export function istRangeStart(raw: unknown): Date | null {
  const day = istDayOfParam(raw);
  return day ? parseISTStart(day) : null;
}

/** 23:59:59.999 IST of the day a dateTo param names, or null. */
export function istRangeEnd(raw: unknown): Date | null {
  const day = istDayOfParam(raw);
  return day ? parseISTEnd(day) : null;
}
