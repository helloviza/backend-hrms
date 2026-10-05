// Customer-facing SBT prices, and the supplier net kept on the server.
//
// Customers (SBT, concierge) only ever receive SELLING prices. Our supplier net,
// commission, TDS, incentive/PLB, RSP floor and margin stay on the server:
//
//   flights   sellingFlight / sellingFlightResults   search, farequote, price-rbd, reissue
//             stripFlightBookingFares                 Book / Ticket / booking-detail responses
//             loadFlightNet + applyQuoteFares         Book / Ticket fill each passenger's
//                                                     TBO Fare from the FareQuote the
//                                                     server stored — never the browser's
//             keepSupplierResponse                    the full Book / Ticket response, kept on
//                                                     the payment row for /bookings/save
//   hotels    customerRoom / customerHotelResults     search, rooms, prebook (room allow-list)
//             stripHotelCost                          any other hotel payload (book, voucher…)
//   bookings  customerFlightBooking / customerHotelBooking   booking documents sent to customers
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import SBTPayment from "../models/SBTPayment.js";
import { applyMargin, applyMarginWithFloor, getMarginConfig, isDomestic } from "../utils/margin.js";
import { callerScope, loadScopedQuote, FARE_EXPIRED, type Refusal } from "./sbtPaymentGate.js";
import { sbtLogger } from "../utils/logger.js";

type AnyObj = Record<string, any>;

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => Number(v) || 0;
// Plain objects only: Dates, ObjectIds and Buffers pass through untouched.
const isObj = (v: unknown): v is AnyObj => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/* ───────────────────────── margins ───────────────────────── */

let airportCountry: Map<string, string> | null = null;

/** ISO country of an airport (data/airports.json), "" when unknown. */
export function countryOfAirport(iata: unknown): string {
  if (!airportCountry) {
    airportCountry = new Map();
    try {
      const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "../data/airports.json");
      for (const a of JSON.parse(readFileSync(file, "utf-8")) as AnyObj[]) {
        if (a?.code) airportCountry.set(String(a.code).toUpperCase(), String(a.countryCode || ""));
      }
    } catch (err: any) {
      sbtLogger.warn("[sbt-quote] airports.json not readable", { err: err?.message });
    }
  }
  return airportCountry.get(String(iata ?? "").toUpperCase()) || "";
}

/** The flight margin percent for a route (0 when margins are off). */
export async function flightMarginPct(originCountry?: string, destCountry?: string): Promise<number> {
  const m = await getMarginConfig();
  if (!m.enabled) return 0;
  return isDomestic(originCountry, destCountry) ? m.flight.domestic : m.flight.international;
}

/** The hotel margin percent for a destination country (0 when margins are off). */
export async function hotelMarginPct(countryCode?: string): Promise<number> {
  const m = await getMarginConfig();
  if (!m.enabled) return 0;
  return (countryCode || "IN") === "IN" ? m.hotel.domestic : m.hotel.international;
}

/* ───────────────────────── flights ───────────────────────── */

/** Fare fields that are our cost or margin, never the customer's price. */
export const FLIGHT_FARE_COST_KEYS = [
  "_netPublishedFare", "_netOfferedFare", "_marginPercent", "_marginAmount",
  "CommissionEarned", "PLBEarned", "IncentiveEarned",
  "TdsOnCommission", "TdsOnPLB", "TdsOnIncentive",
  "AdditionalTxnFeeOfrd", "AdditionalTxnFeePub",
] as const;

function dropKeys(o: AnyObj, keys: readonly string[]): AnyObj {
  const out = { ...o };
  for (const k of keys) delete out[k];
  return out;
}

/** Spread `amount` over the rows' BaseFare in proportion to it (equal shares
 *  when every BaseFare is 0); the last row takes the rounding remainder so the
 *  rows add up to exactly `amount`. */
function foldIntoBreakdown(rows: unknown[], amount: number): unknown[] {
  const clean = rows.map((r) => (isObj(r) ? dropKeys(r, FLIGHT_FARE_COST_KEYS) : r));
  if (!(amount > 0) || clean.length === 0) return clean;
  const total: number = clean.reduce((s: number, r) => s + (isObj(r) ? num(r.BaseFare) : 0), 0) as number;
  let given = 0;
  return clean.map((r, i) => {
    if (!isObj(r)) return r;
    const share = i === clean.length - 1
      ? round2(amount - given)
      : round2(amount * (total > 0 ? num(r.BaseFare) / total : 1 / clean.length));
    given = round2(given + share);
    return { ...r, BaseFare: round2(num(r.BaseFare) + share) };
  });
}

/**
 * One flight result as the customer sees it: the selling price only.
 * PublishedFare and OfferedFare both carry the selling total (OfferedFare is
 * TBO's net-of-commission figure — never shown), the cost keys are gone, and
 * the margin is folded into BaseFare (top-level and FareBreakdown) so
 * BaseFare + Tax adds up to the total. `flight.Fare` must be TBO's raw fare.
 * Only a positive margin is applied — the same rule search and FareQuote use.
 */
export function sellingFlight<T extends AnyObj>(flight: T, marginPct: number): T {
  const fare = flight?.Fare;
  if (!isObj(fare)) return flight;
  const netPublished = num(fare.PublishedFare);
  const selling = marginPct > 0 ? applyMargin(netPublished, marginPct) : netPublished;
  const margin = round2(selling - netPublished);
  const sellingFare: AnyObj = dropKeys(fare, FLIGHT_FARE_COST_KEYS);
  sellingFare.PublishedFare = selling;
  sellingFare.OfferedFare = selling;
  if (margin > 0) sellingFare.BaseFare = round2(num(fare.BaseFare) + margin);
  return {
    ...flight,
    Fare: sellingFare,
    ...(Array.isArray(flight.FareBreakdown) ? { FareBreakdown: foldIntoBreakdown(flight.FareBreakdown, margin) } : {}),
  };
}

/** sellingFlight on every flight result anywhere in a response (flat Results,
 *  round-trip [[ob],[ib]], a single Results object, multi-city legs, PriceRBD).
 *  A flight result = an object with Fare and ResultIndex or Segments. Any other
 *  cost key found on the way is dropped too. Returns a copy. */
export function sellingFlightResults(node: unknown, marginPct: number): any {
  if (Array.isArray(node)) return node.map((n) => sellingFlightResults(n, marginPct));
  if (!isObj(node)) return node;
  if ("Fare" in node && ("ResultIndex" in node || "Segments" in node)) {
    const sold = sellingFlight(node, marginPct);
    const out: AnyObj = {};
    for (const [k, v] of Object.entries(sold)) {
      out[k] = k === "Fare" || k === "FareBreakdown" ? v : sellingFlightResults(v, marginPct);
    }
    return out;
  }
  const out: AnyObj = {};
  for (const [k, v] of Object.entries(node)) {
    if ((FLIGHT_FARE_COST_KEYS as readonly string[]).includes(k)) continue;
    out[k] = sellingFlightResults(v, marginPct);
  }
  return out;
}

/** Book / Ticket / GetBookingDetails responses: the itinerary and passenger
 *  Fare / FareBreakdown nodes are TBO net and the customer does not need them
 *  (confirmation pages show the charged total) — drop them, and any cost key,
 *  at every depth. Returns a copy. */
export function stripFlightBookingFares<T>(node: T): T {
  if (Array.isArray(node)) return node.map((n) => stripFlightBookingFares(n)) as unknown as T;
  if (!isObj(node)) return node;
  const out: AnyObj = {};
  for (const [k, v] of Object.entries(node)) {
    if ((k === "Fare" || k === "FareBreakdown") && v && typeof v === "object") continue;
    if ((FLIGHT_FARE_COST_KEYS as readonly string[]).includes(k)) continue;
    out[k] = stripFlightBookingFares(v);
  }
  return out as T;
}

/**
 * The per-pax TBO Fare for each PaxType, built from the quote's raw FareQuote:
 * that type's FareBreakdown row (totals, not divided) + the top-level net
 * Published/Offered/commission/TDS. The same object SBTReview's
 * buildPerPaxFareMap sent from the browser before the net left the response.
 */
export function quotePassengerFares(quote: AnyObj): Map<number, Record<string, number | string>> {
  const map = new Map<number, Record<string, number | string>>();
  const top: AnyObj = quote?.netFare || {};
  for (const fb of (quote?.netFareBreakdown as AnyObj[] | undefined) || []) {
    const pt = Number(fb?.PassengerType ?? fb?.PaxType ?? 1);
    map.set(pt, {
      Currency: fb.Currency || top.Currency || "INR",
      BaseFare: num(fb.BaseFare),
      Tax: num(fb.Tax),
      YQTax: num(fb.YQTax),
      AdditionalTxnFeeOfrd: num(fb.AdditionalTxnFeeOfrd),
      AdditionalTxnFeePub: num(fb.AdditionalTxnFeePub),
      PGCharge: num(fb.PGCharge),
      OtherCharges: 0,
      Discount: 0,
      PublishedFare: num(top.PublishedFare),
      OfferedFare: num(top.OfferedFare),
      TdsOnCommission: num(top.TdsOnCommission),
      TdsOnPLB: num(top.TdsOnPLB),
      TdsOnIncentive: num(top.TdsOnIncentive),
      ServiceFee: 0,
      TransactionFee: num(fb.TransactionFee),
      AirTransFee: 0,
      CommissionEarned: num(top.CommissionEarned),
      PLBEarned: num(top.PLBEarned),
      IncentiveEarned: num(top.IncentiveEarned),
    });
  }
  return map;
}

/** Every passenger's Fare replaced with the quote's net fare for its PaxType
 *  (falling back to the adult fare, then the top-level net fare — the order the
 *  browser used). Whatever Fare the client sent is discarded. */
export function applyQuoteFares<P extends AnyObj>(passengers: P[] | undefined, quote: AnyObj): P[] {
  const fares = quotePassengerFares(quote);
  const topNet: AnyObj = quote?.netFare || {};
  return (Array.isArray(passengers) ? passengers : []).map((p) => {
    const pt = Number(p?.PaxType) || 1;
    const fare = fares.get(pt) || fares.get(1) || { ...topNet };
    return { ...p, Fare: fare };
  });
}

/** The quotes a Book / Ticket call may draw its net from: the payment row's
 *  (server-set by the gate or the checkout), else the request's. */
function quoteIdsFor(req: AnyObj): string[] {
  const fromRow = req?.sbtPayment?.quoteIds;
  const ids = Array.isArray(fromRow) && fromRow.length ? fromRow : req?.body?.quoteIds;
  return Array.isArray(ids) ? ids.filter((q: unknown) => typeof q === "string" && q) : [];
}

export interface FlightNet { ok: true; ob: AnyObj; ib: AnyObj | null }

/**
 * The stored FareQuotes covering the legs about to be booked: `ob` for
 * `resultIndex`, `ib` for `returnResultIndex` (special return: one quote covers
 * both). Each must be the caller's own (workspace + user), fresh, and carry the
 * raw net fare — otherwise 410 FARE_EXPIRED. Never a fallback to client values.
 */
export async function loadFlightNet(
  req: AnyObj,
  legs: { resultIndex: unknown; returnResultIndex?: unknown; isSpecialReturn?: boolean },
): Promise<FlightNet | Refusal> {
  const scope = callerScope(req);
  const quotes: AnyObj[] = [];
  for (const id of quoteIdsFor(req)) {
    const q = await loadScopedQuote(scope, id, "FLIGHT");
    if (q && isObj(q.netFare)) quotes.push(q);
  }
  const covering = (ri: unknown) => {
    const key = String(ri ?? "");
    return key ? quotes.find((q) => ((q.resultIndexes || []) as string[]).map(String).includes(key)) || null : null;
  };
  const ob = covering(legs.resultIndex);
  if (!ob) {
    sbtLogger.warn("[sbt-quote] no stored net fare for the outbound leg", { resultIndex: legs.resultIndex, quotes: quotes.length });
    return FARE_EXPIRED;
  }
  if (legs.returnResultIndex == null || legs.returnResultIndex === "") return { ok: true, ob, ib: null };
  const ib = covering(legs.returnResultIndex) || (legs.isSpecialReturn ? ob : null);
  if (!ib) {
    sbtLogger.warn("[sbt-quote] no stored net fare for the return leg", { resultIndex: legs.returnResultIndex });
    return FARE_EXPIRED;
  }
  return { ok: true, ob, ib };
}

/** Keep the supplier's full Book / Ticket response on the payment row, keyed by
 *  TBO BookingId (best effort — the booking already exists at the supplier). */
export async function keepSupplierResponse(req: AnyObj, bookingId: unknown, response: unknown): Promise<void> {
  const rowId = req?.sbtPayment?._id;
  const id = bookingId != null ? String(bookingId) : "";
  if (!rowId || !id || id === "0") return;
  try {
    await SBTPayment.updateOne({ _id: rowId }, { $push: { supplierResponses: { bookingId: id, response, at: new Date() } } });
  } catch (err: any) {
    sbtLogger.warn("[sbt-quote] supplier response not kept", { bookingId: id, err: err?.message });
  }
}

/** The kept supplier response for a TBO BookingId (latest wins). */
export function supplierResponseFor(rows: unknown, bookingId: unknown): AnyObj | null {
  const id = String(bookingId ?? "");
  if (!id || !Array.isArray(rows)) return null;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i] as AnyObj;
    if (String(r?.bookingId ?? "") === id && r?.response) return r.response as AnyObj;
  }
  return null;
}

/* ───────────────────────── hotels ───────────────────────── */

/** Room / booking fields that are our cost, commission or the supplier's floor.
 *  TotalTax stays (the tax line the customer sees). Lower-case `totalFare` on
 *  our own booking documents is the selling total and stays. */
export const HOTEL_COST_KEYS = [
  "NetAmount", "NetTax", "TotalFare", "DayRates", "PriceBreakUp", "AgentCommission",
  "RecommendedSellingRate", "recommendedSellingRate", "MinimumRate",
  "netAmount", "agentCommission", "tds", "isPublishedFare",
  "marginAmount", "marginPercent", "_markupAmount", "_netAmount", "_rsp", "_rspClamped", "_marginPercent",
] as const;

/** Drop hotel cost keys at every depth. Returns a copy. */
export function stripHotelCost<T>(node: T): T {
  if (Array.isArray(node)) return node.map((n) => stripHotelCost(n)) as unknown as T;
  if (!isObj(node)) return node;
  const out: AnyObj = {};
  for (const [k, v] of Object.entries(node)) {
    if ((HOTEL_COST_KEYS as readonly string[]).includes(k)) continue;
    out[k] = stripHotelCost(v);
  }
  return out as T;
}

const isPercentType = (ct: unknown) => ct === "Percentage" || ct === "Percent" || ct === 2 || ct === "2";

/**
 * Cancellation tiers without amounts: dates and charge type stay; a fixed
 * charge (TBO's, on our net) becomes the percentage of the room it represents,
 * so "INR 4,000" never reaches the customer but a full / partial / free tier
 * still reads the same.
 */
export function policiesWithoutAmounts(policies: unknown, netTotal: number): AnyObj[] {
  if (!Array.isArray(policies)) return [];
  return policies.filter(isObj).map((p) => {
    const out: AnyObj = {};
    for (const k of ["FromDate", "ToDate", "Index", "Currency"]) if (p[k] !== undefined) out[k] = p[k];
    const charge = num(p.CancellationCharge);
    if (isPercentType(p.ChargeType)) {
      out.ChargeType = "Percentage";
      out.CancellationCharge = Math.min(100, charge);
    } else {
      out.ChargeType = "Percentage";
      out.CancellationCharge = charge <= 0 ? 0 : netTotal > 0 ? Math.min(100, Math.round((charge / netTotal) * 100)) : 100;
    }
    return out;
  });
}

/** Room fields the customer sees, verbatim. */
const ROOM_FIELDS = [
  "Name", "RoomTypeName", "BookingCode", "Inclusion", "MealType", "RoomPromotion", "Amenities",
  "RateConditions", "Supplements", "supplements", "IsRefundable", "isRefundable", "LastCancellationDeadline",
  "WithTransfers", "IsPackageFare", "RoomImage", "Occupancy", "Adults", "Children", "ChildrenAges",
  "TotalTax", "Currency",
] as const;

/**
 * A room as the customer sees it — built from an allow-list, never a spread of
 * TBO's room: name / type, meal plan, inclusions, cancellation tiers (dates, no
 * amounts), occupancy, BookingCode, TotalTax, the selling total
 * (`_displayTotalFare`) and a per-night selling rate derived from it
 * (`_displayPerNight`, per room). `selling` overrides the computed total
 * (PreBook, whose total is the rounded RSP-floored charge).
 */
export function customerRoom(room: AnyObj, marginPct: number, selling?: number): AnyObj {
  const net = num(room?.TotalFare ?? room?.NetAmount);
  const rsp = typeof room?.RecommendedSellingRate === "number" ? room.RecommendedSellingRate
    : typeof room?.recommendedSellingRate === "number" ? room.recommendedSellingRate : null;
  const total = typeof selling === "number" ? selling : applyMarginWithFloor(net, marginPct, rsp);
  const dayRates = Array.isArray(room?.DayRates) ? room.DayRates : [];
  const roomCount = Math.max(1, dayRates.length || (Array.isArray(room?.Name) ? room.Name.length : 1));
  const nights = Math.max(1, Array.isArray(dayRates[0]) ? dayRates[0].length : 1);
  const out: AnyObj = {};
  for (const k of ROOM_FIELDS) if (room?.[k] !== undefined) out[k] = room[k];
  const policies = room?.CancelPolicies ?? room?.cancelPolicies;
  if (policies !== undefined) {
    const clean = policiesWithoutAmounts(policies, net);
    out.CancelPolicies = clean;
    out.cancelPolicies = clean;
  }
  out._displayTotalFare = total;
  out._displayPerNight = round2((total - num(room?.TotalTax)) / nights / roomCount);
  return out;
}

/** Hotel search / rooms / prebook payloads: every `Rooms` array is rebuilt with
 *  customerRoom, every other node loses its cost keys. */
export function customerHotelResults(node: unknown, marginPct: number, firstRoomSelling?: number): any {
  if (Array.isArray(node)) return node.map((n) => customerHotelResults(n, marginPct, firstRoomSelling));
  if (!isObj(node)) return node;
  const out: AnyObj = {};
  for (const [k, v] of Object.entries(node)) {
    if ((HOTEL_COST_KEYS as readonly string[]).includes(k)) continue;
    if (k === "Rooms" && Array.isArray(v)) {
      out.Rooms = v.map((r, i) => (isObj(r) ? customerRoom(r, marginPct, i === 0 ? firstRoomSelling : undefined) : r));
      continue;
    }
    out[k] = customerHotelResults(v, marginPct, firstRoomSelling);
  }
  return out;
}

/* ───────────────────────── booking documents ───────────────────────── */

const toPlain = (doc: any): AnyObj => (doc && typeof doc.toObject === "function" ? doc.toObject() : doc) || {};

/**
 * A flight booking document as the customer sees it: everything the booking
 * pages use, without our net, margin or the supplier's fare nodes. baseFare is
 * the selling base (total − taxes − add-ons) so base + taxes is the total paid;
 * the stored record keeps TBO's real BaseFare / Tax.
 */
export function customerFlightBooking(doc: any): AnyObj {
  const d = { ...toPlain(doc) };
  for (const k of ["netAmount", "marginAmount", "marginPercent", "fareBreakdown", "commissionEarned", "tds"]) delete d[k];
  if (Array.isArray(d.passengers)) {
    d.passengers = d.passengers.map((p: AnyObj) => {
      if (!isObj(p)) return p;
      const { fare: _fare, Fare: _Fare, ...rest } = p;
      return rest;
    });
  }
  for (const k of ["raw", "rawResponse", "bookingDetails"]) if (d[k] !== undefined) d[k] = stripFlightBookingFares(d[k]);
  if (typeof d.totalFare === "number") {
    d.baseFare = round2(Math.max(0, d.totalFare - num(d.taxes) - num(d.extras)));
  }
  return d;
}

/** A hotel booking document as the customer sees it: no net, commission, TDS,
 *  RSP, margin; supplier payloads (raw, voucher, booking detail) without cost keys. */
export function customerHotelBooking(doc: any): AnyObj {
  const d = toPlain(doc);
  const out: AnyObj = stripHotelCost({ ...d });
  if (Array.isArray(d.cancelPolicies)) out.cancelPolicies = policiesWithoutAmounts(d.cancelPolicies, num(d.netAmount) || num(d.totalFare));
  return out;
}
