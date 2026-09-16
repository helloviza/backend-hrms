// apps/backend/src/services/expenseFx.service.ts
//
// Base-currency conversion for the expense module (FX slice 0, 2026-09-16 —
// fixes audit F-19: every expense total used to be a currency-blind $sum of
// `amount`). ONE place for:
//   • the workspace base currency (config.baseCurrency, "INR" when absent);
//   • freezing a line's conversion at entry (identity → live API → pending);
//   • the manual / finance-correction rate write;
//   • the aggregation expression every $sum now uses instead of "$amount".
//
// Rate lookups reuse utils/exchangeRate.ts — the CSTEP utility — unchanged:
// it is a plain in-process function keyed off env.EXCHANGERATE_API_KEY (back-
// filled from the APP_SECRETS bundle by bootstrap/loadSecrets.ts in the same
// process that serves /cstep/fx-rate), cached per base currency for 6h, and it
// returns null on every failure instead of throwing. A null here is NOT an
// error: the line is saved as conversion-pending and a person supplies the
// rate (see setManualRate). Capture is never blocked by the rates API.

import mongoose from "mongoose";
import CustomerWorkspace from "../models/CustomerWorkspace.js";
import { getLiveRate } from "../utils/exchangeRate.js";

export const DEFAULT_BASE_CURRENCY = "INR";

export type RateSource = "base" | "api" | "manual";

export type FxFields = {
  exchangeRate: number | null;
  rateDate: string | null;
  rateSource: RateSource | null;
  amountBase: number | null;
  baseCurrency: string;
};

export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** "usd " → "USD"; anything that is not a 3-letter code → "". */
export function normalizeCurrency(v: any): string {
  const c = String(v ?? "")
    .trim()
    .toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : "";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The workspace's base currency. Lean reads of workspaces created before the
 * field existed return no `baseCurrency`, so the default is applied HERE (the
 * schema default only fires on hydrated documents) — every pre-slice workspace
 * is INR without a backfill.
 */
export async function getWorkspaceBaseCurrency(
  workspaceId: mongoose.Types.ObjectId | string,
): Promise<string> {
  const ws: any = await CustomerWorkspace.findById(workspaceId).select("config.baseCurrency").lean();
  return normalizeCurrency(ws?.config?.baseCurrency) || DEFAULT_BASE_CURRENCY;
}

/**
 * Freeze a line's conversion at entry.
 *   currency === base → identity (rate 1, "base");
 *   else live lookup  → frozen "api" rate;
 *   else              → conversion pending (amountBase null, rateSource null).
 * Never throws; never blocks a save.
 */
export async function resolveFxAtEntry(params: {
  amount: number;
  currency: string;
  baseCurrency: string;
}): Promise<FxFields> {
  const base = normalizeCurrency(params.baseCurrency) || DEFAULT_BASE_CURRENCY;
  const cur = normalizeCurrency(params.currency) || base;
  const amount = Number(params.amount) || 0;

  if (cur === base) {
    return {
      exchangeRate: 1,
      rateDate: todayIso(),
      rateSource: "base",
      amountBase: round2(amount),
      baseCurrency: base,
    };
  }

  const live = await getLiveRate(cur, base);
  if (live && Number.isFinite(live.rate) && live.rate > 0) {
    return {
      exchangeRate: live.rate,
      rateDate: live.date,
      rateSource: "api",
      amountBase: round2(amount * live.rate),
      baseCurrency: base,
    };
  }

  return { exchangeRate: null, rateDate: null, rateSource: null, amountBase: null, baseCurrency: base };
}

/** Fields for a person-supplied rate (pending resolution or finance correction). */
export function manualFx(params: {
  amount: number;
  exchangeRate: number;
  rateDate?: string | null;
  baseCurrency: string;
}): FxFields {
  const base = normalizeCurrency(params.baseCurrency) || DEFAULT_BASE_CURRENCY;
  const rate = Number(params.exchangeRate);
  return {
    exchangeRate: rate,
    rateDate: params.rateDate && /^\d{4}-\d{2}-\d{2}$/.test(params.rateDate) ? params.rateDate : todayIso(),
    rateSource: "manual",
    amountBase: round2((Number(params.amount) || 0) * rate),
    baseCurrency: base,
  };
}

/**
 * amountBase as a READER sees it, covering pre-slice rows:
 *   stored amountBase           → that;
 *   missing, currency === base  → amount (identity — a legacy INR row);
 *   missing, foreign            → null (conversion pending).
 */
export function effectiveAmountBase(expense: any, baseCurrency: string): number | null {
  if (expense == null) return null;
  if (expense.amountBase != null && Number.isFinite(Number(expense.amountBase))) {
    return Number(expense.amountBase);
  }
  const base = normalizeCurrency(baseCurrency) || DEFAULT_BASE_CURRENCY;
  const cur = normalizeCurrency(expense.currency) || base;
  return cur === base ? round2(Number(expense.amount) || 0) : null;
}

export function isConversionPending(expense: any, baseCurrency: string): boolean {
  return effectiveAmountBase(expense, baseCurrency) == null;
}

/**
 * The aggregation twin of effectiveAmountBase — what every $sum over expenses
 * now uses in place of "$amount". A conversion-pending line contributes 0 (and
 * is counted separately by pendingConversionExpr so a total is never shown
 * without its "N lines pending" caveat).
 */
export function amountBaseExpr(baseCurrency: string): any {
  const base = normalizeCurrency(baseCurrency) || DEFAULT_BASE_CURRENCY;
  return {
    $cond: [
      { $ne: [{ $ifNull: ["$amountBase", null] }, null] },
      "$amountBase",
      {
        $cond: [
          { $eq: [{ $toUpper: { $ifNull: ["$currency", base] } }, base] },
          { $ifNull: ["$amount", 0] },
          0,
        ],
      },
    ],
  };
}

/** 1 for a conversion-pending line, else 0 — $sum it for a pending count. */
export function pendingConversionExpr(baseCurrency: string): any {
  const base = normalizeCurrency(baseCurrency) || DEFAULT_BASE_CURRENCY;
  return {
    $cond: [
      {
        $and: [
          { $eq: [{ $ifNull: ["$amountBase", null] }, null] },
          { $ne: [{ $toUpper: { $ifNull: ["$currency", base] } }, base] },
        ],
      },
      1,
      0,
    ],
  };
}

/** Response decoration for one expense: the reader-facing FX view. */
export function fxView(expense: any, baseCurrency: string) {
  const base = normalizeCurrency(baseCurrency) || DEFAULT_BASE_CURRENCY;
  const amountBase = effectiveAmountBase(expense, base);
  return {
    baseCurrency: base,
    amountBase,
    exchangeRate: expense?.exchangeRate ?? (amountBase != null && expense?.amountBase == null ? 1 : null),
    rateDate: expense?.rateDate ?? null,
    rateSource: expense?.rateSource ?? (amountBase != null && expense?.amountBase == null ? "base" : null),
    conversionPending: amountBase == null,
  };
}
