// apps/backend/src/services/approvalSearch/selection.ts
//
// The price-free selection a requester attaches to an approval request item
// from live TBO search. It is the ONLY search data stored on the request
// (cartItems[].meta.selection); the raw option with prices goes to the
// staff-only ApprovalSelectionSnapshot.
//
// Built by ALLOW-LIST: every field below is picked explicitly from the raw
// TBO object; anything not named here never reaches the request.
//
// Field names are chosen to pass the approvals price sanitiser
// (approvals.security.ts isPriceKey): no segment "total", "fare", "rate",
// "charge(s)", "cost", "net", "tax", "fee", "amount", "price". So "journeyMin"
// not "totalDuration", "stopCount" not "totalStops". selection.test.ts fails
// if a key here would be stripped, or if any value carries a currency figure.
//
// Not included until Imran decides D2: fare-type label (Saver/Flexi) and seats
// left.

import { stripPriceText } from "../../routes/approvals.security.js";

export type FlightPoint = { code: string; city: string; terminal: string };

export type FlightSegmentSelection = {
  airlineCode: string;
  airlineName: string;
  flightNumber: string;
  from: FlightPoint;
  to: FlightPoint;
  departAt: string; // TBO local time at the airport, as sent ("2026-10-12T06:10:00")
  arriveAt: string;
  durationMin: number;
  layoverMin: number; // ground time before this segment; 0 on the first
  cabin: string;
  baggage: { checkIn: string; cabin: string };
};

export type FlightLegSelection = {
  direction: "out" | "back";
  segments: FlightSegmentSelection[];
  stopCount: number;
  journeyMin: number;
  refundable: boolean | null;
  isLCC: boolean;
};

export type FlightTripKind = "OW" | "RT_DOM" | "RT_INTL";

export type FlightSelection = {
  kind: "flight";
  optionRef: string;
  returnOptionRef?: string;
  tripKind: FlightTripKind;
  legs: FlightLegSelection[];
  searchedAt: string;
};

export type HotelSelection = {
  kind: "hotel";
  optionRef: string;
  hotelCode: string;
  name: string;
  stars: number | null;
  address: string;
  city: string;
  checkIn: string;
  checkOut: string;
  roomName: string;
  mealPlan: string;
  refundable: boolean | null;
  /** Free cancellation before this date (YYYY-MM-DD). Never an amount. */
  cancelBy: string | null;
  inclusions: string[];
  searchedAt: string;
};

export type ApprovalSelection = FlightSelection | HotelSelection;

/* ── helpers ─────────────────────────────────────────────────────────────── */

const text = (v: unknown): string => stripPriceText(String(v ?? "").trim());
const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

// TBO Air CabinClass codes.
const CABIN: Record<number, string> = {
  1: "All",
  2: "Economy",
  3: "Premium Economy",
  4: "Business",
  5: "Premium Business",
  6: "First",
};
export function cabinLabel(v: unknown): string {
  return CABIN[Number(v)] ?? "";
}

function point(p: any): FlightPoint {
  const a = p?.Airport ?? {};
  return { code: text(a.AirportCode), city: text(a.CityName), terminal: text(a.Terminal) };
}

function segment(s: any, i: number): FlightSegmentSelection {
  return {
    airlineCode: text(s?.Airline?.AirlineCode),
    airlineName: text(s?.Airline?.AirlineName),
    flightNumber: text(s?.Airline?.FlightNumber),
    from: point(s?.Origin),
    to: point(s?.Destination),
    departAt: text(s?.Origin?.DepTime),
    arriveAt: text(s?.Destination?.ArrTime),
    durationMin: num(s?.Duration),
    layoverMin: i === 0 ? 0 : num(s?.GroundTime),
    cabin: cabinLabel(s?.CabinClass),
    baggage: { checkIn: text(s?.Baggage), cabin: text(s?.CabinBaggage) },
  };
}

function leg(rawSegments: any[], raw: any, direction: "out" | "back"): FlightLegSelection {
  const segments = (Array.isArray(rawSegments) ? rawSegments : []).map(segment);
  return {
    direction,
    segments,
    stopCount: Math.max(0, segments.length - 1),
    journeyMin: segments.reduce((m, s) => m + s.durationMin + s.layoverMin, 0),
    refundable: bool(raw?.IsRefundable),
    isLCC: raw?.IsLCC === true,
  };
}

/* ── projections ─────────────────────────────────────────────────────────── */

/**
 * One TBO flight Result → selection. Domestic round trip: TBO returns the
 * outbound and inbound lists separately, so the inbound pick comes in as
 * `back` (its own option). International round trip: one Result whose
 * Segments[1] is the return leg. The return leg is never dropped.
 */
export function toFlightSelection(args: {
  out: any;
  back?: any;
  optionRef: string;
  returnOptionRef?: string;
  searchedAt: Date;
}): FlightSelection {
  const outSegs = Array.isArray(args.out?.Segments) ? args.out.Segments : [];
  const legs: FlightLegSelection[] = [leg(outSegs[0], args.out, "out")];
  let tripKind: FlightTripKind = "OW";

  if (args.back) {
    const backSegs = Array.isArray(args.back?.Segments) ? args.back.Segments : [];
    legs.push(leg(backSegs[0], args.back, "back"));
    tripKind = "RT_DOM";
  } else if (outSegs.length > 1) {
    legs.push(leg(outSegs[1], args.out, "back"));
    tripKind = "RT_INTL";
  }

  return {
    kind: "flight",
    optionRef: args.optionRef,
    ...(args.returnOptionRef ? { returnOptionRef: args.returnOptionRef } : {}),
    tripKind,
    legs,
    searchedAt: args.searchedAt.toISOString(),
  };
}

const STAR_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
export function parseStars(v: unknown): number | null {
  if (typeof v === "number" && v > 0) return Math.min(5, Math.round(v));
  const s = String(v ?? "").trim().toLowerCase();
  const digit = s.match(/[1-5]/);
  if (digit) return Number(digit[0]);
  const word = s.match(/^(one|two|three|four|five)/);
  return word ? STAR_WORDS[word[1]] : null;
}

export function formatMealPlan(v: unknown): string {
  const s = text(v).replace(/_/g, " ").toLowerCase();
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** TBO "DD-MM-YYYY HH:mm:ss" (or ISO) → "YYYY-MM-DD", no timezone shift. */
function tboDay(v: unknown): string | null {
  const s = String(v ?? "").trim();
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1] : null;
}

/** Date from which cancelling costs anything; null when unknown or non-refundable. */
export function cancelByDate(room: any): string | null {
  if (room?.IsRefundable === false) return null;
  const policies: any[] = Array.isArray(room?.CancelPolicies) ? room.CancelPolicies : [];
  const charged = policies
    .filter((p) => Number(p?.CancellationCharge) > 0)
    .map((p) => tboDay(p?.FromDate))
    .filter((d): d is string => !!d)
    .sort();
  return charged[0] ?? null;
}

function roomName(room: any): string {
  const n = room?.Name;
  return text(Array.isArray(n) ? n.filter(Boolean).join(", ") : n);
}

function inclusions(room: any): string[] {
  const inc = room?.Inclusion;
  const list = Array.isArray(inc) ? inc : String(inc ?? "").split(",");
  return list.map(text).filter(Boolean);
}

/** One TBO HotelResult + the chosen room → selection. */
export function toHotelSelection(args: {
  hotel: any;
  room: any;
  optionRef: string;
  checkIn: string;
  checkOut: string;
  searchedAt: Date;
}): HotelSelection {
  const { hotel, room } = args;
  return {
    kind: "hotel",
    optionRef: args.optionRef,
    hotelCode: text(hotel?.HotelCode),
    name: text(hotel?.HotelName),
    stars: parseStars(hotel?.HotelRating ?? hotel?.StarRating),
    address: text(hotel?.Address),
    city: text(hotel?.CityName),
    checkIn: text(args.checkIn),
    checkOut: text(args.checkOut),
    roomName: roomName(room),
    mealPlan: formatMealPlan(room?.MealType),
    refundable: bool(room?.IsRefundable),
    cancelBy: cancelByDate(room),
    inclusions: inclusions(room),
    searchedAt: args.searchedAt.toISOString(),
  };
}
