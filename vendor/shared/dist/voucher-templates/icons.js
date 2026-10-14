/* ── Voucher icons as inline SVG ─────────────────────────────────────────────
   The voucher PDFs are painted by a Lambda whose only fonts are the
   self-hosted Latin subsets of Manrope and Playfair Display. Emoji and symbol
   characters (📍 ✓ ✈ ⚠ → …) have no glyph there and print as solid boxes, so
   every icon in the templates is drawn as a small inline SVG instead — it
   needs no font and looks the same in the Lambda, a browser, and print.

   Each helper returns markup sized in px and coloured with `currentColor`
   unless a colour is passed, so it inherits the surrounding text colour.
   ────────────────────────────────────────────────────────────────────────── */
function svg(size, color, body, extraStyle = "") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="display:inline-block;vertical-align:-0.15em;flex-shrink:0;${extraStyle}">${body}</svg>`;
}
export const iconCheck = (size = 12, color = "currentColor") => svg(size, color, `<path d="M4 12.5l5 5L20 6.5"/>`);
export const iconCross = (size = 12, color = "currentColor") => svg(size, color, `<path d="M6 6l12 12M18 6L6 18"/>`);
export const iconWarning = (size = 12, color = "currentColor") => svg(size, color, `<path d="M12 3.5L22 20.5H2z"/><path d="M12 10v4.5"/><path d="M12 17.6v.1"/>`);
export const iconInfo = (size = 12, color = "currentColor") => svg(size, color, `<circle cx="12" cy="12" r="9.5"/><path d="M12 11v6"/><path d="M12 7.4v.1"/>`);
export const iconPin = (size = 12, color = "currentColor") => svg(size, color, `<path d="M12 21.5s-7-6.3-7-11.5a7 7 0 0 1 14 0c0 5.2-7 11.5-7 11.5z"/><circle cx="12" cy="10" r="2.6"/>`, "margin-top:2px;");
export const iconArrowRight = (size = 10, color = "currentColor") => svg(size, color, `<path d="M4 12h16M14 6l6 6-6 6"/>`);
export const iconPrinter = (size = 14, color = "currentColor") => svg(size, color, `<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>`);
/** Filled aircraft silhouette, nose to the right. */
export const iconPlane = (size = 22, color = "currentColor") => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" style="display:inline-block;vertical-align:middle;"><path fill="${color}" d="M21.5 12c0-.8-.7-1.4-1.5-1.4h-5.1L10.2 3H8l2.4 7.6H5.6L4 8.5H2.5l1 3.5-1 3.5H4l1.6-2.1h4.8L8 21h2.2l4.7-7.6H20c.8 0 1.5-.6 1.5-1.4z"/></svg>`;
/** Decorative passport outline for the partner-offer panel. */
export const iconPassport = (size = 80, color = "currentColor") => svg(size, color, `<rect x="5" y="2.5" width="14" height="19" rx="2"/><circle cx="12" cy="10.5" r="3.5"/><path d="M8.5 10.5h7M12 7v7M9 17.5h6"/>`, "stroke-width:1.4;");
/** Icon for a cancellation chip tone (the SVG twin of TONE_PALETTE.iconChar). */
export function chipIcon(tone, size = 11) {
    switch (tone) {
        case "success":
            return iconCheck(size);
        case "warning":
            return iconWarning(size);
        case "danger":
            return iconCross(size);
        default:
            return iconInfo(size);
    }
}
