// apps/backend/src/utils/cstepDeskDashboard.ts
//
// #13 — the Travel Desk dashboard (GET /api/cstep/desk-dashboard). Pure:
// takes the Processing-board requests the caller may see (already scoped
// the way GET /official-queue scopes them) plus each ARRANGING request's
// arrangement-line counts, and splits them into:
//
//   upcoming — APPROVED / ARRANGING / ARRANGED trips whose departureDate is
//              today or later (IST), soonest first.
//   pending  — the cases the desk still has to act on, each with a
//              deskAction: APPROVED -> AWAITING_ARRANGEMENT (not yet opened
//              for arranging); ARRANGING with a PENDING arrangement line ->
//              PENDING_SERVICES; ARRANGING with none pending ->
//              READY_TO_MARK_ARRANGED (only "Mark arranged" is left).
//              Nearest departure first, so the most urgent sit at the top;
//              a departure already past is kept (it is still unarranged)
//              and sorts above everything.
//
// departureDate is the request's own "YYYY-MM-DD" string (Tour Proposal
// departure, Event Request start), so plain string comparison orders it.

export const DESK_DASHBOARD_STATUSES = ["APPROVED", "ARRANGING", "ARRANGED"] as const;

/** A departure this many days away or fewer, still unarranged, is flagged. */
export const DESK_NEAR_DAYS = 3;

export type DeskUrgency = "OVERDUE" | "DUE_SOON";

export type DeskAction = "AWAITING_ARRANGEMENT" | "PENDING_SERVICES" | "READY_TO_MARK_ARRANGED";

export type DeskServiceCounts = { pending: number; total: number };

const DAY_MS = 86_400_000;
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Whole days from `today` to `day` (both "YYYY-MM-DD"); null when `day` isn't a date. */
export function daysUntil(today: string, day: unknown): number | null {
  if (!isDay(day)) return null;
  return Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

/** Departure ascending; a request with no departure date goes last. */
function byDeparture(a: any, b: any): number {
  const da = isDay(a.departureDate) ? a.departureDate : "9999-12-31";
  const db = isDay(b.departureDate) ? b.departureDate : "9999-12-31";
  if (da !== db) return da < db ? -1 : 1;
  return String(a.createdAt ?? "") < String(b.createdAt ?? "") ? -1 : 1;
}

export function buildDeskDashboard(
  requests: any[],
  servicesByRequest: Map<string, DeskServiceCounts>,
  today: string,
): { upcoming: any[]; pending: any[] } {
  const rows = requests
    .filter((r) => (DESK_DASHBOARD_STATUSES as readonly string[]).includes(r.status))
    .map((r) => {
      const daysToDeparture = daysUntil(today, r.departureDate);
      const services = servicesByRequest.get(String(r._id));
      return {
        ...r,
        daysToDeparture,
        pendingServices: services?.pending ?? 0,
        totalServices: services?.total ?? 0,
      };
    });

  const upcoming = rows.filter((r) => r.daysToDeparture !== null && r.daysToDeparture >= 0).sort(byDeparture);

  const pending = rows
    .filter((r) => r.status === "APPROVED" || r.status === "ARRANGING")
    .map((r) => {
      const deskAction: DeskAction =
        r.status === "APPROVED" ? "AWAITING_ARRANGEMENT" : r.pendingServices > 0 ? "PENDING_SERVICES" : "READY_TO_MARK_ARRANGED";
      const urgency: DeskUrgency | null =
        r.daysToDeparture === null ? null : r.daysToDeparture < 0 ? "OVERDUE" : r.daysToDeparture <= DESK_NEAR_DAYS ? "DUE_SOON" : null;
      return { ...r, deskAction, urgency };
    })
    .sort(byDeparture);

  return { upcoming, pending };
}
