import logger from "./logger.js";

const TYPE_COST_LABELS: Record<string, string> = {
  FLIGHT:            "Flight Cost",
  FLIGHT_RESCHEDULE: "Flight Rescheduling",
  DUMMY_FLIGHT: "Flight Cost",
  HOTEL:        "Hotel Cost",
  DUMMY_HOTEL:  "Hotel Cost",
  TRAIN:        "Train Cost",
  VISA:         "Visa Cost",
  TRANSFER:     "Transfer Cost",
  CAB:          "Cab Cost",
  FOREX:        "Forex Cost",
  ESIM:         "eSIM Cost",
  HOLIDAYS:     "Holiday Cost",
  EVENTS:       "Event Cost",
  OTHER:        "Service Cost",
  TROPHY:       "Service Cost",
  GIFT:         "Service Cost",
  STATIONERY:   "Service Cost",
  SERVICE:      "Service Cost",
};

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const dt = new Date(d as string);
  if (isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * Compute nights between check-in and check-out dates.
 * Returns null if either date is missing or invalid; never returns 0.
 * Same-day check-in/out → 1 (treated as a 1-night stay for billing).
 */
function computeNightsFromDates(
  travelDate: unknown,
  returnDate: unknown
): number | null {
  if (!travelDate || !returnDate) return null;
  const ci = new Date(travelDate as string | Date);
  const co = new Date(returnDate as string | Date);
  if (isNaN(ci.getTime()) || isNaN(co.getTime())) return null;
  const ms = co.getTime() - ci.getTime();
  if (ms < 0) return null;  // return-before-checkin = invalid
  const days = Math.round(ms / 86_400_000);
  return Math.max(1, days);  // same-day stay clamps to 1
}

/**
 * Resolve nights for a HOTEL booking using a clear precedence:
 * 1. itinerary.nights if present and > 0
 * 2. computed from travelDate/returnDate
 * 3. fallback to 1 (preserves existing rendering for malformed docs)
 */
function resolveHotelNights(booking: any): number {
  const stored = Number(booking?.itinerary?.nights);
  if (Number.isFinite(stored) && stored > 0) return stored;
  const computed = computeNightsFromDates(
    booking?.travelDate,
    booking?.returnDate
  );
  if (computed != null) return computed;
  return 1;
}

/**
 * Resolve room count with similar precedence.
 */
function resolveHotelRooms(booking: any): number {
  const stored = Number(booking?.itinerary?.roomCount);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return 1;
}

function computeQty(booking: any): number {
  const t: string = booking.type;

  if (t === "HOTEL" || t === "DUMMY_HOTEL") {
    const nights = resolveHotelNights(booking);
    const rooms = resolveHotelRooms(booking);
    const qty    = nights * rooms;
    if (!qty || isNaN(qty) || qty <= 0) {
      logger.warn("[invoiceLineItems] hotel QTY is zero/NaN, falling back to 1", {
        bookingRef: booking.bookingRef, nights, rooms,
      });
      return 1;
    }
    return qty;
  }

  if (t === "OTHER" || t === "TROPHY" || t === "GIFT" || t === "STATIONERY") return 1;

  if (t === "FOREX" || t === "ESIM") return 1;

  const pax = (booking.passengers || []).length || 1;
  if (!pax || isNaN(pax) || pax <= 0) {
    logger.warn("[invoiceLineItems] passenger QTY is zero/NaN, falling back to 1", {
      bookingRef: booking.bookingRef, pax,
    });
    return 1;
  }
  return pax;
}

function buildUnitCountPrefix(booking: any): string {
  const t: string = booking.type;
  const paxCount = (booking.passengers || []).length || 1;

  if (t === "HOTEL" || t === "DUMMY_HOTEL") {
    const nights = resolveHotelNights(booking);
    const rooms = resolveHotelRooms(booking);
    const nightLabel = nights === 1 ? "Night" : "Nights";
    const roomLabel = rooms === 1 ? "Room" : "Rooms";
    return `${nights} ${nightLabel} x ${rooms} ${roomLabel}`;
  }
  if (t === "FLIGHT" || t === "FLIGHT_RESCHEDULE" || t === "DUMMY_FLIGHT" || t === "TRAIN") {
    return `${paxCount} ${paxCount === 1 ? "Passenger" : "Passengers"}`;
  }
  if (t === "VISA") {
    return `${paxCount} ${paxCount === 1 ? "Applicant" : "Applicants"}`;
  }
  if (t === "TRANSFER" || t === "CAB" || t === "HOLIDAYS") {
    return `${paxCount} Passenger(s)`;
  }
  if (t === "EVENTS") {
    return `${paxCount} Attendee(s)`;
  }
  // FOREX/ESIM render as a single unit until the form captures
  // currency/amount or SIM count/validity-days. See audit
  // 2026-05-05 Section 1.2.
  if (t === "FOREX" || t === "ESIM") {
    return "1 Unit";
  }
  return "";
}

function buildSubDescription(booking: any, paxStr: string): string {
  const t: string = booking.type;
  const prefix = buildUnitCountPrefix(booking);

  let parts: (string | undefined)[];

  if (t === "FLIGHT" || t === "FLIGHT_RESCHEDULE" || t === "DUMMY_FLIGHT") {
    const origin      = booking.itinerary?.origin || "";
    const destination = booking.itinerary?.destination || "";
    const route       = origin && destination ? `${origin}-${destination}` : origin || destination || "—";
    const airline     = booking.itinerary?.airline || "";
    const flightNo    = booking.itinerary?.flightNo || "";
    const carrier     = [airline, flightNo].filter(Boolean).join(" ");
    const dateStr     = fmtDate(booking.travelDate);
    parts = [paxStr, route, carrier || undefined, dateStr ? `Travel Date: ${dateStr}` : undefined];
  } else if (t === "TRAIN") {
    const origin      = booking.itinerary?.origin || "";
    const destination = booking.itinerary?.destination || "";
    const route       = origin && destination ? `${origin}-${destination}` : origin || destination || "—";
    const trainClass  = booking.itinerary?.trainClass || "";
    const trainNo     = booking.itinerary?.flightNo || "";
    const carrier     = [trainClass, trainNo].filter(Boolean).join(" ");
    const dateStr     = fmtDate(booking.travelDate);
    parts = [paxStr, route, carrier || undefined, dateStr ? `Travel Date: ${dateStr}` : undefined];
  } else if (t === "HOTEL" || t === "DUMMY_HOTEL") {
    const hotelName = booking.itinerary?.hotelName || "";
    const city      = booking.itinerary?.destination || booking.sector || "";
    const checkIn   = fmtDate(booking.travelDate);
    const checkOut  = fmtDate(booking.returnDate);
    parts = [
      paxStr,
      hotelName || undefined,
      city     || undefined,
      checkIn  ? `Check-in: ${checkIn}`   : undefined,
      checkOut ? `Check-out: ${checkOut}` : undefined,
    ];
  } else if (t === "VISA") {
    const dateStr = fmtDate(booking.travelDate);
    parts = [paxStr, "Visa Service", dateStr ? `Travel Date: ${dateStr}` : undefined];
  } else if (t === "HOLIDAYS") {
    const desc    = booking.itinerary?.description || "";
    const dateStr = fmtDate(booking.travelDate);
    parts = [paxStr, "Holiday Package", desc || undefined, dateStr ? `Travel Date: ${dateStr}` : undefined];
  } else if (t === "EVENTS") {
    const desc = booking.itinerary?.description || "";
    parts = [paxStr, "Event", desc || undefined];
  } else if (t === "TRANSFER" || t === "CAB" || t === "FOREX" || t === "ESIM") {
    const desc = booking.itinerary?.description || t;
    parts = [paxStr, desc];
  } else {
    const desc = booking.itinerary?.description || booking.notes || "";
    parts = [paxStr, desc || undefined];
  }

  const body = parts.filter(Boolean).join(" || ");
  return prefix ? `${prefix} || ${body}` : body;
}

export function buildLineItemsForBooking(booking: any): any[] {
  const passengerNames: string[] = (booking.passengers || []).map((p: any) => p.name);
  const paxStr = passengerNames.join(", ") || "—";

  const supplierCost = booking.pricing?.supplierCost ?? booking.pricing?.actualPrice ?? 0;
  const markupAmount = booking.pricing?.markupAmount ?? booking.pricing?.diff ?? 0;
  const gstPercent   = booking.pricing?.gstPercent ?? 18;
  const gstMode      = booking.pricing?.gstMode || "ON_MARKUP";

  const diff =
    booking.pricing?.diff != null
      ? booking.pricing.diff
      : (booking.pricing?.quotedPrice ?? 0) - (booking.pricing?.actualPrice ?? 0);

  const subDesc   = buildSubDescription(booking, paxStr);
  const costLabel = TYPE_COST_LABELS[booking.type] || "Service Cost";

  // ON_FULL: single combined line — GST charged on full quoted price.
  // Per-row contract: Rate is pre-GST base, GST is broken out, Amount = Rate × Qty + GST.
  if (gstMode === "ON_FULL") {
    const quotedPrice = booking.pricing?.quotedPrice ?? 0;
    const igst = parseFloat((quotedPrice * gstPercent / 100).toFixed(2));
    const amountWithGst = parseFloat((quotedPrice + igst).toFixed(2));
    // Sanity: should equal pricing.grandTotal. Use authoritative value if drift ≤ 1 paisa.
    const grandTotalRef = booking.pricing?.grandTotal ?? amountWithGst;
    const amountFinal = Math.abs(amountWithGst - grandTotalRef) <= 1
      ? parseFloat(grandTotalRef.toFixed(2))
      : amountWithGst;
    return [
      {
        bookingRef:     booking.bookingRef,
        rowType:        "COST",
        description:    costLabel,
        subDescription: subDesc,
        qty:            1,
        rate:           parseFloat(quotedPrice.toFixed(2)),
        igst,
        amount:         amountFinal,
        passengerNames,
        travelDate:     booking.travelDate,
        type:           booking.type,
      },
    ];
  }

  // ON_MARKUP: 2 lines — COST (no GST, qty=units) + SERVICE_FEE (flat per-booking, pre-GST amount, GST broken out)
  const igst = parseFloat(((diff * gstPercent) / (100 + gstPercent)).toFixed(2));

  const qty      = computeQty(booking);

  // Non-positive markup (actualPrice >= quotedPrice — a loss/surge booking):
  // the markup-derived Transaction Fees line would carry a NEGATIVE amount and
  // NEGATIVE embedded GST (igst = diff*g/(100+g) < 0), producing an invalid
  // invoice line and dragging the footer GST negative. Suppress the fee line and
  // bill a SINGLE cost line at quotedPrice (what the client actually owes), so the
  // line sums to grandTotal. The loss stays internal in pricing.basePrice (already
  // persisted on the booking) and never surfaces on the invoice. ON_FULL is
  // unaffected — it returned above and never reaches this branch.
  if (diff <= 0) {
    const quotedPrice = booking.pricing?.quotedPrice ?? 0;
    const lossRate   = parseFloat((quotedPrice / qty).toFixed(2));
    const lossAmtRaw = parseFloat((lossRate * qty).toFixed(2));
    const lossAmt = Math.abs(lossAmtRaw - quotedPrice) <= 1
      ? parseFloat(quotedPrice.toFixed(2))
      : lossAmtRaw;
    return [
      {
        bookingRef:     booking.bookingRef,
        rowType:        "COST",
        description:    costLabel,
        subDescription: subDesc,
        qty,
        rate:           lossRate,
        igst:           0,
        amount:         lossAmt,
        passengerNames,
        travelDate:     booking.travelDate,
        type:           booking.type,
      },
    ];
  }

  const costRate = parseFloat((supplierCost / qty).toFixed(2));
  const costAmtRaw = parseFloat((costRate * qty).toFixed(2));

  // Cost row: rounding-drift absorber preserves authoritative supplierCost
  const costAmt = Math.abs(costAmtRaw - supplierCost) <= 1
    ? parseFloat(supplierCost.toFixed(2))
    : costAmtRaw;

  if (Math.abs(costAmt - supplierCost) > 1) {
    logger.warn("[invoiceLineItems] COST row drift > ±1", {
      bookingRef: booking.bookingRef, expected: supplierCost, got: costAmt,
    });
  }

  // Transaction Fees row: flat per-booking charge.
  // Under ON_MARKUP, markupAmount is GST-inclusive, so:
  //   - Rate is the pre-GST base (= markup − igst)
  //   - GST sits in its own column
  //   - Amount = Rate + GST = customer-payable line total (= markupAmount)
  //   - qty is always 1 (a transaction fee is not per-unit)
  const txnFeeBase = parseFloat((markupAmount - igst).toFixed(2));
  const txnFeeAmount = parseFloat((txnFeeBase + igst).toFixed(2));
  // Use authoritative markupAmount when drift ≤ 1 paisa to avoid float jitter.
  const txnFeeAmountFinal = Math.abs(txnFeeAmount - markupAmount) <= 1
    ? parseFloat(markupAmount.toFixed(2))
    : txnFeeAmount;

  return [
    {
      bookingRef:     booking.bookingRef,
      rowType:        "COST",
      description:    costLabel,
      subDescription: subDesc,
      qty,
      rate:           costRate,
      igst:           0,
      amount:         costAmt,
      passengerNames,
      travelDate:     booking.travelDate,
      type:           booking.type,
    },
    {
      bookingRef:     booking.bookingRef,
      rowType:        "SERVICE_FEE",
      description:    "Transaction Fees",
      subDescription: subDesc,
      qty:            1,
      rate:           txnFeeBase,
      igst,
      amount:         txnFeeAmountFinal,
      passengerNames,
      travelDate:     booking.travelDate,
      type:           booking.type,
    },
  ];
}

/* ─── Combined invoice format ───────────────────────────────────────────
 * "Combined" collapses many bookings into one COST (+ one Transaction Fees)
 * line per category, vs "Separate" which itemises every booking. The grand
 * total is identical between formats — only the line presentation differs.
 *
 * Reconciliation guarantee: we build the authoritative per-booking lines via
 * buildLineItemsForBooking() and then SUM their amount/igst into the combined
 * lines. Because Σ(combined amounts) === Σ(separate amounts) and likewise for
 * igst, the route's subtotal / totalGST / grandTotal math (which sums across
 * lineItems + booking pricing) yields exactly the same totals either way.
 */

// Booking type → combined-group key. Flights + dummy flights merge; flight
// reschedules stay their OWN group (never merged with flights); hotels + dummy
// hotels merge; everything else (VISA, TRAIN, TRANSFER, …, TROPHY, GIFT,
// STATIONERY) groups by its own type.
function combinedGroupKey(type: string): string {
  if (type === "DUMMY_FLIGHT" || type === "DUMMY_HOTEL") return "DUMMY";
  return type;
}

// Dynamic label for the DUMMY group — reflects which dummy types are present.
function dummyGroupLabel(bookings: any[]): string {
  let hasFlight = false;
  let hasHotel = false;
  for (const b of bookings) {
    if (b?.type === "DUMMY_FLIGHT") hasFlight = true;
    else if (b?.type === "DUMMY_HOTEL") hasHotel = true;
  }
  if (hasFlight && hasHotel) return "Dummy Hotel & Flight";
  if (hasHotel) return "Dummy Hotel";
  return "Dummy Flight";
}

// Combined-line cost labels. Falls back to the per-booking TYPE_COST_LABELS
// (so service types read "Transfer Cost", "Service Cost", etc.).
const COMBINED_COST_LABELS: Record<string, string> = {
  FLIGHT:            "Flight Booking",
  FLIGHT_RESCHEDULE: "Flight Rescheduling",
  HOTEL:             "Hotel Booking",
  TRAIN:             "Train Booking",
  VISA:              "VISA",
};
function combinedCostLabel(groupKey: string): string {
  return COMBINED_COST_LABELS[groupKey] || TYPE_COST_LABELS[groupKey] || "Service Cost";
}

// Date range spanning a group: earliest travelDate → latest returnDate (or
// travelDate when no return). Same-year ranges drop the year ("01 May – 13 May");
// a single date keeps it ("01 May 2026"); cross-year keeps both years.
function combinedGroupDateRange(bookings: any[]): string {
  let min: number | null = null;
  let max: number | null = null;
  for (const b of bookings) {
    const start = b?.travelDate ? new Date(b.travelDate).getTime() : NaN;
    const endRaw = b?.returnDate || b?.travelDate;
    const end = endRaw ? new Date(endRaw).getTime() : NaN;
    if (!isNaN(start)) min = min === null ? start : Math.min(min, start);
    if (!isNaN(end))   max = max === null ? end   : Math.max(max, end);
  }
  if (min === null && max === null) return "";
  const lo = new Date(min ?? (max as number));
  const hi = new Date(max ?? (min as number));
  const dm  = (d: Date) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" });
  const dmy = (d: Date) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  if (lo.getTime() === hi.getTime()) return dmy(lo);
  if (lo.getFullYear() === hi.getFullYear()) return `${dm(lo)} – ${dm(hi)}`;
  return `${dmy(lo)} – ${dmy(hi)}`;
}

export function buildCombinedLineItems(bookings: any[]): any[] {
  // Group bookings (preserving first-seen order), collecting each group's
  // authoritative per-booking lines for summation.
  const groups = new Map<string, { bookings: any[]; lines: any[] }>();
  const order: string[] = [];
  for (const b of bookings) {
    const key = combinedGroupKey(String(b?.type || ""));
    let g = groups.get(key);
    if (!g) {
      g = { bookings: [], lines: [] };
      groups.set(key, g);
      order.push(key);
    }
    g.bookings.push(b);
    g.lines.push(...buildLineItemsForBooking(b));
  }

  const out: any[] = [];
  for (const key of order) {
    const g = groups.get(key)!;
    const costRows = g.lines.filter((li) => li.rowType === "COST");
    const feeRows  = g.lines.filter((li) => li.rowType === "SERVICE_FEE");

    const dateRange = combinedGroupDateRange(g.bookings);
    const refs = g.bookings.map((b) => b.bookingRef).filter(Boolean).join(", ");
    const passengerNames = g.bookings.flatMap((b) => (b.passengers || []).map((p: any) => p.name));

    // Combined COST line — Σ of the group's COST-row amounts & GST.
    const costAmount = parseFloat(costRows.reduce((s, r) => s + (r.amount ?? 0), 0).toFixed(2));
    const costIgst   = parseFloat(costRows.reduce((s, r) => s + (r.igst ?? 0), 0).toFixed(2));
    // Rate = pre-GST base so the per-row contract (Amount = Rate × Qty + GST,
    // Qty = 1) holds for both ON_MARKUP (igst 0) and ON_FULL (igst > 0) groups.
    out.push({
      bookingRef:     refs,
      rowType:        "COST",
      description:    key === "DUMMY" ? dummyGroupLabel(g.bookings) : combinedCostLabel(key),
      subDescription: dateRange,
      qty:            1,
      rate:           parseFloat((costAmount - costIgst).toFixed(2)),
      igst:           costIgst,
      amount:         costAmount,
      passengerNames,
      travelDate:     g.bookings[0]?.travelDate,
      type:           key,
    });

    // Combined Transaction Fees line — Σ of the group's SERVICE_FEE-row amounts
    // & GST. Emitted only when the group has fee rows (all-ON_FULL groups have
    // none, matching SEPARATE).
    if (feeRows.length > 0) {
      const feeAmount = parseFloat(feeRows.reduce((s, r) => s + (r.amount ?? 0), 0).toFixed(2));
      const feeIgst   = parseFloat(feeRows.reduce((s, r) => s + (r.igst ?? 0), 0).toFixed(2));
      out.push({
        bookingRef:     refs,
        rowType:        "SERVICE_FEE",
        description:    "Transaction Fees",
        subDescription: dateRange,
        qty:            1,
        rate:           parseFloat((feeAmount - feeIgst).toFixed(2)),
        igst:           feeIgst,
        amount:         feeAmount,
        passengerNames,
        travelDate:     g.bookings[0]?.travelDate,
        type:           key,
      });
    }
  }

  return out;
}
