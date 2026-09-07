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
//   · no PII is required to be SCORED — the inputs are option indices,
//     not identity. POST /lead takes an email, but only because the reader
//     typed one to unlock their breakdown, and it is the one endpoint here
//     that does;
//   · the assessment is never persisted, by anyone, on any path. /lead
//     writes a support ticket carrying the DERIVED result and nothing
//     else — never the answers (see DPDP below);
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
//   POST /score         the RESULT. No inputs echoed, no weights. NO
//                       Turnstile — the gauge scores per answer and a
//                       per-submission token cannot cover that; the rate
//                       limit is this endpoint's control. See its header.
//   POST /lead          a ticketRef. The email gate on the breakdown; it
//                       WRITES (one Ticket), and is the only one that
//                       does. Keeps its own honeypot + tighter limiter.
//                       No weights, no answers — see its own header.
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
// sufficient alone — and since Phase 3b they are the ONLY two, /score
// having deliberately shed its Turnstile gate (see that route's header
// for why a per-submission token cannot guard a per-answer gauge).
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
  type VisaScoreResult,
} from "../services/visaProfileScore.js";
/* The lead endpoint's two models and the shared case service. The rest of
 * this file touches no model at all and must stay that way — see the
 * scoped persistence note in the DPDP block below. */
import Consumer from "../models/Consumer.js";
import Ticket from "../models/Ticket.js";
import {
  createConsumerSupportCase,
  isAllowedSubject,
  type ConsumerSupportSubject,
} from "../services/consumerSupport.js";
import {
  BASE_RATES,
  SOURCED_APPROVAL,
  clampDisplayPct,
  APPROVAL_ESTIMATE_DISCLAIMER,
  difficultyFor,
  type BaseRateMode,
} from "../utils/visaDifficulty.js";
import { findSeedCountry, isSeedReady, listSeedCountries } from "../config/visaCountrySeed.js";
import { visaScoreLeadLimiter, visaScoreLimiter } from "../middleware/rateLimit.js";
import logger from "../utils/logger.js";
import { isSensitiveQuestion, toSafeBreakdown, publicFactorShape } from "../services/visaScoreSafeBreakdown.js";

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
 *   1. THE ANSWERS ARE NEVER PERSISTED. Three of the four endpoints here
 *      write to Mongo at all; the fourth, POST /lead, writes exactly one
 *      support ticket, and it is built from the engine's DERIVED output by
 *      buildScoreBrief() — which drops every factor and flag belonging to
 *      a sensitive question before a word of it is written. The answers
 *      themselves are an argument to a pure function and are discarded
 *      with the request. (Read that as: three endpoints have the absence
 *      of a writer, which is the strongest guarantee; the fourth has a
 *      writer that has never been given the sensitive values.)
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

/**
 * Question ids whose ANSWER VALUE may never appear in a log line.
 *
 * RE-EXPORTED, not declared. The canonical definition moved to
 * services/visaScoreSafeBreakdown.ts when persistence became a second
 * writer of this rule — two writers filtering with two copies of the same
 * key list is how a rule like this rots. Kept exported from here because
 * public.visaScore.lead.test.ts and other callers import it from this
 * module, and one definition behind two names is fine; two definitions is
 * not.
 */
export { SENSITIVE_ANSWER_KEYS } from "../services/visaScoreSafeBreakdown.js";

/**
 * Answers with the sensitive values replaced. The KEY is kept — knowing
 * that a caller answered the compliance question is not sensitive, and
 * dropping the key would make a malformed-input log unreadable.
 */
export function redactAnswers(answers: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!answers || typeof answers !== "object") return out;
  for (const [k, v] of Object.entries(answers as Record<string, unknown>)) {
    out[k] = isSensitiveQuestion(k) ? "[redacted]" : v;
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
 * ── NO TURNSTILE HERE. THE RATE LIMIT IS THE CONTROL. ─────────────────
 * This endpoint carried a createTurnstileGate("visa-score") until Phase 3b
 * and no longer does. That is a DELIBERATE REMOVAL, recorded here because
 * a missing gate is exactly the kind of thing a later reader re-adds in
 * good faith.
 *
 * A Turnstile token is PER-SUBMISSION. The Phase 3a gauge scores on every
 * answered question — ~15 calls per assessment — so it would need ~15
 * tokens, and a widget cannot mint them. The gate was therefore not a
 * stricter control than the limiter, it was a BROKEN one: the client sends
 * no token, so in production (where TURNSTILE_SECRET is set) every score
 * call returned 400 and the gauge was dead. It only appeared to work
 * locally because .env.development sets TURNSTILE_DEV_BYPASS=true. The
 * choice was the live gauge or the widget, and the live gauge is the
 * product.
 *
 * WHAT GUARDS THIS ENDPOINT NOW: visaScoreLimiter, and nothing else. It
 * stays at 60 per 15 minutes per IP precisely BECAUSE scoring is
 * per-answer — one honest assessment costs ~15 calls, so 60 leaves room
 * for a reader comparing a few corridors while still putting full
 * extraction of even one corridor over multiple windows. Lowering it to
 * the ~20 that a score-once-on-submit UI would allow would break the real
 * per-answer case on a reader's first visit. See the limiter's own note.
 *
 * AND WHAT THIS DOES NOT CHANGE: POST /lead keeps its own, tighter gate —
 * honeypot plus visaScoreLeadLimiter at 5 per 15 minutes — because it
 * WRITES a ticket into a queue ops read. A compute endpoint and a write
 * endpoint do not get the same control, and only /score lost anything
 * here.
 */
router.post(
  "/visa-score/score",
  visaScoreLimiter,
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
        /* BUCKETED, never the raw leave-one-out number — see
         * services/visaScoreSafeBreakdown.ts's impact-firewall block.
         * A per-question point figure here collapsed §12.2's ~5-calls-
         * per-question extraction cost to one call. */
        factors: {
          helping: result.factors.helping.map(publicFactorShape),
          holdingBack: result.factors.holdingBack.map(publicFactorShape),
        },
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

/* ═══════════════════════════════════════════════════════════════════════
 * POST /visa-score/lead — THE EMAIL GATE ON THE BREAKDOWN
 * ═══════════════════════════════════════════════════════════════════════
 *
 * The score, band and range are free (Phase 3a). The factor-by-factor
 * breakdown — what is helping, what is holding the applicant back, and the
 * consular rule each is assessed under — costs an email address. This is
 * the endpoint behind that field.
 *
 * ── IT FILES A TICKET. IT DOES NOT CREATE AN ACCOUNT. ────────────────
 * The lead lands in /admin/tickets, the same queue an emailed B2B case and
 * a D2C support case land in, through the same services/consumerSupport.ts
 * every other consumer door uses. There is no "score leads" table, because
 * a second queue is the one nobody watches — the exact reasoning
 * routes/public.visa.ts records for replacing its enquiry ManualBooking
 * with a ticket.
 *
 * It differs from that door in one deliberate way: NO CONSUMER ACCOUNT IS
 * CREATED. The enquiry form asks for a password because a person who has
 * decided to enquire is signing up; this gate interrupts someone in the
 * middle of an assessment they have not finished reading. Asking them to
 * choose a password there costs conversions on the one surface whose whole
 * job is capture, and it would mint an identity — in the consumer
 * registry, in the DPDP erasure surface, in the marketing base — for
 * somebody who only typed an address into a calculator. The ticket IS the
 * lead. If they go on to apply, the account is made then, by the door that
 * actually needs one.
 *
 * The one lookup that does happen: if the address ALREADY belongs to a
 * consumer, the case is filed against that account, so it appears on their
 * own /account/support beside everything else of theirs. Nothing is
 * created on either branch and the response is identical, so the endpoint
 * discloses nothing about who has an account here.
 *
 * ── THE BRIEF IS BUILT SERVER-SIDE, FROM A RECOMPUTED SCORE ──────────
 * The request carries the ANSWERS, not the result. The engine is run again
 * here and the ticket is written from ITS output, for two reasons:
 *
 *   1. TRUTH. A client-supplied score is a number ops would act on and
 *      nobody checked. The engine is deterministic on (answers, route,
 *      mode, ruleset), so the recomputed score is the same one the reader
 *      saw — asserted by test rather than assumed.
 *   2. NO CALLER-AUTHORED TEXT REACHES THE QUEUE. Every word of the brief
 *      below comes from the ruleset. The only strings a caller controls
 *      are their own email and name. A body assembled from client-sent
 *      factor text would be an open write into an ops inbox.
 *
 * ── DPDP §12.7 — WHAT THE TICKET MAY NOT CARRY ───────────────────────
 * The compliance and character answers are sensitive personal data, and
 * this is the FIRST endpoint in this file that writes anything at all, so
 * "nothing here is persisted" no longer covers it. What replaces it is
 * narrower and explicit:
 *
 *   · the ANSWERS are never written and never logged unredacted — they are
 *     an input to a pure function and are discarded with the request;
 *   · buildScoreBrief() DROPS every factor and every flag belonging to a
 *     sensitive question, so a disclosed overstay or conviction cannot
 *     reach an ops screen through its factor line or its hard-stop
 *     message;
 *   · the brief does not say the score was CAPPED either. The only two
 *     caps in the ruleset are the misrepresentation and custodial hard
 *     stops, so "capped" names the sensitive fact by elimination. The band
 *     is reported; why it is low is the applicant's to tell.
 *
 * ── ABUSE CONTROL ────────────────────────────────────────────────────
 * No Turnstile, decided in Phase 3a: the gate itself is the friction, and
 * a widget on the reveal step would cost more capture than it saves. What
 * guards a write endpoint instead is the same trio public.travelRequest.ts
 * uses minus the widget — honeypot (fake success, so a bot learns nothing),
 * visaScoreLeadLimiter (15 min / 5 per IP), and a submissionId dedupe so a
 * retry files one ticket rather than one per attempt.
 * ═══════════════════════════════════════════════════════════════════════ */

/** Namespaced so a score lead can never false-dedupe against an enquiry. */
const SCORE_LEAD_REF_PREFIX = "hvscore";

/** Ops filter for this channel. A TAG, not a new subject — see below. */
export const SCORE_LEAD_TAG = "visa-score-lead";

/**
 * MUST be a member of CONSUMER_SUPPORT_SUBJECTS.
 *
 * A "Visa readiness enquiry" subject was considered and rejected: that
 * array is not a free ops taxonomy, it is the list a CONSUMER picks from in
 * /account/support, and adding a subject there puts a phrase in a dropdown
 * that no consumer filing a support case would ever mean. The channel is
 * carried by SCORE_LEAD_TAG instead, which is what tags are for and what
 * CALLBACK_TAG already does for the one other sub-channel.
 */
const SCORE_LEAD_SUBJECT: ConsumerSupportSubject = "Visa application help";

/* Verified against the allowlist at module load rather than trusted from
 * the comment — a typo here would be a 500 discovered by a customer. */
if (!isAllowedSubject(SCORE_LEAD_SUBJECT)) {
  throw new Error(
    `public.visaScore: lead subject "${SCORE_LEAD_SUBJECT}" is not in CONSUMER_SUPPORT_SUBJECTS`,
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeLeadEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/* isSensitiveQuestion() and the filtering below now come from
 * services/visaScoreSafeBreakdown.ts — see the import block. */

/**
 * THE OPS BRIEF — a self-diagnosed lead with its own objections on the
 * front page.
 *
 * The point of filing a score lead as a ticket rather than as a row is that
 * the visa desk opens it already knowing what the conversation is about:
 * the corridor, where this applicant stands on it, and — the part that
 * makes it a brief rather than a notification — WHICH FACTORS ARE HOLDING
 * THEM BACK. "No travel history, employment under a year" is the objection
 * the desk would otherwise spend the first call discovering.
 *
 * Exported for the test that asserts what is in it and, more importantly,
 * what is not.
 */
export function buildScoreBrief(args: {
  result: VisaScoreResult;
  scoreMode: ScoreMode;
  destinationName: string;
  destinationIso2: string;
  mode: BaseRateMode;
}): string {
  const { result, destinationName, destinationIso2 } = args;
  const lines: string[] = [];

  lines.push(`Visa Profile Score enquiry — ${destinationName} (${destinationIso2})`);

  if (result.score !== null && result.band) {
    lines.push(`Score ${result.score} · Band: ${result.band.name}`);
  } else if (args.scoreMode === "suppressed") {
    lines.push("No score — the engine withheld it for this route.");
  } else {
    lines.push("No score — this corridor has no sourced approval rate to assess against.");
  }

  if (result.range) {
    lines.push(
      `Likely range ${result.range.low}–${result.range.high} (${result.range.label.toLowerCase()} confidence)`,
    );
  }

  /* Route context. baseRate and baseScore are already published on /routes
   * and on the public map, so neither adds a disclosure here. */
  if (result.build.baseRate !== null) {
    /* baseRate is a PROBABILITY (0..1) — utils/visaDifficulty.ts's prob()
     * normalises every published figure to one, and the engine works in
     * that scale throughout. Printing it raw put "0.7333%" in front of an
     * agent, which reads as a corridor nobody gets through. Converted here
     * with the same display clamp the public map applies, so the number in
     * the brief is the number on the site. */
    const window = args.mode === "a5" ? "5-year average" : "3-year average";
    const pct = clampDisplayPct(result.build.baseRate * 100);
    lines.push(`Corridor approval rate ${pct.toFixed(1)}% (${window})`);
  }
  if (result.build.baseScore !== null) {
    lines.push(`Where an average applicant on this route starts: ${result.build.baseScore}`);
  }

  /* ── THE OBJECTIONS. Sensitive questions dropped — see the DPDP note.
   *
   * ONE FILTER, TWO WRITERS. toSafeBreakdown() is the same call
   * services/visaScoreAssessments.ts makes before it persists a row, so
   * the ops brief and the stored assessment cannot come to disagree about
   * what is safe to keep. */
  const safe = toSafeBreakdown(result);
  const holding = safe.holdingBack;
  const helping = safe.helping;

  if (holding.length) {
    lines.push("");
    lines.push("HOLDING THEM BACK");
    for (const f of holding.slice(0, 6)) {
      lines.push(`· ${f.questionText}: ${f.answerLabel} (${f.impact}, ${f.cite})`);
    }
  }

  if (helping.length) {
    lines.push("");
    lines.push("STRENGTHENING THE APPLICATION");
    for (const f of helping.slice(0, 4)) {
      lines.push(`· ${f.questionText}: ${f.answerLabel} (+${f.impact}, ${f.cite})`);
    }
  }

  const flags = safe.flags;
  if (flags.length) {
    lines.push("");
    lines.push("FLAGS");
    for (const f of flags.slice(0, 6)) {
      lines.push(`· [${f.severity}] ${f.message}`);
    }
  }

  lines.push("");
  lines.push(
    `Self-assessed on the public Visa Profile Score calculator (ruleset ${result.rulesetVersion}) at ${result.generatedAt}.`,
  );
  lines.push(
    "The applicant's individual answers are not recorded — only the derived factors above. Anything sensitive they disclosed is deliberately absent, so ask rather than assume.",
  );

  return lines.join("\n");
}

function validateLeadBody(body: any): string[] {
  const errors: string[] = [];

  const email = normalizeLeadEmail(body?.email);
  if (!email) errors.push("An email address is required");
  else if (!EMAIL_RE.test(email)) errors.push("Email address is not valid");

  if (!UUID_V4.test(String(body?.submissionId ?? ""))) errors.push("Invalid submission");

  /* The route and the answers are validated by the SAME function /score
   * uses. Two validators over one input shape is how two endpoints drift
   * into disagreeing about what a valid assessment is. */
  errors.push(...validateScoreBody(body));

  return errors;
}

function leadHoneypotGate(req: any, res: any, next: any) {
  const trap = req.body?.hpField;
  if (typeof trap === "string" && trap.trim().length > 0) {
    scoreLogger.warn("lead — honeypot triggered, discarding silently", {
      ip: req.ip,
    });
    /* Fake success, and the DUPLICATE outcome specifically: it is the
     * branch with no side effects to imitate, so a bot gets a plausible
     * 200 with no ticket behind it and learns nothing about which field to
     * leave blank next time. */
    return res.status(200).json({ ok: true, outcome: "duplicate" });
  }
  next();
}

router.post(
  "/visa-score/lead",
  leadHoneypotGate,
  visaScoreLeadLimiter,
  async (req: any, res: any) => {
    try {
      const body = req.body ?? {};

      const errors = validateLeadBody(body);
      if (errors.length) {
        // redactAnswers, never body — the same discipline /score applies.
        scoreLogger.warn("lead rejected — invalid input", {
          destination: String(body?.destination ?? "").toUpperCase().slice(0, 16),
          errors,
          answers: redactAnswers(body?.answers),
        });
        return res.status(400).json({ error: errors.join("; "), details: errors });
      }

      const email = normalizeLeadEmail(body.email);
      const name = String(body.name ?? "").trim();
      const passport = String(body.passport).trim().toUpperCase();
      const destination = String(body.destination).trim().toUpperCase();
      const mode = (body.mode ? String(body.mode) : RULESET.baseRate.defaultMode) as BaseRateMode;
      const submissionId = String(body.submissionId).trim();
      const enquiryRef = `${SCORE_LEAD_REF_PREFIX}:${submissionId}`;

      /* ── IDEMPOTENCY, BEFORE ANYTHING IS WRITTEN ────────────────────
       * The submissionId is minted once per assessment and re-sent on
       * retry, so a double-click or a lost response does not file a second
       * ticket. Verbatim the enquiry door's dedupe, on its own namespace. */
      const prior = await Ticket.findOne({ "extractedFields.enquiryRef": enquiryRef })
        .select("_id ticketRef")
        .lean();
      if (prior) {
        return res.status(200).json({
          ok: true,
          outcome: "duplicate",
          ticketRef: (prior as any).ticketRef,
          reference: submissionId,
        });
      }

      /* THE SCORE, RECOMPUTED. generatedAt is minted here for the reason
       * /score mints its own: the engine is pure and must not read a
       * clock. */
      const result = computeVisaProfileScore({
        passportIso2: passport,
        destinationIso2: destination,
        answers: body.answers as ScoreAnswers,
        heldVisas: Array.isArray(body.heldVisas) ? body.heldVisas.map(String) : undefined,
        mode,
        generatedAt: new Date().toISOString(),
      });
      const scoreMode = resolveScoreMode(destination, result);

      const brief = buildScoreBrief({
        result,
        scoreMode,
        destinationName: destinationNameFor(destination) ?? destination,
        destinationIso2: destination,
        mode,
      });

      /* ── THE IDENTITY FORK ──────────────────────────────────────────
       * A read, never a write. An address we already know is filed against
       * that account so the case shows up on the person's own support
       * page; one we do not know is filed as an anonymous lead. No account
       * is created on either branch.
       *
       * There is deliberately NO B2B fork here, where the enquiry door has
       * one and 409s. That fork exists to stop a second identity being
       * minted for a corporate user — and nothing is minted here at all. A
       * B2B colleague assessing their own personal trip is an ordinary
       * lead, and refusing them mid-assessment would be a dead end with
       * nothing behind it. */
      const existing = await Consumer.findOne({ email }).select("_id").lean();

      const { ticket } = await createConsumerSupportCase({
        ...(existing
          ? { consumerId: String((existing as any)._id) }
          : { lead: { email, ...(name ? { name } : {}) } }),
        subject: SCORE_LEAD_SUBJECT,
        message: brief,
        enquiryRef,
        extraTags: [SCORE_LEAD_TAG],
      });

      scoreLogger.info("lead — case filed", {
        destination,
        ticketRef: ticket.ticketRef,
        knownConsumer: Boolean(existing),
        // The SCORE is logged. What produced it never is — see DPDP above.
        score: result.score,
      });

      return res.status(201).json({
        ok: true,
        outcome: "filed",
        ticketRef: ticket.ticketRef,
        reference: submissionId,
      });
    } catch (err: any) {
      scoreLogger.error("lead failed", { message: err?.message });
      return res
        .status(500)
        .json({ error: "We couldn't unlock your breakdown just then. Please try again." });
    }
  },
);

export default router;
