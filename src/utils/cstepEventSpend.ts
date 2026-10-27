// apps/backend/src/utils/cstepEventSpend.ts
//
// CSTEP per-event spend (#15) — one row per Event Master event, built from
// the requests tagged to it ("Related to an event? Yes"). Pure: takes
// already-loaded, already-scoped cases and returns the rows, so GET
// /cstep/reports/event-spend (routes/cstep.ts) owns the queries and the
// Admin / Finance scoping, and this file owns only the arithmetic.
//
// A case's cost follows the Travel Register's convention:
//   - it has a settlement: the stored totalCostOfTour. FINALIZED counts as
//     settled; VERIFYING is still provisional (the Register's "TOTAL
//     (prov.)").
//   - no settlement yet: its real arrangements' frozen INR figure
//     (amountInr), provisional. A booking with a foreign amount and no rate
//     has no INR figure — it is counted in `unpricedBookings`, never
//     guessed.
// The CSTEP-paid / traveller-paid split and the category breakdown come from
// the settlement's lines (OFFICIAL = CSTEP-paid, PERSONAL = traveller-paid,
// each by the line's shipped expense category) plus the per diem
// (traveller-paid, PER_DIEM). Before settlement every arrangement is a
// CSTEP booking, so it is CSTEP-paid under its service type's category.

import { categoryOfServiceType, type CstepExpenseCategory } from "../models/cstep/expenseCategories.js";

/** A settlement line filed before categories existed has none. */
export const UNCATEGORISED = "UNCATEGORISED" as const;
export type EventSpendCategory = CstepExpenseCategory | typeof UNCATEGORISED;

export interface EventSpendCase {
  eventId: string;
  eventCode?: string; // the request's snapshot — the label when the master row is gone
  eventName?: string;
  /** Real arrangements only (arrangementIsReal). Read only when there is no settlement. */
  arrangements: Array<{ arrangedType?: string; amount?: number; currency?: string; amountInr?: number }>;
  settlement?: { status: string; totalCostOfTour?: number; perDiem?: { amountInr?: number } };
  settlementLines: Array<{ classification?: string; amountInr?: number; category?: string | null }>;
}

export interface EventSpendRow {
  eventId: string;
  eventCode: string;
  eventName: string;
  cases: number;
  settledCases: number;
  provisionalCases: number;
  totalInr: number;
  settledInr: number;
  provisionalInr: number;
  cstepPaidInr: number;
  travellerPaidInr: number;
  byCategory: Partial<Record<EventSpendCategory, number>>;
  unpricedBookings: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function emptyRow(eventId: string, eventCode: string, eventName: string): EventSpendRow {
  return {
    eventId,
    eventCode,
    eventName,
    cases: 0,
    settledCases: 0,
    provisionalCases: 0,
    totalInr: 0,
    settledInr: 0,
    provisionalInr: 0,
    cstepPaidInr: 0,
    travellerPaidInr: 0,
    byCategory: {},
    unpricedBookings: 0,
  };
}

function addTo(row: EventSpendRow, c: EventSpendCase) {
  const add = (cat: EventSpendCategory, amt: number) => {
    if (!amt) return;
    row.byCategory[cat] = round2((row.byCategory[cat] || 0) + amt);
  };
  row.cases++;

  let total: number;
  let settled = false;
  if (c.settlement) {
    settled = c.settlement.status === "FINALIZED";
    total = Number(c.settlement.totalCostOfTour || 0);
    for (const l of c.settlementLines) {
      const amt = Number(l.amountInr || 0);
      if (l.classification === "PERSONAL") row.travellerPaidInr += amt;
      else row.cstepPaidInr += amt;
      add((l.category as CstepExpenseCategory) || UNCATEGORISED, amt);
    }
    const perDiem = Number(c.settlement.perDiem?.amountInr || 0);
    row.travellerPaidInr += perDiem;
    add("PER_DIEM", perDiem);
  } else {
    total = 0;
    for (const a of c.arrangements) {
      const inr = Number(a.amountInr || 0);
      if (inr > 0) {
        total += inr;
        row.cstepPaidInr += inr;
        add(categoryOfServiceType(a.arrangedType), inr);
      } else if (Number(a.amount) > 0) {
        row.unpricedBookings++;
      }
    }
  }

  row.totalInr += total;
  if (settled) {
    row.settledCases++;
    row.settledInr += total;
  } else {
    row.provisionalCases++;
    row.provisionalInr += total;
  }
}

function roundRow(row: EventSpendRow): EventSpendRow {
  for (const k of ["totalInr", "settledInr", "provisionalInr", "cstepPaidInr", "travellerPaidInr"] as const) {
    row[k] = round2(row[k]);
  }
  return row;
}

/**
 * One row per event that has at least one case, sorted by event code, plus
 * an "all events" total. `events` is the Event Master's current code / name
 * by id; an event no longer in the master falls back to the cases' own
 * snapshot.
 */
export function buildEventSpendRows(
  cases: EventSpendCase[],
  events: Map<string, { eventCode: string; eventName: string }>,
): { rows: EventSpendRow[]; total: EventSpendRow } {
  const byEvent = new Map<string, EventSpendRow>();
  const total = emptyRow("", "", "All events");
  for (const c of cases) {
    let row = byEvent.get(c.eventId);
    if (!row) {
      const master = events.get(c.eventId);
      row = emptyRow(c.eventId, master?.eventCode || c.eventCode || "", master?.eventName || c.eventName || "");
      byEvent.set(c.eventId, row);
    }
    addTo(row, c);
    addTo(total, c);
  }
  const rows = [...byEvent.values()].map(roundRow).sort((a, b) => a.eventCode.localeCompare(b.eventCode));
  return { rows, total: roundRow(total) };
}
