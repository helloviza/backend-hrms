// apps/backend/src/utils/heroImageContrastConstants.ts
//
// The contrast threshold, and nothing else. Split out of
// heroImageContrast.ts (2026-08-14) because that module needs `sharp` — a
// native addon — and routes/admin.visa.rules.ts imported it solely to
// quote this number back in a 4xx message. server.ts imports that router
// at module load, so a bare 4.5 was pulling libvips onto the API's boot
// path, where a failure to dlopen kills the whole process before Express
// ever listens (the crash-loop that rolled back both visa deploys).
//
// heroImageContrast.ts now loads sharp lazily, so that alone would have
// been enough; this split is the belt to that suspenders. Anything that
// only needs the threshold should import it from here, so no future
// edit can quietly put an image library back on the boot graph.
//
// WCAG 2.1 AA for large text is 3:1 and for body text 4.5:1. The hero's
// summary paragraph is body-sized, so 4.5 is the binding requirement for
// both sampled regions — see heroImageContrast.ts's TEXT_REGIONS.
export const MIN_HERO_CONTRAST = 4.5;
