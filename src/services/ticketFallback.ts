// apps/backend/src/services/ticketFallback.ts
//
// Travel Spend falls back to the extracted ticket (ExtractedDocument.flightRows)
// when a manual flight booking has no departure time or no cabin class
// (Phase B additions, 2026-11-18). The values go into the TravelBooking mirror
// ONLY, with a source flag ("ticket"); the booking itself is never touched.
//
// Departure time rules:
//   1. Segment: the one that starts at the booking's origin (first stop of
//      the first leg, else of itinerary.origin; IATA code or city name),
//      earliest first; otherwise the earliest-dated segment on the ticket.
//   2. Date sanity: the segment's date must be within 7 days of the booking's
//      travel date; with no travel date, within a year of the booking date.
//      Anything else (misread year, a different trip's ticket, no date) is
//      rejected.
//   3. Time: India departures are IST already; foreign departures are
//      converted from the airport's local time to IST (data/airportTimezones);
//      an airport whose zone is unknown is skipped.
// Cabin class: a REAL cabin only (Economy / Premium Economy / Business /
// First). Fare-class codes ("SM", "FL", "U1") are never mapped — IndiGo
// Stretch and AI Express Biz exist, so a code doesn't imply Economy.
//
// Pure except loadTicketRows (one read of extracteddocuments).
import mongoose from "mongoose";
import { travelLookup, travelCountryOf } from "../data/destinationLookup.js";
import { departureTimeZone, localToUtcMs, istMinutesOf } from "../data/airportTimezones.js";
import { parseClockTime, fmtClock } from "../utils/flightTime.js";

export type TicketRow = {
  segmentIndex?: number | null;
  depAirport?: string | null;
  depCity?: string | null;
  depDate?: string | null;
  depTime?: string | null;
  cabinClass?: string | null;
};

export const CABIN_CLASSES = ["Economy", "Premium Economy", "Business", "First"] as const;
export type CabinClass = (typeof CABIN_CLASSES)[number];

/**
 * A real cabin named in free text, else null. Order matters: "Premium
 * Economy" before "Economy", "Premium Business" is Business. Product names
 * that ARE cabins count ("Stretch", "Biz", "Upper Class"); bare fare-class
 * codes never do.
 */
export function realCabin(raw: unknown): CabinClass | null {
  const s = String(raw ?? "").toLowerCase();
  if (!s.trim()) return null;
  if (/premium\s*(economy|eco\b)|prem\.?\s*eco/.test(s)) return "Premium Economy";
  if (/\bfirst\b/.test(s)) return "First";
  if (/business|\bbiz\b|stretch|upper\s*class|club\s*world/.test(s)) return "Business";
  if (/economy|\beco\b|\bcoach\b|main\s*cabin/.test(s)) return "Economy";
  return null;
}

/** TBO cabin code on an SBT booking → cabin (1 = "All" is not a cabin). */
export function sbtCabin(code: unknown): CabinClass | null {
  switch (Number(code)) {
    case 2: return "Economy";
    case 3: return "Premium Economy";
    case 4:
    case 5: return "Business";
    case 6: return "First";
    default: return null;
  }
}

const MON: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const mon = (s: string) => MON[s.slice(0, 3).toLowerCase()];

/**
 * A ticket date (the extractor returns several formats) → Date.UTC of that
 * calendar day, or null. `yearHint` fills a date printed without a year.
 *   2026-07-17 · 17-Jul-2026 · 17 Jul 2026 · 16Aug2026 · Sun 19 Apr, 2026 ·
 *   Mon, Aug 10, 2026 · 17/07/2026 (day first) · Jul 19 / 27AUG (+ yearHint)
 */
export function parseTicketDate(raw: unknown, yearHint?: number | null): Date | null {
  const s = String(raw ?? "").trim();
  if (!s || s.toLowerCase() === "null") return null;
  const mk = (y: number, m: number | undefined, d: number) =>
    m == null || d < 1 || d > 31 || y < 1900 ? null : new Date(Date.UTC(y, m, d));
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return mk(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/(\d{1,2})[\s\-\/]*([A-Za-z]{3})[a-z]*[\s,\-\/]*(\d{4})/);
  if (m && mon(m[2]) != null) return mk(+m[3], mon(m[2]), +m[1]);
  m = s.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (m && mon(m[1]) != null) return mk(+m[3], mon(m[1]), +m[2]);
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) return mk(+m[3], +m[2] - 1, +m[1]);
  if (yearHint) {
    m = s.match(/^([A-Za-z]{3})[a-z]*\s+(\d{1,2})$/);
    if (m && mon(m[1]) != null) return mk(yearHint, mon(m[1]), +m[2]);
    m = s.match(/^(\d{1,2})\s*([A-Za-z]{3})[a-z]*$/);
    if (m && mon(m[2]) != null) return mk(yearHint, mon(m[2]), +m[1]);
  }
  return null;
}

/** First stop of a route string: "BLR - DEL" → "BLR". */
export function firstStop(raw: unknown): string {
  return String(raw ?? "").split(/\s*(?:-|–|,|\/|>|→|\bto\b)\s*/i).map((x) => x.trim()).filter(Boolean)[0] ?? "";
}

const norm = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
function sameStop(a: unknown, b: unknown): boolean {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ca = travelLookup(a)?.city;
  return !!ca && ca === travelLookup(b)?.city;
}

export type TicketDeparture =
  | { ok: true; minutesIST: number; departTimeIST: string; how: "origin" | "earliest"; fromTz: string | null; segmentIndex: number | null }
  | { ok: false; reason: "no-rows" | "no-segment" | "bad-date" | "no-time" | "unknown-tz" };

const DAY = 86400000;

/** The booking's first departure, IST, from its ticket rows (rules above). */
export function ticketDeparture(booking: any, rows: TicketRow[]): TicketDeparture {
  if (!rows?.length) return { ok: false, reason: "no-rows" };
  const it = booking?.itinerary || {};
  const origin = firstStop(it.legs?.[0]?.origin ?? it.origin);
  const travelDate = booking?.travelDate ? new Date(booking.travelDate) : null;
  const yearHint = (travelDate ?? (booking?.bookingDate ? new Date(booking.bookingDate) : null))?.getUTCFullYear() ?? null;

  // One entry per segment (rows repeat per passenger).
  const segs = new Map<string, TicketRow>();
  for (const r of rows) segs.set(`${r.segmentIndex}|${r.depAirport}|${r.depDate}|${r.depTime}`, r);
  const all = [...segs.values()].map((r) => ({ r, d: parseTicketDate(r.depDate, yearHint) }));
  const byDate = (a: { d: Date | null }, b: { d: Date | null }) => (a.d?.getTime() ?? Infinity) - (b.d?.getTime() ?? Infinity);

  let how: "origin" | "earliest" = "origin";
  let pick = origin ? all.filter((x) => sameStop(x.r.depAirport, origin) || sameStop(x.r.depCity, origin)).sort(byDate)[0] : undefined;
  if (!pick) {
    how = "earliest";
    pick = all.filter((x) => x.d).sort(byDate)[0];
  }
  if (!pick) return { ok: false, reason: "no-segment" };

  const d = pick.d;
  const dateOk = !!d && (travelDate
    ? Math.abs(d.getTime() - Date.UTC(travelDate.getUTCFullYear(), travelDate.getUTCMonth(), travelDate.getUTCDate())) <= 7 * DAY
    : !!booking?.bookingDate && Math.abs(d.getUTCFullYear() - new Date(booking.bookingDate).getUTCFullYear()) <= 1);
  if (!dateOk) return { ok: false, reason: "bad-date" };

  const local = parseClockTime(pick.r.depTime);
  if (local == null) return { ok: false, reason: "no-time" };

  const country = travelCountryOf(pick.r.depAirport) ?? travelCountryOf(pick.r.depCity);
  const segmentIndex = typeof pick.r.segmentIndex === "number" ? pick.r.segmentIndex : null;
  if (country === "IN") return { ok: true, minutesIST: local, departTimeIST: fmtClock(local), how, fromTz: null, segmentIndex };
  const tz = country ? departureTimeZone(pick.r.depAirport, country) : null;
  if (!tz) return { ok: false, reason: "unknown-tz" };
  const minutesIST = istMinutesOf(localToUtcMs(d!.getTime(), local, tz));
  return { ok: true, minutesIST, departTimeIST: fmtClock(minutesIST), how, fromTz: tz, segmentIndex };
}

/** A real cabin from the ticket: the chosen segment's rows first, then any row in segment order. */
export function ticketCabin(rows: TicketRow[], preferSegment?: number | null): CabinClass | null {
  if (!rows?.length) return null;
  const ordered = [...rows].sort((a, b) => (Number(a.segmentIndex) || 0) - (Number(b.segmentIndex) || 0));
  if (preferSegment != null) {
    for (const r of ordered) if (r.segmentIndex === preferSegment && realCabin(r.cabinClass)) return realCabin(r.cabinClass);
  }
  for (const r of ordered) { const c = realCabin(r.cabinClass); if (c) return c; }
  return null;
}

/** Flight rows of the booking's extracted tickets (status "extracted" only). Never throws. */
export async function loadTicketRows(bookingId: unknown): Promise<TicketRow[]> {
  try {
    if (!bookingId || mongoose.connection.readyState !== 1) return [];
    const id = new mongoose.Types.ObjectId(String(bookingId));
    const docs = await mongoose.connection.collection("extracteddocuments")
      .find({ bookingId: id, status: "extracted" }, { projection: { flightRows: 1, createdAt: 1 } })
      .sort({ createdAt: 1 })
      .toArray();
    return docs.flatMap((d: any) => (Array.isArray(d.flightRows) ? d.flightRows : []));
  } catch {
    return [];
  }
}
