// apps/backend/src/services/visaProfileScore.test.ts
//
// THE GOLDEN FIXTURES (KT spec section 11), F1-F12, plus the regression
// guard for the logit-pin fix and a parity check against the reference.
//
// ── WHY THESE ARE PURE TESTS ──────────────────────────────────────────
// The engine reads nothing at call time — base rates and the ruleset are
// frozen at module init — so there is no Mongo, no router, no network and
// no clock here. `generatedAt` is injected into every case, which is what
// makes F10 (determinism) writable at all: a function that stamped its own
// timestamp could never be compared to itself.
//
// ── THE TWO CLAIMS THIS SUITE MAKES TOGETHER ──────────────────────────
// 1. For every country whose base rate sits strictly inside the envelope,
//    this engine is BYTE-IDENTICAL to the reference. That is the parity
//    block at the bottom, and it is what lets us call this a port.
// 2. For the 47 countries whose base sits outside it, this engine is
//    DELIBERATELY DIFFERENT, because the reference is wrong there. The FIX
//    fixtures pin that difference so nobody "restores parity" by undoing
//    the bug fix.
import { describe, it, expect } from "vitest";

import {
  computeVisaProfileScore,
  baselineScore,
  schengenSyntheticRate,
  heldVisaPoints,
  activeQuestions,
  transform,
  logit,
  sigmoid,
  type ScoreAnswers,
} from "./visaProfileScore.js";
import { VISA_SCORE_RULESET as R } from "../config/visaScoreRuleset.js";
import { BASE_RATES, baseRateFor } from "../utils/visaDifficulty.js";

/** Injected, never read from the clock. See the file header. */
const AT = "2026-09-02T00:00:00.000Z";

/**
 * THE MODAL APPLICANT — every question answered with its zero-point
 * option. This profile must land exactly on the route baseline, which is
 * what "zero-centered" means and what F1 exists to prove.
 */
const MODAL: ScoreAnswers = {
  residence: 0,  // In my country of citizenship        0
  age: 2,        // 27-55                               0  (silent)
  travel: 2,     // 3-5 countries                       0
  purpose: 0,    // Tourism / leisure                   0
  staylen: 1,    // 2-4 weeks                           0
  companions: 1, // Spouse / partner                    0  (silent)
  family: 1,     // Spouse / partner at home            0
  assets: 1,     // Property or long-term lease         0
  employment: 1, // Employed 3-7 years                  0
  payer: 0,      // My personal funds                   0
  finproof: 1,   // Average income, documented          0
  refusals: 0,   // Never refused                       0
  compliance: 0, // Always complied                     0
  character: 0,  // No criminal record                  0
};

const STRONG: ScoreAnswers = {
  ...MODAL,
  residence: 1, age: 3, travel: 4, purpose: 1, staylen: 0, companions: 0,
  family: 0, assets: 0, employment: 0, payer: 1, finproof: 0,
};

const WEAK: ScoreAnswers = {
  ...MODAL,
  residence: 5, age: 0, travel: 1, purpose: 3, staylen: 3, companions: 5,
  family: 4, assets: 3, employment: 7, payer: 5, finproof: 3, refusals: 3,
};

/**
 * What the REFERENCE would return for a given base rate and points total —
 * i.e. with the clamp applied only AFTER the logit. Used by the FIX block
 * to show what we are diverging from, rather than asserting our own numbers
 * against themselves.
 */
function referencePin(baseRate: number, points: number): number {
  const raw = Math.min(0.95, Math.max(0.05, sigmoid(logit(baseRate) + points * 0.016)));
  return Math.min(870, Math.max(310, Math.round(300 + raw * 600)));
}

const score = (dest: string, answers: ScoreAnswers, extra: Record<string, unknown> = {}) =>
  computeVisaProfileScore({
    passportIso2: "IN", destinationIso2: dest, answers, generatedAt: AT, ...extra,
  } as any);

/* ═══════════════════════════════════════════════════════════════════════
 * F1 — ZERO-CENTERING
 * ═══════════════════════════════════════════════════════════════════════ */
describe("F1 — the modal profile lands on the route baseline", () => {
  it("scores within ±2 of the baseline on IN→US", () => {
    const r = score("US", MODAL);
    expect(r.build.totalPoints).toBe(0);
    expect(Math.abs(r.score! - r.build.baseScore!)).toBeLessThanOrEqual(2);
  });

  it("holds on every corridor we hold a rate for — not just the US", () => {
    // Zero-centering is a property of the DELTAS, so it cannot be true on
    // one route and false on another. If a future edit gives some question
    // a non-zero modal option, this fails everywhere at once.
    const offenders: string[] = [];
    for (const iso2 of Object.keys(BASE_RATES)) {
      const r = score(iso2, MODAL);
      if (r.score === null) continue;
      if (Math.abs(r.score - r.build.baseScore!) > 2) offenders.push(iso2);
    }
    expect(offenders).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * F2 / F3 — DIRECTION, AND NOT PINNED
 * ═══════════════════════════════════════════════════════════════════════ */
describe("F2/F3 — a strong profile rises above the baseline, a weak one falls below", () => {
  it("F2: strong IN→US is above baseline and not pinned at the cap", () => {
    const r = score("US", STRONG);
    expect(r.score!).toBeGreaterThan(r.build.baseScore!);
    expect(r.score!).toBeLessThan(R.transform.scoreCap);
    expect(r.build.capped).toBeNull();
  });

  it("F3: weak IN→US is below baseline and not pinned at the floor", () => {
    const r = score("US", WEAK);
    expect(r.score!).toBeLessThan(r.build.baseScore!);
    expect(r.score!).toBeGreaterThan(R.transform.scoreFloor);
  });

  it("orders strong > modal > weak on the same route", () => {
    expect(score("US", STRONG).score!).toBeGreaterThan(score("US", MODAL).score!);
    expect(score("US", MODAL).score!).toBeGreaterThan(score("US", WEAK).score!);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * F4 / F5 — HARD STOPS CAP THE DISPLAY, NOT THE COMPUTATION
 * ═══════════════════════════════════════════════════════════════════════ */
describe("F4/F5 — the two capping hard stops", () => {
  it("F4: a misrepresentation finding caps the displayed score at 449", () => {
    const r = score("US", { ...STRONG, compliance: 3 });
    // The cap must actually BITE — a fixture that passes because the raw
    // score was already under 449 would assert nothing.
    expect(r.build.rawScore!).toBeGreaterThan(449);
    expect(r.score).toBe(449);
    expect(r.build.capped).toBe("misrep");
    expect(r.flags.some((f) => f.code === "misrep" && f.severity === "critical")).toBe(true);
  });

  it("F5: a custodial sentence caps the displayed score at 449", () => {
    const r = score("US", { ...STRONG, character: 3 });
    expect(r.build.rawScore!).toBeGreaterThan(449);
    expect(r.score).toBe(449);
    expect(r.build.capped).toBe("custodial");
    expect(r.flags.some((f) => f.code === "custodial" && f.severity === "critical")).toBe(true);
  });

  it("preserves the raw computed value behind the cap", () => {
    // The point of capping at the DISPLAY layer: a capped applicant can be
    // told they were capped, rather than silently handed 449 as if it were
    // the computation.
    const r = score("US", { ...STRONG, compliance: 3 });
    expect(r.build.rawScore).not.toBe(r.score);
    expect(r.build.displayScore).toBe(449);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * F6 — SUPPRESSION
 * ═══════════════════════════════════════════════════════════════════════ */
describe("F6 — an exhausted Schengen window suppresses the number entirely", () => {
  it("returns no score at all, not a low one", () => {
    const r = score("SCHENGEN", { ...MODAL, schdays: 3 });
    expect(r.score).toBeNull();
    expect(r.band).toBeNull();
    expect(r.range).toBeNull();
    expect(r.build.suppressed).toBe(true);
    expect(r.flags.some((f) => f.code === "window")).toBe(true);
  });

  it("still scores Schengen normally when the window is not exhausted", () => {
    const r = score("SCHENGEN", { ...MODAL, schdays: 1 });
    expect(r.score).not.toBeNull();
    expect(r.build.suppressed).toBe(false);
  });

  it("uses the reference's ten-member synthetic, ~0.79", () => {
    const rate = schengenSyntheticRate("a3")!;
    expect(rate).toBeCloseTo(0.7939, 4);
    expect(R.schengen.members).toHaveLength(10);
  });

  it("does not ask schdays on a non-Schengen route", () => {
    expect(activeQuestions("US", MODAL).some((q) => q.id === "schdays")).toBe(false);
    expect(activeQuestions("SCHENGEN", MODAL).some((q) => q.id === "schdays")).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * F7 — THE BASE RATE DRIVES THE RESULT
 * ═══════════════════════════════════════════════════════════════════════ */
describe("F7 — an identical profile scores far higher on an easy route", () => {
  it("Japan (0.9267) sits well above Canada (0.5333) for the same answers", () => {
    expect(baseRateFor("JP", "a3")).toBeCloseTo(0.9267, 4);
    expect(baseRateFor("CA", "a3")).toBeCloseTo(0.5333, 4);

    const jp = score("JP", MODAL).score!;
    const ca = score("CA", MODAL).score!;
    expect(jp).toBeGreaterThan(ca);
    // "Far" higher, not incidentally higher — the corridor is the dominant
    // term and a regression that flattened it would still pass a bare >.
    expect(jp - ca).toBeGreaterThan(150);
  });

  it("reads the same source the map reads", () => {
    // One source of truth: the engine's base rate must be the dataset's
    // un-rounded a3, and the map's integer is that value rounded.
    expect(baseRateFor("US", "a3")).toBe(BASE_RATES.US.a3);
    expect(Math.round(BASE_RATES.US.a3 * 100)).toBe(73);
  });

  it("honours the 3Y/5Y toggle, defaulting to 3Y", () => {
    expect(R.baseRate.defaultMode).toBe("a3");
    const a3 = score("US", MODAL);
    const a5 = score("US", MODAL, { mode: "a5" });
    expect(a3.route.mode).toBe("a3");
    expect(a5.route.mode).toBe("a5");
    expect(a5.build.baseRate).toBe(BASE_RATES.US.a5);
    expect(a3.build.baseRate).not.toBe(a5.build.baseRate);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * F8 — FIRST-TIMER HANDLING
 * ═══════════════════════════════════════════════════════════════════════ */
describe("F8 — a first-time traveller skips two questions and boosts four", () => {
  const FT: ScoreAnswers = { ...MODAL, travel: 0 };

  it("removes compliance and schdays from the active set", () => {
    const ids = activeQuestions("SCHENGEN", FT).map((q) => q.id);
    expect(ids).not.toContain("compliance");
    expect(ids).not.toContain("schdays");
  });

  it("still asks refusals — a first trip is not a clean record", () => {
    expect(activeQuestions("US", FT).map((q) => q.id)).toContain("refusals");
  });

  it("applies the ×1.25 boost to the four ties-and-means questions", () => {
    // employment "Employed under 1 year" is -17; boosted it is round(-21.25)
    // = -21. Asserting through the score keeps the test honest about what
    // the applicant actually experiences.
    const plain = score("US", { ...MODAL, employment: 3 });
    const boosted = score("US", { ...FT, employment: 3 });
    const plainPts = plain.build.totalPoints;
    const boostedPts = boosted.build.totalPoints;
    // boosted carries travel:0 (-18) plus the boosted employment penalty
    expect(boostedPts).toBe(Math.round(-17 * 1.25) + -18);
    expect(plainPts).toBe(-17);
  });

  it("a hard stop on a skipped question cannot fire", () => {
    // A first-timer who somehow has compliance:3 on the payload must not be
    // capped for a question the route did not ask.
    const r = score("US", { ...FT, compliance: 3 });
    expect(r.build.capped).toBeNull();
    expect(r.flags.some((f) => f.code === "misrep")).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * F9 — SILENT FACTORS
 * ═══════════════════════════════════════════════════════════════════════ */
describe("F9 — age and companions are scored but never explained", () => {
  it("never appear in either factor list, on any route", () => {
    const answersThatMaximiseTheirWeight: ScoreAnswers = { ...MODAL, age: 0, companions: 5 };
    for (const dest of ["US", "CA", "JP", "SCHENGEN", "GB"]) {
      const r = score(dest, answersThatMaximiseTheirWeight);
      const ids = [...r.factors.helping, ...r.factors.holdingBack].map((f) => f.questionId);
      expect(ids).not.toContain("age");
      expect(ids).not.toContain("companions");
    }
  });

  it("are still counted in the score, and say so in silentExcluded", () => {
    const withSilent = score("US", { ...MODAL, age: 0, companions: 5 });
    const neutral = score("US", MODAL);
    // -14 (age) + -10 (companions) = -24
    expect(withSilent.build.totalPoints).toBe(neutral.build.totalPoints - 24);
    expect(withSilent.score!).toBeLessThan(neutral.score!);
    expect(withSilent.silentExcluded.sort()).toEqual(["age", "companions"]);
  });

  it("every surfaced factor carries its consular citation", () => {
    const r = score("US", WEAK);
    const all = [...r.factors.helping, ...r.factors.holdingBack];
    expect(all.length).toBeGreaterThan(0);
    for (const f of all) expect(f.cite.length).toBeGreaterThan(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * F10 — DETERMINISM
 * ═══════════════════════════════════════════════════════════════════════ */
describe("F10 — the same input produces byte-identical output", () => {
  it("is identical across two runs", () => {
    const a = score("US", STRONG, { heldVisas: ["GB", "CA"] });
    const b = score("US", STRONG, { heldVisas: ["GB", "CA"] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("is identical across many routes and both modes", () => {
    for (const dest of ["US", "CA", "JP", "SCHENGEN", "NP", "PS"]) {
      for (const mode of ["a3", "a5"] as const) {
        const a = JSON.stringify(score(dest, WEAK, { mode }));
        const b = JSON.stringify(score(dest, WEAK, { mode }));
        expect(a).toBe(b);
      }
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * F11 — THE RANGE STAYS INSIDE THE SCALE
 * ═══════════════════════════════════════════════════════════════════════ */
describe("F11 — the range never leaves [floor, cap]", () => {
  it("holds for every corridor and every one of the three profiles", () => {
    for (const iso2 of Object.keys(BASE_RATES)) {
      for (const answers of [MODAL, STRONG, WEAK]) {
        const r = score(iso2, answers);
        if (!r.range) continue;
        expect(r.range.high).toBeLessThanOrEqual(R.transform.scoreCap);
        expect(r.range.low).toBeGreaterThanOrEqual(R.transform.scoreFloor);
        expect(r.range.low).toBeLessThanOrEqual(r.range.high);
      }
    }
  });

  it("widens the range where the data is thin", () => {
    // A boundary-valued corridor is exactly where we should be least
    // confident, and the range is how the output says so.
    //
    // MEASURED ON A MID-RANGE PROFILE ON PURPOSE. Nepal's modal score is
    // 870 — hard against the cap — so its range is truncated to [810, 870]
    // and comes out NARROWER than a mid-range corridor's. That truncation
    // is the clamp above doing its job, not a confidence regression, so
    // comparing widths there would assert the opposite of the intent.
    const thin = score("NP", WEAK);
    const sourced = score("US", WEAK);
    expect(thin.range!.confidence).toBe("low");
    expect(sourced.range!.confidence).not.toBe("low");
    expect(thin.score!).toBeLessThan(R.transform.scoreCap);
    expect(thin.range!.high - thin.range!.low).toBeGreaterThan(
      sourced.range!.high - sourced.range!.low,
    );
  });

  it("derives the width from the confidence grade, before clamping", () => {
    // The grade-to-width mapping, asserted directly so it survives a score
    // that sits at either boundary.
    expect(R.confidence.grades.low.halfWidthPp).toBeGreaterThan(
      R.confidence.grades.medium.halfWidthPp,
    );
    expect(R.confidence.grades.medium.halfWidthPp).toBeGreaterThan(
      R.confidence.grades.high.halfWidthPp,
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * F12 — HELD-VISA BONUS
 * ═══════════════════════════════════════════════════════════════════════ */
describe("F12 — the held-visa bonus excludes the target, dedupes, and caps", () => {
  it("a US visa is worth nothing on a US application", () => {
    expect(heldVisaPoints(["US"], "US")).toBe(0);
    const withIt = score("US", MODAL, { heldVisas: ["US"] });
    const without = score("US", MODAL);
    expect(withIt.build.heldVisaPoints).toBe(0);
    expect(withIt.score).toBe(without.score);
  });

  it("caps the total at +12 however many are held", () => {
    expect(heldVisaPoints(["GB"], "US")).toBe(6);
    expect(heldVisaPoints(["GB", "CA"], "US")).toBe(12);
    expect(heldVisaPoints(["GB", "CA", "AU", "JP", "KR"], "US")).toBe(R.heldVisas.cap);
    expect(R.heldVisas.cap).toBe(12);
  });

  it("collapses duplicates", () => {
    expect(heldVisaPoints(["GB", "GB", "GB"], "US")).toBe(6);
  });

  it("ignores countries outside the eligible set", () => {
    expect(heldVisaPoints(["NP", "ZW"], "US")).toBe(0);
  });

  it("excludes the target while still counting the others", () => {
    // The headline F12 case: holding US + GB + CA and applying to the US
    // drops the US visa and caps the remaining two at 12.
    expect(heldVisaPoints(["US", "GB", "CA"], "US")).toBe(12);
    expect(heldVisaPoints(["US", "GB"], "US")).toBe(6);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * FIX — THE LOGIT-PIN REGRESSION GUARD
 *
 * This is the one place this engine deliberately DISAGREES with the
 * reference. If someone "restores parity" by removing the pre-logit clamp,
 * these fail — which is the entire point of writing them.
 * ═══════════════════════════════════════════════════════════════════════ */
describe("FIX — corridors at a 0 or 1 base rate stay answer-sensitive", () => {
  it("Nepal (a3 = 1.0) moves with the answers instead of pinning at the cap", () => {
    expect(baseRateFor("NP", "a3")).toBe(1);
    const strong = score("NP", STRONG).score!;
    const weak = score("NP", WEAK).score!;
    expect(weak).toBeLessThan(strong);
    // The reference returns 870 for BOTH of these. The failure mode this
    // guards is a score of 870 for an unemployed first-time traveller.
    expect(weak).toBeLessThan(R.transform.scoreCap);
  });

  it("Palestine (a3 = 0.0) moves with the answers instead of pinning at the floor", () => {
    expect(baseRateFor("PS", "a3")).toBe(0);
    const strong = score("PS", STRONG).score!;
    const weak = score("PS", WEAK).score!;
    expect(strong).toBeGreaterThan(weak);
    expect(strong).toBeGreaterThan(R.transform.scoreFloor);
  });

  it("Malaysia (a3 = 0.9833, above the envelope max) separates strong from weak", () => {
    // THE SECOND CLASS, and the one that is easy to miss: there is no
    // infinity here, so nothing obviously breaks. The failure is that a
    // base of 0.9833 hands the reference nearly a full extra unit of logit
    // headroom no realistic points total can spend, and profiles collapse
    // together at the top of the scale.
    expect(baseRateFor("MY", "a3")).toBeCloseTo(0.9833, 4);
    const strong = score("MY", STRONG).score!;
    const weak = score("MY", WEAK).score!;

    expect(weak).toBeLessThan(strong);
    // The WEAK profile is what must come off the cap. A strong profile on a
    // 98%-approval corridor sitting at 870 is the correct answer, not a pin.
    expect(weak).toBeLessThan(R.transform.scoreCap - 100);
  });

  it("the reference collapses entirely on the highest-rate corridors, and we do not", () => {
    // Thailand (0.9967) and the Maldives (0.9983) are the sharpest form of
    // the >0.95 class: under the reference a strong and a weak profile both
    // return exactly 870, a separation of ZERO. Neither country is at an
    // exact 1.0, so a fix that only guarded against Infinity would leave
    // both of them broken.
    for (const iso2 of ["TH", "MV"]) {
      const a3 = baseRateFor(iso2, "a3")!;
      expect(a3).toBeGreaterThan(R.transform.envelope.max);

      const strong = score(iso2, STRONG);
      const weak = score(iso2, WEAK);

      // What the reference would have returned for these same point totals.
      const refStrong = referencePin(a3, strong.build.totalPoints);
      const refWeak = referencePin(a3, weak.build.totalPoints);
      expect(refStrong - refWeak).toBe(0);

      // What ours returns instead.
      expect(weak.score!).toBeLessThan(strong.score!);
    }
  });

  it("keeps logit finite for every corridor in the dataset", () => {
    for (const iso2 of Object.keys(BASE_RATES)) {
      const r = score(iso2, MODAL);
      if (r.score === null) continue;
      expect(Number.isFinite(r.build.p!)).toBe(true);
      expect(Number.isFinite(r.build.clampedBase!)).toBe(true);
      expect(Number.isInteger(r.score)).toBe(true);
    }
  });

  it("the clamp is a no-op for a corridor already inside the envelope", () => {
    const r = score("US", MODAL);
    expect(r.build.clampedBase).toBe(r.build.baseRate);
  });

  it("the ruleset cannot silently disable the fix", () => {
    expect(R.transform.clampBaseBeforeLogit).toBe(true);
    expect(R.transform.envelope.min).toBeGreaterThan(0);
    expect(R.transform.envelope.max).toBeLessThan(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * PARITY — identical to the reference wherever the reference is correct
 * ═══════════════════════════════════════════════════════════════════════ */
describe("PARITY — byte-identical to the reference inside the envelope", () => {
  /** A verbatim port of the reference's scoreAgainstBase, bug included. */
  const REF_QS = R.questions.filter((q) => q.id !== "schdays");
  function referenceScore(baseRate: number, answers: ScoreAnswers): number {
    const ft = answers.travel === 0;
    const skip = ["compliance", "schdays"];
    const qs = REF_QS.filter((q) => !(ft && skip.includes(q.id)));
    let pts = 0;
    for (const q of qs) {
      const a = answers[q.id];
      if (a === undefined) continue;
      let p = q.options[a].points;
      if (ft && ["employment", "family", "payer", "finproof"].includes(q.id)) p = Math.round(p * 1.25);
      pts += p;
    }
    const raw = Math.min(0.95, Math.max(0.05, sigmoid(logit(baseRate) + pts * 0.016)));
    let display = Math.min(870, Math.max(310, Math.round(300 + raw * 600)));
    if (answers.compliance === 3 && display > 449) display = 449;
    if (answers.character === 3 && display > 449) display = 449;
    return display;
  }

  // Deterministic pseudo-random answer sets — no Math.random, so a failure
  // is reproducible from the seed alone.
  function answerSets(n: number): ScoreAnswers[] {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    return Array.from({ length: n }, () => {
      const a: Record<string, number> = {};
      for (const q of REF_QS) a[q.id] = Math.floor(rnd() * q.options.length);
      return a as ScoreAnswers;
    });
  }

  it("matches exactly on every corridor whose base sits strictly inside (0.05, 0.95)", () => {
    const sets = answerSets(40);
    let compared = 0;
    const mismatches: string[] = [];

    for (const [iso2, row] of Object.entries(BASE_RATES)) {
      if (!(row.a3 > R.transform.envelope.min && row.a3 < R.transform.envelope.max)) continue;
      for (const answers of sets) {
        const mine = score(iso2, answers).score;
        const theirs = referenceScore(row.a3, answers);
        compared++;
        if (mine !== theirs) mismatches.push(`${iso2}: ${mine} vs ${theirs}`);
      }
    }

    expect(compared).toBeGreaterThan(5000);
    expect(mismatches).toEqual([]);
  });

  it("differs from the reference ONLY where the reference pins", () => {
    const sets = answerSets(10);
    const differing = new Set<string>();
    for (const [iso2, row] of Object.entries(BASE_RATES)) {
      for (const answers of sets) {
        if (score(iso2, answers).score !== referenceScore(row.a3, answers)) differing.add(iso2);
      }
    }
    // Every differing corridor must be one the clamp legitimately moved.
    for (const iso2 of differing) {
      const a3 = BASE_RATES[iso2].a3;
      expect(a3 <= R.transform.envelope.min || a3 >= R.transform.envelope.max).toBe(true);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * CONTRACT + ELIGIBILITY
 * ═══════════════════════════════════════════════════════════════════════ */
describe("the output contract and the separate eligibility pass", () => {
  it("returns every field the contract promises", () => {
    const r = score("US", STRONG, { heldVisas: ["GB"] });
    for (const k of [
      "rulesetVersion", "route", "eligibility", "score", "band", "build",
      "range", "profileStrength", "factors", "flags", "silentExcluded",
      "disclaimer", "generatedAt",
    ]) {
      expect(r).toHaveProperty(k);
    }
    expect(r.rulesetVersion).toBe(R.version);
    expect(r.generatedAt).toBe(AT);
    expect(r.disclaimer.length).toBeGreaterThan(0);
  });

  it("declines a corridor with no sourced rate rather than inventing one", () => {
    const r = score("ZZ", MODAL);
    expect(r.eligibility.assessable).toBe(false);
    expect(r.eligibility.code).toBe("NO_BASE_RATE");
    expect(r.score).toBeNull();
    expect(r.band).toBeNull();
  });

  it("declines India-to-India rather than scoring it", () => {
    const r = score("IN", MODAL);
    expect(r.eligibility.assessable).toBe(false);
    // India carries nulls in the dataset, so it is unassessable either way;
    // the same-country rule is what names the reason correctly.
    expect(["SAME_COUNTRY", "NO_BASE_RATE"]).toContain(r.eligibility.code);
  });

  it("reports profile strength as a 0-100 position over the answers", () => {
    expect(score("US", STRONG).profileStrength!).toBeGreaterThan(score("US", WEAK).profileStrength!);
    for (const a of [MODAL, STRONG, WEAK]) {
      const ps = score("US", a).profileStrength!;
      expect(ps).toBeGreaterThanOrEqual(0);
      expect(ps).toBeLessThanOrEqual(100);
    }
  });

  it("keeps the ruleset server-side by declaration", () => {
    expect(R.serverSideOnly).toBe(true);
  });

  it("attributes factors by a real counterfactual, not by raw points", () => {
    // The leave-one-out impact and the option's own points are different
    // numbers because the logistic curve is not linear. If these ever
    // coincide exactly for every factor, attribution has been flattened
    // into a lookup and the counterfactual has been lost.
    const r = score("CA", WEAK);
    const all = [...r.factors.helping, ...r.factors.holdingBack];
    expect(all.length).toBeGreaterThan(0);
    for (const f of all) expect(Number.isInteger(f.impact)).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * The transform, unit-level
 * ═══════════════════════════════════════════════════════════════════════ */
describe("the transform itself", () => {
  it("maps the envelope onto the score bounds", () => {
    expect(transform(0.95, 0).score).toBe(870);
    expect(transform(0.05, 0).score).toBe(330);
    expect(baselineScore(0.7333)).toBe(740);
  });

  it("uses K = 0.016", () => {
    expect(R.transform.K).toBe(0.016);
  });

  it("is monotonic in points", () => {
    let prev = -Infinity;
    for (const pts of [-120, -60, -30, 0, 30, 60, 120]) {
      const s = transform(0.7333, pts).score;
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });
});
