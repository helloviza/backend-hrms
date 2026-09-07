// apps/backend/src/services/visaScoreSafeBreakdown.ts
//
// THE ONE PLACE THE SENSITIVE-ANSWER RULE LIVES.
//
// ══════════════════════════════════════════════════════════════════════
// DPDP §12.7 — WHY THIS MODULE EXISTS AT ALL
// ══════════════════════════════════════════════════════════════════════
// `compliance` (overstays, removal, misrepresentation findings) and
// `character` (criminal history) are sensitive personal data. They are
// PROCESSED to produce a score and never persisted or logged in the clear.
//
// Until now that rule had exactly one enforcement point: a filter written
// inline inside routes/public.visaScore.ts's buildScoreBrief(), guarding
// the single writer the score surface had — the ops ticket.
//
// Persistence adds a SECOND writer. Two writers filtering the same rule
// with two copies of the same three-line predicate is precisely how a rule
// like this rots: someone fixes one, or extends the key list in one, and
// the other keeps shipping. So the predicate, the key list and the
// scrubbing are lifted here, and both writers call the same function.
//
// ── WHY A SERVICE AND NOT THE ROUTE ──────────────────────────────────
// The constants used to be exported from the route module. A model or a
// persistence service importing a ROUTE to find out what it may store is
// backwards, and in an ESM graph it drags an express router and its
// rate-limiter into anything that needs the predicate — including a test
// that only wanted to know which keys are sensitive. The route now
// re-exports SENSITIVE_ANSWER_KEYS from here, so every existing importer
// keeps working and there is still one definition.
//
// ── WHAT "SAFE" MEANS, PRECISELY ─────────────────────────────────────
// Three separate disclosures have to be closed, and the third is the one
// that is easy to miss:
//
//   1. FACTORS — a leave-one-out attribution row carries `questionText`
//      ("Immigration compliance history") and `answerLabel` ("Deported /
//      misrepresentation finding"). Dropped by question id.
//   2. FLAGS — a hard-stop flag carries the ruleset's own message, which
//      spells the finding out in full. Dropped by question id.
//   3. THE CAP — `build.capped` is a hard-stop CODE, and every cap in the
//      shipped ruleset fires on one of the two sensitive questions
//      (`misrep` on compliance, `custodial` on character). Storing the
//      string "misrep" discloses the compliance answer exactly as surely
//      as storing the answer would; it names the fact by elimination.
//      Nulled unless the cap came from a non-sensitive question.
//
// The check is on the QUESTION ID in all three cases, never on the text,
// because the text is ruleset-authored and a future edit could reword a
// hard stop without anyone re-reading this file. The id is the stable fact.
import type { ScoreFactor, ScoreFlag, VisaScoreResult } from "./visaProfileScore.js";

/**
 * Question ids whose answer, label, explanation or hard-stop code may
 * never be persisted or logged.
 *
 * THE CANONICAL DEFINITION. routes/public.visaScore.ts re-exports this
 * rather than declaring its own, so the redaction the log lines apply and
 * the filtering the writers apply cannot come to disagree about which
 * questions are sensitive.
 */
export const SENSITIVE_ANSWER_KEYS: readonly string[] = ["compliance", "character"];

/** Is this factor, flag or hard stop safe to put in front of anyone? */
export function isSensitiveQuestion(questionId: string): boolean {
  return SENSITIVE_ANSWER_KEYS.includes(String(questionId));
}

/**
 * The engine's explanation, with everything sensitive removed.
 *
 * Deliberately NOT a `Partial<VisaScoreResult>`: a caller that received a
 * trimmed VisaScoreResult would have no way to tell it apart from a whole
 * one, and the whole one is a legal hazard in a writer. A distinct type
 * means "this is the version you are allowed to store" is carried by the
 * type system rather than by a comment.
 */
export interface SafeBreakdown {
  helping: ScoreFactor[];
  holdingBack: ScoreFactor[];
  flags: ScoreFlag[];
  /**
   * The hard-stop code, or null when the cap itself would be a
   * disclosure. See point 3 in the header.
   */
  capped: string | null;
  /**
   * Suppression is NOT scrubbed: the only suppressing hard stop in the
   * ruleset fires on `schdays` (the Schengen 90/180 window), which is not
   * sensitive, and a suppressed score has no number to explain away.
   * Carried through so a stored row records why it holds no score.
   */
  suppressed: boolean;
}

/**
 * ONE call, both writers.
 *
 * routes/public.visaScore.ts's buildScoreBrief() uses it to build the ops
 * ticket; services/visaScoreAssessments.ts uses it to build the persisted
 * row. Neither filters anything itself.
 */
export function toSafeBreakdown(result: VisaScoreResult): SafeBreakdown {
  const safe = (f: { questionId: string }) => !isSensitiveQuestion(f.questionId);

  const flags = result.flags.filter(safe);

  /* THE CAP SURVIVES ONLY IF ITS OWN CAUSE IS PUBLISHABLE.
   *
   * `capped` names a hard-stop code; the flag carrying that code names the
   * question it fired on. If that flag did not survive the filter above,
   * the question was sensitive and the code must go with it.
   *
   * Falling through to null when NO flag matches is the conservative
   * branch and it is intentional: a cap whose provenance cannot be
   * established is not a cap this function is willing to vouch for. */
  const capped =
    result.build.capped !== null && flags.some((f) => f.code === result.build.capped)
      ? result.build.capped
      : null;

  return {
    helping: result.factors.helping.filter(safe),
    holdingBack: result.factors.holdingBack.filter(safe),
    flags,
    capped,
    suppressed: result.build.suppressed,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
 * THE IMPACT FIREWALL — a factor says HOW MUCH, never HOW MANY POINTS
 * ═══════════════════════════════════════════════════════════════════════
 *
 * ScoreFactor.impact is a leave-one-out counterfactual in display points.
 * It is genuinely not the option's raw `points` — the logistic transform
 * is not linear, so the same -13 moves a mid-range route further than a
 * near-saturated one, and most impacts land on values no option holds.
 *
 * MOST is not NONE, and that is the whole problem. Observed live on
 * 2026-09-07: a single ordinary profile returned impacts of -39, -29, -27
 * and -18, and -27 and -18 are both exact ruleset deltas. The collision is
 * a coincidence of the curve, but a scraper does not need to know which
 * values are coincidences — it needs a distribution, and this handed one
 * over per question, per call.
 *
 * WORSE THAN THE COLLISION IS THE SHORTCUT. routes/public.visaScore.ts's
 * §12.2 firewall reasons that the weights stay recoverable in principle —
 * hold every answer fixed, vary ONE question across its options, diff the
 * scores — and sizes visaScoreLimiter (60 / 15 min) against that cost:
 * about five calls per question, ~75 per corridor. A per-question impact
 * in the response collapses that to ONE call. The rate limit was pricing a
 * door that had been left open beside it.
 *
 * ── WHY BUCKETS AND NOT A SCALED NUMBER ──────────────────────────────
 * Any monotonic re-scaling (0-100, a normalised index) is still a function
 * of the delta: recoverable by inversion, and still ordered exactly as the
 * weights are. Rounding is worse than it looks — quantising to multiples
 * of 5 emits -25, -20, -15, every one of which IS a ruleset delta.
 *
 * A small ordinal set has no arithmetic relationship to the points at all.
 * Three levels per direction means an observer learns which of three bins
 * |impact| fell in and nothing else; there is no arrangement of calls that
 * turns "moderate" back into a number. It is the only one of the three
 * that is structurally safe rather than merely inconvenient.
 *
 * ── AND IT IS THE HONEST SHAPE FOR THE READER ────────────────────────
 * "-27 pts" on an 870-point scale is not something a person can act on;
 * the precision implies an exactness the model does not have. What they
 * can act on is "this is holding you back a lot". Direction already comes
 * from which list the factor is in, and the engine's own ordering is
 * preserved, so the breakdown loses a number and keeps every claim.
 *
 * Thresholds are ABSOLUTE, not relative to the strongest factor in the
 * response: a reader who improves one answer must not see an untouched
 * factor jump from "mild" to "strong" because the maximum moved under it.
 * ═══════════════════════════════════════════════════════════════════════ */

/** How much a factor moves the score, in bins that cannot encode a weight. */
export type FactorMagnitude = "strong" | "moderate" | "mild";

/**
 * Bin boundaries on |impact|, in display points.
 *
 * Chosen against the live distribution rather than invented: ordinary
 * profiles produce impacts clustered in the teens and twenties, so 25 and
 * 10 put a meaningful number of factors in each bin instead of collapsing
 * everything into one. An observer who knows these numbers exactly still
 * learns only which of three intervals a factor fell into.
 */
export const MAGNITUDE_STRONG_MIN = 25;
export const MAGNITUDE_MODERATE_MIN = 10;

export function factorMagnitude(impact: number): FactorMagnitude {
  const m = Math.abs(Number(impact) || 0);
  if (m >= MAGNITUDE_STRONG_MIN) return "strong";
  if (m >= MAGNITUDE_MODERATE_MIN) return "moderate";
  return "mild";
}

/**
 * THE SERIALISATION BOUNDARY. Every factor leaving this server for a
 * client goes through here, and `impact` is dropped rather than
 * transformed-in-place so that a future field added to ScoreFactor cannot
 * ride out unnoticed: this is an allow-list, and the number is not on it.
 *
 * `impact` is still computed, still used for ordering, and still stored
 * (models/VisaScoreAssessment.ts) — it simply never crosses the wire.
 * Keeping it server-side is what lets stored rows written before this
 * change render correctly: the read path buckets on the way out, so no
 * migration is needed and no history is lost.
 */
export function publicFactorShape(f: {
  questionId: string;
  questionText: string;
  dim: string;
  cite: string;
  answerLabel: string;
  impact: number;
}) {
  return {
    questionId: f.questionId,
    questionText: f.questionText,
    dim: f.dim,
    cite: f.cite,
    answerLabel: f.answerLabel,
    magnitude: factorMagnitude(f.impact),
  };
}
