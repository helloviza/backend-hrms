/* ── Cancellation policy display — shared utility ────────────────────────────
   Canonical source for cancellation-policy chip rendering across SBT hotel
   surfaces (Review, Confirmed, Detail, Guests, PaymentMode, Voucher).

   Centralizes the chip-strip pattern first introduced at SBTHotelReview.tsx
   (per-tier chip with charge label · "From [date]"). All consumers should
   import buildCancellationChips for full multi-tier displays or
   buildCancellationSummary for compact one-liners (room cards, summary boxes).
   ────────────────────────────────────────────────────────────────────────── */
/** Stitch design-system tone palette already in use elsewhere in the app. */
export const TONE_PALETTE = {
    success: { background: "#E1F5EE", color: "#085041", border: "#5DCAA5", iconChar: "✓" },
    warning: { background: "#FAEEDA", color: "#633806", border: "#F0C674", iconChar: "⚠" },
    danger: { background: "#FCEBEB", color: "#791F1F", border: "#E5A5A5", iconChar: "✕" },
    info: { background: "#EEF2FF", color: "#1E3A8A", border: "#C7D2FE", iconChar: "ℹ" },
};
/** Parse TBO date "DD-MM-YYYY HH:mm:ss" (or ISO fallback) into Date. */
export function parseTBODate(input) {
    if (!input || typeof input !== "string")
        return null;
    const m = input.match(/^(\d{2})-(\d{2})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
    if (m) {
        const [, dd, mm, yyyy, hh = "00", mi = "00", ss = "00"] = m;
        const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss));
        return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(input);
    return isNaN(d.getTime()) ? null : d;
}
/** Format Date as "13 May 2026" (en-IN). */
export function formatDateShort(date) {
    return date.toLocaleDateString("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}
/** Format Date as "11 Jul 2026 23:59" — deadline-style (24-hour HH:mm). */
export function formatDateTime(date) {
    const hh = String(date.getHours()).padStart(2, "0");
    const mm = String(date.getMinutes()).padStart(2, "0");
    return `${formatDateShort(date)} ${hh}:${mm}`;
}
/** Subtract exactly one second — used to convert "next tier's FromDate" into a deadline. */
function subtractOneSecond(date) {
    return new Date(date.getTime() - 1000);
}
/**
 * Drop policies whose FromDate falls after the checkout date.
 * Such tiers can never apply and only clutter the display.
 */
export function isCancelDateValid(fromDate, checkOut) {
    const cancel = parseTBODate(fromDate || "");
    if (!cancel)
        return false;
    const checkout = new Date(checkOut);
    if (isNaN(checkout.getTime()))
        return true;
    return cancel <= checkout;
}
/**
 * Filter to policies that can still apply: FromDate ≤ checkOut.
 * Sorted by FromDate ascending. Preserves all valid tiers (no
 * "historical tier" pruning — users see the full multi-tier policy).
 */
export function getEffectiveCancelPolicies(policies, checkOut) {
    if (!Array.isArray(policies) || policies.length === 0)
        return [];
    const filtered = policies.filter((p) => {
        if (!p?.FromDate)
            return true;
        if (!checkOut)
            return true;
        return isCancelDateValid(p.FromDate, checkOut);
    });
    const withDates = filtered
        .map((p) => ({ raw: p, parsed: parseTBODate(p.FromDate || "") }))
        .filter((x) => x.parsed !== null);
    withDates.sort((a, b) => a.parsed.getTime() - b.parsed.getTime());
    return withDates.map((x) => x.raw);
}
const isPercentageType = (ct) => ct === "Percentage" || ct === "Percent" || ct === 2 || ct === "2";
const isFixedType = (ct) => ct === "Fixed" || ct === 1 || ct === "1";
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
export function buildCancellationChips(policies, opts) {
    if (!Array.isArray(policies) || policies.length === 0)
        return [];
    const filtered = getEffectiveCancelPolicies(policies, opts?.checkOut);
    const sorted = filtered
        .map((p) => ({ raw: p, parsed: parseTBODate(p.FromDate || "") }))
        .filter((x) => x.parsed !== null);
    if (sorted.length === 0)
        return [];
    const currencyFallback = opts?.currencyFallback || "INR";
    // Special case: 1-tier policy
    if (sorted.length === 1) {
        const only = sorted[0];
        const charge = Number(only.raw.CancellationCharge ?? 0);
        if (charge === 0) {
            return [{
                    label: "Free cancellation any time",
                    tone: "success",
                    icon: "check",
                    isFree: true,
                }];
        }
        if (isPercentageType(only.raw.ChargeType) && charge >= 100) {
            return [{
                    label: "Non-refundable · 100% charge from booking date",
                    tone: "danger",
                    icon: "cross",
                    isFree: false,
                    chargePercentage: 100,
                }];
        }
        if (isPercentageType(only.raw.ChargeType)) {
            return [{
                    label: `${charge}% cancellation charge from booking date`,
                    tone: "warning",
                    icon: "warning",
                    isFree: false,
                    chargePercentage: charge,
                }];
        }
        if (isFixedType(only.raw.ChargeType)) {
            const currency = only.raw.Currency || currencyFallback;
            return [{
                    label: `${currency} ${charge.toLocaleString("en-IN")} cancellation charge from booking date`,
                    tone: "warning",
                    icon: "warning",
                    isFree: false,
                }];
        }
        return [{
                label: `${charge}% cancellation charge from booking date`,
                tone: charge >= 100 ? "danger" : "warning",
                icon: charge >= 100 ? "cross" : "warning",
                isFree: false,
                chargePercentage: charge,
            }];
    }
    // Multi-tier (2 or more): deadline-style for free tier + range-style for middle, open-ended for last
    const chips = [];
    for (let i = 0; i < sorted.length; i++) {
        const current = sorted[i];
        const next = sorted[i + 1];
        const charge = Number(current.raw.CancellationCharge ?? 0);
        const chargeType = current.raw.ChargeType;
        const deadline = next ? subtractOneSecond(next.parsed) : null;
        if (charge === 0 && deadline) {
            chips.push({
                label: `Free cancellation until ${formatDateTime(deadline)}`,
                tone: "success",
                icon: "check",
                isFree: true,
            });
            continue;
        }
        if (charge === 0 && !deadline) {
            chips.push({
                label: "Free cancellation any time",
                tone: "success",
                icon: "check",
                isFree: true,
            });
            continue;
        }
        if (isPercentageType(chargeType) && charge >= 100) {
            chips.push({
                label: `100% cancellation charge from ${formatDateShort(current.parsed)}`,
                tone: "danger",
                icon: "cross",
                isFree: false,
                chargePercentage: 100,
            });
            continue;
        }
        if (isPercentageType(chargeType) && charge > 0 && charge < 100 && deadline) {
            chips.push({
                label: `${charge}% cancellation charge from ${formatDateShort(current.parsed)} to ${formatDateShort(deadline)}`,
                tone: "warning",
                icon: "warning",
                isFree: false,
                chargePercentage: charge,
            });
            continue;
        }
        if (isPercentageType(chargeType) && charge > 0 && charge < 100 && !deadline) {
            chips.push({
                label: `${charge}% cancellation charge from ${formatDateShort(current.parsed)}`,
                tone: "warning",
                icon: "warning",
                isFree: false,
                chargePercentage: charge,
            });
            continue;
        }
        if (isFixedType(chargeType) && charge > 0) {
            const currency = current.raw.Currency || currencyFallback;
            const range = deadline
                ? `from ${formatDateShort(current.parsed)} to ${formatDateShort(deadline)}`
                : `from ${formatDateShort(current.parsed)}`;
            chips.push({
                label: `${currency} ${charge.toLocaleString("en-IN")} cancellation charge ${range}`,
                tone: "warning",
                icon: "warning",
                isFree: false,
            });
            continue;
        }
        // Fallback for unknown ChargeType — treat values >100 as a fixed amount.
        if (charge <= 100) {
            chips.push({
                label: `${charge}% cancellation charge from ${formatDateShort(current.parsed)}`,
                tone: charge >= 100 ? "danger" : "warning",
                icon: charge >= 100 ? "cross" : "warning",
                isFree: false,
                chargePercentage: charge,
            });
        }
        else {
            const currency = current.raw.Currency || currencyFallback;
            chips.push({
                label: `${currency} ${charge.toLocaleString("en-IN")} cancellation charge from ${formatDateShort(current.parsed)}`,
                tone: "warning",
                icon: "warning",
                isFree: false,
            });
        }
    }
    return chips;
}
/**
 * Compact one-liner for tight spaces (room cards, summary boxes).
 * Returns the first (most permissive) chip plus an isRefundable flag
 * based on whether any free tier exists.
 */
export function buildCancellationSummary(policies, opts) {
    const chips = buildCancellationChips(policies, opts);
    if (chips.length === 0) {
        return {
            label: "Cancellation policy unavailable",
            isRefundable: false,
            tone: "info",
        };
    }
    const first = chips[0];
    return {
        label: first.label,
        isRefundable: first.isFree,
        tone: first.tone,
    };
}
