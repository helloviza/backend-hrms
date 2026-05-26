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
//   - Connecting / 3+ legs collapse to outbound + optional return only.
//   - Baggage/seat/meal are NOT touched — the template keeps its current
//     literals (15kg / 7kg / "—"). Real baggage is L3b.
//   - Cabin: reverse-map class string → CABIN_MAP number; fallback Economy (2).
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

/* ───────────────────────── small helpers ───────────────────────── */

/** Coerce any null/undefined to "" (never pass null into the templates). */
function nz(x: unknown): string {
  return x === null || x === undefined ? "" : String(x);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
  apr: 3, april: 3, may: 4, jun: 5, june: 5, jul: 6, july: 6,
  aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9,
  nov: 10, november: 10, dec: 11, december: 11,
};

/**
 * Parse a free-form extracted date string into a Date (time set to local
 * midnight). Handles the common voucher shapes; returns null if unparseable.
 *   "14 Jun 2026" · "14 June 2026" · "14-06-2026" · "14/06/2026" ·
 *   "2026-06-14" · "Jun 14, 2026" · "14.06.2026"
 * Numeric DMY is assumed day-first (India / European vouchers).
 */
function parseLooseDate(input?: string | null): Date | null {
  const s = (input || "").trim();
  if (!s) return null;

  // ISO yyyy-mm-dd (optionally with time we ignore here)
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  // DD <Mon> YYYY  (e.g. "14 Jun 2026", "14-June-2026")
  m = s.match(/^(\d{1,2})[ \-./]+([A-Za-z]+)[ \-./,]+(\d{4})$/);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
    const d = new Date(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]));
    return isNaN(d.getTime()) ? null : d;
  }

  // <Mon> DD, YYYY  (e.g. "Jun 14, 2026")
  m = s.match(/^([A-Za-z]+)[ \-./]+(\d{1,2})[ \-./,]+(\d{4})$/);
  if (m && MONTHS[m[1].toLowerCase()] !== undefined) {
    const d = new Date(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]));
    return isNaN(d.getTime()) ? null : d;
  }

  // DD MM YYYY numeric, day-first (e.g. "14/06/2026", "14-06-2026", "14.06.2026")
  m = s.match(/^(\d{1,2})[\-/.](\d{1,2})[\-/.](\d{4})$/);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return isNaN(d.getTime()) ? null : d;
  }

  // Last resort — let the engine try (covers RFC/ISO-with-time strings).
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

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

/** Local ISO `YYYY-MM-DDTHH:mm:ss` that `new Date(...)` parses reliably. */
function toLocalIso(d: Date): string {
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/** Date-only local ISO `YYYY-MM-DD`. */
function toLocalIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Combine a leg's separate date + time strings into an ISO datetime the
 * template's `new Date(...)` parses cleanly (so fmtTime/fmtDate format and the
 * duration computes). Returns "" — NOT the raw string and NOT NaN — when the
 * date can't be parsed, so the template renders blank rather than junk.
 */
function buildLegDateTime(leg: FlightLeg | undefined, label: string): string {
  const date = parseLooseDate(leg?.date);
  if (!date) {
    if (nz(leg?.date) || nz(leg?.time)) {
      logger.warn("[voucher-adapter] unparseable leg datetime; rendering blank", {
        label,
        date: nz(leg?.date),
        time: nz(leg?.time),
      });
    }
    return "";
  }
  const time = parseLooseTime(leg?.time);
  date.setHours(time?.h ?? 0, time?.m ?? 0, 0, 0);
  return toLocalIso(date);
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

function buildPassengers(
  pax: Passenger[] | undefined,
): TicketBooking["passengers"] {
  return (pax || []).map((p, i) => {
    const { title, firstName, lastName } = splitName(p?.name);
    return { title, firstName, lastName, paxType: mapPaxType(p?.type), isLead: i === 0 };
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
  shared: { passengers: TicketBooking["passengers"]; ticketId: string; createdAt: string },
): TicketBooking {
  const origin = seg?.origin;
  const dest = seg?.destination;
  return {
    pnr: nz(v?.booking_info?.pnr),
    bookingId: nz(v?.booking_info?.booking_id),
    ticketId: shared.ticketId,
    status: "CONFIRMED", // extract has no status; template also defaults this
    // Guard (b): code coerced null→"" so cityName()/airportFullName() never throw.
    origin: { code: nz(origin?.code), city: nz(origin?.city) },
    destination: { code: nz(dest?.code), city: nz(dest?.city) },
    departureTime: buildLegDateTime(origin, "departure"),
    arrivalTime: buildLegDateTime(dest, "arrival"),
    airlineCode: "", // not rendered by the template
    airlineName: nz(seg?.airline),
    flightNumber: nz(seg?.flight_no),
    cabin: classToCabin(seg?.class),
    passengers: shared.passengers,
    // Fares are not rendered on the e-ticket — supply zeros / INR.
    baseFare: 0,
    taxes: 0,
    extras: 0,
    totalFare: 0,
    currency: "INR",
    // isLCC drives the "Non-Refundable" badge + policy wording in the template.
    isLCC: !!v?.policies?.is_non_refundable,
    createdAt: shared.createdAt, // Guard (e): required string
  };
}

/**
 * Map an extracted flight voucher to the shared template's booking + optional
 * return booking. Connecting / 3+ legs collapse to outbound + last (return).
 */
export function adaptFlight(v: PlumtripsVoucher): {
  booking: TicketBooking;
  returnBooking?: TicketBooking;
} {
  const segs: FlightSegment[] = Array.isArray(v?.flight_details?.segments)
    ? v.flight_details!.segments
    : [];

  const shared = {
    passengers: buildPassengers(v?.passengers),
    ticketId: nz(v?.passengers?.[0]?.ticket_no), // lead pax ticket as the single ticketId
    createdAt: new Date().toISOString(),
  };

  if (segs.length <= 1) {
    return { booking: buildBookingFromSegment(v, segs[0], shared) };
  }

  if (segs.length === 2) {
    const booking = buildBookingFromSegment(v, segs[0], shared);
    const returnBooking = buildBookingFromSegment(v, segs[1], shared);
    if (!returnsTowardOrigin(segs[0], segs[1])) {
      // 2-leg connecting (not a round trip) — both legs still shown, but the
      // second page is labeled "Return". Log so we can see how often this happens.
      logger.warn("[voucher-adapter] 2-segment itinerary is not a round trip; second leg shown as 'Return'", {
        pnr: nz(v?.booking_info?.pnr),
        seg0: `${nz(segs[0]?.origin?.code)}→${nz(segs[0]?.destination?.code)}`,
        seg1: `${nz(segs[1]?.origin?.code)}→${nz(segs[1]?.destination?.code)}`,
      });
    }
    return { booking, returnBooking };
  }

  // 3+ legs — outbound = first, return = last, MIDDLE LEGS DROPPED (degradation).
  const last = segs[segs.length - 1];
  logger.warn("[voucher-adapter] 3+ segment itinerary collapsed to first+last; middle legs dropped", {
    pnr: nz(v?.booking_info?.pnr),
    totalSegments: segs.length,
    dropped: segs.length - 2,
    first: `${nz(segs[0]?.origin?.code)}→${nz(segs[0]?.destination?.code)}`,
    last: `${nz(last?.origin?.code)}→${nz(last?.destination?.code)}`,
  });
  return {
    booking: buildBookingFromSegment(v, segs[0], shared),
    returnBooking: buildBookingFromSegment(v, last, shared),
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
 * Issue-2 mitigation (snapshot-safe, adapter-only — no template change): a lone
 * trivial optional bullet renders a section HEADER + a single line that strands
 * onto a near-empty page in the paginated PDF. Suppress such sparse optional
 * sections — keep genuinely informative content (≥2 items, or a single
 * substantial line ≥60 chars). Returns undefined when the section should be
 * omitted entirely (template hides the section when the array is undefined/empty).
 */
function meaningfulOptionalList(items?: string[] | null): string[] | undefined {
  const cleaned = (items || []).map((s) => (s || "").trim()).filter(Boolean);
  if (cleaned.length === 0) return undefined;
  if (cleaned.length === 1 && cleaned[0].length < 60) return undefined;
  return cleaned;
}

/** First name for the greeting (mirrors the template's own extractFirstName). */
function firstNameOf(fullName?: string | null): string {
  const cleaned = (fullName || "")
    .replace(/^(Mr\.?|Mrs\.?|Ms\.?|Miss\.?|Dr\.?|Prof\.?)\s+/i, "")
    .trim();
  return cleaned.split(/\s+/)[0] || "Valued Guest";
}

/** Date-only normalization for hotel check-in/out → "" (blank) if unparseable. */
function hotelDate(input: string | null | undefined, label: string): string {
  const d = parseLooseDate(input);
  if (!d) {
    if (nz(input)) {
      logger.warn("[voucher-adapter] unparseable hotel date; rendering blank", {
        label,
        value: nz(input),
      });
    }
    return "";
  }
  return toLocalIsoDate(d);
}

/** TBO-format a Date as "DD-MM-YYYY HH:mm:ss" (what parseTBODate expects). */
function tboFormat(d: Date): string {
  return (
    `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/**
 * Guard (c): synthesize cancelPolicies[] from the only structured signals the
 * extract carries (is_non_refundable + cancellation_deadline). All FromDates
 * are emitted in valid TBO format. For a NON-REFUNDABLE booking we then verify
 * with buildCancellationChips that the result never renders as free-cancellable;
 * if it would (empty chips, or any free chip), we hide the section ([]) rather
 * than emit the misleading "Free cancellation available" fallback.
 */
function synthesizeCancelPolicies(
  v: PlumtripsVoucher,
  checkOut: string,
): CancelPolicy[] {
  const isNonRefundable = !!v?.policies?.is_non_refundable;
  const deadline = parseLooseDate(v?.policies?.cancellation_deadline);
  const bookingDate = parseLooseDate(v?.booking_info?.booking_date);

  // A safe "from booking" anchor that always sorts before any later tier and is
  // far enough in the past to survive the checkout ≥ FromDate filter. The
  // template never displays this anchor date (the labels are fixed text or the
  // deadline), so a sentinel is fine.
  const anchor = bookingDate && (!deadline || bookingDate < deadline)
    ? bookingDate
    : new Date(2000, 0, 1);

  let policies: CancelPolicy[];

  if (isNonRefundable) {
    // Single 100% tier → "Non-refundable · 100% charge from booking date".
    policies = [
      { FromDate: tboFormat(anchor), ChargeType: "Percentage", CancellationCharge: 100 },
    ];
  } else if (deadline) {
    // Free until the deadline, then 100% — give the deadline an end-of-day time
    // when none was carried so the "until …" label reads naturally.
    if (deadline.getHours() === 0 && deadline.getMinutes() === 0 && deadline.getSeconds() === 0) {
      deadline.setHours(23, 59, 59, 0);
    }
    policies = [
      { FromDate: tboFormat(anchor), ChargeType: "Percentage", CancellationCharge: 0 },
      { FromDate: tboFormat(deadline), ChargeType: "Percentage", CancellationCharge: 100 },
    ];
  } else {
    // Refundable, no deadline → free any time.
    policies = [
      { FromDate: tboFormat(anchor), ChargeType: "Percentage", CancellationCharge: 0 },
    ];
  }

  if (isNonRefundable) {
    const chips = buildCancellationChips(policies, { checkOut });
    const safe = chips.length > 0 && chips.every((c) => !c.isFree);
    if (!safe) {
      logger.warn("[voucher-adapter] non-refundable cancel synthesis unsafe; hiding section", {
        bookingId: nz(v?.booking_info?.booking_id),
        chipCount: chips.length,
      });
      return []; // hide rather than render a misleading "free cancellation"
    }
  }

  return policies;
}

/** Map an extracted hotel voucher to the shared template's params. */
export function adaptHotel(v: PlumtripsVoucher): HotelVoucherParams {
  const h = v?.hotel_details || ({} as NonNullable<PlumtripsVoucher["hotel_details"]>);
  const stay = v?.stay_details || ({} as NonNullable<PlumtripsVoucher["stay_details"]>);
  const guest = v?.guest_details || ({} as NonNullable<PlumtripsVoucher["guest_details"]>);
  const room = v?.room_details || ({} as NonNullable<PlumtripsVoucher["room_details"]>);

  const checkIn = hotelDate(stay.check_in_date, "check_in");
  const checkOut = hotelDate(stay.check_out_date, "check_out");

  const cleanNotes = stripRepairNotes(v?.policies?.important_notes);
  const supplierConf = nz(v?.booking_info?.supplier_conf_no);

  const ci = nz(stay.check_in_time);
  const co = nz(stay.check_out_time);

  return {
    hotelName: nz(h.name),
    hotelAddress: nz(h.address),
    checkIn,
    checkOut,
    roomName: nz(room.room_type),
    bookingId: nz(v?.booking_info?.booking_id),
    confirmationNo: supplierConf, // required by type; not rendered in body
    bookingRefNo: nz(v?.booking_info?.voucher_no), // required by type; not rendered
    // Visible "HOTEL REFERENCE — SHOW AT CHECK-IN" box; omit when absent.
    tboReferenceNo: supplierConf || null,
    // important_notes surfaced as Rate Conditions (repair notes already stripped).
    // A lone trivial note is suppressed so it doesn't strand a near-empty page.
    rateConditions: meaningfulOptionalList(cleanNotes),
    guestFirstName: firstNameOf(guest.primary_guest),
    leadGuestName: nz(guest.primary_guest),
    inclusions: Array.isArray(room.inclusions) ? room.inclusions : [],
    cancelPolicies: synthesizeCancelPolicies(v, checkOut), // Guard (c)
    displayVoucherStatus: "CONFIRMED",
    qrUrl: "", // template builds its own maps QR; this field is ignored
    reconciled: true, // Guard (a): generateHotelVoucherHTML throws otherwise
    showPrintButton: false, // suppress the print FAB in the PDF
    hotelPolicies: ci || co ? { checkInTime: ci || null, checkOutTime: co || null, minimumAge: null } : null,
  };
}
