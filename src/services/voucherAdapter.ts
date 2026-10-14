// apps/backend/src/services/voucherAdapter.ts
//
// L3a — adapter from an EXTRACTED PlumtripsVoucher (record.extractedJson, the
// Gemini→normalize output) to the SHARED SBT template input shapes:
//   adaptFlight → { booking: TicketBooking; returnBooking?: TicketBooking }
//   adaptHotel  → HotelVoucherParams
//
// The mapping follows infra/audit/voucher-adapter-mapping-audit-2026-05-27.md
// field-by-field. Locked decisions for this phase:
//   - One PNR per record (single scalar). No multi-PNR.
//   - Cabin: reverse-map class string → CABIN_MAP number; fallback Economy (2).
//
// Two decisions from that audit have since been REVERSED, because both dropped
// data the source document carried (render-fidelity fixes S2 / S3 = F-06):
//   - Legs: every segment is rendered on its own page. 3+ leg itineraries are
//     no longer collapsed to first + last.
//   - Baggage/seat/meal/ticket number: mapped through per passenger and per
//     segment. Where the document states nothing we print "—" rather than let
//     the template's "15 kg" literal assert an allowance nobody granted.
//
// Five BROKEN-RISK guards from the audit are implemented here:
//   (a) Hotel: hard-set reconciled:true — generateHotelVoucherHTML throws otherwise.
//   (b) Flight: coerce null origin.code/destination.code → "" — the template
//       calls code.toUpperCase() and throws on null.
//   (c) Hotel non-refundable: synthesize cancelPolicies[] with VALID TBO-format
//       FromDates, and verify with buildCancellationChips that a non-refundable
//       booking never renders as "Free cancellation available" (wrong+harmful) —
//       if synthesis is unsafe we HIDE the section ([]), never render free.
//   (d) Strip "[repair] …" notes (injected by voucherNormalize.ts) before any
//       visible slot.
//   (e) Supply the required TicketBooking.createdAt as a string.

import type {
  PlumtripsVoucher,
  FlightSegment,
  FlightLeg,
  Passenger,
} from "../types/index.js";
import type { TicketBooking } from "@plumtrips/shared/voucher-templates/ticketGenerator";
import type { HotelVoucherParams } from "@plumtrips/shared/voucher-templates/hotelVoucherGenerator";
import {
  buildCancellationChips,
  type CancelPolicy,
} from "@plumtrips/shared/voucher-templates/cancellationPolicy";
import logger from "../utils/logger.js";
import { statedNonRefundable } from "./voucherNormalize.js";
import { leadingCount } from "@plumtrips/shared/voucher-templates/counts";
import {
  buildDateContext,
  fmtDay,
  isoDate,
  resolveStayDates,
  resolveVoucherDate,
  type DateContext,
} from "./voucherDates.js";

/* ───────────────────────── small helpers ───────────────────────── */

/** Coerce any null/undefined to "" (never pass null into the templates). */
function nz(x: unknown): string {
  return x === null || x === undefined ? "" : String(x);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Parse a free-form time string into {h, m}; null if none/unparseable. */
function parseLooseTime(input?: string | null): { h: number; m: number } | null {
  const s = (input || "").trim();
  if (!s) return null;

  // HH:MM[:SS] [am/pm]
  let m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?/);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    const ap = m[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return { h, m: min };
  }

  // "8 AM" / "8 pm"
  m = s.match(/^(\d{1,2})\s*([AaPp][Mm])$/);
  if (m) {
    let h = Number(m[1]);
    const ap = m[2].toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h >= 0 && h <= 23) return { h, m: 0 };
  }

  // "0835" / "2015" 24h compact
  m = s.match(/^(\d{2})(\d{2})$/);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h <= 23 && min <= 59) return { h, m: min };
  }

  return null;
}

/**
 * Wall-clock `YYYY-MM-DDTHH:mm:ss` (no zone) from a UTC-midnight calendar day
 * plus a time. The ticket template reads it back with `new Date(...)` and
 * formats it in the same zone, so the printed day and time are exactly these.
 */
function wallClockIso(day: Date, time: { h: number; m: number } | null): string {
  return `${isoDate(day)}T${pad2(time?.h ?? 0)}:${pad2(time?.m ?? 0)}:00`;
}

/**
 * Optional render context. `createdAt` anchors the year for dates printed
 * without one; `warnings` collects anything ops should double-check (shown on
 * the record in /admin/vouchers). Both optional — callers that pass nothing
 * get today as the anchor and the warnings are discarded.
 */
export interface AdaptContext {
  createdAt?: Date | string | null;
  warnings?: string[];
}

/**
 * What the adapters are given for a stored record — the one preparation both
 * the PDF render (routes/vouchers.ts renderViaSbtLambda) and the page's
 * Summary (voucherDisplayDates) use:
 *   - isDemo from the record (VoucherExtraction.isDemo, set at extraction),
 *     so the template renders the SAMPLE watermark; never persisted;
 *   - refundability as the document stated it (true / false / null) — older
 *     records stored a collapsed boolean (statedNonRefundable).
 */
export function adapterInput(record: any): PlumtripsVoucher {
  const v: any = { ...(record?.extractedJson ?? {}), isDemo: !!record?.isDemo };
  v.policies = { ...(v.policies ?? {}), is_non_refundable: statedNonRefundable(record) };
  return v;
}

function dateContextFor(v: PlumtripsVoucher, ctx?: AdaptContext): DateContext {
  return buildDateContext(v?.booking_info?.booking_date, ctx?.createdAt, ctx?.warnings ?? []);
}

/**
 * Resolve a leg's date (inferring a missing year — see voucherDates.ts) and
 * combine it with the leg's time. Returns "" — NOT the raw string and NOT NaN —
 * when the date can't be read, so the template renders blank rather than junk.
 */
function buildLegDateTime(
  leg: FlightLeg | undefined,
  label: string,
  dctx: DateContext,
  notBefore: Date | null,
): { iso: string; day: Date | null } {
  const day = resolveVoucherDate(leg?.date, dctx, { label, notBefore });
  if (!day) {
    if (nz(leg?.date) || nz(leg?.time)) {
      logger.warn("[voucher-adapter] unparseable leg datetime; rendering blank", {
        label,
        date: nz(leg?.date),
        time: nz(leg?.time),
      });
    }
    return { iso: "", day: null };
  }
  return { iso: wallClockIso(day, parseLooseTime(leg?.time)), day };
}

/* ───────────────────────── flight bits ───────────────────────── */

// Reverse of CABIN_MAP in the shared ticket template.
function classToCabin(cls?: string | null): number {
  const s = (cls || "").toLowerCase().trim();
  if (!s) return 2; // Economy fallback
  if (s.includes("first")) return 6;
  if ((s.includes("premium") || s.includes("prem")) && s.includes("business")) return 5;
  if (s.includes("business")) return 4;
  if ((s.includes("premium") || s.includes("prem")) && s.includes("econ")) return 3;
  if (s.includes("econom") || s === "economy") return 2;
  if (s === "all") return 1;
  // RBD letter heuristics
  if (/^[fa]$/.test(s)) return 6;
  if (/^[jcdiz]$/.test(s)) return 4;
  if (/^w$/.test(s)) return 3;
  return 2; // unknown → Economy (locked decision)
}

const TITLE_RE = /^(mr|mrs|ms|miss|mstr|master|dr|prof)\.?$/i;

function normalizeTitle(raw: string): string {
  const t = raw.replace(/\.$/, "").toLowerCase();
  const map: Record<string, string> = {
    mr: "Mr", mrs: "Mrs", ms: "Ms", miss: "Miss",
    mstr: "Mstr", master: "Master", dr: "Dr", prof: "Prof",
  };
  return map[t] || raw;
}

/** Split a single extracted name string into {title, firstName, lastName}. */
function splitName(full?: string | null): {
  title: string;
  firstName: string;
  lastName: string;
} {
  const s = (full || "").trim();
  if (!s) return { title: "", firstName: "", lastName: "" };

  // BCBP "LASTNAME/FIRSTNAME TITLE"
  if (s.includes("/")) {
    const [lastRaw, restRaw] = s.split("/");
    const parts = (restRaw || "").trim().split(/\s+/).filter(Boolean);
    let title = "";
    if (parts.length && TITLE_RE.test(parts[parts.length - 1])) {
      title = normalizeTitle(parts.pop() as string);
    }
    const first = parts.join(" ");
    const last = (lastRaw || "").trim();
    if (first) return { title, firstName: first, lastName: last };
    return { title, firstName: last, lastName: "" };
  }

  const tokens = s.split(/\s+/).filter(Boolean);
  let title = "";
  if (TITLE_RE.test(tokens[0])) {
    title = normalizeTitle(tokens[0]);
    tokens.shift();
  }
  if (tokens.length === 0) return { title, firstName: "", lastName: "" };
  if (tokens.length === 1) return { title, firstName: tokens[0], lastName: "" };
  const firstName = tokens.shift() as string;
  return { title, firstName, lastName: tokens.join(" ") };
}

// Template displays adult/1, child/2, infant/3 → anything else "Adult".
function mapPaxType(type?: string | null): string {
  const s = (type || "").toLowerCase().trim();
  if (!s) return "adult";
  if (s.startsWith("inf") || s === "3") return "infant";
  if (s.startsWith("ch") || s === "2") return "child";
  return "adult";
}

/**
 * What we print when the source document states no allowance. A blank is the
 * honest answer: the template's own "15 kg" default is a plausible number the
 * airline may never have granted, and a passenger reads the voucher at the
 * bag drop. The e-ticket's policy list already says allowance is as booked.
 */
const NOT_STATED = "—";

/** True when the passengers state genuinely different values from each other. */
function variesAcrossPassengers(values: (string | null | undefined)[]): boolean {
  return new Set(values.map((v) => (v ?? "").trim()).filter(Boolean)).size > 1;
}

/**
 * Passengers are rebuilt per segment, because baggage belongs to a passenger
 * *on a leg*.
 *
 * The extract states allowance on two independent axes — per passenger and per
 * segment — and neither contains the other. So we take whichever axis actually
 * carries information: when the passengers differ from each other, their own
 * figures are what matter; otherwise the segment's figure is the one specific
 * to the page being rendered (a return leg often has a different allowance from
 * the outbound, and the per-passenger field tends to hold a merged summary of
 * both). The other axis fills the gaps.
 */
function buildPassengers(
  pax: Passenger[] | undefined,
  seg: FlightSegment | undefined,
): TicketBooking["passengers"] {
  const anc = seg?.ancillaries;
  const list = pax || [];
  const checkInIsPerPassenger = variesAcrossPassengers(list.map((p) => p?.baggage_check_in));
  const cabinIsPerPassenger = variesAcrossPassengers(list.map((p) => p?.baggage_cabin));

  return list.map((p, i) => {
    const { title, firstName, lastName } = splitName(p?.name);
    return {
      title,
      firstName,
      lastName,
      paxType: mapPaxType(p?.type),
      isLead: i === 0,
      ticketNumber: p?.ticket_no ?? null,
      checkInBaggage:
        (checkInIsPerPassenger
          ? p?.baggage_check_in ?? anc?.checkin_bag
          : anc?.checkin_bag ?? p?.baggage_check_in) ?? NOT_STATED,
      cabinBaggage:
        (cabinIsPerPassenger
          ? p?.baggage_cabin ?? anc?.cabin_bag
          : anc?.cabin_bag ?? p?.baggage_cabin) ?? NOT_STATED,
      // Seat and meal are stated per passenger; a segment value only fills gaps.
      seat: p?.seat ?? anc?.seat ?? null,
      meal: p?.meal ?? anc?.meal ?? null,
    };
  });
}

/** True when the last segment lands back at the first segment's origin. */
function returnsTowardOrigin(first: FlightSegment, last: FlightSegment): boolean {
  const o = (first?.origin?.code || first?.origin?.city || "").toLowerCase().trim();
  const d = (last?.destination?.code || last?.destination?.city || "").toLowerCase().trim();
  return !!o && !!d && o === d;
}

function buildBookingFromSegment(
  v: PlumtripsVoucher,
  seg: FlightSegment | undefined,
  shared: { ticketId: string; createdAt: string },
  times: { departureTime: string; arrivalTime: string },
  legLabel?: string,
): TicketBooking {
  const origin = seg?.origin;
  const dest = seg?.destination;
  const anc = seg?.ancillaries;
  return {
    pnr: nz(v?.booking_info?.pnr),
    // H-12: empty when the source states no booking ID; the template then
    // leaves the box out (the PNR has its own box).
    bookingId: nz(v?.booking_info?.booking_id).trim(),
    ticketId: shared.ticketId,
    status: "CONFIRMED", // extract has no status; template also defaults this
    // Guard (b): code coerced null→"" so cityName()/airportFullName() never throw.
    origin: { code: nz(origin?.code), city: nz(origin?.city) },
    destination: { code: nz(dest?.code), city: nz(dest?.city) },
    departureTime: times.departureTime,
    arrivalTime: times.arrivalTime,
    airlineCode: "", // not rendered by the template
    airlineName: nz(seg?.airline),
    flightNumber: nz(seg?.flight_no),
    cabin: classToCabin(seg?.class),
    passengers: buildPassengers(v?.passengers, seg),
    // Leg-level allowance: what this segment's fare grants, used for the summary
    // tiles and as the fallback for a passenger who carries no figure of its own.
    checkInBaggage: anc?.checkin_bag ?? NOT_STATED,
    cabinBaggage: anc?.cabin_bag ?? NOT_STATED,
    legLabel: legLabel ?? null,
    // Fares are not rendered on the e-ticket — supply zeros / INR.
    baseFare: 0,
    taxes: 0,
    extras: 0,
    totalFare: 0,
    currency: "INR",
    // isLCC drives the "Non-Refundable" badge + policy wording in the template.
    isLCC: !!v?.policies?.is_non_refundable,
    createdAt: shared.createdAt, // Guard (e): required string
    // Demo Platform — forwarded onto BOTH outbound + return bookings via the
    // shared `buildBookingFromSegment` helper, so the watermark renders on every
    // page of a multi-leg ticket. See Sprint 2 audit P5.
    isDemo: !!v?.isDemo,
  };
}

/**
 * Map an extracted flight voucher to the shared template's booking + the legs
 * that follow it. EVERY segment is rendered — a 3+ leg itinerary gets a page
 * per leg rather than being collapsed to first + last (F-06).
 *
 * The final leg is titled "Return" only when it actually lands back where the
 * itinerary began; otherwise it is "Onward". Legs in between are "Connecting".
 */
export function adaptFlight(
  v: PlumtripsVoucher,
  ctx?: AdaptContext,
): {
  booking: TicketBooking;
  returnBooking?: TicketBooking | TicketBooking[];
} {
  const segs: FlightSegment[] = Array.isArray(v?.flight_details?.segments)
    ? v.flight_details!.segments
    : [];

  const shared = {
    ticketId: nz(v?.passengers?.[0]?.ticket_no), // lead pax ticket as the booking-level fallback
    createdAt: new Date().toISOString(),
  };

  // Legs are resolved in order: a leg printed without a year can't precede the
  // one before it, so it rolls into the next year (a Dec 31 → Jan 1 itinerary).
  const dctx = dateContextFor(v, ctx);
  let prev: Date | null = null;
  const legTimes = segs.map((seg, i) => {
    const n = segs.length > 1 ? ` (segment ${i + 1})` : "";
    const dep = buildLegDateTime(seg?.origin, `Departure date${n}`, dctx, prev);
    const arr = buildLegDateTime(seg?.destination, `Arrival date${n}`, dctx, dep.day ?? prev);
    prev = arr.day ?? dep.day ?? prev;
    return { departureTime: dep.iso, arrivalTime: arr.iso };
  });
  const noTimes = { departureTime: "", arrivalTime: "" };

  if (segs.length <= 1) {
    return { booking: buildBookingFromSegment(v, segs[0], shared, legTimes[0] ?? noTimes) };
  }

  const onward = segs.slice(1);
  const isRoundTrip = returnsTowardOrigin(segs[0], segs[segs.length - 1]);

  const onwardBookings = onward.map((seg, i) => {
    const isFinalLeg = i === onward.length - 1;
    const legLabel = isFinalLeg ? (isRoundTrip ? "Return" : "Onward") : "Connecting";
    return buildBookingFromSegment(v, seg, shared, legTimes[i + 1], legLabel);
  });

  if (segs.length > 2) {
    logger.info("[voucher-adapter] multi-leg itinerary rendered one page per leg", {
      pnr: nz(v?.booking_info?.pnr),
      totalSegments: segs.length,
      route: segs
        .map((s) => `${nz(s?.origin?.code)}→${nz(s?.destination?.code)}`)
        .join(" / "),
    });
  }

  return {
    booking: buildBookingFromSegment(v, segs[0], shared, legTimes[0]),
    // Single extra leg stays a bare object — the shape existing callers expect.
    returnBooking: onwardBookings.length === 1 ? onwardBookings[0] : onwardBookings,
  };
}

/* ───────────────────────── hotel bits ───────────────────────── */

/** Guard (d): drop the internal "[repair] …" notes before any visible slot. */
function stripRepairNotes(notes?: string[] | null): string[] {
  if (!Array.isArray(notes)) return [];
  return notes.filter(
    (n) => typeof n === "string" && !n.trim().toLowerCase().startsWith("[repair]"),
  );
}

/**
 * A stay perk the voucher lists among its notes ("Early check-in up to 2
 * hours (subject to availability)", "Late Checkout Subject to Availability").
 * Gemini files these under notes, which printed them under "Rate Conditions"
 * apart from the rest of what's included. Deliberately narrow: the WHOLE line
 * must be the perk itself — optionally "up to / until …" and "(subject to
 * availability)" — and mention no fee. So these stay notes:
 *   "Special requests (bed type, early check-in, late check-out …) are not guaranteed"
 *   "Early Check-in and Late Check-out will attract 50% of room tariff."
 *   "Early check-in and late check-out are subject to availability and hotel policy."
 *   "Optional fees: … late check-out (CHF 20)"
 */
const PERK = String.raw`(?:early\s*check[- ]?in|late\s*check[- ]?out)`;
const PERK_LINE_RE = new RegExp(
  String.raw`^\s*(?:complimentary\s+|free\s+)?${PERK}(?:\s+(?:and|&)\s+${PERK})?` +
    String.raw`(?:\s+(?:up\s*to|till|until)\s+[\w\s:.]+?)?` +
    String.raw`\s*(?:[(,-]?\s*subject\s+to\s+availability\s*\)?)?\s*\.?\s*$`,
  "i",
);
const PERK_EXCLUDE_RE = /\b(?:fee|fees|charge|charges|chargeable|cost|payable|paid|tariff|rate|extra)\b|%|[₹$€£]/i;
export function isStayPerk(note: string): boolean {
  const s = (note || "").trim();
  return s.length > 0 && s.length <= 90 && PERK_LINE_RE.test(s) && !PERK_EXCLUDE_RE.test(s);
}

/**
 * A note that states what the booking cost or what was paid for it ("Complete
 * payment to avoid auto cancellation. Amount ₹ 58,530 by 25 Dec", "Booking.com
 * paid 716.67 of this booking … 10,035.57 as the total price"). The extracted
 * voucher goes to the traveller, who must never see the supplier's price, so
 * these are dropped. Needs both a price/payment word AND an amount, and loses
 * to anything about fees the guest pays at the hotel — city/tourist tax,
 * resort fee, deposit, "payable at the property" — which is the guest's to
 * know. Anything else that mentions money stays.
 */
const PRICE_WORD_RE =
  /\b(?:amount|total|grand\s+total|booking\s+(?:amount|value|price)|paid|payment|net\s+rate|price)\b/i;
const AMOUNT_RE =
  /[₹$€£]\s*\d|\b(?:inr|rs\.?|usd|eur|euro|aed|chf|gbp|sar|aud|sgd|thb|myr)\s*\d|\d\s*(?:inr|usd|eur|euros?|aed|chf|gbp|sar|aud|sgd|thb|myr)\b|\b\d{1,3}(?:,\d{2,3})+(?:\.\d+)?\b|\b\d+\.\d{2}\b/i;
const AT_HOTEL_FEE_RE =
  /\b(?:city|tourist|tourism)\s+(?:tax|fee)|\bresort\s+fee|\bdeposit|\bpayable\b|\b(?:paid|pay|collected|charged)\s+(?:directly\s+)?(?:at|to|by)\s+(?:the\s+)?(?:hotel|property)|\bat\s+(?:the\s+)?(?:hotel|property)\b|\bon\s+arrival\b|\bat\s+check[- ]?(?:in|out)\b|\bsupplements?\b/i;
export function isPriceNote(note: string): boolean {
  const s = note || "";
  return PRICE_WORD_RE.test(s) && AMOUNT_RE.test(s) && !AT_HOTEL_FEE_RE.test(s);
}

/** Notes → { perks for "What's included", the rest for "Important information" }. */
function splitPerks(notes: string[], inclusions: string[]): { inclusions: string[]; notes: string[] } {
  const seen = new Set(inclusions.map((i) => i.trim().toLowerCase()));
  const outInc = [...inclusions];
  const outNotes: string[] = [];
  for (const n of notes) {
    const t = (n || "").trim();
    if (!t) continue;
    if (isStayPerk(t)) {
      if (!seen.has(t.toLowerCase())) {
        seen.add(t.toLowerCase());
        outInc.push(t);
      }
    } else {
      outNotes.push(t);
    }
  }
  return { inclusions: outInc, notes: outNotes };
}

/**
 * Booking-agency support lines that suppliers' pages show where the hotel's
 * number should be. Never printed as the hotel's phone. Keyed on the last 10
 * digits, so "0124-4998999", "+91 124 4998999" and "1244998999" all match.
 */
export const AGENCY_SUPPORT_NUMBERS: Readonly<Record<string, string>> = {
  "1244998999": "TBO support (\"Call us at\" on TBO booking pages; seen on 11 different hotels)",
  "8826843266": "Plumtrips (the agent's own line)",
};

/**
 * The hotel's phone number(s) out of the extracted contact line, which mixes
 * phones, emails and URLs ("9151915166, 05224606555, reservations@…"). Keeps
 * up to two numbers — later ones are often an aggregator's support lines —
 * and treats "+919880888999" and "9880888999" as one. Returns null for the
 * literal "null" older records hold, and for a contact block carrying a
 * plumtrips.com address: that is our own agent's line, not the hotel's. A
 * known agency support number (AGENCY_SUPPORT_NUMBERS) is skipped too.
 */
export function hotelPhoneFrom(x: unknown): string | null {
  const s = nz(x).trim();
  if (!s || /plumtrips\.com/i.test(s)) return null;
  const seen = new Set<string>();
  const phones: string[] = [];
  for (const part of s.split(/[,;|/]|\s{2,}/)) {
    const t = part.replace(/^\s*(?:phone|tel|telephone|mobile|mob|ph|contact)\s*[:.-]?\s*/i, "").trim();
    if (!t || /@|https?:|www\./i.test(t) || !/^[+\d\s().-]+$/.test(t)) continue;
    const digits = t.replace(/\D/g, "");
    if (digits.length < 6) continue;
    const key = digits.slice(-10);
    if (seen.has(key) || AGENCY_SUPPORT_NUMBERS[key]) continue;
    seen.add(key);
    phones.push(t);
    if (phones.length === 2) break;
  }
  return phones.length ? phones.join(", ") : null;
}


/** First name for the greeting (mirrors the template's own extractFirstName). */
function firstNameOf(fullName?: string | null): string {
  const cleaned = (fullName || "")
    .replace(/^(Mr\.?|Mrs\.?|Ms\.?|Miss\.?|Dr\.?|Prof\.?)\s+/i, "")
    .trim();
  return cleaned.split(/\s+/)[0] || "Valued Guest";
}

/** TBO-format a Date as "DD-MM-YYYY HH:mm:ss" (what parseTBODate expects). */
function tboFormat(d: Date): string {
  // Calendar fields only (the dates here are UTC-midnight days from voucherDates).
  return (
    `${pad2(d.getUTCDate())}-${pad2(d.getUTCMonth() + 1)}-${d.getUTCFullYear()} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  );
}

/** Sorts before any real tier and survives the FromDate ≤ check-out filter; never displayed. */
const FROM_BOOKING = new Date(Date.UTC(2000, 0, 1));

/** "Free cancellation …" said in so many words by the document. */
const FREE_STATEMENT_RE =
  /\bfree\s+cancell?ation\b|\bcancell?ation\s+(?:is\s+)?free\b|\bcancel(?:led)?\s+free\s+of\s+charge\b/i;
/** …and with no condition attached. */
const FREE_ANY_TIME_RE = /\bfree\s+cancell?ation\s+(?:at\s+)?any\s*time\b/i;

/** "10 days prior to arrival", "48 hours before check-in". */
const RELATIVE_DEADLINE_RE =
  /(\d{1,3})\s*(days?|hours?|hrs?)\s*(?:prior|before)\s*(?:to\s*)?(?:the\s*)?(?:arrival|check[- ]?in)/i;

/**
 * The moment cancellation charges begin, from cancellation_deadline:
 *   - a relative deadline counts back from check-in (at the check-in time when
 *     the voucher gives one, else from the start of the check-in day — the
 *     earlier, safer reading);
 *   - an absolute deadline keeps a time the document printed; a date with no
 *     time ends free cancellation at the START of that day, so "free before
 *     21 Jun" is never stretched into 21 Jun.
 * Alongside it, the deadline as the document states it, for printing:
 * "25 Dec 2026, 11:59 PM IST", "21 Jun 2026", "10 days prior to arrival" —
 * the stated day and time, with the year filled in the way stay dates get it.
 * `dateOnly` marks a deadline with no time, whose charges begin at the start
 * of that day. Returns null when the voucher gives no deadline.
 */
interface Deadline {
  /** When charges begin; null when the stated deadline can't be read. */
  chargesFrom: Date | null;
  stated: string;
  dateOnly: boolean;
}
function readDeadline(
  v: PlumtripsVoucher,
  checkIn: Date | null,
  checkInTime: { h: number; m: number } | null,
  dctx: DateContext,
): Deadline | null {
  const raw = nz(v?.policies?.cancellation_deadline).trim();
  if (!raw || /^null$/i.test(raw)) return null;

  const rel = raw.match(RELATIVE_DEADLINE_RE);
  if (rel) {
    if (!checkIn) return { chargesFrom: null, stated: raw, dateOnly: false };
    const n = Number(rel[1]);
    const ms = /^d/i.test(rel[2]) ? n * 86_400_000 : n * 3_600_000;
    const arrival = checkIn.getTime() + ((checkInTime?.h ?? 0) * 60 + (checkInTime?.m ?? 0)) * 60_000;
    return { chargesFrom: new Date(arrival - ms), stated: raw, dateOnly: false };
  }

  const day = resolveVoucherDate(raw, dctx, { label: "Cancellation deadline" });
  if (!day) return { chargesFrom: null, stated: raw, dateOnly: false };
  const t = raw.match(/(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp]\.?[Mm]\.?)?(?:\s*\b(IST|GMT|UTC|CET|CEST|BST|GST)\b)?/);
  const time = t ? parseLooseTime(`${t[1]}:${t[2]}${t[3] ? " " + t[3].replace(/\./g, "") : ""}`) : null;
  // start of the deadline day
  if (!time) return { chargesFrom: day, stated: fmtDay(day), dateOnly: true };
  const statedTime = `${t![1]}:${t![2]}${t![3] ? " " + t![3].toUpperCase() : ""}${t![4] ? " " + t![4] : ""}`;
  return {
    // The chip prints "until <next tier − 1s>"; starting charges at :59 makes
    // that read exactly the time the document gave ("until 12:59").
    chargesFrom: new Date(day.getTime() + (time.h * 60 + time.m) * 60_000 + 59_000),
    stated: `${fmtDay(day)}, ${statedTime}`,
    dateOnly: false,
  };
}

/**
 * Guard (c): cancelPolicies[] from what the document actually states. Free
 * cancellation is never inferred:
 *   - non-refundable (true)                              → one 100% tier ("Non-refundable …")
 *   - refundable (false) + a deadline                    → free until the deadline, then 100%
 *   - an explicit free-cancellation statement + deadline → the same
 *   - "free cancellation any time", stated as such       → free any time
 *   - a deadline and nothing else (refundability unstated) → [] plus the
 *     deadline: the template prints "Cancellation deadline: <date>. Charges
 *     may apply after this, as per supplier policy." — a deadline alone is
 *     not a promise that cancelling before it is free
 *   - anything else (unknown)                            → [] — the template prints
 *     "As per supplier policy — contact support" for extracted vouchers.
 * All FromDates are TBO format. `deadline` is returned for every case except
 * non-refundable, which the deadline can't soften.
 */
function synthesizeCancelPolicies(
  v: PlumtripsVoucher,
  checkIn: Date | null,
  checkInTime: { h: number; m: number } | null,
  checkOut: string,
  dctx: DateContext,
): { policies: CancelPolicy[]; deadline: Deadline | null } {
  const flag = v?.policies?.is_non_refundable;
  const notes = stripRepairNotes(v?.policies?.important_notes);
  const freeStatement = notes.some((n) => FREE_STATEMENT_RE.test(n));
  const freeAnyTime = notes.some((n) => FREE_ANY_TIME_RE.test(n));

  if (flag === true) {
    const policies: CancelPolicy[] = [
      { FromDate: tboFormat(FROM_BOOKING), ChargeType: "Percentage", CancellationCharge: 100 },
    ];
    const chips = buildCancellationChips(policies, { checkOut });
    if (chips.length > 0 && chips.every((c) => !c.isFree)) return { policies, deadline: null };
    logger.warn("[voucher-adapter] non-refundable cancel synthesis unsafe; printing supplier-policy line", {
      bookingId: nz(v?.booking_info?.booking_id),
      chipCount: chips.length,
    });
    return { policies: [], deadline: null };
  }

  const deadline = readDeadline(v, checkIn, checkInTime, dctx);
  if ((flag === false || freeStatement) && deadline?.chargesFrom) {
    return {
      policies: [
        { FromDate: tboFormat(FROM_BOOKING), ChargeType: "Percentage", CancellationCharge: 0 },
        { FromDate: tboFormat(deadline.chargesFrom), ChargeType: "Percentage", CancellationCharge: 100 },
      ],
      deadline,
    };
  }
  if (freeAnyTime) {
    return {
      policies: [{ FromDate: tboFormat(FROM_BOOKING), ChargeType: "Percentage", CancellationCharge: 0 }],
      deadline: null,
    };
  }
  return { policies: [], deadline };
}

/** Map an extracted hotel voucher to the shared template's params. */
export function adaptHotel(v: PlumtripsVoucher, ctx?: AdaptContext): HotelVoucherParams {
  const h = v?.hotel_details || ({} as NonNullable<PlumtripsVoucher["hotel_details"]>);
  const stay = v?.stay_details || ({} as NonNullable<PlumtripsVoucher["stay_details"]>);
  const guest = v?.guest_details || ({} as NonNullable<PlumtripsVoucher["guest_details"]>);
  const room = v?.room_details || ({} as NonNullable<PlumtripsVoucher["room_details"]>);

  const dctx = dateContextFor(v, ctx);
  const stayDates = resolveStayDates(stay.check_in_date, stay.check_out_date, stay.total_nights, dctx);
  const checkIn = stayDates.checkIn ? isoDate(stayDates.checkIn) : "";
  const checkOut = stayDates.checkOut ? isoDate(stayDates.checkOut) : "";

  const cleanNotes = stripRepairNotes(v?.policies?.important_notes);
  // Perks go with the inclusions; every other note prints, even a lone short
  // one — the T&C page has room for it (the old <60-char suppression hid data)
  // — except one stating the booking's price or payment (isPriceNote).
  const sorted = splitPerks(
    cleanNotes.filter((n) => !isPriceNote(n)),
    Array.isArray(room.inclusions) ? room.inclusions : [],
  );
  const supplierConf = nz(v?.booking_info?.supplier_conf_no);

  const ci = nz(stay.check_in_time);
  const co = nz(stay.check_out_time);
  const cancel = synthesizeCancelPolicies(v, stayDates.checkIn, parseLooseTime(ci), checkOut, dctx);

  return {
    hotelName: nz(h.name),
    hotelAddress: nz(h.address),
    hotelPhone: hotelPhoneFrom(h.contact),
    checkIn,
    checkOut,
    roomName: nz(room.room_type),
    bookingId: nz(v?.booking_info?.booking_id),
    // Extracted vouchers print these under their own labels ("Hotel
    // confirmation no.", "Supplier voucher no."), deduped against booking ID.
    confirmationNo: supplierConf,
    bookingRefNo: nz(v?.booking_info?.voucher_no),
    // Visible "HOTEL REFERENCE — SHOW AT CHECK-IN" box; omit when absent.
    tboReferenceNo: supplierConf || null,
    // important_notes (repair notes stripped, perks moved to inclusions):
    // the template prints them as "Important information" on the T&C page.
    rateConditions: sorted.notes.length > 0 ? sorted.notes : undefined,
    guestFirstName: firstNameOf(guest.primary_guest),
    leadGuestName: nz(guest.primary_guest),
    // The co-guests. The extract has carried all_guest_names[] all along —
    // normalize keeps it, the record holds it — and this adapter simply never
    // read it, so a two-guest booking rendered as though one person were
    // travelling. Same miss as the flight baggage fields: data present, never
    // mapped. The template de-duplicates the lead out of this list.
    allGuestNames: Array.isArray(guest.all_guest_names) ? guest.all_guest_names : [],
    inclusions: sorted.inclusions,
    // Each part prints only when the voucher states it (H-05).
    stayFacts: {
      // Counts arrive as printed ("1 night", "2 adults"); leadingCount is the one reader.
      nights: leadingCount(stay.total_nights),
      adults: leadingCount(guest.adults),
      children: leadingCount(guest.children),
      guests: leadingCount(guest.total_pax),
      rooms: leadingCount(room.no_of_rooms),
    },
    specialRequests: nz(room.special_requests) || null,
    cancelPolicies: cancel.policies, // Guard (c)
    cancellationDeadline: cancel.deadline ? { stated: cancel.deadline.stated, dateOnly: cancel.deadline.dateOnly } : null,
    displayVoucherStatus: "CONFIRMED",
    qrUrl: "", // template builds its own maps QR; this field is ignored
    reconciled: true, // Guard (a): generateHotelVoucherHTML throws otherwise
    showPrintButton: false, // suppress the print FAB in the PDF
    hotelPolicies: ci || co ? { checkInTime: ci || null, checkOutTime: co || null, minimumAge: null } : null,
    // Demo Platform — render the SAMPLE watermark + footer disclaimer when the
    // source VoucherExtraction was captured under impersonation. See Sprint 2 audit P5.
    isDemo: !!v?.isDemo,
    // Extracted from a third party's voucher: the template words cancellation,
    // fixed policy text and ID labels so nothing is claimed the source didn't say.
    source: "extracted",
  };
}
