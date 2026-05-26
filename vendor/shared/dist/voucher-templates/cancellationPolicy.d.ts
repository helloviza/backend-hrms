export interface CancelPolicy {
    FromDate?: string;
    ChargeType?: "Fixed" | "Percentage" | "Percent" | number | string;
    CancellationCharge?: number | string;
    Index?: string | number;
    Currency?: string;
    ToDate?: string;
}
export type CancellationTone = "success" | "warning" | "danger" | "info";
export interface CancellationChip {
    label: string;
    tone: CancellationTone;
    icon: "check" | "warning" | "cross";
    isFree: boolean;
    chargePercentage?: number;
}
/** Stitch design-system tone palette already in use elsewhere in the app. */
export declare const TONE_PALETTE: Record<CancellationTone, {
    background: string;
    color: string;
    border: string;
    iconChar: string;
}>;
/** Parse TBO date "DD-MM-YYYY HH:mm:ss" (or ISO fallback) into Date. */
export declare function parseTBODate(input: string | null | undefined): Date | null;
/** Format Date as "13 May 2026" (en-IN). */
export declare function formatDateShort(date: Date): string;
/** Format Date as "11 Jul 2026 23:59" — deadline-style (24-hour HH:mm). */
export declare function formatDateTime(date: Date): string;
/**
 * Drop policies whose FromDate falls after the checkout date.
 * Such tiers can never apply and only clutter the display.
 */
export declare function isCancelDateValid(fromDate: string | null | undefined, checkOut: string): boolean;
/**
 * Filter to policies that can still apply: FromDate ≤ checkOut.
 * Sorted by FromDate ascending. Preserves all valid tiers (no
 * "historical tier" pruning — users see the full multi-tier policy).
 */
export declare function getEffectiveCancelPolicies(policies: CancelPolicy[] | undefined | null, checkOut?: string): CancelPolicy[];
/**
 * Convert N CancelPolicy tiers into N CancellationChip lines using
 * deadline-style labels for the free tier and any partial tier with
 * a successor.
 *
 * Per-tier label rules:
 *   Free tier (charge=0) WITH successor       → "Free cancellation until {next.FromDate − 1s, formatted as DD MMM YYYY HH:mm}"
 *   Free tier (charge=0) WITHOUT successor    → "Free cancellation any time"
 *   Partial % tier WITH successor             → "{N}% cancellation charge from {start DD MMM YYYY} to {end DD MMM YYYY}"
 *   Partial % tier WITHOUT successor          → "{N}% cancellation charge from {start DD MMM YYYY}"
 *   100% tier                                 → "100% cancellation charge from {start DD MMM YYYY}"
 *   Fixed-currency tier (charge>0)            → "{Currency} {N} cancellation charge from {start} [to {end}]"
 *
 * Special cases:
 *   1-tier non-refundable (single 100% Percentage tier) → "Non-refundable · 100% charge from booking date"
 *   1-tier free (lone free tier, no successor)          → "Free cancellation any time"
 *   1-tier partial (rare)                               → "{N}% cancellation charge from booking date"
 *
 * Returns [] if input is empty/invalid.
 */
export declare function buildCancellationChips(policies: CancelPolicy[] | undefined | null, opts?: {
    checkOut?: string;
    currencyFallback?: string;
}): CancellationChip[];
/**
 * Compact one-liner for tight spaces (room cards, summary boxes).
 * Returns the first (most permissive) chip plus an isRefundable flag
 * based on whether any free tier exists.
 */
export declare function buildCancellationSummary(policies: CancelPolicy[] | undefined | null, opts?: {
    checkOut?: string;
    currencyFallback?: string;
}): {
    label: string;
    isRefundable: boolean;
    tone: CancellationTone;
};
