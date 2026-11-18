// apps/backend/src/services/flightInsights.ts
//
// Travel Spend Phase B panels, computed from CONFIRMED TravelBooking rows:
//   - Domestic vs International — Flights and Hotels, count + spend
//   - Airline share — split by booking (metadata.carrierShares sum to 1), so
//     count and spend add up to 100% of flight bookings
//   - Departure time slot — first leg's IST clock (metadata.departMinutesIST),
//     with the coverage the panel must show ("based on N of M flights") and
//     how many came from the ticket (metadata.departTimeSource)
//   - Cabin class mix (metadata.cabinClass) + coverage + "from ticket" count
//     (Phase B additions, 2026-11-18)
//
// Pure: GET /admin/unified/flight-insights runs it on the scoped rows, and
// scripts/resync-travel-booking-mirrors.ts runs it on the before/after rows
// of a dry run, so both report the same numbers.
import { DEPART_SLOTS, slotOf, type DepartSlot } from "../utils/flightTime.js";
import { UNKNOWN_CARRIER } from "../utils/airlineNormalize.js";
import { CABIN_CLASSES } from "./ticketFallback.js";

export type InsightRow = {
  service?: string | null;
  amount?: number | null;
  isInternational?: boolean | null;
  metadata?: {
    carrierShares?: { name: string; share: number }[] | null;
    departMinutesIST?: number | null;
    departTimeUnknown?: boolean | null;
    departTimeSource?: string | null;
    cabinClass?: string | null;
    cabinClassSource?: string | null;
  } | null;
};

export type Cell = { count: number; spend: number };
export type DomIntl = { domestic: Cell; international: Cell; unknown: Cell };
export type AirlineRow = { name: string; count: number; spend: number; countPct: number; spendPct: number };
export type SlotRow = { slot: DepartSlot; count: number; spend: number; pct: number };
export type CabinRow = { cabin: string; count: number; spend: number; pct: number };

export type FlightInsights = {
  domesticInternational: { FLIGHT: DomIntl; HOTEL: DomIntl };
  airlines: { rows: AirlineRow[]; flights: number; spend: number };
  departureSlots: { slots: SlotRow[]; timed: number; total: number; markedUnknown: number; fromTicket: number };
  cabins: { rows: CabinRow[]; known: number; total: number; fromTicket: number };
};

export const AIRLINE_TOP_N = 8;
export const OTHER_AIRLINES = "Other";

const r2 = (n: number) => Math.round(n * 100) / 100;
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const cell = (): Cell => ({ count: 0, spend: 0 });
const domIntl = (): DomIntl => ({ domestic: cell(), international: cell(), unknown: cell() });

export function computeFlightInsights(rows: InsightRow[], topN = AIRLINE_TOP_N): FlightInsights {
  const di = { FLIGHT: domIntl(), HOTEL: domIntl() };
  const carriers = new Map<string, Cell>();
  const slots = new Map<DepartSlot, Cell>(DEPART_SLOTS.map((s) => [s, cell()]));
  let flights = 0;
  let flightSpend = 0;
  let timed = 0;
  let markedUnknown = 0;
  let timedFromTicket = 0;
  const cabins = new Map<string, Cell>(CABIN_CLASSES.map((c) => [c, cell()]));
  let cabinKnown = 0;
  let cabinFromTicket = 0;

  for (const r of rows) {
    const svc = String(r.service || "");
    const amt = Number(r.amount) || 0;
    if (svc === "FLIGHT" || svc === "HOTEL") {
      const bucket = r.isInternational === true ? "international" : r.isInternational === false ? "domestic" : "unknown";
      di[svc][bucket].count += 1;
      di[svc][bucket].spend += amt;
    }
    if (svc !== "FLIGHT") continue;

    flights += 1;
    flightSpend += amt;
    const shares = Array.isArray(r.metadata?.carrierShares) && r.metadata!.carrierShares!.length
      ? r.metadata!.carrierShares!
      : [{ name: UNKNOWN_CARRIER, share: 1 }];
    for (const s of shares) {
      const c = carriers.get(s.name) ?? cell();
      c.count += s.share;
      c.spend += amt * s.share;
      carriers.set(s.name, c);
    }

    const min = r.metadata?.departMinutesIST;
    if (typeof min === "number" && Number.isFinite(min)) {
      timed += 1;
      if (r.metadata?.departTimeSource === "ticket") timedFromTicket += 1;
      const c = slots.get(slotOf(min))!;
      c.count += 1;
      c.spend += amt;
    } else if (r.metadata?.departTimeUnknown === true) {
      markedUnknown += 1;
    }

    const cab = r.metadata?.cabinClass ? cabins.get(String(r.metadata.cabinClass)) : undefined;
    if (cab) {
      cabinKnown += 1;
      if (r.metadata?.cabinClassSource === "ticket") cabinFromTicket += 1;
      cab.count += 1;
      cab.spend += amt;
    }
  }

  // Ranked by count. The top N named carriers, then "Other" (the remaining
  // named carriers), then "Unknown" (no airline recorded) on its own row so
  // missing data is never mistaken for small airlines.
  const ranked = [...carriers.entries()].sort((a, b) => b[1].count - a[1].count || b[1].spend - a[1].spend);
  const named = ranked.filter(([n]) => n !== UNKNOWN_CARRIER);
  const toRow = (name: string, c: Cell): AirlineRow => ({
    name, count: r2(c.count), spend: r2(c.spend), countPct: pct(c.count, flights), spendPct: pct(c.spend, flightSpend),
  });
  const airlineRows: AirlineRow[] = named.slice(0, topN).map(([name, c]) => toRow(name, c));
  const tail = named.slice(topN);
  if (tail.length) {
    airlineRows.push(toRow(OTHER_AIRLINES, tail.reduce((a, [, c]) => ({ count: a.count + c.count, spend: a.spend + c.spend }), cell())));
  }
  const unknown = carriers.get(UNKNOWN_CARRIER);
  if (unknown) airlineRows.push(toRow(UNKNOWN_CARRIER, unknown));

  for (const svc of ["FLIGHT", "HOTEL"] as const) {
    for (const k of ["domestic", "international", "unknown"] as const) di[svc][k].spend = r2(di[svc][k].spend);
  }

  return {
    domesticInternational: di,
    airlines: { rows: airlineRows, flights, spend: r2(flightSpend) },
    departureSlots: {
      slots: DEPART_SLOTS.map((s) => {
        const c = slots.get(s)!;
        return { slot: s, count: c.count, spend: r2(c.spend), pct: pct(c.count, timed) };
      }),
      timed,
      total: flights,
      markedUnknown,
      fromTicket: timedFromTicket,
    },
    cabins: {
      rows: CABIN_CLASSES.map((c) => {
        const v = cabins.get(c)!;
        return { cabin: c, count: v.count, spend: r2(v.spend), pct: pct(v.count, cabinKnown) };
      }),
      known: cabinKnown,
      total: flights,
      fromTicket: cabinFromTicket,
    },
  };
}
