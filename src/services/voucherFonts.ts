// apps/backend/src/services/voucherFonts.ts
//
// Self-hosted web fonts for the in-process voucher renderer. Parity mirror of
// services/voucher-render-lambda/fonts.mjs — same families, weights, check
// specs and base64 @font-face construction, so the Lambda and the in-process
// Puppeteer renderer behave identically.
//
// The voucher templates reference Manrope (400/600/700/800) and Playfair
// Display (700 normal + italic) via a remote @import url(fonts.googleapis.com).
// Under headless Chromium that network fetch + font substitution races the PDF
// text serialization and doubles / transposes glyphs. Embedding the woff2 (via
// @fontsource) as base64 @font-face rules — injected AFTER setContent so they
// win the cascade — removes the race; the local fonts are guaranteed to be used.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// [family, weight, style, resolvable woff2 path]
const FACES: Array<[string, number, "normal" | "italic", string]> = [
  ["Manrope", 400, "normal", "@fontsource/manrope/files/manrope-latin-400-normal.woff2"],
  ["Manrope", 600, "normal", "@fontsource/manrope/files/manrope-latin-600-normal.woff2"],
  ["Manrope", 700, "normal", "@fontsource/manrope/files/manrope-latin-700-normal.woff2"],
  ["Manrope", 800, "normal", "@fontsource/manrope/files/manrope-latin-800-normal.woff2"],
  ["Playfair Display", 700, "normal", "@fontsource/playfair-display/files/playfair-display-latin-700-normal.woff2"],
  ["Playfair Display", 700, "italic", "@fontsource/playfair-display/files/playfair-display-latin-700-italic.woff2"],
];

// Specs the render gate verifies via document.fonts.check(...) before page.pdf().
export const FONT_CHECK_SPECS: string[] = [
  '400 12px "Manrope"',
  '600 12px "Manrope"',
  '700 12px "Manrope"',
  '800 12px "Manrope"',
  '700 12px "Playfair Display"',
  'italic 700 12px "Playfair Display"',
];

function buildFontFaceCss(): string {
  return FACES.map(([family, weight, style, spec]) => {
    const b64 = readFileSync(require.resolve(spec)).toString("base64");
    return (
      `@font-face{font-family:'${family}';font-style:${style};` +
      `font-weight:${weight};font-display:block;` +
      `src:url(data:font/woff2;base64,${b64}) format('woff2');}`
    );
  }).join("");
}

// Built once at module load; reused across renders.
export const FONT_FACE_CSS: string = buildFontFaceCss();
