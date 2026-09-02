// apps/backend/src/routes/public.visaScore.ts
//
// THE VISA PROFILE SCORE API — four endpoints, no auth of any kind.
//
// Its own file and its own router, for the reason routes/public.visa.ts and
// routes/places.photo.public.ts both state for themselves: "which endpoints
// are unauthenticated" must be answerable by reading one short file, not by
// tracing middleware order through a router that also serves authed routes.
// NOTHING that requires a session may ever be added here.
//
// ══════════════════════════════════════════════════════════════════════
// WHY PUBLIC
// ══════════════════════════════════════════════════════════════════════
// The score exists to be used BEFORE someone applies — that is the whole
// product. Gating it behind a login inverts the funnel: a person who has
// not decided whether to apply is exactly who it is for, and asking them to
// create an account first means the tool only ever reaches people who
// already converted.
//
// It is also safe to be public, which is the part that matters more:
//   · no PII is required — the inputs are OPTION INDICES, not identity;
//   · nothing is persisted, by anyone, on any path (see DPDP below);
//   · every read is global reference data — the ruleset file and the
//     country seed. No traveller, no workspace, no user, no case. There is
//     no id a caller can supply that reaches a record.
//
// ══════════════════════════════════════════════════════════════════════
// THE §12.2 FIREWALL — THE RULESET NEVER LEAVES THIS PROCESS
// ══════════════════════════════════════════════════════════════════════
// The deltas, K, the envelope and the hard-stop thresholds ARE the model.
// The competitor this was modelled against shipped theirs in a JS bundle
// and was cloned off it, so the single most important property of this file
// is that no response carries a weight.
//
// The discipline is the one public.visa.ts states: every response is built
// by CONSTRUCTING a new object from named fields, never by spreading a
// ruleset object and deleting keys. A delete-list is one schema addition
// away from leaking; a whitelist is not. Concretely:
//
//   GET /questions      labels + citations + order + conditional metadata.
//                       NO `points`. The client renders; the server scores.
//   GET /routes         names, published historical rates, climate band.
//                       NO deltas. These are restatements of a public
//                       statistic, not part of the model.
//   GET /meta/ruleset   version, provenance, citations. NO weights.
//   POST /score         the RESULT. No inputs echoed, no weights.
//
// publicVisaScore.test.ts greps every serialised response for the actual
// delta values and asserts they are absent.
//
// ── AND THE HONEST LIMIT OF THAT FIREWALL ─────────────────────────────
// Hiding the weights does not make them unrecoverable. Hold every answer
// fixed, vary one question through its options, and diff the returned
// scores: that recovers one question's deltas in ~5 calls, and the whole
// table in ~75 per corridor. The firewall raises the cost from "read the
// bundle" to "run a few hundred requests"; the RATE LIMIT is what makes
// that cost real. The two are one control, not two, and neither is
// sufficient alone.
import { Router } from "express";

import {
  VISA_SCORE_RULESET as RULESET,
  type RulesetQuestion,
} from "../config/visaScoreRuleset.js";
import {
  computeVisaProfileScore,
  schengenSyntheticRate,
  schengenSyntheticSeries,
  type ScoreAnswers,
} from "../services/visaProfileScore.js";
import {
  BASE_RATES,
  SOURCED_APPROVAL,
  clampDisplayPct,
  APPROVAL_ESTIMATE_DISCLAIMER,
  difficultyFor,
  type BaseRateMode,
} from "../utils/visaDifficulty.js";
import { findSeedCountry, isSeedReady, listSeedCountries } from "../config/visaCountrySeed.js";
import { createTurnstileGate } from "../middleware/turnstile.js";
import { visaScoreLimiter } from "../middleware/rateLimit.js";
import logger from "../utils/logger.js";

const router = Router();
const scoreLogger = logger.child({ module: "visaScore" });

/* ═══════════════════════════════════════════════════════════════════════
 * DPDP §12.7 — THE TWO SENSITIVE ANSWERS
 *
 * `compliance` (overstays, deportation, misrepresentation findings) and
 * `character` (criminal history) are sensitive personal data. They are
 * PROCESSED for the score and never persisted or logged in the clear.
 *
 * Three things make that true, and all three are needed:
 *
 *   1. NOTHING IS PERSISTED AT ALL. No endpoint here writes to Mongo. The
 *      strongest guarantee is the absence of a writer, not a redactor.
 *   2. THE ACCESS LOG CANNOT SEE THEM. server.ts's morgan format is
 *      ":request-id :method :url :status :response-time ms" — no body, and
 *      these arrive in a POST body rather than a query string, so they
 *      never reach the URL either.
 *   3. ANYTHING THIS FILE LOGS GOES THROUGH redactAnswers(). That is the
 *      only path left, and it is the one a future edit is most likely to
 *      add to carelessly.
 *
 * The response does not echo answers back either — a caller gets the
 * result, not their own submission reflected into a client-side log.
 * ═══════════════════════════════════════════════════════════════════════ */

/** Question ids whose ANSWER VALUE may never appear in a log line. */
export const SENSITIVE_ANSWER_KEYS: readonly string[] = ["compliance", "character"];

/**
 * Answers with the sensitive values replaced. The KEY is kept — knowing
 * that a caller answered the compliance question is not sensitive, and
 * dropping the key would make a malformed-input log unreadable.
 */
export function redactAnswers(answers: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!answers || typeof answers !== "object") return out;
  for (const [k, v] of Object.entries(answers as Record<string, unknown>)) {
    out[k] = SENSITIVE_ANSWER_KEYS.includes(k) ? "[redacted]" : v;
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════
 * SCORE MODES
 * ═══════════════════════════════════════════════════════════════════════ */

export type ScoreMode = "score" | "indicative" | "no_visa" | "blocked" | "suppressed";

/**
 * Which of the five answers this route gets, resolved deterministically.
 *
 * ORDER IS THE WHOLE DESIGN. The first three questions are about the ROUTE
 * and are asked before any answer is looked at, because a route that needs
 * no visa cannot be assessed well or badly — it is simply not a question.
 * Reversing the order would score a visa-free corridor and print a number
 * for an application nobody will ever file.
 *
 *   1. no_visa    — VISA_FREE in the seed. The L0 stop.
 *   2. blocked    — RESTRICTED. There is no ordinary tourist route at all;
 *                   scoring one would imply a path that does not exist.
 *   3. indicative — we hold no sourced base rate. The corridor is real and
 *                   we decline to put a number on it rather than inventing
 *                   one, which is the same rule the map follows.
 *   4. suppressed — the engine withheld the number (Schengen window).
 *   5. score      — a real assessment.
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

/* ═══════════════════════════════════════════════════════════════════════
 * VALIDATION
 * ═══════════════════════════════════════════════════════════════════════ */

const ISO2 = /^[A-Z]{2}$/;

function validateScoreBody(body: any): string[] {
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
      // The INDEX is named, never the label — an error string is a log line
      // waiting to happen, and "character: 3" would defeat the redaction.
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

/* ═══════════════════════════════════════════════════════════════════════
 * POST /visa-score/score
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * ── WHY A TURNSTILE GATE ON A READ-SHAPED ENDPOINT ────────────────────
 * It computes rather than persists, so it is not a form submission in the
 * usual sense — but it is the one endpoint whose repeated use recovers the
 * model (see the firewall note in this file's header). The gate and the
 * limiter together are the anti-extraction control.
 *
 * CONSEQUENCE FOR PHASE 3, stated here because it is a product constraint
 * and not an implementation detail: a Turnstile token is per-submission, so
 * the client must score ONCE when the questionnaire is complete. The
 * reference UI re-scores on every answer to animate its gauge; that design
 * would need ~15 tokens per assessment and cannot work against this gate.
 * If the live gauge is wanted, the choice is to drop the gate and lean
 * entirely on the rate limit — worth deciding deliberately rather than
 * discovering during the UI build.
 */
router.post(
  "/visa-score/score",
  visaScoreLimiter,
  createTurnstileGate("visa-score"),
  async (req: any, res: any) => {
    try {
      const body = req.body ?? {};

      const errors = validateScoreBody(body);
      if (errors.length) {
        // redactAnswers, not body — see the DPDP block above.
        scoreLogger.warn("score rejected — invalid input", {
          destination: String(body?.destination ?? "").toUpperCase().slice(0, 16),
          errors,
          answers: redactAnswers(body?.answers),
        });
        return res.status(400).json({ error: errors.join("; "), details: errors });
      }

      const passport = String(body.passport).trim().toUpperCase();
      const destination = String(body.destination).trim().toUpperCase();
      const mode = (body.mode ? String(body.mode) : RULESET.baseRate.defaultMode) as BaseRateMode;

      /* generatedAt is minted HERE and injected. The engine is a pure
       * function and must stay one — a service that reads the clock cannot
       * be compared to itself, which is what the determinism fixture
       * depends on. This is the only non-deterministic value in the
       * response, and it is the route's to own. */
      const generatedAt = new Date().toISOString();

      const result = computeVisaProfileScore({
        passportIso2: passport,
        destinationIso2: destination,
        answers: body.answers as ScoreAnswers,
        heldVisas: Array.isArray(body.heldVisas) ? body.heldVisas.map(String) : undefined,
        mode,
        generatedAt,
      });

      const scoreMode = resolveScoreMode(destination, result);

      /* ── THE RESPONSE, FIELD BY NAMED FIELD ────────────────────────────
       * Constructed, never spread. `result` is the engine's own object and
       * spreading it here would ship whatever a future engine field holds
       * — which is exactly how a weight would eventually leak. */
      return res.json({
        ok: true,
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
        factors: result.factors,
        flags: result.flags,
        silentExcluded: result.silentExcluded,
        /* The arithmetic trail MINUS the model. baseRate and baseScore are
         * the corridor's published rate and where an average applicant
         * starts — both already disclosed on /routes and the public map.
         * `totalPoints`, `p` and `clampedBase` are NOT here: a points total
         * returned beside a known answer set is a direct read of the
         * deltas, and it is the single most extractable field in the whole
         * contract. rawScore stays, because a capped applicant is entitled
         * to know they were capped. */
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
      });
    } catch (err: any) {
      scoreLogger.error("score failed", { message: err?.message });
      return res.status(500).json({ error: "Could not compute a score right now." });
    }
  },
);

function destinationNameFor(iso2: string): string | null {
  if (iso2 === RULESET.schengen.code) return RULESET.schengen.name;
  return findSeedCountry(iso2)?.countryName ?? null;
}

/* ═══════════════════════════════════════════════════════════════════════
 * GET /visa-score/routes — the destination catalogue
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * What the explorer needs to draw a country list and a trend chart, and
 * nothing else.
 *
 * ── WHY BOTH AVERAGES AND THE SERIES ARE DISCLOSED ────────────────────
 * These are published historical statistics about a destination, not part
 * of the model — the public map already prints the latest year of the same
 * dataset. Withholding them would also create the worse problem: the score
 * is computed on the 3-year average, so a catalogue showing only the map's
 * latest-year figure would have the two surfaces quoting different numbers
 * for the same corridor with no way for a reader to reconcile them. Both
 * averages plus the series are shown, each labelled, and `activeWindow`
 * names the one the score actually used.
 *
 * `years[0]` is the same 2026 figure the map renders, so the surfaces
 * agree by construction rather than by coincidence.
 */
router.get("/visa-score/routes", async (_req: any, res: any) => {
  try {
    if (!isSeedReady()) {
      return res.status(503).json({ error: "Destination catalogue is unavailable." });
    }

    const climateFor = (rate: number) =>
      RULESET.climateBands.find((b) => rate >= b.min) ?? RULESET.climateBands.at(-1)!;

    const destinations = listSeedCountries()
      .map((c) => {
        const base = BASE_RATES[c.iso2];
        const figures = SOURCED_APPROVAL[c.iso2]?.figures;
        const assessable = Boolean(base);

        const mode: ScoreMode =
          c.visaCategory === "VISA_FREE" ? "no_visa"
          : c.visaCategory === "RESTRICTED" ? "blocked"
          : assessable ? "score"
          : "indicative";

        const climate = assessable ? climateFor(base!.a3) : null;

        return {
          iso2: c.iso2,
          name: c.countryName,
          visaCategory: c.visaCategory,
          difficulty: difficultyFor(c.iso2, c.visaCategory),
          mode,
          /* ── THE DISPLAYED INTEGERS COME FROM SOURCED_APPROVAL ─────────
           * NOT from re-rounding BASE_RATES. This looks like a detour and
           * is load-bearing: the dataset's stored integers were rounded
           * half-DOWN, while JS Math.round is half-UP, so recomputing them
           * here would disagree with the public map on 76 of 194 corridors
           * (Canada 52 vs 53, Australia 72 vs 73, and 74 more) and on avg3
           * for 5 more. Two surfaces quoting different percentages for the
           * same country, off a rounding tie-break nobody would ever think
           * to look for.
           *
           * visaDifficulty.ts already declares itself "the only place a
           * number may live"; honouring that here makes the agreement
           * structural rather than coincidental. clampDisplayPct is applied
           * for the same reason it is on the map — a flat 100% reads as a
           * guarantee, the one claim this feature must not make.
           *
           * years[1..4] have no stored integers, so they ARE computed. They
           * are trend-chart points that no other surface displays, so there
           * is nothing for them to disagree with. */
          approval: assessable && figures
            ? {
                avg3Pct: clampDisplayPct(figures.avg3),
                avg5Pct: clampDisplayPct(figures.avg5),
                yearsPct: [
                  clampDisplayPct(figures.y2026),
                  ...base!.years.slice(1).map((y) => clampDisplayPct(Math.round(y * 100))),
                ],
                activeWindow: RULESET.baseRate.defaultMode,
              }
            : null,
          climate: climate ? { name: climate.name, hex: climate.hex, note: climate.note } : null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    const schengenA3 = schengenSyntheticRate("a3");
    const schengenA5 = schengenSyntheticRate("a5");
    const schengen =
      schengenA3 === null || schengenA5 === null
        ? null
        : {
            iso2: RULESET.schengen.code,
            name: RULESET.schengen.name,
            visaCategory: "STICKER" as const,
            difficulty: "Hard" as const,
            mode: "score" as ScoreMode,
            synthetic: true,
            members: RULESET.schengen.members,
            approval: {
              avg3Pct: clampDisplayPct(Math.round(schengenA3 * 100)),
              avg5Pct: clampDisplayPct(Math.round(schengenA5 * 100)),
              /* Averaged per year slot across the same ten members, so the
               * trend chart has a line to draw for the corridor people ask
               * about most. Empty only if a member's series is missing. */
              yearsPct: schengenSyntheticSeries().map((y) => clampDisplayPct(Math.round(y * 100))),
              activeWindow: RULESET.baseRate.defaultMode,
            },
            climate: (() => {
              const c = climateFor(schengenA3);
              return { name: c.name, hex: c.hex, note: c.note };
            })(),
          };

    return res.json({
      ok: true,
      rulesetVersion: RULESET.version,
      yearOrder: [2026, 2025, 2024, 2023, 2022],
      disclaimer: APPROVAL_ESTIMATE_DISCLAIMER,
      schengen,
      destinations,
    });
  } catch (err: any) {
    scoreLogger.error("routes catalogue failed", { message: err?.message });
    return res.status(500).json({ error: "Could not load the destination catalogue." });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
 * GET /visa-score/questions — the questionnaire, WITHOUT the weights
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * THE FIREWALL ENDPOINT. Everything a client needs to RENDER the
 * questionnaire, and nothing it would need to score it.
 *
 * Each option is reduced to its label and its index. The index is what the
 * client posts back, so it has to be here; `points` is what the server
 * keeps, so it must not be. That single omission is the whole §12.2
 * measure, which is why the mapping below is written as an explicit
 * construction of two fields rather than a destructure-and-rest.
 *
 * The conditional metadata IS disclosed — which questions are Schengen-only
 * and which are skipped for a first-time traveller — because a client that
 * does not know the skip rules would ask a first-timer about their
 * compliance history and then have the server silently ignore the answer.
 * Knowing that a question is skipped reveals nothing about what any answer
 * is worth.
 */
router.get("/visa-score/questions", async (req: any, res: any) => {
  try {
    const destination = String(req.query?.destination ?? "").trim().toUpperCase();

    const applies = (q: RulesetQuestion) =>
      !q.appliesTo || !destination || q.appliesTo.map((c) => c.toUpperCase()).includes(destination);

    const questions = RULESET.questions.filter(applies).map((q, order) => ({
      id: q.id,
      order,
      text: q.text,
      dimension: q.dim,
      cite: q.cite,
      /* `silent` is disclosed on purpose. It tells the client this answer
       * will never be quoted back as a reason, which is a promise to the
       * person answering it — and it is a statement about EXPLANATION, not
       * about weight. */
      silent: Boolean(q.silent),
      appliesTo: q.appliesTo ?? null,
      skippedForFirstTimer: RULESET.firstTimer.skipQuestions.includes(q.id),
      options: q.options.map((o, index) => ({ index, label: o.label })),
    }));

    return res.json({
      ok: true,
      rulesetVersion: RULESET.version,
      destination: destination || null,
      firstTimer: {
        triggerQuestion: RULESET.firstTimer.triggerQuestion,
        triggerOptionIndex: RULESET.firstTimer.triggerOptionIndex,
        skipQuestions: RULESET.firstTimer.skipQuestions,
        /* boostQuestions is deliberately ABSENT. Naming which questions are
         * boosted, beside a multiplier, would hand over a piece of the
         * model — and the client has no rendering decision that depends on
         * it. The skip list is different: it changes which questions are
         * shown at all. */
      },
      heldVisas: {
        eligible: RULESET.heldVisas.eligible,
        /* The CAP is disclosed (a client may reasonably say "up to 3 count")
         * but pointsPerVisa is not — that is a weight. */
        maxCounted: Math.ceil(RULESET.heldVisas.cap / RULESET.heldVisas.pointsPerVisa),
        excludesTargetCountry: RULESET.heldVisas.excludeTargetCountry,
      },
      questions,
    });
  } catch (err: any) {
    scoreLogger.error("questions failed", { message: err?.message });
    return res.status(500).json({ error: "Could not load the questionnaire." });
  }
});

/* ═══════════════════════════════════════════════════════════════════════
 * GET /visa-score/meta/ruleset — provenance for the transparency page
 * ═══════════════════════════════════════════════════════════════════════ */

/**
 * What the model is BUILT ON, never what it is.
 *
 * The distinction this endpoint has to hold: "the compliance question is
 * assessed under UK Part 9 §9.8" is provenance and belongs to the reader —
 * it is how they check our reasoning against a public rule. "The
 * deported/misrepresentation option is worth −45" is the model.
 *
 * Counts and coverage are disclosed instead of values: how many corridors
 * carry a sourced figure, how many questions there are, which dimensions
 * exist. Enough to audit the shape of the thing without handing over its
 * contents.
 */
router.get("/visa-score/meta/ruleset", async (_req: any, res: any) => {
  try {
    const withSeries = Object.values(BASE_RATES).filter((r) => r.years.length > 0).length;

    return res.json({
      ok: true,
      ruleset: {
        version: RULESET.version,
        effectiveFrom: RULESET.effectiveFrom,
        questionCount: RULESET.questions.length,
        dimensions: [...new Set(RULESET.questions.map((q) => q.dim))].sort(),
        silentQuestions: RULESET.questions.filter((q) => q.silent).map((q) => q.id),
        averagingWindows: RULESET.baseRate.modes,
        defaultWindow: RULESET.baseRate.defaultMode,
      },
      /* Citations only — the rule each question is assessed under, with no
       * option labels and no values beside them. */
      citations: RULESET.questions.map((q) => ({
        questionId: q.id,
        dimension: q.dim,
        cite: q.cite,
      })),
      baseRateData: {
        nationality: "IN",
        corridorsWithSourcedRate: Object.keys(BASE_RATES).length,
        corridorsWithYearSeries: withSeries,
        yearOrder: [2026, 2025, 2024, 2023, 2022],
        disclaimer: APPROVAL_ESTIMATE_DISCLAIMER,
      },
      /* Named, not enumerated with their thresholds — a reader learns that
       * a misrepresentation finding caps the result without learning the
       * cap value or the points behind it. */
      hardStops: RULESET.hardStops.map((h) => ({
        code: h.code,
        questionId: h.question,
        action: h.action,
        severity: h.severity,
        message: h.message,
      })),
      bands: RULESET.bands.map((b) => ({ name: b.name, hex: b.hex, note: b.note })),
      climateBands: RULESET.climateBands.map((b) => ({ name: b.name, hex: b.hex, note: b.note })),
      disclaimer: RULESET.disclaimer,
    });
  } catch (err: any) {
    scoreLogger.error("meta/ruleset failed", { message: err?.message });
    return res.status(500).json({ error: "Could not load ruleset metadata." });
  }
});

export default router;
