// apps/backend/src/services/visaScoreAssessments.ts
//
// THE WRITE AND READ PATH for a consumer's stored Visa Profile Score.
//
// Phase A of the enabler plan: the persistence CAPABILITY, with no caller
// on the funnel yet. Phase C wires the breakdown gate to recordAssessment()
// once a session exists; Phase B renders listAssessments() in the account.
// Nothing in this file is reachable from a route today, and that is the
// intended state — it lands, it is tested against the real engine, and the
// conversion path is changed separately.
//
// ══════════════════════════════════════════════════════════════════════
// THE ONE RULE THIS FILE ENFORCES
// ══════════════════════════════════════════════════════════════════════
// recordAssessment() takes a VisaScoreResult — the engine's WHOLE output,
// sensitive factors and all — and is the boundary at which the sensitive
// half is dropped. It calls toSafeBreakdown() and stores only what comes
// back.
//
// It deliberately does NOT take `answers`. A signature that accepted them
// would compile, would be convenient, and would be one careless edit away
// from writing them down. The caller keeps the answers; this function
// never sees them.
//
// ── WHY THE CALLER PASSES A RESULT AND NOT A SCORE ───────────────────
// Because the score has to come from the engine, on the server, and a
// function that accepted a bare number could be handed one by a client.
// The §12.2 firewall on the public routes exists to stop exactly that, and
// persistence must not become the hole in it: Phase C re-runs
// computeVisaProfileScore() server-side from the held answers — the same
// thing POST /visa-score/lead already does — and hands the result here.
import mongoose from "mongoose";

import VisaScoreAssessment, {
  type VisaScoreAssessmentDocument,
  type VisaScoreAssessmentSource,
} from "../models/VisaScoreAssessment.js";
import { d2cWorkspaceObjectId } from "./consumerWorkspace.js";
import type { VisaScoreResult } from "./visaProfileScore.js";
import { toSafeBreakdown } from "./visaScoreSafeBreakdown.js";

export interface RecordAssessmentArgs {
  /** From req.consumer.id — never from a request body. */
  consumerId: string | mongoose.Types.ObjectId;
  /** The engine's output, whole. Filtered here, not by the caller. */
  result: VisaScoreResult;
  source?: VisaScoreAssessmentSource;
  /** The client-minted assessment id, when the flow has one. */
  submissionId?: string;
}

/**
 * Store one assessment. APPEND — never an update.
 *
 * A retake is a new row on purpose: the history is what makes a stored
 * score worth storing. See the index note on the model.
 */
export async function recordAssessment(
  args: RecordAssessmentArgs,
): Promise<VisaScoreAssessmentDocument> {
  const { consumerId, result, source = "gate", submissionId } = args;

  /* THE FILTER, at the boundary. Everything below reads `safe`; `result`
   * is not touched again except for values that are not answer-derived
   * explanations (the score, the route, the arithmetic trail). */
  const safe = toSafeBreakdown(result);

  return VisaScoreAssessment.create({
    consumerId: new mongoose.Types.ObjectId(String(consumerId)),
    workspaceId: d2cWorkspaceObjectId(),

    destination: result.route.destinationIso2,
    passport: result.route.passportIso2,
    rulesetVersion: result.rulesetVersion,
    mode: result.route.mode,

    score: result.score,
    /* `note` is dropped on purpose — it is the band's long advisory
     * sentence, it is ruleset config rather than this consumer's data, and
     * it would be stale the moment the ruleset rewords it. The name and
     * the colour are what a stored row needs to render. */
    band: result.band ? { name: result.band.name, hex: result.band.hex } : null,
    range: result.range
      ? {
          low: result.range.low,
          high: result.range.high,
          confidence: result.range.confidence,
          label: result.range.label,
        }
      : null,
    profileStrength: result.profileStrength,
    baseScore: result.build.baseScore,

    capped: safe.capped,
    suppressed: safe.suppressed,
    factors: { helping: safe.helping, holdingBack: safe.holdingBack },
    flags: safe.flags,

    source,
    ...(submissionId ? { submissionId } : {}),
    generatedAt: new Date(result.generatedAt),
  });
}

/**
 * A consumer's most recent assessment for one corridor, or null.
 *
 * Own-scoped by construction: consumerId is a required argument and the
 * query cannot be built without it.
 */
export async function latestAssessmentFor(
  consumerId: string | mongoose.Types.ObjectId,
  destination: string,
): Promise<VisaScoreAssessmentDocument | null> {
  return VisaScoreAssessment.findOne({
    consumerId: new mongoose.Types.ObjectId(String(consumerId)),
    destination: String(destination).trim().toUpperCase(),
  })
    .sort({ createdAt: -1 })
    .lean<VisaScoreAssessmentDocument | null>();
}

/**
 * A consumer's assessments, newest first.
 *
 * `limit` is capped rather than trusted: this is the function an account
 * page will call, and an unbounded read on a collection that grows with
 * every retake is the kind of thing that is fine until someone with two
 * hundred rows loads their profile.
 */
export async function listAssessments(
  consumerId: string | mongoose.Types.ObjectId,
  opts: { destination?: string; limit?: number } = {},
): Promise<VisaScoreAssessmentDocument[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 100);

  const query: Record<string, unknown> = {
    consumerId: new mongoose.Types.ObjectId(String(consumerId)),
  };
  if (opts.destination) query.destination = String(opts.destination).trim().toUpperCase();

  return VisaScoreAssessment.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<VisaScoreAssessmentDocument[]>();
}

/**
 * The latest assessment per corridor — what an account overview shows.
 *
 * Done as a sort-then-dedupe in application code rather than as an
 * aggregation pipeline, deliberately: the row count per consumer is small
 * (one per retake), the index already orders it, and a $group here would
 * be the one read on this collection that a future encryption decision
 * could silently break — the encryption plugin's own header warns that
 * aggregate() bypasses decryption.
 */
export async function latestPerDestination(
  consumerId: string | mongoose.Types.ObjectId,
  limit = 100,
): Promise<VisaScoreAssessmentDocument[]> {
  const rows = await listAssessments(consumerId, { limit });
  const seen = new Set<string>();
  const out: VisaScoreAssessmentDocument[] = [];
  for (const row of rows) {
    if (seen.has(row.destination)) continue;
    seen.add(row.destination);
    out.push(row);
  }
  return out;
}
