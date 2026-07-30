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
