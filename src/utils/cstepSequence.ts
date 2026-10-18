// apps/backend/src/utils/cstepSequence.ts
//
// CSTEP running serials — ONE mechanism for every CSTEP reference number,
// on the shared Counter collection with the same findByIdAndUpdate($inc,
// upsert) pattern Invoice/Ticket/CreditNote use.
//
// Series and keys:
//   TIN / LTC / EXP / EVR — 4-digit serial that restarts each financial
//     year (Apr–Mar):  cstep:<workspaceId>:<TIN|LTC|EXP|EVR>:FY<startYear>
//   VENDOR / TALLY — continuous, never reset:  cstep:<workspaceId>:<VENDOR|TALLY>
//     (TALLY numbers Tally journal vouchers. To make it restart each
//     financial year instead, drop it from CONTINUOUS_SERIES below.)
//
// Counter.seq is the LAST number issued, so the next one is seq + 1.
//
// Every date here (financial year, MMYY) is taken in IST (Asia/Kolkata,
// fixed +05:30, no DST) — never server time: the API runs in UTC, where
// 00:00–05:30 IST on the 1st still reads as the previous month.
//
// Transactions: pass the caller's session and the increment commits or
// rolls back with the caller's transaction, so an aborted approve never
// burns a number. Two approvals racing on the same counter (including the
// first-of-year upsert) surface as a write conflict, which
// session.withTransaction retries on its own.

import Counter from "../models/Counter.js";

export const CSTEP_SERIES = ["TIN", "LTC", "EXP", "EVR", "VENDOR", "TALLY"] as const;
export type CstepSeries = (typeof CSTEP_SERIES)[number];

const IST_OFFSET_MS = 330 * 60 * 1000;

/** IST calendar year and month (1–12) of an instant. */
function istYearMonth(at: Date): { year: number; month: number } {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1 };
}

/** Start year of the IST financial year (Apr–Mar) containing `at`:
 * 1 Apr 2026 … 31 Mar 2027 → 2026. */
export function cstepFyStartYear(at: Date = new Date()): number {
  const { year, month } = istYearMonth(at);
  return month >= 4 ? year : year - 1;
}

/** "MMYY" of `at` in IST — e.g. "1026". */
export function cstepMMYY(at: Date = new Date()): string {
  const { year, month } = istYearMonth(at);
  return `${String(month).padStart(2, "0")}${String(year % 100).padStart(2, "0")}`;
}

/** Series that never reset. Every other series restarts each FY. */
const CONTINUOUS_SERIES = new Set<CstepSeries>(["VENDOR", "TALLY"]);

export function isFySeries(series: CstepSeries): boolean {
  return !CONTINUOUS_SERIES.has(series);
}

/** Counter _id for a series. A per-FY series needs the financial year —
 * pass `at` (resolved in IST) or an explicit `fyStartYear`. */
export function cstepSeriesKey(
  workspaceId: any,
  series: CstepSeries,
  opts: { at?: Date; fyStartYear?: number } = {},
): string {
  if (!isFySeries(series)) return `cstep:${String(workspaceId)}:${series}`;
  const fy = opts.fyStartYear ?? cstepFyStartYear(opts.at ?? new Date());
  return `cstep:${String(workspaceId)}:${series}:FY${fy}`;
}

/** Atomically takes the next serial of a series. */
export async function nextCstepSerial(
  workspaceId: any,
  series: CstepSeries,
  opts: { at?: Date; session?: any } = {},
): Promise<{ seq: number; key: string }> {
  const key = cstepSeriesKey(workspaceId, series, { at: opts.at });
  const counter = await Counter.findByIdAndUpdate(
    key,
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session: opts.session },
  );
  return { seq: counter!.seq, key };
}

/** The number the series will issue next (read-only). */
export async function peekCstepSerial(
  workspaceId: any,
  series: CstepSeries,
  opts: { at?: Date; fyStartYear?: number } = {},
): Promise<{ next: number; key: string }> {
  const key = cstepSeriesKey(workspaceId, series, opts);
  const counter: any = await Counter.findById(key).lean();
  return { next: (Number(counter?.seq) || 0) + 1, key };
}

/**
 * Forward-only seed: make the series' NEXT number `startNumber`. A single
 * atomic $max, so it can only ever raise the counter. A start at or below
 * what the series would already issue is refused (and nothing changes),
 * except the exact current next number, which is a no-op success.
 * `prevNext` is what the series would have issued just before this call
 * (read from the same atomic update), so a caller can audit old → new.
 */
export async function seedCstepSerial(
  workspaceId: any,
  series: CstepSeries,
  startNumber: number,
  opts: { at?: Date; fyStartYear?: number } = {},
): Promise<{ ok: boolean; next: number; prevNext: number; key: string }> {
  const key = cstepSeriesKey(workspaceId, series, opts);
  const before: any = await Counter.findByIdAndUpdate(
    key,
    { $max: { seq: startNumber - 1 } },
    { new: false, upsert: true },
  ).lean();
  const prevSeq = Number(before?.seq) || 0;
  const next = Math.max(prevSeq, startNumber - 1) + 1;
  return { ok: next === startNumber, next, prevNext: prevSeq + 1, key };
}

const pad4 = (n: number) => String(n).padStart(4, "0");

/** Tour TIN: "0001/1026" (no prefix). */
export function formatCstepTin(seq: number, mmyy: string): string {
  return `${pad4(seq)}/${mmyy}`;
}

/** Prefixed reference: claims "LTC0001/1026", "EXP0001/1026"; Event
 * Requests "EVR0001/1026" (no separator). */
export function formatCstepClaimReference(prefix: "LTC" | "EXP" | "EVR", seq: number, mmyy: string): string {
  return `${prefix}${pad4(seq)}/${mmyy}`;
}

/** Tally voucher number: the bare serial ("1", "2", …), shared by a paid
 * line's Dr and Cr rows. Change the shape here if Tally needs a prefix. */
export function formatCstepTallyVoucher(seq: number): string {
  return String(seq);
}

/** Vendor code: "CSTEPVEN0001" — continuous, no FY. */
export function formatCstepVendorCode(seq: number): string {
  return `CSTEPVEN${pad4(seq)}`;
}
