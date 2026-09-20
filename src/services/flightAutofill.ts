// apps/backend/src/services/flightAutofill.ts
//
// Turns an extracted flight voucher into the exact fields the
// /admin/manual-bookings/new form can take — nothing more. Pure, no I/O, so
// it is unit-testable against hand-written vouchers and re-runnable over a
// stored extractedJson.
//
// SINGLE LEG ONLY (Step 2). The form has one itinerary block, so this reads
// SEGMENT 0 and reports how many segments the ticket actually had; the form
// tells the operator when it was more than one. Multi-leg / round-trip lands
// with a model change in a later step — do not grow this to cover it.
//
// Field-name contract (form ⇄ voucher), verified against ManualBookingForm's
// FormState / PassengerInput and types/voucher.ts:
//   travelDate  ← flight_details.segments[0].origin.date
//   returnDate  ← flight_details.segments[0].destination.date   ("Arrival / Return Date")
//   origin      ← segments[0].origin.code        (form label "Origin Code")
//   destination ← segments[0].destination.code
//   flightNo    ← segments[0].flight_no
//   airline     ← segments[0].airline
//   supplierPNR ← booking_info.pnr, else booking_info.booking_id
//   supplierName — NO source on the voucher (no agency/issuer field); always null
//   passengers[] ← passengers[].{name,type,email,phone}; PAN has no source
import type { PlumtripsVoucher } from "../types/index.js";

export interface FlightAutofillPassenger {
  name: string;
  type: "ADULT" | "CHILD" | "INFANT" | null;
  email: string | null;
  phone: string | null;
}

export interface FlightAutofill {
  /** ISO YYYY-MM-DD for <input type="date">, or null when unparseable. */
  travelDate: string | null;
  /** What the ticket printed, for the "couldn't parse" hint. */
  travelDateRaw: string | null;
  returnDate: string | null;
  returnDateRaw: string | null;
  origin: string | null;
  destination: string | null;
  flightNo: string | null;
  airline: string | null;
  supplierPNR: string | null;
  supplierName: null;
  /** Segments the ticket carried; the form fills from the first only. */
  segmentCount: number;
  passengers: FlightAutofillPassenger[];
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function iso(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Round-trip through Date (UTC) to reject 31 Feb and friends.
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

/**
 * Parse a date the way it is printed on a ticket into YYYY-MM-DD.
 * The extractor imposes no format (the prompt only says "never invent"), so
 * this accepts the shapes airlines and portals actually print:
 *   2026-10-15 · 2026-10-15T06:30 · 15/10/2026 · 15-10-2026 · 15.10.2026
 *   15 Oct 2026 · 15 October 2026 · 15-Oct-2026 · 15Oct26 · Oct 15, 2026
 *   Wed, 15 Oct 2026 · 15 Oct 2026 06:30 · 15 Oct 26
 * Numeric D/M/Y is read day-first (Indian tickets); it flips to month-first
 * only when the first number cannot be a day. Anything else → null, and the
 * form shows the raw string so the operator can type it.
 */
export function parseTicketDate(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;

  // ISO first — cheapest and unambiguous.
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (m) return iso(+m[1], +m[2], +m[3]);

  // Drop a leading weekday ("Wed, " / "Wednesday ") and any trailing time.
  s = s.replace(/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*[,.]?\s+/i, "");
  s = s.replace(/[\s,]+\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm|hrs)?\s*$/i, "");
  s = s.replace(/,/g, " ").replace(/\s+/g, " ").trim();

  // Numeric: D/M/Y, D-M-Y, D.M.Y (2- or 4-digit year).
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2}|\d{4})$/);
  if (m) {
    let d = +m[1], mo = +m[2];
    const y = +m[3];
    if (d > 12 && mo <= 12) { /* day-first as written */ }
    else if (d <= 12 && mo > 12) { const t = d; d = mo; mo = t; }
    return iso(y, mo, d);
  }

  // 15 Oct 2026 / 15-Oct-2026 / 15Oct26 / 15 October 2026
  m = s.match(/^(\d{1,2})[\s\-]*([a-z]{3,9})[\s\-]*(\d{2}|\d{4})$/i);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    return mo ? iso(+m[3], mo, +m[1]) : null;
  }

  // Oct 15 2026 / October 15 2026 (comma already stripped)
  m = s.match(/^([a-z]{3,9})\s+(\d{1,2})\s+(\d{2}|\d{4})$/i);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    return mo ? iso(+m[3], mo, +m[2]) : null;
  }

  return null;
}

/** ADT/Adult → ADULT, CHD/Child → CHILD, INF/Infant → INFANT, anything else → null. */
export function normalizePassengerType(raw: string | null | undefined): FlightAutofillPassenger["type"] {
  const t = String(raw ?? "").trim().toUpperCase();
  if (!t) return null;
  if (t.startsWith("AD")) return "ADULT";
  if (t.startsWith("CH")) return "CHILD";
  if (t.startsWith("IN")) return "INFANT";
  return null;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
}

/**
 * Build the form fill from a voucher. Returns null when the voucher is not a
 * flight or carries neither a segment nor a passenger — the caller then
 * treats the document as "nothing to fill" and the form stays manual.
 */
export function buildFlightAutofill(voucher: PlumtripsVoucher | null | undefined): FlightAutofill | null {
  if (!voucher || voucher.type !== "flight") return null;

  const segments = Array.isArray(voucher.flight_details?.segments)
    ? voucher.flight_details!.segments
    : [];
  const paxIn = Array.isArray(voucher.passengers) ? voucher.passengers : [];

  const passengers: FlightAutofillPassenger[] = paxIn
    .map((p) => ({
      name: str(p?.name) ?? "",
      type: normalizePassengerType(p?.type),
      email: str(p?.email),
      phone: str(p?.phone),
    }))
    // A passenger with no name is not a row the form can hold (name is the
    // one required passenger field) — drop rather than create a blank row.
    .filter((p) => p.name);

  if (!segments.length && !passengers.length) return null;

  const seg = segments[0];
  const depRaw = str(seg?.origin?.date);
  const arrRaw = str(seg?.destination?.date);

  return {
    travelDate: parseTicketDate(depRaw),
    travelDateRaw: depRaw,
    returnDate: parseTicketDate(arrRaw),
    returnDateRaw: arrRaw,
    origin: str(seg?.origin?.code)?.toUpperCase() ?? null,
    destination: str(seg?.destination?.code)?.toUpperCase() ?? null,
    flightNo: str(seg?.flight_no),
    airline: str(seg?.airline),
    supplierPNR: str(voucher.booking_info?.pnr) ?? str(voucher.booking_info?.booking_id),
    supplierName: null,
    segmentCount: segments.length,
    passengers,
  };
}
