// apps/backend/src/utils/departTimeGate.ts
//
// Departure time on manual FLIGHT bookings (Travel Spend Phase B, decision
// 2026-11-18). Every leg needs a departure time — or the operator's explicit
// "Unknown" — when a flight booking moves INTO Confirmed (Done): a new
// booking saved at Done, or an edit from any other status to Done. Same
// transition rule as the supplier fields (utils/bookingStatusGate.ts):
//   - Pending / WIP / Cancelled: optional;
//   - already Done before this save: not asked (a legacy Done booking stays
//     editable without a time it never had);
//   - SBT-sourced rows: never (the time comes from the SBT booking);
//   - rows with no legs[] (legacy single-sector shape): not asked — the form
//     always sends legs for a flight.
// NC leads never reach this (routes check isNcLead first). Frontend twin:
// lib/flightLegs.ts validateLegs (requireDepartTime).
import { parseClockTime } from "./flightTime.js";

const FLIGHT_TYPES = new Set(["FLIGHT", "FLIGHT_RESCHEDULE", "DUMMY_FLIGHT"]);
const EXEMPT_SOURCES = new Set(["SBT", "SBT_AUTO"]);
const str = (v: unknown) => String(v ?? "").trim();

export const departTimeRequired = (legNo: number) => `Leg ${legNo} Depart Time is required (or mark it Unknown)`;

/** Does this leg carry a usable time or an explicit "Unknown"? */
export function legHasDepartTime(l: any): boolean {
  return parseClockTime(l?.departTime) != null || l?.departTimeUnknown === true;
}

export function departTimeGateErrors(booking: any, previousStatus?: string): string[] {
  if (str(booking?.status).toUpperCase() !== "CONFIRMED") return [];
  if (str(previousStatus).toUpperCase() === "CONFIRMED") return [];
  if (!FLIGHT_TYPES.has(str(booking?.type).toUpperCase())) return [];
  if (EXEMPT_SOURCES.has(str(booking?.source).toUpperCase())) return [];
  const legs = booking?.itinerary?.legs;
  if (!Array.isArray(legs) || !legs.length) return [];
  const out: string[] = [];
  legs.forEach((l: any, i: number) => {
    if (!legHasDepartTime(l)) out.push(departTimeRequired(i + 1));
  });
  return out;
}
