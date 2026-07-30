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

  return { atRisk: marginDays < 0, availableDays, etaMaxDays, marginDays };
}
