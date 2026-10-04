// apps/backend/src/utils/dateRange.ts
//
// The list endpoints' date filter (My Requests, approver inbox, Admin Queue,
// Booking History): ?from=YYYY-MM-DD&to=YYYY-MM-DD&by=submitted|travel.
// The browser resolves presets ("This week", …) to from/to; the server only
// validates and applies them. Both days are inclusive and are IST calendar
// days (Asia/Kolkata, UTC+05:30, no DST):
//   by=submitted — createdAt in [from 00:00 IST, to+1 00:00 IST)
//   by=travel    — the request's EARLIEST travel date across its items (a
//                  stored calendar date, compared as YYYY-MM-DD); a request
//                  with no travel date never matches.
// The clause only ever narrows a query — callers $and it with their own
// scope, so who can see what is unchanged.

type AnyObj = Record<string, any>;

export type DateBy = "submitted" | "travel";
export type DateRange = { from: string; to: string; by: DateBy };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN_DAYS = 366;

function isRealDay(s: string) {
  if (!DAY.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const dayNumber = (s: string) => Math.round(new Date(`${s}T00:00:00Z`).getTime() / 86400000);

/** 00:00 IST of an IST calendar day, as a UTC instant. */
export function istDayStart(day: string): Date {
  return new Date(`${day}T00:00:00+05:30`);
}

export function addDays(day: string, n: number): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
}

export class DateRangeError extends Error {
  status = 400;
  code = "BAD_DATE_RANGE";
}

/**
 * Reads from/to/by off a query. No from and no to → null (no filter).
 * Anything malformed throws DateRangeError (→ 400).
 */
export function parseDateRange(q: AnyObj | undefined): DateRange | null {
  const from = String(q?.from ?? "").trim();
  const to = String(q?.to ?? "").trim();
  const byRaw = String(q?.by ?? "").trim().toLowerCase();
  if (!from && !to) {
    if (byRaw && byRaw !== "submitted" && byRaw !== "travel") throw new DateRangeError("by must be submitted or travel");
    return null;
  }
  if (!from || !to) throw new DateRangeError("Both from and to are required (YYYY-MM-DD).");
  if (!isRealDay(from) || !isRealDay(to)) throw new DateRangeError("Dates must be real days in YYYY-MM-DD form.");
  if (from > to) throw new DateRangeError("from must be on or before to.");
  if (dayNumber(to) - dayNumber(from) + 1 > MAX_SPAN_DAYS) throw new DateRangeError("The range can be at most one year.");
  if (byRaw && byRaw !== "submitted" && byRaw !== "travel") throw new DateRangeError("by must be submitted or travel");
  return { from, to, by: byRaw === "travel" ? "travel" : "submitted" };
}

/* ───────────────────────── travel date ───────────────────────── */

/** The fields that carry an item's start day, in order (first one set wins). */
const ITEM_DATE_PATHS = ["departDate", "checkIn", "travelDate", "startDate", "pickupDate"];

const dayOf = (v: any) => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  const s = String(v ?? "").trim().slice(0, 10);
  return isRealDay(s) ? s : "";
};

/** Earliest travel day across a request's items ("" when none) — the JS twin of travelDateExpr. */
export function travelDateOf(r: AnyObj): string {
  const days: string[] = [];
  for (const it of Array.isArray(r?.cartItems) ? r.cartItems : []) {
    const m = it?.meta || {};
    const first = [...ITEM_DATE_PATHS.map((k) => m[k]), Array.isArray(m.legs) ? m.legs[0]?.date : undefined].map(dayOf).find(Boolean);
    if (first) days.push(first);
  }
  return days.sort()[0] || "";
}

/** One value as "YYYY-MM-DD" or null (Dates become their UTC day, junk becomes null). */
const dayExpr = (input: any) => ({
  $let: {
    vars: { s: { $substrCP: [{ $convert: { input, to: "string", onError: "", onNull: "" } }, 0, 10] } },
    in: { $cond: [{ $regexMatch: { input: "$$s", regex: /^\d{4}-\d{2}-\d{2}$/ } }, "$$s", null] },
  },
});

/** Aggregation expression: the request's earliest item travel day, or null. */
export const travelDateExpr = {
  $min: {
    $map: {
      input: { $ifNull: ["$cartItems", []] },
      as: "i",
      // First set field wins; nested two-argument $ifNull (works on MongoDB < 5).
      in: [...ITEM_DATE_PATHS.map((k) => dayExpr(`$$i.meta.${k}`)), dayExpr({ $arrayElemAt: [{ $ifNull: ["$$i.meta.legs.date", []] }, 0] })].reduceRight(
        (rest: any, e: any) => ({ $ifNull: [e, rest] }),
        null as any,
      ),
    },
  },
};

/** Mongo filter for a range (to $and with the caller's own filter + scope). */
export function dateRangeClause(r: DateRange): AnyObj {
  if (r.by === "travel") {
    return {
      $expr: {
        $let: {
          vars: { d: travelDateExpr },
          in: { $and: [{ $ne: ["$$d", null] }, { $gte: ["$$d", r.from] }, { $lte: ["$$d", r.to] }] },
        },
      },
    };
  }
  return { createdAt: { $gte: istDayStart(r.from), $lt: istDayStart(addDays(r.to, 1)) } };
}

/** filter AND the range (unchanged when no range). */
export function withDateRange<T extends AnyObj>(filter: T, r: DateRange | null): AnyObj {
  return r ? { $and: [filter, dateRangeClause(r)] } : filter;
}

/** Route helper: the parsed range, null for no filter, or false once it has sent the 400. */
export function dateRangeOr400(req: AnyObj, res: AnyObj): DateRange | null | false {
  try {
    return parseDateRange(req.query);
  } catch (e) {
    if (e instanceof DateRangeError) {
      res.status(400).json({ ok: false, error: e.message, code: e.code });
      return false;
    }
    throw e;
  }
}
