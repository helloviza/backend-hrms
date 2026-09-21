// apps/backend/src/services/flightLegs.ts
//
// Pure helpers over a list of flight legs, shared by the ManualBooking
// pre-save derivation (models/ManualBooking.ts deriveFlatFromLegs) and the
// e-ticket auto-fill (services/flightAutofill.ts). No I/O, no mongoose —
// the leg shape is structural so both the model's Date-typed legs and the
// autofill's ISO-string legs fit.

export interface LegLike {
  origin?: string | null;
  destination?: string | null;
  departDate?: Date | string | null;
  arriveDate?: Date | string | null;
  /** Layover printed AFTER this leg; present ⇒ the next leg is a connection. */
  layover?: string | null;
}

export type TripType = "ONE_WAY" | "ROUND_TRIP" | "MULTI_CITY";

function code(v: string | null | undefined): string {
  return String(v ?? "").trim().toUpperCase();
}

function dayIndex(d: Date | string): number | null {
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? Math.floor(t / 86_400_000) : null;
}

/**
 * Trip type from the legs alone:
 *   1 leg                                        → ONE_WAY
 *   last.destination === first.origin            → ROUND_TRIP
 *   every boundary has a printed layover         → ONE_WAY (via hub)
 *   otherwise                                    → MULTI_CITY
 * The layover check runs on legs[0..n-2] only — nothing is printed after the
 * final leg, so its layover is always empty and must not count against it.
 */
export function deriveTripType(legs: LegLike[]): TripType {
  const n = legs.length;
  if (n <= 1) return "ONE_WAY";
  const o = code(legs[0].origin);
  const d = code(legs[n - 1].destination);
  if (o && d && o === d) return "ROUND_TRIP";
  if (legs.slice(0, n - 1).every((l) => String(l.layover ?? "").trim())) return "ONE_WAY";
  return "MULTI_CITY";
}

/**
 * Index of the first leg of the homeward journey in a ROUND_TRIP. Three
 * tiers, first hit wins:
 *   1. the first leg boundary with NO printed layover — trusted only when
 *      the ticket printed layovers at all;
 *   2. the first boundary where the next departure falls on a later
 *      calendar day than the previous arrival;
 *   3. the midpoint.
 * n ≤ 2 is always 1. The turnaround city is legs[result - 1].destination.
 */
export function returnJourneyStart(legs: LegLike[]): number {
  const n = legs.length;
  if (n <= 2) return 1;
  if (legs.some((l) => String(l.layover ?? "").trim())) {
    for (let i = 1; i < n; i++) if (!String(legs[i - 1].layover ?? "").trim()) return i;
  }
  for (let i = 1; i < n; i++) {
    const a = legs[i - 1].arriveDate;
    const d = legs[i].departDate;
    if (a && d) {
      const ai = dayIndex(a);
      const di = dayIndex(d);
      if (ai != null && di != null && di > ai) return i;
    }
  }
  return Math.ceil(n / 2);
}
