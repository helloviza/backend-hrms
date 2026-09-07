// apps/backend/src/routes/consumer.visaScore.ts
//
// The consumer's own stored Visa Profile Scores. Mounted at
// /api/consumer/visa-score.
//
// ══════════════════════════════════════════════════════════════════════
// THE ONE RULE, AS EVERYWHERE ELSE: THE CONSUMER ID COMES FROM
// req.consumer.id. ALWAYS.
// ══════════════════════════════════════════════════════════════════════
// Never from a route param, a query string or a body field. The only
// caller-supplied value any handler here reads is a destination code, and
// it is used to NARROW a query that is already pinned to the session's
// consumer — so the worst a crafted request can do is ask for a corridor
// this person has not assessed, and get an empty list.
//
// ── WHY THIS IS A SEPARATE ROUTER FROM public.visaScore.ts ───────────
// They are different surfaces with opposite gates. The public one is
// deliberately unauthenticated (a reader scores without an account, which
// is the entire top of the funnel) and rate-limited by IP. This one is
// session-only and reads nothing but rows that already belong to the
// caller. Putting a requireConsumer route inside the public router would
// mean one file whose gate depends on which handler you landed in, which
// is exactly how an endpoint ends up unguarded by accident.
//
// ── PHASE B IS READ-ONLY, ON PURPOSE ─────────────────────────────────
// There is no POST here. Nothing in the product writes an assessment yet:
// recordAssessment() exists (Phase A) and gets its caller when the
// breakdown gate learns to fork on an account (Phase C). A write endpoint
// shipped now would be an unauthenticated-score-shaped hole waiting for a
// client to post a number into — the §12.2 firewall's whole concern — so
// it lands with the flow that needs it, not before.
//
// ── DPDP ─────────────────────────────────────────────────────────────
// This route cannot leak a sensitive answer because the rows do not
// contain one: models/VisaScoreAssessment.ts has no path that could hold
// an answer, and services/visaScoreSafeBreakdown.ts filtered the factors,
// the flags and the cap before the row was written. The mapper below is
// still an explicit allow-list rather than a `.lean()` passthrough —
// belt and braces, and it keeps `workspaceId`, `submissionId` and `__v`
// off a public response for the ordinary reason that a client has no use
// for them.
import { Router } from "express";
import { publicFactorShape } from "../services/visaScoreSafeBreakdown.js";
import {
  computeScoreFromBody,
  isCompleteAnswerSet,
  scoreResponsePayload,
  validateScoreBody,
} from "../services/visaScoreScoring.js";
import { latestAssessmentFor, recordAssessment } from "../services/visaScoreAssessments.js";
import { consumerVisaScoreLimiter } from "../middleware/rateLimit.js";
import logger from "../utils/logger.js";

const scoreLogger = logger.child({ module: "consumer-visa-score" });

import { requireConsumer } from "../middleware/requireConsumer.js";
import { findSeedCountry } from "../config/visaCountrySeed.js";
import { VISA_SCORE_RULESET as RULESET } from "../config/visaScoreRuleset.js";
import {
  latestPerDestination,
  listAssessments,
} from "../services/visaScoreAssessments.js";

const router = Router();

// EVERY route in this file. Mounted here rather than per-route so a new
// handler cannot be added unguarded.
router.use(requireConsumer);

/** The session's consumer. The ONLY source of a consumer id in this file. */
function me(req: any): string {
  return String(req.consumer.id);
}

/**
 * The display name for a corridor.
 *
 * Resolved server-side from the same static catalogue the map and the
 * public score routes use, for the reason consumer.saved.ts gives at
 * length: a client-side join is a second copy of the catalogue vocabulary
 * and it goes stale the day the seed moves. SCHENGEN is the ruleset's
 * synthetic and has no seed row, so it is answered first.
 */
function destinationNameFor(code: string): string | null {
  if (code === RULESET.schengen.code) return RULESET.schengen.name;
  return findSeedCountry(code)?.countryName ?? null;
}

/** What a stored row looks like on the wire. An allow-list, not a dump. */
function publicAssessment(row: any) {
  return {
    id: String(row._id),
    destination: row.destination,
    destinationName: destinationNameFor(row.destination),
    passport: row.passport,
    rulesetVersion: row.rulesetVersion,
    mode: row.mode,

    score: row.score ?? null,
    band: row.band ? { name: row.band.name, hex: row.band.hex } : null,
    range: row.range
      ? {
          low: row.range.low,
          high: row.range.high,
          confidence: row.range.confidence,
          label: row.range.label,
        }
      : null,
    profileStrength: row.profileStrength ?? null,
    baseScore: row.baseScore ?? null,
    suppressed: Boolean(row.suppressed),

    /* The FILTERED explanation, exactly as stored. Shorter than the one
     * the live assessment showed, because the sensitive factors were
     * never written — the page says so in as many words. */
    factors: {
      helping: (row.factors?.helping ?? []).map(publicFactor),
      holdingBack: (row.factors?.holdingBack ?? []).map(publicFactor),
    },
    flags: (row.flags ?? []).map((f: any) => ({
      code: f.code,
      severity: f.severity,
      message: f.message,
    })),

    source: row.source,
    generatedAt: row.generatedAt ? new Date(row.generatedAt).toISOString() : null,
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
  };
}

/* Delegates to the ONE serialisation boundary — see the impact-firewall
 * block in services/visaScoreSafeBreakdown.ts. Stored rows still hold the
 * raw `impact` (models/VisaScoreAssessment.ts requires it, and rows written
 * before the firewall carry it), so the bucketing happens HERE, on the way
 * out. No migration, no lost history, and the number never crosses the wire. */
const publicFactor = publicFactorShape;

/**
 * GET /api/consumer/visa-score/assessments
 *
 * With no query: ONE ROW PER CORRIDOR, newest first — the overview an
 * account page opens on.
 *
 * With ?destination=XX: that corridor's full history, newest first, which
 * is what makes "you were at 690, you are at 744 now" renderable. The
 * narrowing is applied on top of the consumer scope, never instead of it.
 */
router.get("/assessments", async (req: any, res: any) => {
  try {
    const consumerId = me(req);
    const destination =
      typeof req.query?.destination === "string" && req.query.destination.trim()
        ? String(req.query.destination).trim().toUpperCase()
        : null;

    if (destination) {
      const rows = await listAssessments(consumerId, { destination, limit: 50 });
      return res.json({
        ok: true,
        destination,
        assessments: rows.map(publicAssessment),
      });
    }

    const rows = await latestPerDestination(consumerId);
    return res.json({
      ok: true,
      destination: null,
      assessments: rows.map(publicAssessment),
    });
  } catch (err: any) {
    console.error("[consumer visa-score] list failed:", err?.message);
    return res.status(500).json({ error: "We couldn't load your visa scores." });
  }
});

export default router;

/* ═══════════════════════════════════════════════════════════════════════
 * POST /api/consumer/visa-score/score — PHASE C, THE MISSING WRITE
 * ═══════════════════════════════════════════════════════════════════════
 *
 * The header above used to say "Phase B is read-only, on purpose" and that
 * recordAssessment() "gets its caller when the breakdown gate learns to
 * fork on an account (Phase C)". This is that caller.
 *
 * ── WHY THE ENDPOINT LIVES HERE AND NOT ON THE PUBLIC ROUTER ─────────
 * Not preference — the session cookie is scoped Path=/api/consumer
 * (config/consumerAuth.ts). A browser will not attach it to
 * /api/public/visa-score/score however the client asks, so adding
 * `credentials: "include"` over there authenticates nothing. An endpoint
 * under this prefix is the only place the cookie actually arrives, short
 * of widening the cookie path — which is exactly the narrowing that keeps
 * a consumer session off every public endpoint.
 *
 * It therefore also inherits `router.use(requireConsumer)` at the top of
 * this file: session-gated by construction, with no second gate to get
 * wrong.
 *
 * ── THE SCORE IS COMPUTED, NEVER ACCEPTED ────────────────────────────
 * The body carries ANSWERS. It does not carry a score, and if it did this
 * route would ignore it. A POST that wrote a client-supplied number into
 * an account would be the "unauthenticated-score-shaped hole" the header
 * above refuses to open — the caller is authenticated here, but a person's
 * own stored score still must not be something they can type.
 *
 * Scoring goes through services/visaScoreScoring.ts, the same path the
 * public endpoint uses, so signing in cannot change the number.
 *
 * ── PERSIST-THEN-RESPOND, AND WHAT HAPPENS IF THE WRITE FAILS ────────
 * The write is awaited before the response so a 200 means "recorded", not
 * "computed and probably recorded". A reader who is told their score was
 * saved and then finds an empty account page has been lied to by the
 * cheaper ordering.
 * ═══════════════════════════════════════════════════════════════════════ */
router.post("/score", consumerVisaScoreLimiter, async (req: any, res: any) => {
  try {
    const consumerId = req.consumer?.id;
    if (!consumerId) {
      // Unreachable behind requireConsumer; thrown rather than defaulted
      // for the same reason routes/consumer.profile.ts throws here.
      throw new Error("consumer.visaScore: reached a handler with no req.consumer");
    }

    const body = req.body ?? {};

    const errors = validateScoreBody(body);
    if (errors.length) {
      /* NO ANSWERS IN THE LOG. The public route redacts them here; this
       * one does not log them at all. Two of the fourteen are the
       * sensitive pair, and a validation failure is not worth the risk of
       * a redaction bug on an authenticated, attributable request. */
      scoreLogger.warn("consumer score rejected — invalid input", {
        consumerId: String(consumerId),
        errors,
      });
      return res.status(400).json({ error: errors.join("; "), details: errors });
    }

    const { result, scoreMode, input } = computeScoreFromBody(body);

    /* ── "account" OR "retake" ──────────────────────────────────────
     * The enum (models/VisaScoreAssessment.ts) is ["gate","retake",
     * "account"]. "gate" belongs to the anonymous funnel — someone who
     * unlocked their breakdown with an email that turned out to be an
     * account. In here the person is already signed in, so a first
     * assessment for this corridor is "account" and any later one is
     * "retake". The distinction is what lets the account page say "you
     * were at 690, you are at 744" rather than showing two unrelated
     * rows. */
    /* ── PERSIST ONLY A FINISHED ASSESSMENT ────────────────────────
     * The gauge re-scores after every answer, so this endpoint is called
     * ~15 times for one sitting. Writing each one would put fifteen rows
     * behind a single assessment and make the account page's progression
     * a transcript of someone thinking rather than a history of their
     * scores. isCompleteAnswerSet() asks the engine's own resolver which
     * questions are actually in play (route-conditional, first-timer
     * skip), so the rule cannot drift from the one that scored them.
     *
     * A partial set still SCORES and still returns — the live gauge is the
     * product — it simply is not recorded. */
    const persisted = isCompleteAnswerSet(input.destination, body.answers as any);

    const prior = persisted ? await latestAssessmentFor(consumerId, input.destination) : null;
    const source = prior ? "retake" : "account";

    /* APPEND, never upsert — recordAssessment calls create(). The
     * progression IS the history; overwriting would delete the only thing
     * a returning reader comes back to see.
     *
     * DPDP: recordAssessment takes the RESULT, not the answers. It runs
     * toSafeBreakdown() and the schema has no answers path at all, so this
     * write cannot store the compliance or character answer even by
     * mistake. Phase A built it that way; this route inherits it and adds
     * nothing of its own. */
    if (persisted) await recordAssessment({
      consumerId,
      result,
      source,
      ...(typeof body.submissionId === "string" && body.submissionId.trim()
        ? { submissionId: body.submissionId.trim() }
        : {}),
    });

    /* The SAME payload the public endpoint returns — one allow-list, so a
     * field added for one caller is a decision for both, and the client
     * can render either response with the same code. */
    return res.json(scoreResponsePayload(result, scoreMode, input.destination));
  } catch (err: any) {
    scoreLogger.error("consumer score failed", { message: err?.message });
    return res.status(500).json({ error: "Could not compute a score right now." });
  }
});
