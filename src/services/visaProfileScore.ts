// apps/backend/src/services/visaProfileScore.ts
//
// THE VISA PROFILE SCORE — a deterministic readiness index, not a
// prediction.
//
// ══════════════════════════════════════════════════════════════════════
// WHAT THIS NUMBER IS, AND WHAT IT IS NOT
// ══════════════════════════════════════════════════════════════════════
// It takes a corridor's HISTORICAL approval rate for Indian applicants —
// a real, published-ish statistic about a destination — and moves it up or
// down by how this applicant's answers compare to the modal applicant on
// that route. It is an advisory readiness index.
//
// It is NOT a probability that this person will be approved. Nothing in
// this system has ever observed a visa outcome (see the roster routes'
// headers: not one application in production has reached an issued
// outcome), so there is no data anywhere that could calibrate a personal
// probability, and the internal `p` below must never be rendered as one.
// The output carries `disclaimer` for exactly this reason and every
// surface is expected to show it.
//
// ══════════════════════════════════════════════════════════════════════
// DETERMINISM IS A CONTRACT, NOT AN ASPIRATION
// ══════════════════════════════════════════════════════════════════════
// Same inputs, byte-identical output. That means, in the compute path:
// no I/O, no Date.now(), no Math.random(), no network, no model call.
//
// `generatedAt` is REQUIRED on the input rather than read from the clock.
// A function that stamps its own timestamp cannot be compared to itself,
// and fixture F10 asserts two runs are identical — which would be
// unwritable if this reached for `new Date()`.
//
// The two data reads (base rates, ruleset) happen at MODULE INIT in the
// modules that own them and are frozen there, so by the time this function
// runs there is nothing left to read.
//
// ══════════════════════════════════════════════════════════════════════
// THE FIVE LAYERS
// ══════════════════════════════════════════════════════════════════════
//   L1  base rate    — the corridor's historical rate, from the SAME
//                      source the Global Map prints (baseRateFor).
//   L2  deltas       — zero-centered question points, first-timer skip
//                      and boost, held-visa bonus.
//   L3  transform    — clamp -> logit -> +K*pts -> sigmoid -> clamp -> score.
//   L4  attribution  — leave-one-out impacts, silent factors excluded.
//   L5  presentation — band, range, flags, hard stops at the DISPLAY layer.
import {
  VISA_SCORE_RULESET,
  type VisaScoreRuleset,
  type RulesetQuestion,
  type FlagSeverity,
  type ConfidenceGrade,
  type ScoreDimension,
} from "../config/visaScoreRuleset.js";
import {
  BASE_RATES,
  baseRateFor,
  DEFAULT_BASE_RATE_MODE,
  type BaseRateMode,
} from "../utils/visaDifficulty.js";

/* ═══════════════════════════════════════════════════════════════════════
 * INPUT / OUTPUT CONTRACT (KT spec section 6)
 * ═══════════════════════════════════════════════════════════════════════ */

/** Answers are questionId -> selected OPTION INDEX. Absent = unanswered. */
export type ScoreAnswers = Readonly<Record<string, number>>;

export interface VisaScoreInput {
  /** Applicant's passport, iso2. Today's dataset is India-origin only. */
  passportIso2: string;
  /** Destination iso2, or the ruleset's synthetic Schengen code. */
  destinationIso2: string;
  answers: ScoreAnswers;
  /** iso2 codes of valid visas already held. See ruleset.heldVisas. */
  heldVisas?: readonly string[];
  /** Averaging window. Defaults to the ruleset's own default (3-year). */
  mode?: BaseRateMode;
  /** REQUIRED and injected — never read from the clock. See header. */
  generatedAt: string;
  /** Test/ops override. When absent the rate is resolved from BASE_RATES. */
  baseRateOverride?: number;
}

export interface ScoreFactor {
  questionId: string;
  questionText: string;
  dim: ScoreDimension;
  cite: string;
  answerLabel: string;
  /** Leave-one-out impact in DISPLAY points. */
  impact: number;
}

export interface ScoreFlag {
  code: string;
  severity: FlagSeverity;
  questionId: string;
  message: string;
}

export interface ScoreEligibility {
  /** Whether this route can be assessed at all. */
  assessable: boolean;
  code: "OK" | "NO_BASE_RATE" | "UNKNOWN_DESTINATION" | "SAME_COUNTRY";
  reason: string;
}

export interface VisaScoreResult {
  rulesetVersion: string;
  route: {
    passportIso2: string;
    destinationIso2: string;
    destinationName: string | null;
    mode: BaseRateMode;
    synthetic: boolean;
  };
  eligibility: ScoreEligibility;
  /** null when suppressed or unassessable. Never a guess. */
  score: number | null;
  band: { name: string; hex: string; note: string } | null;
  /** The arithmetic trail, so a cap reads as a cap and not as the number. */
  build: {
    baseRate: number | null;
    clampedBase: number | null;
    baseScore: number | null;
    totalPoints: number;
    heldVisaPoints: number;
    p: number | null;
    rawScore: number | null;
    displayScore: number | null;
    capped: string | null;
    suppressed: boolean;
  };
  range: { low: number; high: number; confidence: ConfidenceGrade; label: string } | null;
  /** 0..100 position of the given answers within the answerable span. */
  profileStrength: number | null;
  factors: { helping: ScoreFactor[]; holdingBack: ScoreFactor[] };
  flags: ScoreFlag[];
  /** Question ids scored but deliberately never explained. */
  silentExcluded: string[];
  disclaimer: string;
  generatedAt: string;
}

/* ═══════════════════════════════════════════════════════════════════════
 * MATH
 * ═══════════════════════════════════════════════════════════════════════ */

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
export function logit(p: number): number {
  return Math.log(p / (1 - p));
}
export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/* ═══════════════════════════════════════════════════════════════════════
 * L1 — BASE RATE
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * The Schengen synthetic.
 *
 * Schengen is not a country and has no row of its own, but it is one of
 * the most-asked corridors, so the reference builds it from its members.
 *
 * ── TEN MEMBERS, NOT TWENTY-NINE, AND THAT IS A DECISION ──────────────
 * utils/visaDifficulty.ts enumerates all 29 Schengen states for map
 * colouring. This averages the ruleset's ten, because that is what the
 * reference engine did and the ruling was to match it. The two lists give
 * different numbers, so the ruleset names its members explicitly rather
 * than reaching for the map's constant and silently drifting.
 *
 * Unweighted: a mean over member states, not over applications. A weighted
 * mean would be the better statistic and we do not hold the volumes to
 * build one; saying so here is cheaper than someone rediscovering it.
 */
export function schengenSyntheticRate(
  mode: BaseRateMode,
  ruleset: VisaScoreRuleset = VISA_SCORE_RULESET,
): number | null {
  const rows = ruleset.schengen.members
    .map((iso2) => BASE_RATES[iso2.toUpperCase()])
    .filter((r): r is NonNullable<typeof r> => Boolean(r));

  // All or nothing: a "Schengen average" missing three members is a
  // different statistic wearing the same label.
  if (rows.length !== ruleset.schengen.members.length) return null;

  const sum = rows.reduce((acc, r) => acc + (mode === "a5" ? r.a5 : r.a3), 0);
  const factor = 10 ** ruleset.schengen.precision;
  return Math.round((sum / rows.length) * factor) / factor;
}

/**
 * The Schengen synthetic's YEAR SERIES — the same unweighted mean, applied
 * per year slot.
 *
 * Not used by the score (which reads a3/a5), and here because the public
 * catalogue's trend chart would otherwise have nothing to draw for one of
 * the most-asked corridors. Same all-or-nothing rule as the rate: a member
 * missing a series would silently shorten the average for some years and
 * not others, which is a different statistic per point on the chart.
 */
export function schengenSyntheticSeries(
  ruleset: VisaScoreRuleset = VISA_SCORE_RULESET,
): number[] {
  const rows = ruleset.schengen.members
    .map((iso2) => BASE_RATES[iso2.toUpperCase()])
    .filter((r): r is NonNullable<typeof r> => Boolean(r));

  if (rows.length !== ruleset.schengen.members.length) return [];

  const length = rows[0]?.years.length ?? 0;
  if (length === 0 || rows.some((r) => r.years.length !== length)) return [];

  const factor = 10 ** ruleset.schengen.precision;
  return Array.from({ length }, (_, i) => {
    const sum = rows.reduce((acc, r) => acc + r.years[i], 0);
    return Math.round((sum / rows.length) * factor) / factor;
  });
}

function resolveBaseRate(
  input: VisaScoreInput,
  mode: BaseRateMode,
  ruleset: VisaScoreRuleset,
): { rate: number | null; synthetic: boolean; name: string | null } {
  if (typeof input.baseRateOverride === "number") {
    return { rate: input.baseRateOverride, synthetic: false, name: null };
  }
  const dest = String(input.destinationIso2 ?? "").toUpperCase();

  if (dest === ruleset.schengen.code) {
    return { rate: schengenSyntheticRate(mode, ruleset), synthetic: true, name: ruleset.schengen.name };
  }
  return { rate: baseRateFor(dest, mode), synthetic: false, name: null };
}

/**
 * Confidence in this corridor's base rate, which sets how wide the range is.
 *
 * Derived from the DATA, never authored per country: a row either carries a
 * published per-country figure, or a full five-year series, or neither. A
 * boundary-valued series (a year at exactly 0 or 1) is treated as thin
 * because those are the rows whose underlying counts are smallest — they
 * are also precisely the rows the pre-logit clamp exists for.
 */
export function confidenceFor(iso2: string, synthetic: boolean): ConfidenceGrade {
  if (synthetic) return "medium"; // an average of ten sourced members
  const row = BASE_RATES[String(iso2 ?? "").toUpperCase()];
  if (!row) return "low";
  const years = row.years ?? [];
  if (years.length === 0) return "low";
  if (years.some((y) => y <= 0 || y >= 1) || row.a3 <= 0 || row.a3 >= 1) return "low";
  if (years.length >= 5) return "medium";
  return "low";
}

/* ═══════════════════════════════════════════════════════════════════════
 * L2 — DELTAS
 * ═══════════════════════════════════════════════════════════════════════ */

/** The questions in play for this route, after the first-timer skip. */
export function activeQuestions(
  destinationIso2: string,
  answers: ScoreAnswers,
  ruleset: VisaScoreRuleset = VISA_SCORE_RULESET,
): RulesetQuestion[] {
  const dest = String(destinationIso2 ?? "").toUpperCase();
  const ft = isFirstTimer(answers, ruleset);

  return ruleset.questions.filter((q) => {
    // Route-conditional questions (schdays is Schengen-only).
    if (q.appliesTo && !q.appliesTo.map((c) => c.toUpperCase()).includes(dest)) return false;
    // Section 4.4 — REMOVED from the set, not answered as zero.
    if (ft && ruleset.firstTimer.skipQuestions.includes(q.id)) return false;
    return true;
  });
}

export function isFirstTimer(
  answers: ScoreAnswers,
  ruleset: VisaScoreRuleset = VISA_SCORE_RULESET,
): boolean {
  return answers[ruleset.firstTimer.triggerQuestion] === ruleset.firstTimer.triggerOptionIndex;
}

/** One question's contribution, with the first-timer boost applied. */
function pointsFor(
  q: RulesetQuestion,
  optionIndex: number,
  firstTimer: boolean,
  ruleset: VisaScoreRuleset,
): number {
  const raw = q.options[optionIndex]?.points ?? 0;
  if (firstTimer && ruleset.firstTimer.boostQuestions.includes(q.id)) {
    // Math.round, matching the reference exactly — not Math.trunc, and not
    // left as a float. A half-point here would desync every fixture.
    return Math.round(raw * ruleset.firstTimer.boostMultiplier);
  }
  return raw;
}

/**
 * Section 4.6 — the held-visa bonus.
 *
 * Three rules, and each exists because dropping it breaks the claim:
 *   • the TARGET country's own visa is excluded — telling a US officer you
 *     hold a US visa adds nothing they cannot already see;
 *   • duplicates collapse, so listing the same country twice is not worth
 *     twice as much;
 *   • the total is capped, so a visa collector cannot buy an unbounded
 *     bonus that swamps every ties-and-means answer.
 * Fixture F12 pins all three.
 */
export function heldVisaPoints(
  heldVisas: readonly string[] | undefined,
  destinationIso2: string,
  ruleset: VisaScoreRuleset = VISA_SCORE_RULESET,
): number {
  const cfg = ruleset.heldVisas;
  if (!cfg.enabled || !heldVisas?.length) return 0;

  const dest = String(destinationIso2 ?? "").toUpperCase();
  const eligible = new Set(cfg.eligible.map((c) => c.toUpperCase()));

  const counted = new Set<string>();
  let total = 0;
  for (const v of heldVisas) {
    const code = String(v ?? "").toUpperCase();
    if (!eligible.has(code)) continue;
    if (cfg.excludeTargetCountry && code === dest) continue;
    if (cfg.excludeDuplicates && counted.has(code)) continue;
    counted.add(code);
    total += cfg.pointsPerVisa;
  }
  return Math.min(total, cfg.cap);
}

function sumPoints(
  questions: RulesetQuestion[],
  answers: ScoreAnswers,
  firstTimer: boolean,
  ruleset: VisaScoreRuleset,
  omitQuestionId?: string,
): number {
  let total = 0;
  for (const q of questions) {
    if (q.id === omitQuestionId) continue;
    const a = answers[q.id];
    if (a === undefined) continue;
    total += pointsFor(q, a, firstTimer, ruleset);
  }
  return total;
}

/* ═══════════════════════════════════════════════════════════════════════
 * L3 — TRANSFORM (with THE FIX)
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * base + points -> score.
 *
 * ══════════════════════════════════════════════════════════════════════
 * THE PRE-LOGIT CLAMP IS THE BUG FIX. DO NOT "SIMPLIFY" IT AWAY.
 * ══════════════════════════════════════════════════════════════════════
 * The reference engine computes `sig(logit(baseRate) + pts*K)` and clamps
 * only AFTERWARDS. That is fine for the 147 countries whose base rate sits
 * strictly inside the envelope — and wrong for the 47 that do not.
 *
 * ── THE 47, IN THREE CLASSES ──────────────────────────────────────────
 * It is NOT only the exact-0/1 rows, which is the easy thing to assume and
 * the reason this count is spelled out rather than left as "the extremes":
 *
 *   19  a3 or a5 at EXACTLY 0 or 1 — BB BT DM FJ GD JM KN LC MU NP PS RW
 *       SC SN TO TV VC WS ZM. logit(1) is +Infinity; adding points to
 *       infinity is still infinity; sigmoid saturates to exactly 1; the
 *       post-hoc clamp pins it at the envelope max and the score comes out
 *       870 NO MATTER WHAT THE APPLICANT ANSWERED. Palestine (0) pins at
 *       the floor the same way. Verified against the reference: Rwanda
 *       returns 870 at 0, -50, -100 AND -150 points.
 *
 *   26  ABOVE the envelope max (>0.95) — AE AZ DJ ET FM ID KH KM KZ LK MV
 *       MW MY OM PW QA SA SB SR ST TG TH TL TT TZ UG. No infinity here, so
 *       this class is easy to miss, and it fails the same way for a subtler
 *       reason: a base of 0.9833 (Malaysia) hands the reference nearly a
 *       full extra unit of logit headroom that no realistic points total
 *       can spend, so strong and weak profiles collapse onto 870 together.
 *
 *    2  BELOW the envelope min (<0.05) — UA YE. The mirror case, stuck at
 *       the floor.
 *
 * A score that cannot move is not a score, and one that reads 870 for an
 * unemployed first-time traveller with a deportation on file is worse than
 * no score at all.
 *
 * Clamping the base INTO the envelope first keeps logit finite AND caps the
 * headroom, so the points term does what it is there to do on all three
 * classes. For every country already inside the envelope the clamp is a
 * no-op and the output is byte-identical to the reference — which is what
 * lets the fixtures assert both things at once (see the PARITY block:
 * 5,800 comparisons, zero in-envelope differences).
 */
export function transform(
  baseRate: number,
  points: number,
  ruleset: VisaScoreRuleset = VISA_SCORE_RULESET,
): { clampedBase: number; p: number; score: number } {
  const { envelope, K, scoreBase, scoreSpan, scoreFloor, scoreCap } = ruleset.transform;

  const clampedBase = ruleset.transform.clampBaseBeforeLogit
    ? clamp(baseRate, envelope.min, envelope.max)
    : baseRate;

  const p = clamp(sigmoid(logit(clampedBase) + points * K), envelope.min, envelope.max);
  const score = clamp(Math.round(scoreBase + p * scoreSpan), scoreFloor, scoreCap);

  return { clampedBase, p, score };
}

/** The route's baseline — where a modal applicant starts, before answers. */
export function baselineScore(
  baseRate: number,
  ruleset: VisaScoreRuleset = VISA_SCORE_RULESET,
): number {
  return transform(baseRate, 0, ruleset).score;
}

/* ═══════════════════════════════════════════════════════════════════════
 * L4 — PROFILE STRENGTH
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * Where the given answers sit within the span of answers that COULD have
 * been given, 0..100.
 *
 * This is the honest single figure: it is a statement about the answers,
 * min-max normalised against the same questions' own best and worst
 * options. It says nothing about outcomes and needs no calibration, which
 * is exactly why it survives where a percentage would not.
 *
 * Silent questions are INCLUDED here — they are scored, so excluding them
 * would make strength disagree with the score it sits beside. They are
 * excluded from `factors`, which is a different promise: scored, but never
 * used to explain a result back to a person.
 */
export function profileStrength(
  questions: RulesetQuestion[],
  answers: ScoreAnswers,
  firstTimer: boolean,
  ruleset: VisaScoreRuleset = VISA_SCORE_RULESET,
): number | null {
  let sum = 0, lo = 0, hi = 0, answered = 0;

  for (const q of questions) {
    const a = answers[q.id];
    if (a === undefined) continue;
    answered++;
    const pts = q.options.map((_, i) => pointsFor(q, i, firstTimer, ruleset));
    sum += pointsFor(q, a, firstTimer, ruleset);
    lo += Math.min(...pts);
    hi += Math.max(...pts);
  }

  if (answered === 0) return null;
  if (hi === lo) return 50;
  return clamp(Math.round(((sum - lo) / (hi - lo)) * 100), 0, 100);
}

/* ═══════════════════════════════════════════════════════════════════════
 * THE ENGINE
 * ═══════════════════════════════════════════════════════════════════════ */

export function computeVisaProfileScore(
  input: VisaScoreInput,
  ruleset: VisaScoreRuleset = VISA_SCORE_RULESET,
): VisaScoreResult {
  const mode: BaseRateMode = input.mode ?? (ruleset.baseRate.defaultMode as BaseRateMode) ?? DEFAULT_BASE_RATE_MODE;
  const passportIso2 = String(input.passportIso2 ?? "").toUpperCase();
  const destinationIso2 = String(input.destinationIso2 ?? "").toUpperCase();
  const answers = input.answers ?? {};

  const { rate, synthetic, name } = resolveBaseRate({ ...input, destinationIso2 }, mode, ruleset);

  /* ── ELIGIBILITY — a SEPARATE deterministic pass, before any scoring ──
   * Kept out of the score rather than folded into it, because "we cannot
   * assess this route" and "this route assesses poorly" are different
   * statements and collapsing them would print a low score where the
   * honest answer is no score. */
  const eligibility: ScoreEligibility = !destinationIso2
    ? { assessable: false, code: "UNKNOWN_DESTINATION", reason: "No destination was given." }
    : passportIso2 && passportIso2 === destinationIso2
      ? { assessable: false, code: "SAME_COUNTRY", reason: "A passport holder does not apply for a visa to their own country." }
      : rate === null
        ? { assessable: false, code: "NO_BASE_RATE", reason: `No sourced approval rate is held for ${destinationIso2}, so this route cannot be assessed.` }
        : { assessable: true, code: "OK", reason: "A sourced base rate is available for this route." };

  const emptyResult = (): VisaScoreResult => ({
    rulesetVersion: ruleset.version,
    route: { passportIso2, destinationIso2, destinationName: name, mode, synthetic },
    eligibility,
    score: null,
    band: null,
    build: {
      baseRate: rate, clampedBase: null, baseScore: null, totalPoints: 0, heldVisaPoints: 0,
      p: null, rawScore: null, displayScore: null, capped: null, suppressed: false,
    },
    range: null,
    profileStrength: null,
    factors: { helping: [], holdingBack: [] },
    flags: [],
    silentExcluded: [],
    disclaimer: ruleset.disclaimer,
    generatedAt: input.generatedAt,
  });

  if (!eligibility.assessable || rate === null) return emptyResult();

  /* ── L2 ──────────────────────────────────────────────────────────── */
  const firstTimer = isFirstTimer(answers, ruleset);
  const questions = activeQuestions(destinationIso2, answers, ruleset);
  const answerPoints = sumPoints(questions, answers, firstTimer, ruleset);
  const bonus = heldVisaPoints(input.heldVisas, destinationIso2, ruleset);
  const totalPoints = answerPoints + bonus;

  /* ── L3 ──────────────────────────────────────────────────────────── */
  const { clampedBase, p, score: rawScore } = transform(rate, totalPoints, ruleset);
  const baseScore = baselineScore(rate, ruleset);

  /* ── L5a — HARD STOPS, AT THE DISPLAY LAYER ──────────────────────────
   * The raw computed value is preserved in `build.rawScore` throughout. A
   * cap that overwrote the computation would make the cap invisible, and
   * the one thing a capped applicant deserves is to be told they were
   * capped rather than quietly handed 449. */
  let displayScore: number | null = rawScore;
  let capped: string | null = null;
  let suppressed = false;
  const flags: ScoreFlag[] = [];

  for (const hs of ruleset.hardStops) {
    // A hard stop on a question the route skipped cannot fire — a
    // first-timer has no compliance history to have failed.
    if (!questions.some((q) => q.id === hs.question)) continue;
    if (answers[hs.question] !== hs.optionIndex) continue;

    flags.push({ code: hs.code, severity: hs.severity, questionId: hs.question, message: hs.message });

    if (hs.action === "suppress") {
      suppressed = true;
      displayScore = null;
    } else if (hs.action === "cap" && typeof hs.capAt === "number" && displayScore !== null && displayScore > hs.capAt) {
      displayScore = hs.capAt;
      capped = hs.code;
    }
  }
  // Suppression outranks a cap: if the window is exhausted there is no
  // number to cap. Re-applied after the loop so hard-stop ORDER in the
  // ruleset cannot change the outcome.
  if (suppressed) { displayScore = null; capped = null; }

  /* ── L4 — LEAVE-ONE-OUT ATTRIBUTION ──────────────────────────────────
   * Each factor's impact is measured by recomputing the score WITHOUT that
   * question and taking the difference — a real counterfactual, not a
   * restatement of the option's raw points. The two differ because the
   * logistic curve is not linear: the same -13 moves a mid-range route far
   * more than a near-saturated one.
   *
   * Silent questions never enter this list. They are scored (they are in
   * `totalPoints`) but they must never be shown as a reason, because
   * "your age is holding you back" is not something this product will say
   * to a person. Fixture F9 asserts it. */
  const helping: ScoreFactor[] = [];
  const holdingBack: ScoreFactor[] = [];
  const silentExcluded: string[] = [];

  for (const q of questions) {
    const a = answers[q.id];
    if (a === undefined) continue;
    if (q.silent) { silentExcluded.push(q.id); continue; }

    const without = sumPoints(questions, answers, firstTimer, ruleset, q.id) + bonus;
    const impact = rawScore - transform(rate, without, ruleset).score;
    if (impact === 0) continue;

    const factor: ScoreFactor = {
      questionId: q.id,
      questionText: q.text,
      dim: q.dim,
      cite: q.cite,
      answerLabel: q.options[a]?.label ?? "Selected",
      impact,
    };
    (impact > 0 ? helping : holdingBack).push(factor);

    // A materially negative answer earns a warning flag beside its citation
    // — the applicant can act on these, unlike the criticals above.
    if (q.options[a]?.points !== undefined && q.options[a].points <= ruleset.warningThreshold) {
      flags.push({ code: `weak:${q.id}`, severity: "warning", questionId: q.id, message: `${q.text} — assessed under ${q.cite}.` });
    }
  }

  helping.sort((x, y) => y.impact - x.impact || x.questionId.localeCompare(y.questionId));
  holdingBack.sort((x, y) => x.impact - y.impact || x.questionId.localeCompare(y.questionId));

  /* ── L5b — BAND AND RANGE ────────────────────────────────────────── */
  const band = displayScore === null
    ? null
    : (() => {
        const b = ruleset.bands.find((x) => displayScore! >= x.min) ?? ruleset.bands.at(-1)!;
        return { name: b.name, hex: b.hex, note: b.note };
      })();

  const confidence = confidenceFor(destinationIso2, synthetic);
  const halfWidth = Math.round(
    (ruleset.confidence.grades[confidence].halfWidthPp * ruleset.transform.scoreSpan) / 100,
  );
  const range = displayScore === null
    ? null
    : {
        // Clamped to the same bounds as the score itself, so the range can
        // never promise a number the scale does not contain. F11.
        low: clamp(displayScore - halfWidth, ruleset.transform.scoreFloor, ruleset.transform.scoreCap),
        high: clamp(displayScore + halfWidth, ruleset.transform.scoreFloor, ruleset.transform.scoreCap),
        confidence,
        label: ruleset.confidence.grades[confidence].label,
      };

  return {
    rulesetVersion: ruleset.version,
    route: { passportIso2, destinationIso2, destinationName: name, mode, synthetic },
    eligibility,
    score: displayScore,
    band,
    build: {
      baseRate: rate,
      clampedBase,
      baseScore,
      totalPoints,
      heldVisaPoints: bonus,
      p,
      rawScore,
      displayScore,
      capped,
      suppressed,
    },
    range,
    profileStrength: profileStrength(questions, answers, firstTimer, ruleset),
    factors: { helping, holdingBack },
    flags,
    silentExcluded,
    disclaimer: ruleset.disclaimer,
    generatedAt: input.generatedAt,
  };
}
