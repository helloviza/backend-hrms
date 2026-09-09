// apps/backend/src/services/visaScoreLeads.ts
//
// THE ONE WRITER FOR models/VisaScoreLead.
//
// The gate calls this instead of createConsumerSupportCase. That swap is
// the whole point of the collection: a Visa Score check is a MARKETING
// SIGNAL, not a support request. Filing it as a ticket put a case in an
// agent's queue that no agent had been asked to work, and made "how many
// real support cases do we have" unanswerable — the same argument
// models/VisaD2CLead.ts makes about not minting a VisaApplication for
// somebody who merely clicked Continue.
//
// ── IT NEVER THROWS INTO THE RESPONSE PATH ───────────────────────────
// Same posture recordAssessment already has at this door: the reader is
// waiting to see their breakdown, and a marketing row failing to write is
// not a reason to deny it to them. Failures are logged and swallowed by
// the caller.
import mongoose from "mongoose";

import VisaScoreLead from "../models/VisaScoreLead.js";
import { normaliseUtm } from "../models/visaUtm.js";
import type { VisaScoreResult } from "./visaProfileScore.js";
import logger from "../utils/logger.js";

const leadLogger = logger.child({ module: "visaScoreLeads" });

export interface RecordVisaScoreCheckInput {
  email: string;
  name?: string | null;
  /** Set only when the address already belonged to an account. */
  consumerId?: string | mongoose.Types.ObjectId | null;
  /** The RECOMPUTED result — never a client-supplied score. */
  result: VisaScoreResult;
  utm?: unknown;
}

/**
 * Upsert one lead row for (email, destination).
 *
 * ── UPSERT, NOT APPEND, AND WHY THAT IS THE RIGHT SHAPE HERE ─────────
 * The brief asked for a recommendation between appending an event per
 * check and upserting one row per person per corridor. Upsert wins for
 * both jobs this collection has:
 *
 *   MARKETING  the sheet is a list to act on. Somebody who re-checked
 *              Australia four times is one person to call, not four
 *              rows, and an append-only log makes the list unusable
 *              without a de-duplicating query in front of it.
 *   ADOPTION   the re-check is not lost — `checkCount` carries it, and
 *              first/last timestamps carry the span. Those are better
 *              adoption numbers than a raw row count, which conflates
 *              "many people" with "one determined person".
 *
 * If a true per-event log is ever wanted (funnel replay, cohort timing),
 * it belongs in a separate append-only collection rather than by turning
 * this one into a log — the sheet would immediately need to collapse it
 * again.
 *
 * ── WHAT IS $setOnInsert AND WHY ─────────────────────────────────────
 * utm, firstCheckedAt and the consent stamp are first-touch: the campaign
 * that introduced this person, and the disclosure they actually read, are
 * properties of the FIRST check and must not be rewritten by a later
 * untagged one. Same rule VisaD2CLead applies to its own attribution.
 *
 * The score IS overwritten, deliberately — the sheet wants their current
 * standing, and the arithmetic trail is not this collection's job.
 */
export async function recordVisaScoreCheck(
  input: RecordVisaScoreCheckInput,
): Promise<{ id: string } | null> {
  const email = String(input.email || "").trim().toLowerCase();
  if (!email) return null;

  const iso2 = String(input.result?.route?.destinationIso2 || "").trim().toUpperCase();
  if (!iso2) return null;

  // A suppressed or unassessable route has no score to market against, so
  // NO ROW IS WRITTEN — the sheet is a list to act on, and a lead with no
  // standing to quote is not one. The corridor intent is not lost: a later
  // assessable check on the same corridor upserts the row then.
  const score = typeof input.result?.score === "number" ? input.result.score : null;
  if (score === null) return null;

  const consumerId =
    input.consumerId && mongoose.Types.ObjectId.isValid(String(input.consumerId))
      ? new mongoose.Types.ObjectId(String(input.consumerId))
      : null;

  const now = new Date();

  const doc = await VisaScoreLead.findOneAndUpdate(
    { email, destinationIso2: iso2 },
    {
      $set: {
        destinationName: input.result.route.destinationName ?? iso2,
        score,
        band: input.result.band?.name ?? null,
        rangeLow: input.result.range?.low ?? null,
        rangeHigh: input.result.range?.high ?? null,
        lastCheckedAt: now,
        // Re-evaluated every time: an anonymous checker who has since
        // signed up should stop reading as anonymous on the sheet.
        ...(consumerId ? { consumerId, hadAccount: true } : {}),
        ...(input.name ? { name: String(input.name).trim() } : {}),
      },
      $setOnInsert: {
        email,
        destinationIso2: iso2,
        firstCheckedAt: now,
        utm: normaliseUtm(input.utm),
        consentBasis: "GATE_DISCLOSURE_V1",
        disclosureShownAt: now,
        ...(consumerId ? {} : { consumerId: null, hadAccount: false }),
      },
      $inc: { checkCount: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );

  leadLogger.info("score check recorded", {
    destination: iso2,
    hadAccount: Boolean(consumerId),
    // The SCORE is logged. What produced it never is — same rule the
    // score routes follow.
    score,
  });

  return doc ? { id: String(doc._id) } : null;
}
