// apps/backend/src/utils/heroImageContrast.ts
//
// Deterministic contrast check for scripts/fetch-visa-destination-images.ts
// — computed once per candidate at fetch time, not left to ops eyeballing a
// raw thumbnail against text they can't see (task brief, 2026-08-04
// follow-up). Replicates the EXACT treatment RequirementsPage.tsx applies
// to a live heroImageUrl:
//   1. background-size:cover onto the hero band (sharp's fit:"cover").
//   2. the left-weighted --s1 gradient scrim (2026-08-04 — flat 60% from
//      the left edge through 58% of the band's width, easing to 15% at
//      the right edge), painted OVER the photo (background-image layers
//      composite bottom-up before any filter runs).
//   3. filter: saturate(80%), applied to that ALREADY-composited result —
//      CSS filter is a post-process over the whole painted box, not the
//      raw photo alone, so it must run after step 2, not before (getting
//      this order backwards changes the numbers: saturating a photo then
//      alpha-blending it against a non-grey colour like --s1 does not
//      commute with doing it the other way round).
// Then samples the exact regions where VerdictBand's heading and body text
// sit (measured live via browser devtools against the AE/TOURIST
// requirements page, 2026-08-04, at the desktop width RequirementsPage.tsx
// is primarily reviewed at) and reports the WORST per-pixel WCAG contrast
// ratio against #ffffff found in either region. These two elements sit
// directly on the raw treated photo with no card tint behind them —
// EntrySnapshotCard's own bg-visa-black-alpha-20 gives its fact rows extra
// protection this doesn't model, so heading/body is already the binding,
// worst-case pair, not an average across the hero.
//
// Keep every literal below in lockstep with RequirementsPage.tsx's
// heroBackgroundStyle — if that gradient's stops, saturation %, or the
// active theme's --s1 ever changes, this drifts out of sync silently.

// NOTE: `sharp` is deliberately NOT imported at the top level. It is a
// native addon (libvips), and a static import here would put it on the
// API's boot graph: server.ts -> routes/admin.visa.rules.ts -> this file.
// When the addon fails to dlopen — wrong platform/libc for the installed
// binary, a partially-restored node_modules, a base-image change — the
// throw happens during module evaluation, so the process dies before
// Express listens and App Runner health-checks it into a rollback. That
// is exactly what killed both visa deploys (2026-08-13). It is loaded
// lazily inside computeWorstCaseHeroContrast instead, so a broken sharp
// degrades to "image-contrast scoring is unavailable" — a failed admin
// image-fetch job — while every other route, visa included, stays up.

// Matches RequirementsPage.tsx's heroBackgroundStyle exactly: a
// left-weighted horizontal gradient scrim (2026-08-04), not a flat tint.
// Flat at OVERLAY_ALPHA_PLATEAU from the left edge through
// OVERLAY_PLATEAU_END_FRACTION of the band's width (covers TEXT_REGIONS'
// full extent below, with margin), then linearly eases down to
// OVERLAY_ALPHA_FAR_EDGE by the right edge.
//
// THEME-AWARE, GATED ON THE WORST PALETTE (2026-08-04 follow-up). The
// frontend's plateau alpha is per-theme (VISA_THEME.scrimPlateauAlpha,
// components/visa/ui/tokens.ts) because --s1's lightness varies enough
// across the thirteen palettes (colordesign.md §2) that a single alpha
// under-protects the lighter ones. But a candidate is scored ONCE, at
// fetch time, independent of which theme happens to be active when it's
// later rendered — and VisaThemePicker lets staff switch theme at
// runtime. So this gate cannot use Midnight's (the production default's)
// alpha: a candidate that clears 4.5:1 under Midnight but not under
// Ivory would still be selectable, then fail contrast the moment a staff
// session (or a future production default) switches to Ivory. Gate
// against the WORST case across all thirteen instead — if it clears the
// hardest palette to protect against, it clears all of them.
//
// Breakeven (contrast lands at exactly 4.50) for a worst-case #ffffff
// pixel, per palette, then ceil'd up to the nearest whole percent after
// adding ~3pp headroom — same derivation as tokens.ts's
// scrimPlateauAlpha, and this table MUST stay in lockstep with that one
// (regenerate both together if any --s1 changes):
//   ivory 64.05% -> 68%   (worst — this is OVERLAY_ALPHA_PLATEAU below)
//   olive/lagoon/saffron/peacock/cedar ~59.7-61.0% -> 64%
//   graphite/terracotta ~59.2-59.7% -> 63%
//   sapphire/orchid/amethyst ~58.2-58.9% -> 62%
//   midnight 57.18% -> 61%
//   crimson 56.96% -> 60%   (easiest)
const OVERLAY_ALPHA_PLATEAU = 0.68;
const OVERLAY_PLATEAU_END_FRACTION = 0.58;
const OVERLAY_ALPHA_FAR_EDGE = 0.15;
const SATURATION = 0.8;
// Ivory's --s1 (components/visa/ui/tokens.ts) — the worst-case palette
// this gate protects against, NOT the active production theme (Midnight).
// A candidate passing here is guaranteed 4.5:1 under every one of the
// thirteen palettes, not just whichever is live right now.
const S1 = { r: 44, g: 42, b: 38 };

// Overlay alpha at a given horizontal fraction (0 = left edge, 1 = right
// edge) of the hero band — the flat-then-fade shape of the CSS gradient.
function overlayAlphaAt(xFraction: number): number {
  if (xFraction <= OVERLAY_PLATEAU_END_FRACTION) return OVERLAY_ALPHA_PLATEAU;
  const t = (xFraction - OVERLAY_PLATEAU_END_FRACTION) / (1 - OVERLAY_PLATEAU_END_FRACTION);
  return OVERLAY_ALPHA_PLATEAU + t * (OVERLAY_ALPHA_FAR_EDGE - OVERLAY_ALPHA_PLATEAU);
}

// The hero band's own rendered box at a 1280px-wide desktop viewport
// (RequirementsPage.tsx's .bg-visa-hero-dark div, measured live). Text
// position drifts a little at other widths, but this is the primary
// desktop width ops reviews from, and the sampled regions below have
// margin built in (full bounding boxes, not single points).
const REFERENCE_HERO = { width: 1280, height: 483 };

// Fractional bounding boxes (relative to REFERENCE_HERO) of VerdictBand's
// headline (h1) and summary paragraph — the two pieces of white text that
// sit directly on the raw photo, unprotected by any card tint. Measured
// live via browser devtools against the AE/TOURIST requirements page,
// 2026-08-04.
const TEXT_REGIONS: Array<{ name: string; left: number; top: number; right: number; bottom: number }> = [
  { name: "heading", left: 0.0375, top: 0.2681, right: 0.5375, bottom: 0.3435 },
  { name: "body", left: 0.0375, top: 0.3766, right: 0.5375, bottom: 0.4698 },
];

// Re-exported for the callers that need BOTH the threshold and the
// scorer, so they keep a single import. Callers that need only the
// number must import it from heroImageContrastConstants.js directly —
// importing it from here is what dragged sharp onto the boot path.
export { MIN_HERO_CONTRAST } from "./heroImageContrastConstants.js";

// The lazy, first-call load of the native addon — the whole point of
// which is that this line runs when someone scores an image, not when
// Node evaluates the module graph on boot. Node caches the resolved
// module, so repeat calls don't re-pay the dlopen.
//
// Rethrown with context because a raw ERR_DLOPEN_FAILED surfacing out of
// an image-fetch job reads like a bug in the job rather than a broken
// native install. Deliberately NOT swallowed into a 0: 0 is the
// fail-closed "this image fails contrast" value, and stamping every
// candidate FAIL because a library is missing would be a wrong answer
// dressed up as a verdict.
async function loadSharp() {
  try {
    return (await import("sharp")).default;
  } catch (err) {
    throw new Error(
      `Hero contrast scoring is unavailable: the "sharp" native module failed to load (${
        err instanceof Error ? err.message : String(err)
      }). Reinstall it for this platform; the rest of the API is unaffected.`,
    );
  }
}

function srgbChannelToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function relativeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b);
}

function contrastVsWhite(r: number, g: number, b: number): number {
  return 1.05 / (relativeLuminance(r, g, b) + 0.05);
}

// CSS Filter Effects spec's saturate() colour matrix, applied to the
// ALREADY-composited (photo + overlay) pixel — matches real paint order.
function applySaturateFilter(r: number, g: number, b: number, s: number): [number, number, number] {
  const r2 = (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b;
  const g2 = (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b;
  const b2 = (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b;
  return [r2, g2, b2];
}

/**
 * Worst-case WCAG contrast ratio (vs #ffffff) for the given candidate
 * image, after applying the exact hero treatment, sampled at the exact
 * regions the heading/body text occupy. Lower is worse; 21 is the
 * theoretical max (pure black background). Returns 0 (fail-closed) if
 * decoding produced no sampleable pixels, rather than defaulting to a
 * passing value nothing actually verified.
 */
export async function computeWorstCaseHeroContrast(imageBuffer: Buffer): Promise<number> {
  const sharp = await loadSharp();

  const { data, info } = await sharp(imageBuffer)
    .resize(REFERENCE_HERO.width, REFERENCE_HERO.height, { fit: "cover", position: "centre" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  let worst = Infinity;

  for (const region of TEXT_REGIONS) {
    const x0 = Math.max(0, Math.floor(region.left * width));
    const x1 = Math.min(width, Math.ceil(region.right * width));
    const y0 = Math.max(0, Math.floor(region.top * height));
    const y1 = Math.min(height, Math.ceil(region.bottom * height));

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * width + x) * channels;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        // Step 1: the gradient scrim, painted over the photo. Alpha varies
        // with this pixel's horizontal position in the band, not a flat
        // constant — see overlayAlphaAt.
        const alpha = overlayAlphaAt(x / width);
        const cr = r * (1 - alpha) + S1.r * alpha;
        const cg = g * (1 - alpha) + S1.g * alpha;
        const cb = b * (1 - alpha) + S1.b * alpha;

        // Step 2: filter: saturate(80%), applied to that composite.
        const [fr, fg, fb] = applySaturateFilter(cr, cg, cb, SATURATION);

        const contrast = contrastVsWhite(
          Math.min(255, Math.max(0, fr)),
          Math.min(255, Math.max(0, fg)),
          Math.min(255, Math.max(0, fb)),
        );
        if (contrast < worst) worst = contrast;
      }
    }
  }

  return worst === Infinity ? 0 : worst;
}
