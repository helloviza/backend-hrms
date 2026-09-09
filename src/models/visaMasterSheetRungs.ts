// apps/backend/src/models/visaMasterSheetRungs.ts
//
// THE FURTHEST-PROGRESS LADDER — the Master Sheet's one vertical axis.
//
// ══════════════════════════════════════════════════════════════════════
// WHY A LADDER AND NOT THE THREE ENUMS
// ══════════════════════════════════════════════════════════════════════
// The unified sheet is ONE ROW PER PERSON, and a person is not one state.
// Somebody can have checked a score for Australia, started an application
// for Thailand, and paid for Vietnam. Three collections, three vocabularies
// (models/visaD2CLifecycle.ts's status / stage / paymentStatus, plus the
// bare existence of a score-check row and of a Consumer), and no ordering
// between them.
//
// The sheet's question is not "what state is this row in" — a person has no
// single state — it is "HOW FAR HAS THIS PERSON GOT". That is a maximum
// over everything known about them, and a maximum needs a total order. So
// the three enums are PROJECTED onto one integer ladder, the person's rung
// is the max of their signals, and the sheet sorts and filters on that.
//
// ── THE NUMBERS ARE ORDINAL AND THEY ARE THE CONTRACT ────────────────
// -1 is deliberately negative rather than 0-based. Rung 0 is "did a thing"
// (checked a score); registration is the ABSENCE of any funnel act, and
// giving it a negative number means every "has this person actually done
// anything?" filter is `rung >= 0` rather than a magic constant. It also
// leaves 0 meaning what it means everywhere else on the sheet.
//
// ── WHY THIS FILE AND NOT visaD2CLifecycle.ts ────────────────────────
// That file is the STORED vocabulary — values that go into documents and
// out of them, shared with the ops console and B2B. Nothing here is ever
// stored: a rung is computed at read time from what the row already says.
// Putting a derived ranking in the same file as the stored enums is how a
// later reader comes to believe a rung is a field, and then writes one.
//
// ── THE CONSOLE HOLDS NO COPY ────────────────────────────────────────
// The endpoint sends { rung, rungLabel } together, from RUNG_LABELS below.
// The alternative — the console mapping -1..4 to words itself — puts the
// vocabulary in two places, and the day a rung is inserted the sheet reads
// correctly on the server and lies in the browser. Same rule the D2C status
// labels already follow.

import type { D2CPaymentStatus, D2CStage, D2CTrackingStatus } from "./visaD2CLifecycle.js";

/**
 * The ladder. Ordinal, ascending, and the only ordering the sheet has.
 *
 * Values are frozen once read by a client: the console filters and sorts on
 * these integers, so inserting a rung between two existing ones would
 * silently re-band every saved filter. A new stage APPENDS (5, 6, …) or
 * takes a negative below -1.
 */
export const RUNG = {
  /** A Consumer exists and has done nothing else. The third union arm. */
  REGISTERED: -1,
  /** A VisaScoreLead row exists — they checked their odds for a corridor. */
  CHECKED_SCORE: 0,
  /** A VisaD2CLead row exists at all — they opened an application. */
  STARTED: 1,
  /** stage DOC_SUBMITTED — the documents are in. */
  DOCS_SUBMITTED: 2,
  /** Payment was attempted and did not complete. */
  PAYMENT_STALLED: 3,
  /** Money is in. The top of the ladder. */
  VISA_FEES_PAID: 4,
} as const;

export type Rung = (typeof RUNG)[keyof typeof RUNG];

export const RUNG_VALUES: Rung[] = [
  RUNG.REGISTERED,
  RUNG.CHECKED_SCORE,
  RUNG.STARTED,
  RUNG.DOCS_SUBMITTED,
  RUNG.PAYMENT_STALLED,
  RUNG.VISA_FEES_PAID,
];

export const MIN_RUNG: Rung = RUNG.REGISTERED;
export const MAX_RUNG: Rung = RUNG.VISA_FEES_PAID;

/**
 * Display copy. Sent WITH the enum, never instead of it — the console
 * renders `rungLabel` and filters on `rung`, so a copy change is a one-file
 * change here and never a client release.
 */
export const RUNG_LABELS: Record<Rung, string> = {
  [RUNG.REGISTERED]: "Registered",
  [RUNG.CHECKED_SCORE]: "Checked score",
  [RUNG.STARTED]: "Started",
  [RUNG.DOCS_SUBMITTED]: "Docs submitted",
  [RUNG.PAYMENT_STALLED]: "Payment stalled",
  [RUNG.VISA_FEES_PAID]: "Visa fees paid",
};

export function rungLabel(rung: number): string {
  return RUNG_LABELS[rung as Rung] ?? "Unknown";
}

/** The ladder as the endpoint hands it to the console, for filter chips. */
export function rungVocabulary(): Array<{ rung: Rung; label: string }> {
  return RUNG_VALUES.map((rung) => ({ rung, label: RUNG_LABELS[rung] }));
}

/* ═════════════════════════════════════════════════════════════════════
 * THE RANKING FUNCTION
 * ═════════════════════════════════════════════════════════════════════ */

/**
 * How far a single VisaD2CLead row got.
 *
 * ── IT IS A MAX OVER THREE SIGNALS, NOT A SWITCH ON ONE ──────────────
 * stage, status and paymentStatus are three independent axes of the same
 * row and they can disagree. A row can sit at stage PAYMENT_DONE while its
 * status still says IN_PROGRESS (true, and correct: the fee is in, the visa
 * is not). Reading any single field would under-report exactly the rows the
 * sheet exists to surface, so each contributes a floor and the row's rung is
 * the highest floor any of them justifies.
 *
 * ── THE ROW EXISTING IS ITSELF A SIGNAL ──────────────────────────────
 * The floor is STARTED, unconditionally. That is the Scenario-1 promise in
 * models/VisaD2CLead.ts: the row is created the moment somebody opens an
 * application, before any stage has moved, and a person who started and
 * stalled must appear at "Started" rather than falling off the ladder
 * because none of their enums advanced.
 *
 * ── WHAT DELIBERATELY CONTRIBUTES NOTHING ────────────────────────────
 * paymentStatus PENDING contributes 0 (above the STARTED floor), and so do
 * status IN_PROGRESS, COMPLETED and DROPPED. PENDING is the default on every
 * fresh row — it means "no payment event has happened", not progress. The
 * three statuses are the COMMERCIAL/OPS axis, not the funnel axis: DROPPED
 * says how a case ended, not how far it got, and letting COMPLETED imply a
 * high rung would put a case that was closed unpaid above one that paid.
 * VISA_FEES_PAID is the single status that is also a funnel fact, and it is
 * the only one that lifts the rung.
 *
 * PAYMENT_DROPPED is ranked with PAYMENT_FAILED, not below it: both mean
 * "reached payment, no money", which is the state a commercial reader
 * chases. The distinction between them is WHY, and that is the stage enum's
 * job to carry, not the ladder's.
 */
export function rungForLead(lead: {
  stage?: D2CStage | null;
  status?: D2CTrackingStatus | null;
  paymentStatus?: D2CPaymentStatus | null;
}): Rung {
  // The row exists, so they started. Everything below can only raise this.
  let rung: number = RUNG.STARTED;

  switch (lead?.stage) {
    case "DOC_SUBMITTED":
      rung = Math.max(rung, RUNG.DOCS_SUBMITTED);
      break;
    case "PAYMENT_FAILED":
    case "PAYMENT_DROPPED":
      rung = Math.max(rung, RUNG.PAYMENT_STALLED);
      break;
    case "PAYMENT_DONE":
      rung = Math.max(rung, RUNG.VISA_FEES_PAID);
      break;
    // DOC_SUBMISSION_IN_PROGRESS adds nothing — it IS the started state.
    default:
      break;
  }

  if (lead?.status === "VISA_FEES_PAID") rung = Math.max(rung, RUNG.VISA_FEES_PAID);
  if (lead?.paymentStatus === "PAID") rung = Math.max(rung, RUNG.VISA_FEES_PAID);
  if (lead?.paymentStatus === "FAILED") rung = Math.max(rung, RUNG.PAYMENT_STALLED);

  return rung as Rung;
}

/**
 * The same ranking, expressed as a Mongo aggregation expression over the
 * lead-arm fields.
 *
 * ── WHY IT IS DUPLICATED IN TWO LANGUAGES ────────────────────────────
 * The endpoint ranks INSIDE the pipeline — the $group takes a $max of this,
 * so the database never ships one document per corridor to Node just to
 * throw all but the highest away. That means the rule has to exist as a
 * Mongo expression. Keeping the TypeScript version beside it is what makes
 * the pair testable: B6 asserts the two agree over the same fixtures, so a
 * future edit to one that forgets the other fails a test rather than
 * quietly giving the sheet a different ladder from the exporter.
 *
 * Reads $stage / $status / $paymentStatus, so the projection that feeds it
 * must expose exactly those three names.
 */
export function rungExpressionForLeadArm(): Record<string, unknown> {
  return {
    $max: [
      RUNG.STARTED,
      {
        $switch: {
          branches: [
            { case: { $eq: ["$stage", "DOC_SUBMITTED"] }, then: RUNG.DOCS_SUBMITTED },
            { case: { $eq: ["$stage", "PAYMENT_FAILED"] }, then: RUNG.PAYMENT_STALLED },
            { case: { $eq: ["$stage", "PAYMENT_DROPPED"] }, then: RUNG.PAYMENT_STALLED },
            { case: { $eq: ["$stage", "PAYMENT_DONE"] }, then: RUNG.VISA_FEES_PAID },
          ],
          default: RUNG.STARTED,
        },
      },
      { $cond: [{ $eq: ["$status", "VISA_FEES_PAID"] }, RUNG.VISA_FEES_PAID, RUNG.STARTED] },
      { $cond: [{ $eq: ["$paymentStatus", "PAID"] }, RUNG.VISA_FEES_PAID, RUNG.STARTED] },
      { $cond: [{ $eq: ["$paymentStatus", "FAILED"] }, RUNG.PAYMENT_STALLED, RUNG.STARTED] },
    ],
  };
}
