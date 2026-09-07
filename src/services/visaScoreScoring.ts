// apps/backend/src/services/visaScoreScoring.ts
//
// THE ONE SCORING PATH. Validate → normalise → compute → shape.
//
// ══════════════════════════════════════════════════════════════════════
// EXTRACTED SO TWO ENDPOINTS CANNOT DRIFT.
// ══════════════════════════════════════════════════════════════════════
// There are now three callers that must agree exactly on what a score is:
//
//   POST /api/public/visa-score/score     — anonymous, IP-limited
//   POST /api/consumer/visa-score/score   — session-gated, persists (Phase C)
//   POST /api/public/visa-score/lead      — recomputes to build the brief,
//                                           and now to persist on an email
//                                           that matches an account
//
// Before this file, the first and third each had their own copy of the
// compute-and-shape sequence inside routes/public.visaScore.ts. Adding a
// third copy in the consumer router would have been the point at which
// they started disagreeing — and the disagreement would not be loud. Two
// endpoints returning subtly different scores for the same answers is the
// kind of defect a person only notices as "the number moved when I signed
// in", which is exactly the trust this feature is trying to build.
//
// ── WHY THE RESPONSE SHAPE LIVES HERE TOO ────────────────────────────
// The field-by-field construction is not presentation, it is the §12.2
// firewall: routes/public.visaScore.ts's own comment explains that `result`
// is never spread because spreading it would ship whatever a future engine
// field holds — which is how a weight eventually leaks. That reasoning
// applies identically to the authed endpoint, so the allow-list is shared
// rather than re-typed. One place to audit, one place to get right.
//
// ── WHAT DELIBERATELY IS NOT HERE ────────────────────────────────────
// Rate limiting, authentication and persistence. Those differ per caller
// and belong to the route: the public one is IP-limited and writes
// nothing, the consumer one is session-gated and records the result. A
// service that decided any of those would make the two routes' security
// properties invisible from the route file, which is the opposite of what
// this codebase does everywhere else.
import {
  activeQuestions,
  computeVisaProfileScore,
  type ScoreAnswers,
  type VisaScoreResult,
} from "./visaProfileScore.js";
import { VISA_SCORE_RULESET as RULESET } from "../config/visaScoreRuleset.js";
import { findSeedCountry } from "../config/visaCountrySeed.js";
import { APPROVAL_ESTIMATE_DISCLAIMER, type BaseRateMode } from "../utils/visaDifficulty.js";
import { publicFactorShape } from "./visaScoreSafeBreakdown.js";

const ISO2 = /^[A-Z]{2}$/;

export type ScoreMode = "score" | "indicative" | "suppressed" | "no_visa" | "blocked";

/**
 * Which of the five shapes this route/destination combination is in.
 *
 * Moved here from routes/public.visaScore.ts unchanged; that module
 * re-exports it so its existing importers and tests are unaffected.
 */
export function resolveScoreMode(
  destinationIso2: string,
  engine: { eligibility: { assessable: boolean }; build: { suppressed: boolean } },
): ScoreMode {
  const dest = String(destinationIso2 ?? "").toUpperCase();

  // SCHENGEN is the ruleset's synthetic and has no seed row of its own; it
  // is unambiguously a visa route, so it skips the two category checks.
  if (dest !== RULESET.schengen.code) {
    const seed = findSeedCountry(dest);
    if (seed?.visaCategory === "VISA_FREE") return "no_visa";
    if (seed?.visaCategory === "RESTRICTED") return "blocked";
  }

  if (!engine.eligibility.assessable) return "indicative";
  if (engine.build.suppressed) return "suppressed";
  return "score";
}

export function destinationNameFor(iso2: string): string | null {
  if (iso2 === RULESET.schengen.code) return RULESET.schengen.name;
  return findSeedCountry(iso2)?.countryName ?? null;
}

/**
 * Every reason this body cannot be scored, or an empty array.
 *
 * Moved verbatim from the public route. It returns a LIST rather than
 * throwing on the first problem so a caller can report everything wrong at
 * once, and it names option INDEXES rather than labels — an error string
 * is a log line waiting to happen, and "character: 3" would defeat the
 * redaction the route applies before logging.
 */
export function validateScoreBody(body: any): string[] {
  const errors: string[] = [];

  const passport = String(body?.passport ?? "").trim().toUpperCase();
  if (!ISO2.test(passport)) errors.push("passport must be an ISO 3166-1 alpha-2 code");

  const destination = String(body?.destination ?? "").trim().toUpperCase();
  const isSchengen = destination === RULESET.schengen.code;
  if (!isSchengen && !ISO2.test(destination)) {
    errors.push(`destination must be an ISO 3166-1 alpha-2 code or "${RULESET.schengen.code}"`);
  }

  if (body?.mode !== undefined && !RULESET.baseRate.modes.includes(String(body.mode))) {
    errors.push(`mode must be one of ${RULESET.baseRate.modes.join(", ")}`);
  }

  const answers = body?.answers;
  if (answers === undefined || answers === null || typeof answers !== "object" || Array.isArray(answers)) {
    errors.push("answers must be an object of questionId -> option index");
    return errors;
  }

  /* Each answer must name a real question and select a real option.
   * Rejecting an out-of-range index rather than coercing it matters: the
   * engine reads `q.options[i].points`, and an index past the end would
   * silently contribute 0 — a wrong score returned with full confidence. */
  for (const [id, value] of Object.entries(answers as Record<string, unknown>)) {
    const q = RULESET.questions.find((x) => x.id === id);
    if (!q) { errors.push(`unknown question "${id}"`); continue; }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= q.options.length) {
      errors.push(`answer for "${id}" must be an integer option index in 0..${q.options.length - 1}`);
    }
  }

  const held = body?.heldVisas;
  if (held !== undefined) {
    if (!Array.isArray(held)) errors.push("heldVisas must be an array of ISO 3166-1 alpha-2 codes");
    else if (held.some((h: unknown) => typeof h !== "string")) errors.push("heldVisas must contain only strings");
  }

  return errors;
}

export interface NormalisedScoreInput {
  passport: string;
  destination: string;
  mode: BaseRateMode;
}

/** The three normalised scalars, once, so no caller re-derives them. */
export function normaliseScoreBody(body: any): NormalisedScoreInput {
  return {
    passport: String(body.passport).trim().toUpperCase(),
    destination: String(body.destination).trim().toUpperCase(),
    mode: (body.mode ? String(body.mode) : RULESET.baseRate.defaultMode) as BaseRateMode,
  };
}

/**
 * Compute a score from an ALREADY-VALIDATED body.
 *
 * `generatedAt` is minted by the caller and injected, never read from a
 * clock inside the engine: computeVisaProfileScore is a pure function and
 * has to stay one, because the determinism fixture compares it against
 * itself. This is the only non-deterministic value in the response.
 *
 * THE SCORE IS ALWAYS COMPUTED HERE, NEVER ACCEPTED FROM A CLIENT. Both
 * the consumer endpoint and the lead handler persist what this returns —
 * a route that took a score from the request body and wrote it down would
 * be the "unauthenticated-score-shaped hole" routes/consumer.visaScore.ts
 * refuses to open.
 */
export function computeScoreFromBody(
  body: any,
  generatedAt: string = new Date().toISOString(),
): { result: VisaScoreResult; scoreMode: ScoreMode; input: NormalisedScoreInput } {
  const input = normaliseScoreBody(body);

  const result = computeVisaProfileScore({
    passportIso2: input.passport,
    destinationIso2: input.destination,
    answers: body.answers as ScoreAnswers,
    heldVisas: Array.isArray(body.heldVisas) ? body.heldVisas.map(String) : undefined,
    mode: input.mode,
    generatedAt,
  });

  return { result, scoreMode: resolveScoreMode(input.destination, result), input };
}

/**
 * THE RESPONSE, FIELD BY NAMED FIELD.
 *
 * Constructed, never spread. `result` is the engine's own object and
 * spreading it would ship whatever a future engine field holds — which is
 * exactly how a weight would eventually leak. Shared by the public and the
 * consumer endpoint so a field added for one is a deliberate decision for
 * both.
 */
export function scoreResponsePayload(
  result: VisaScoreResult,
  scoreMode: ScoreMode,
  destination: string,
) {
  return {
    ok: true as const,
    mode: scoreMode,
    rulesetVersion: result.rulesetVersion,
    route: {
      passport: result.route.passportIso2,
      destination: result.route.destinationIso2,
      destinationName: result.route.destinationName ?? destinationNameFor(destination),
      averagingWindow: result.route.mode,
      synthetic: result.route.synthetic,
    },
    eligibility: result.eligibility,
    score: result.score,
    band: result.band,
    range: result.range,
    profileStrength: result.profileStrength,
    /* BUCKETED, never the raw leave-one-out number — see
     * visaScoreSafeBreakdown.ts's impact-firewall block. A per-question
     * point figure here collapsed §12.2's ~5-calls-per-question
     * extraction cost to one call. */
    factors: {
      helping: result.factors.helping.map(publicFactorShape),
      holdingBack: result.factors.holdingBack.map(publicFactorShape),
    },
    flags: result.flags,
    silentExcluded: result.silentExcluded,
    /* The arithmetic trail MINUS the model. baseRate and baseScore are the
     * corridor's published rate and where an average applicant starts —
     * both already disclosed on /routes and the public map. `totalPoints`,
     * `p` and `clampedBase` are NOT here: a points total returned beside a
     * known answer set is a direct read of the deltas, and it is the single
     * most extractable field in the whole contract. rawScore stays, because
     * a capped applicant is entitled to know they were capped. */
    build: {
      baseRate: result.build.baseRate,
      baseScore: result.build.baseScore,
      rawScore: result.build.rawScore,
      displayScore: result.build.displayScore,
      capped: result.build.capped,
      suppressed: result.build.suppressed,
    },
    disclaimer: result.disclaimer,
    approvalDataDisclaimer: APPROVAL_ESTIMATE_DISCLAIMER,
    generatedAt: result.generatedAt,
  };
}

/**
 * Has this person actually FINISHED the assessment?
 *
 * The gauge re-scores after every answer — that is the product — so a
 * signed-in assessment sends roughly fifteen score requests. Persisting on
 * each one would write fifteen rows for one sitting and turn the account
 * page's progression into a transcript of someone thinking. The consumer
 * endpoint therefore records only a COMPLETE answer set.
 *
 * "Complete" is not "fourteen answers". Which questions are in play depends
 * on the route (schdays is Schengen-only) and on the first-timer skip
 * (§4.4 REMOVES questions rather than scoring them as zero) — so the set
 * shrinks as someone answers. This delegates to activeQuestions(), the
 * engine's own resolver, rather than restating the rule: a second copy
 * would be a second thing to update when the ruleset gains a conditional
 * question, and the failure would be silent — assessments quietly never
 * persisting, which is the exact bug Phase C exists to fix.
 *
 * The decision is the SERVER's. A client flag would let a caller ask for a
 * row on every keystroke.
 */
export function isCompleteAnswerSet(destination: string, answers: ScoreAnswers): boolean {
  const active = activeQuestions(destination, answers);
  if (active.length === 0) return false;
  return active.every((q) => typeof (answers as Record<string, unknown>)[q.id] === "number");
}
