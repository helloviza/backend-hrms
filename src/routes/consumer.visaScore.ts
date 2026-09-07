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

function publicFactor(f: any) {
  return {
    questionId: f.questionId,
    questionText: f.questionText,
    dim: f.dim,
    cite: f.cite,
    answerLabel: f.answerLabel,
    impact: f.impact,
  };
}

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
