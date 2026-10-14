/* ── Voucher counts ─────────────────────────────────────────────────────────
   Extracted vouchers now carry counts exactly as printed — "1 night",
   "3 Nights", "2 adults, 1 child", "1 room" — or a bare number from older
   records. This is the ONE reader for them (nights, adults, children, guests,
   rooms), used by the date resolver, the PDF adapter, the queue card and the
   voucher page, so they can't disagree.
   ────────────────────────────────────────────────────────────────────────── */
/**
 * The count a voucher states: the LEADING whole number of what was printed.
 * null when there is none — absent, 0, or a number in words ("one night") —
 * never a guess.
 */
export function leadingCount(value) {
    if (typeof value === "number")
        return Number.isFinite(value) && value >= 1 ? Math.floor(value) : null;
    if (typeof value !== "string")
        return null;
    const m = value.match(/^\s*(\d{1,4})(?![\d.,]\d)/);
    const n = m ? Number(m[1]) : NaN;
    return Number.isFinite(n) && n >= 1 ? n : null;
}
