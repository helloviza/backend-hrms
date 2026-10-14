// apps/backend/src/services/voucherDates.ts
//
// Date reading for EXTRACTED vouchers (voucherAdapter → shared templates).
//
// Vouchers print dates the way the supplier laid them out, which is often
// without a year ("OCT 15", "Thu, Aug 20") or with a two-digit one
// ("10/09/26"). The adapter used to hand anything it didn't recognise to
// `new Date(s)`, and V8 fills a missing year with 2001 — so a 2026 stay was
// rendered as 2001, every weekday came out wrong, and a flight e-ticket
// printed "MON, 15 OCT, 2001".
//
// Rules here:
//   - Never ask the JS engine to guess a year. A string with no 4-digit year
//     is read into day/month only, and the year is inferred from an anchor:
//     the voucher's booking date when it carries a year, else the upload time
//     of the record. The first occurrence on/after (anchor − 7 days) wins.
//   - Every Date returned is UTC midnight of the calendar day. Callers format
//     from the UTC fields only, so the server/browser timezone never shifts a
//     day.
//   - Anything a person should double-check is pushed to `warnings` as one
//     plain sentence for ops. Nothing here throws or blocks a render.

import { leadingCount } from "@plumtrips/shared/voucher-templates/counts";

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
  nov: 10, november: 10, dec: 11, december: 11,
};

const WEEKDAY_RE =
  /\b(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b\.?/i;
const WEEKDAY_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const DAY_MS = 86_400_000;

/** What a single date string says, before any year is inferred. */
export interface DateParts {
  /** Full year when the string carried one (4-digit, or a 2-digit year read as 20YY). */
  y: number | null;
  /** 0-based month. */
  m: number;
  d: number;
  /** Weekday the source printed, if any (0 = Sunday). */
  weekday: number | null;
  /** Set for "DD/MM/YY": the two numeric parts as written, for an MM/DD retry. */
  twoDigitYear?: { first: number; second: number };
}

export interface DateContext {
  /** Year anchor: booking date when it carries a year, else the record's createdAt. */
  anchor: Date;
  /** True when the anchor is the upload time rather than a date printed on the voucher. */
  anchorIsUpload: boolean;
  warnings: string[];
}

export function utcDate(y: number, m: number, d: number): Date | null {
  const dt = new Date(Date.UTC(y, m, d));
  if (isNaN(dt.getTime())) return null;
  // Reject rollovers such as 31 Feb → 3 Mar.
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return null;
  return dt;
}

/** "15 Oct 2026" — used in warning text. */
export function fmtDay(d: Date): string {
  return `${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Date-only `YYYY-MM-DD` from the UTC fields. */
export function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * Read day / month / (year) / (weekday) out of a free-form voucher date.
 * Returns null when no day + month can be found. Never guesses a year.
 */
export function parseDateParts(input?: string | null): DateParts | null {
  let s = String(input ?? "").trim();
  if (!s) return null;

  let weekday: number | null = null;
  const wd = s.match(WEEKDAY_RE);
  if (wd) {
    weekday = WEEKDAY_INDEX[wd[1].slice(0, 3).toLowerCase()];
    s = (s.slice(0, wd.index) + " " + s.slice((wd.index ?? 0) + wd[0].length)).trim();
  }

  // ISO yyyy-mm-dd (a time part, if any, is ignored here)
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { y: +m[1], m: +m[2] - 1, d: +m[3], weekday };

  // Numeric, day-first: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, and DD/MM/YY
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4}|\d{2})(?!\d)/);
  if (m) {
    const first = +m[1];
    const second = +m[2];
    if (m[3].length === 4) return { y: +m[3], m: second - 1, d: first, weekday };
    return { y: 2000 + +m[3], m: second - 1, d: first, weekday, twoDigitYear: { first, second } };
  }

  // Textual: a month word, a 1–2 digit day, optionally a year. A time of day
  // goes first, or "25 Dec, 11:59 PM" reads its hour as the year 2011.
  const tokens = s
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?|\b\d{1,2}\s*[ap]\.?m\.?(?![a-z])/gi, " ")
    .toLowerCase()
    .replace(/(\d)(st|nd|rd|th)\b/g, "$1")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let month: number | null = null;
  let day: number | null = null;
  let year: number | null = null;
  for (const t of tokens) {
    if (month === null && MONTHS[t] !== undefined) {
      month = MONTHS[t];
    } else if (/^\d{4}$/.test(t) && year === null) {
      year = +t;
    } else if (/^\d{1,2}$/.test(t)) {
      if (day === null) day = +t;
      else if (year === null && month !== null) year = 2000 + +t; // "15 Oct 26"
    }
  }
  if (month !== null && day !== null) return { y: year, m: month, d: day, weekday };

  // Anything else with an explicit 4-digit year: let the engine read it, but
  // take only its calendar fields. Strings without a year never reach here.
  if (/\b(19|20)\d{2}\b/.test(s)) {
    const dt = new Date(s);
    if (!isNaN(dt.getTime())) {
      return { y: dt.getFullYear(), m: dt.getMonth(), d: dt.getDate(), weekday };
    }
  }
  return null;
}

/**
 * The anchor a missing year is inferred from: the voucher's own booking date
 * when it carries a year, otherwise the record's upload time.
 */
export function buildDateContext(
  bookingDate: string | null | undefined,
  createdAt: Date | string | null | undefined,
  warnings: string[] = [],
): DateContext {
  const bd = parseDateParts(bookingDate);
  if (bd && bd.y !== null) {
    const a = utcDate(bd.y, bd.m, bd.d);
    if (a) return { anchor: a, anchorIsUpload: false, warnings };
  }
  const c = createdAt ? new Date(createdAt) : new Date();
  const base = isNaN(c.getTime()) ? new Date() : c;
  return {
    anchor: new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate())),
    anchorIsUpload: true,
    warnings,
  };
}

/** Year for a day/month with no year: first occurrence on/after (anchor − 7 days). */
function inferYear(m: number, d: number, anchor: Date): Date | null {
  const floor = anchor.getTime() - 7 * DAY_MS;
  const y0 = anchor.getUTCFullYear();
  for (const y of [y0 - 1, y0, y0 + 1, y0 + 2]) {
    const dt = utcDate(y, m, d);
    if (dt && dt.getTime() >= floor) return dt;
  }
  return null;
}

function checkWeekday(parts: DateParts, dt: Date, label: string, raw: string, ctx: DateContext): void {
  if (parts.weekday === null) return;
  if (dt.getUTCDay() !== parts.weekday) {
    ctx.warnings.push(
      `${label} "${raw}" says ${WEEKDAY_NAMES[parts.weekday]}, but ${fmtDay(dt)} is a ${WEEKDAY_NAMES[dt.getUTCDay()]} — check the date.`,
    );
  }
}

export interface ResolveOptions {
  /** Shown in warnings, e.g. "Check-in date". */
  label: string;
  /** A date this one cannot precede (e.g. check-in for a check-out). A
   *  year-less date that lands before it rolls forward a year. */
  notBefore?: Date | null;
}

/**
 * Resolve one voucher date to a UTC-midnight Date (or null), inferring a
 * missing year from the context anchor. Year inference is silent when the
 * anchor is a date printed on the voucher, and flagged when it is only the
 * upload time.
 */
export function resolveVoucherDate(
  input: string | null | undefined,
  ctx: DateContext,
  opts: ResolveOptions,
): Date | null {
  const raw = blankish(input);
  const parts = parseDateParts(raw);
  if (!parts) {
    if (raw) ctx.warnings.push(`${opts.label} "${raw}" could not be read — it is left blank on the voucher.`);
    return null;
  }

  let dt: Date | null;
  if (parts.y !== null) {
    dt = utcDate(parts.y, parts.m, parts.d);
  } else {
    dt = inferYear(parts.m, parts.d, ctx.anchor);
    if (dt && opts.notBefore && dt.getTime() < opts.notBefore.getTime()) {
      dt = utcDate(dt.getUTCFullYear() + 1, parts.m, parts.d);
    }
    // An upload-date anchor is a weaker guess than a printed booking date —
    // unless the source's own weekday confirms the year we landed on.
    if (dt && ctx.anchorIsUpload && parts.weekday !== dt.getUTCDay()) {
      ctx.warnings.push(
        `${opts.label} "${raw}" has no year and the voucher shows no booking date — read as ${fmtDay(dt)} from the upload date.`,
      );
    }
  }
  if (!dt) {
    ctx.warnings.push(`${opts.label} "${raw}" is not a real calendar date — it is left blank on the voucher.`);
    return null;
  }

  checkWeekday(parts, dt, opts.label, raw, ctx);
  return dt;
}

/** Placeholder strings older extractions stored instead of null. */
function blankish(input: string | null | undefined): string {
  const s = String(input ?? "").trim();
  return /^(null|undefined|n\/?a|none|-+)$/i.test(s) ? "" : s;
}

const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY_MS);

/**
 * Check-in / check-out for a hotel stay. Adds the night-count cross-check and
 * the DD/MM/YY ↔ MM/DD/YY retry on top of resolveVoucherDate.
 */
export function resolveStayDates(
  checkInRaw: string | null | undefined,
  checkOutRaw: string | null | undefined,
  totalNights: string | number | null | undefined,
  ctx: DateContext,
): { checkIn: Date | null; checkOut: Date | null } {
  // "1 night" / "3 Nights" / 3 → the stated count (leadingCount); "one night" → none.
  const stated = leadingCount(totalNights);
  const nights = stated ?? NaN;
  const hasNights = stated !== null;

  const ciParts = parseDateParts(checkInRaw);
  const coParts = parseDateParts(checkOutRaw);

  // Two-digit-year numeric dates are written day-first in India, but some
  // suppliers write MM/DD/YY. Read day-first; if the night count disagrees and
  // the month-first reading fits it, use that. Either way, tell ops.
  const ambiguous = (p: DateParts | null) =>
    !!p?.twoDigitYear && p.twoDigitYear.first <= 12 && p.twoDigitYear.second <= 12 && p.twoDigitYear.first !== p.twoDigitYear.second;
  if ((ambiguous(ciParts) || ambiguous(coParts)) && ciParts?.twoDigitYear && coParts?.twoDigitYear) {
    const dmy = (p: DateParts) => utcDate(p.y as number, p.m, p.d);
    const mdy = (p: DateParts) => utcDate(p.y as number, p.twoDigitYear!.first - 1, p.twoDigitYear!.second);
    const aIn = dmy(ciParts), aOut = dmy(coParts);
    const bIn = mdy(ciParts), bOut = mdy(coParts);
    const fits = (i: Date | null, o: Date | null) => !!i && !!o && (hasNights ? daysBetween(i, o) === nights : daysBetween(i, o) > 0);
    let checkIn = aIn, checkOut = aOut;
    if (!fits(aIn, aOut) && fits(bIn, bOut)) {
      checkIn = bIn;
      checkOut = bOut;
      ctx.warnings.push(
        `Stay dates "${checkInRaw}" → "${checkOutRaw}" read month-first (${fmtDay(bIn!)} → ${fmtDay(bOut!)}) because the day-first reading does not match ${hasNights ? `${nights} night(s)` : "a forward stay"} — check the dates.`,
      );
    } else if (!fits(aIn, aOut)) {
      ctx.warnings.push(
        `Stay dates "${checkInRaw}" → "${checkOutRaw}" are ambiguous (day-first vs month-first) — printed day-first; check the dates.`,
      );
    }
    for (const [p, dt, label, raw] of [
      [ciParts, checkIn, "Check-in date", checkInRaw],
      [coParts, checkOut, "Check-out date", checkOutRaw],
    ] as const) {
      if (dt) checkWeekday(p, dt, label, String(raw ?? ""), ctx);
    }
    return { checkIn, checkOut };
  }

  const checkIn = resolveVoucherDate(checkInRaw, ctx, { label: "Check-in date" });
  const checkOut = resolveVoucherDate(checkOutRaw, ctx, { label: "Check-out date", notBefore: checkIn });

  if (checkIn && checkOut) {
    const n = daysBetween(checkIn, checkOut);
    if (n <= 0) {
      ctx.warnings.push(`Check-out ${fmtDay(checkOut)} is not after check-in ${fmtDay(checkIn)} — check the dates.`);
    } else if (hasNights && n !== nights) {
      ctx.warnings.push(
        `Voucher says ${nights} night(s), but ${fmtDay(checkIn)} → ${fmtDay(checkOut)} is ${n} — check the dates.`,
      );
    }
  }
  return { checkIn, checkOut };
}
