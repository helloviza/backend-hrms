// apps/backend/src/utils/visaEta.ts
//
// Computes the estimated-decision window shown on the tracking timeline
// (screen 6) — lodgedAt (models/VisaApplication.ts) plus the ruleSnapshot's
// own etaMinDays/etaMaxDays, walked forward respecting etaBasis
// (BUSINESS/CALENDAR, models/VisaRule.ts). Returns null whenever any input
// is missing — never guesses a window for an application that hasn't been
// lodged yet, or a rule snapshot that never carried an ETA (task brief).
//
// "Business days" here means Mon–Fri only — there is no mission/embassy
// holiday calendar wired into this codebase to consult, so public holidays
// are not skipped. That's a known, deliberate simplification: the window
// is already a min/max estimate, not a guarantee.

export type VisaEtaBasis = "BUSINESS" | "CALENDAR";

export interface EstimatedDecisionWindow {
  minDate: string; // ISO 8601
  maxDate: string;
}

function addCalendarDays(start: Date, days: number): Date {
  const result = new Date(start);
  result.setDate(result.getDate() + days);
  return result;
}

function addBusinessDays(start: Date, days: number): Date {
  const result = new Date(start);
  let remaining = days;
  while (remaining > 0) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay(); // 0 = Sunday, 6 = Saturday
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return result;
}

// Any basis other than the explicit "BUSINESS" (including an absent/unset
// value on an older rule snapshot) is treated as calendar days — the wider,
// more conservative interpretation when we don't actually know.
export function computeEstimatedDecisionWindow(
  lodgedAt: Date | string | null | undefined,
  etaMinDays: number | null | undefined,
  etaMaxDays: number | null | undefined,
  etaBasis: VisaEtaBasis | string | null | undefined,
): EstimatedDecisionWindow | null {
  if (!lodgedAt) return null;
  if (etaMinDays == null || etaMaxDays == null) return null;

  const start = new Date(lodgedAt);
  if (Number.isNaN(start.getTime())) return null;

  const addDays = etaBasis === "BUSINESS" ? addBusinessDays : addCalendarDays;

  return {
    minDate: addDays(start, etaMinDays).toISOString(),
    maxDate: addDays(start, etaMaxDays).toISOString(),
  };
}

// The inverse of addBusinessDays — walks BACKWARD over Mon–Fri only, same
// "no holiday calendar" simplification as the rest of this module.
function subtractBusinessDays(start: Date, days: number): Date {
  const result = new Date(start);
  let remaining = days;
  while (remaining > 0) {
    result.setDate(result.getDate() - 1);
    const day = result.getDay(); // 0 = Sunday, 6 = Saturday
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return result;
}

/**
 * THE at-risk definition (2026-08-12) — the latest instant at which a case is
 * still NOT at risk. `atRisk` is exactly `now > processingDeadlineAt`, and
 * assessProcessingRisk below derives its own verdict from this same function
 * so the two can never disagree.
 *
 * WHY this exists as a stored, precomputed field (models/VisaApplication.ts's
 * processingDeadlineAt) rather than being computed at read time: MongoDB
 * cannot count business days — there is no business-day unit for $dateDiff
 * and no weekday-counting operator — so an ETA-relative, business-day-aware
 * at-risk verdict is NOT expressible in a query from a travel date alone.
 * Precomputing the crossing point is what lets the ops queue filter and sort
 * on at-risk in the database instead of pulling every matching case into
 * Node. It is only safe to precompute because both other inputs
 * (ruleSnapshot.etaMaxDays / etaBasis) are frozen at creation and never
 * change — see that model's own field comment.
 *
 * Returns null when there is nothing to assess (no travel date, or the rule
 * snapshot carries no etaMaxDays) — never a guessed deadline. A null
 * deadline means UNASSESSABLE, which is not the same as "safe": the queue
 * gives those rows their own honest bucket rather than letting them fall
 * into the not-at-risk band by absence.
 *
 * Same basis convention as the rest of this module: only the explicit
 * "BUSINESS" counts Mon–Fri; anything else, including absent, is calendar.
 */
/**
 * Midnight at the start of `d`'s own day. At-risk is denominated in WHOLE
 * DAYS, so the verdict must be too: comparing raw instants would make a case
 * with exactly enough runway flip to at-risk a few milliseconds into its
 * deadline day, which is not what "you are short by a day" means. Comparing
 * day-starts means a deadline that falls TODAY is not yet missed — you still
 * have today — and only a deadline on a strictly earlier day is.
 *
 * Local midnight, not UTC, to match the local-time convention the rest of
 * this module already uses (addBusinessDays/getDay operate on local dates).
 */
export function startOfDay(d: Date): Date {
  const result = new Date(d);
  result.setHours(0, 0, 0, 0);
  return result;
}

/**
 * The instant a queue compares stored deadlines against: anything strictly
 * earlier than this has missed its day. Because a stored deadline is an
 * exact instant, `deadline < startOfDay(now)` is exactly
 * `startOfDay(deadline) < startOfDay(now)` — which is what lets the ops
 * queue express this as a plain indexed range match rather than needing
 * day-truncation in the query.
 */
export function atRiskCutoff(now: Date = new Date()): Date {
  return startOfDay(now);
}

export function computeProcessingDeadline(
  travelDateFrom: Date | string | null | undefined,
  etaMaxDays: number | null | undefined,
  etaBasis: VisaEtaBasis | string | null | undefined,
): Date | null {
  if (!travelDateFrom || etaMaxDays == null) return null;
  const travel = new Date(travelDateFrom);
  if (Number.isNaN(travel.getTime())) return null;

  return etaBasis === "BUSINESS"
    ? subtractBusinessDays(travel, etaMaxDays)
    : addCalendarDays(travel, -etaMaxDays);
}

function countCalendarDaysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

// The inverse of addBusinessDays above: counts Mon–Fri days strictly
// between `from` and `to`. Symmetric for a `to` before `from` (returns a
// negative count) — used by assessProcessingRisk below for a travel date
// already in the past, which must rank as the worst case, not throw or
// loop forever.
function countBusinessDaysBetween(from: Date, to: Date): number {
  const forward = to.getTime() >= from.getTime();
  const start = forward ? from : to;
  const end = forward ? to : from;
  let count = 0;
  const cur = new Date(start);
  while (cur.getTime() < end.getTime()) {
    cur.setDate(cur.getDate() + 1);
    const day = cur.getDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return forward ? count : -count;
}

export interface ProcessingRiskAssessment {
  atRisk: boolean;
  availableDays: number; // calendar or business days between `now` and travel, per etaBasis
  etaMaxDays: number;
  marginDays: number; // availableDays - etaMaxDays; negative = short by that many days, the worse the more negative
}

// "AT RISK" (ops dashboard, Phase 9f) — is there still enough runway before
// travel to plausibly finish processing? Deliberately measured from `now`,
// not from lodgedAt/submittedAt — this is "how much runway is left right
// now", not "will the eventual decision window fit" (that's
// computeEstimatedDecisionWindow's job above, and only answerable once an
// application has actually been lodged). Applies at any pre-decision
// stage, lodged or not.
//
// Reuses this module's own calendar/business convention (etaBasis ===
// "BUSINESS" counts Mon-Fri only; anything else, including absent, is
// CALENDAR — same fallback direction as computeEstimatedDecisionWindow
// above). Note: apps/frontend/src/pages/visa/apply/warnings.ts's own
// pre-lodging runway check defaults the OTHER way (missing basis ->
// BUSINESS) — a pre-existing discrepancy between that module and this one,
// not resolved here since that file covers a different lifecycle stage
// (pre-submission, client-side) with its own already-shipped behavior.
//
// Returns null when there's nothing to assess (no travel date, or the rule
// snapshot carries no etaMaxDays) — never a guessed verdict. `now` is an
// explicit parameter (defaulting to the real current time) so callers —
// and tests — can pin it rather than depending on wall-clock time.
export function assessProcessingRisk(
  travelDateFrom: Date | string | null | undefined,
  etaMaxDays: number | null | undefined,
  etaBasis: VisaEtaBasis | string | null | undefined,
  now: Date = new Date(),
): ProcessingRiskAssessment | null {
  if (!travelDateFrom || etaMaxDays == null) return null;
  const travel = new Date(travelDateFrom);
  if (Number.isNaN(travel.getTime())) return null;

  const countDays = etaBasis === "BUSINESS" ? countBusinessDaysBetween : countCalendarDaysBetween;
  const availableDays = countDays(now, travel);
  const marginDays = availableDays - etaMaxDays;

  // atRisk is derived from computeProcessingDeadline above — ONE definition,
  // shared with the ops queue's query-side band/filter (routes/admin.visa.ts),
  // so the stored field, the filter and this row marker cannot drift apart.
  //
  // BOUNDARY NOTE (2026-08-12): the verdict is now the deadline's, compared
  // at DAY granularity (atRiskCutoff above) rather than as raw instants — a
  // deadline falling today has not been missed, you still have today. That
  // keeps the previous `marginDays < 0` behaviour at the case that actually
  // matters, exactly-enough-runway (margin 0 => not at risk), which a
  // millisecond comparison would have broken. The residual difference from
  // the old rule is ≤1 day and comes from availableDays being Math.round()ed
  // for CALENDAR (the old flip sat at travel-(etaMax-0.5) days) and from the
  // BUSINESS counter's 24h-step loop being sensitive to `now`'s time of day.
  // Pinned by "at-risk boundary" in routes/admin.visa.queue.test.ts, so the
  // shift is recorded rather than rediscovered.
  //
  // availableDays/marginDays keep their exact previous meaning — they are
  // informational. The queue orders by the deadline itself, which is an
  // equivalent ordering: marginDays is monotone in the deadline under both
  // bases (calendar: margin = deadline-now; business: business-day counting
  // is additive, so margin = businessDays(now, deadline)).
  const deadline = computeProcessingDeadline(travelDateFrom, etaMaxDays, etaBasis);
  const atRisk = deadline != null && deadline.getTime() < atRiskCutoff(now).getTime();

  return { atRisk, availableDays, etaMaxDays, marginDays };
}
