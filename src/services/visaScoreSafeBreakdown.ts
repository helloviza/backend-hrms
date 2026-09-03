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
