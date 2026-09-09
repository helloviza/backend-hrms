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
//   POST /lead          the email gate on the breakdown. It WRITES (one
//                       VisaScoreLead row, upserted), and is the only one
//                       that does. It files NO support ticket — that was
//                       the old behaviour and was wrong; a score check is
//                       a marketing signal, not a support request. Keeps
//                       its own honeypot + tighter limiter. No weights,
//                       no answers — see its own header.
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
/* The lead endpoint reads Consumer to decide whether the address already
 * belongs to an account, and writes through services/visaScoreLeads. The
 * rest of this file touches no model at all and must stay that way — see
 * the scoped persistence note in the DPDP block below.
 *
 * Ticket and services/consumerSupport used to be imported here. They are
 * not any more: this door no longer files a support case, and leaving the
 * imports would keep suggesting it might. */
import Consumer from "../models/Consumer.js";
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
import { recordAssessment } from "../services/visaScoreAssessments.js";
import { recordVisaScoreCheck } from "../services/visaScoreLeads.js";
import {
  computeScoreFromBody,
  destinationNameFor,
  resolveScoreMode,
  scoreResponsePayload,
  validateScoreBody,
  type ScoreMode,
} from "../services/visaScoreScoring.js";

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

/* Defined in services/visaScoreScoring.ts (the scoring path owns it now)
 * and re-exported below, so the union cannot be widened in one place and
 * not the other. */

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
/* resolveScoreMode, destinationNameFor and validateScoreBody MOVED to
 * services/visaScoreScoring.ts, so the public route, the consumer route
 * (Phase C) and the lead handler all score through one implementation.
 * Re-exported here because this module's test imports resolveScoreMode
 * from it, and because a route file is the honest place to look for what
 * that route returns. */
export { resolveScoreMode, destinationNameFor };
export type { ScoreMode };

/* ═══════════════════════════════════════════════════════════════════════
 * VALIDATION
 * ═══════════════════════════════════════════════════════════════════════ */


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

      /* THE ONE SCORING PATH — services/visaScoreScoring.ts. The consumer
       * endpoint and the lead handler compute through the same function,
       * so a score cannot differ by which door it came through, and the
       * response allow-list (the §12.2 firewall) is written once. */
      const { result, scoreMode, input } = computeScoreFromBody(body);
      return res.json(scoreResponsePayload(result, scoreMode, input.destination));
    } catch (err: any) {
      scoreLogger.error("score failed", { message: err?.message });
      return res.status(500).json({ error: "Could not compute a score right now." });
    }
  },
);

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
 * visaScoreLeadLimiter (15 min / 5 per IP), and an idempotent write — the
 * lead row is upserted on (email, destination), so a retry increments a
 * counter rather than adding a row.
 * ═══════════════════════════════════════════════════════════════════════ */

/* SCORE_LEAD_REF_PREFIX, SCORE_LEAD_TAG and SCORE_LEAD_SUBJECT lived here
 * — a ref namespace, an ops tag and an allowlisted subject, all three of
 * them only ever arguments to the createConsumerSupportCase call this door
 * no longer makes. They are gone rather than kept "in case": a constant
 * naming a ticket field is a standing suggestion to file a ticket.
 *
 * Tickets ALREADY filed under the old behaviour keep the literal
 * "visa-score-lead" tag in the database and stay filterable by it; nothing
 * here was what made that work. */

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
     * 200 with no lead row behind it and learns nothing about which field to
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

      /* ── IDEMPOTENCY IS NOW THE UPSERT ITSELF ───────────────────────
       * This used to look for a prior Ticket on the enquiryRef, because
       * the door filed one. It no longer does — see the identity fork
       * below — and recordVisaScoreCheck upserts on (email, destination),
       * so a double-click or a retried request lands on the SAME row and
       * increments checkCount rather than creating a second lead.
       *
       * That makes the old pre-flight read redundant, and dropping it
       * removes a Ticket query from a path that no longer writes tickets.
       * `enquiryRef` is retained below only as the caller-facing
       * `reference`, which the client echoes for its own retry dedupe. */

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

      /* buildScoreBrief() is no longer called here — it existed to write
       * the ops brief INTO the ticket body, and there is no ticket now.
       * The function itself stays exported and tested: it is the
       * DPDP-safe renderer of a result (it drops every factor and flag
       * belonging to a sensitive question), and it is what any future
       * surface that needs to show a result to staff should use. */

      /* ── THE IDENTITY FORK ──────────────────────────────────────────
       * A read, never a write. An address we already know is stamped onto
       * the lead row with its consumerId so the sheet can say "this one
       * has an account"; one we do not know is an anonymous-but-emailed
       * lead. No account is created on either branch, and — as before —
       * THE RESPONSE IS IDENTICAL EITHER WAY, so this endpoint still
       * discloses nothing about who has an account here.
       *
       * ── THIS NO LONGER FILES A SUPPORT TICKET ──────────────────────
       * It used to call createConsumerSupportCase, and that was the wrong
       * door. A Visa Score check is a MARKETING signal: somebody measured
       * their odds for a corridor. Filing it into the agent queue put a
       * case in front of a human that nobody had committed to working,
       * and diluted the one number that queue exists to answer — how many
       * real support cases are open.
       *
       * The enquiry door (routes/public.visa.ts) still files its ticket
       * and MUST keep doing so: a person who fills in an enquiry form is
       * asking to be contacted about a specific request. This door is not
       * that, and the swap here is deliberately surgical to it.
       *
       * NOT AWAITED INTO THE FAILURE PATH. The reader is waiting on their
       * breakdown; a marketing row that fails to write must not turn a
       * successful unlock into an error. Same posture recordAssessment
       * already has below. */
      const existing = await Consumer.findOne({ email }).select("_id").lean();

      let leadRef: string | null = null;
      try {
        const lead = await recordVisaScoreCheck({
          email,
          name: name || null,
          consumerId: existing ? String((existing as any)._id) : null,
          result,
          utm: (body as any).utm,
        });
        leadRef = lead?.id ?? null;
      } catch (leadErr: any) {
        scoreLogger.warn("lead — score-lead write failed, breakdown still unlocked", {
          destination,
          message: leadErr?.message,
        });
      }

      /* ── PHASE C (b): AN EMAIL WE RECOGNISE ALSO GETS THE ASSESSMENT ──
       *
       * The fork above already resolved `existing` in order to file the
       * ticket against the right account. When it found one, this person
       * IS an account holder who simply happened to assess while signed
       * out — the commonest way to reach this gate, since the account page
       * links straight to the public calculator. Filing their case and
       * then throwing away the assessment it is about would leave
       * /account/visa-score empty for someone who has just done the work.
       *
       * The result persisted is the one RECOMPUTED above from their
       * answers, never a number from the request. Same principle as the
       * consumer endpoint: a stored score must not be typeable.
       *
       * source "gate" — the enum's name for exactly this door. The
       * consumer endpoint uses "account"/"retake"; this is the third.
       *
       * NOT AWAITED INTO THE RESPONSE PATH. The lead ticket is what the
       * reader is waiting on, and it is already filed. A persistence
       * failure here must not turn a successful unlock into an error, so
       * it is logged and swallowed — the assessment is a convenience on
       * top of the ticket, not a precondition for it.
       *
       * DPDP: recordAssessment takes the RESULT and runs toSafeBreakdown;
       * there is no answers path on the schema. The anonymous branch below
       * writes nothing at all. */
      if (existing) {
        try {
          await recordAssessment({
            consumerId: String((existing as any)._id),
            result,
            source: "gate",
            ...(submissionId ? { submissionId } : {}),
          });
        } catch (persistErr: any) {
          scoreLogger.warn("lead — assessment persist failed, ticket already filed", {
            destination,
            message: persistErr?.message,
          });
        }
      }

      scoreLogger.info("lead — score lead recorded", {
        destination,
        knownConsumer: Boolean(existing),
        // The SCORE is logged. What produced it never is — see DPDP above.
        score: result.score,
      });

      /* `ticketRef` is GONE from this response, because no ticket is
       * filed any more. `reference` stays — it is the submissionId the
       * client already echoes, and the only field it ever used.
       *
       * The response is still byte-identical between the matched and
       * unmatched branches: leadRef is the row id, which exists on both. */
      return res.status(201).json({
        ok: true,
        outcome: "filed",
        reference: submissionId,
        ...(leadRef ? { leadRef } : {}),
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
