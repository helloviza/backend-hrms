import logger from "./logger.js";

const TYPE_COST_LABELS: Record<string, string> = {
  FLIGHT:       "Flight Cost",
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

  if (t === "OTHER") return 1;

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
  if (t === "FLIGHT" || t === "DUMMY_FLIGHT" || t === "TRAIN") {
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

  if (t === "FLIGHT" || t === "DUMMY_FLIGHT") {
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

  // ON_FULL: single combined line — GST charged on full quoted price
  if (gstMode === "ON_FULL") {
    const quotedPrice = booking.pricing?.quotedPrice ?? 0;
    const igst = parseFloat((quotedPrice * gstPercent / 100).toFixed(2));
    return [
      {
        bookingRef:     booking.bookingRef,
        rowType:        "COST",
        description:    costLabel,
        subDescription: subDesc,
        qty:            1,
        rate:           parseFloat(quotedPrice.toFixed(2)),
        igst,
        amount:         parseFloat(quotedPrice.toFixed(2)),
        passengerNames,
        travelDate:     booking.travelDate,
        type:           booking.type,
      },
    ];
  }

  // ON_MARKUP: 2 lines — COST (no GST, qty=units) + SERVICE_FEE (flat per-booking, pre-GST amount, GST broken out)
  const igst = parseFloat(((diff * gstPercent) / (100 + gstPercent)).toFixed(2));

  const qty      = computeQty(booking);
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
  //   - the customer-payable line amount is the pre-GST base
  //     (= markup − igst)
  //   - the GST sits in its own column, not embedded in amount
  //   - qty is always 1 (a transaction fee is not per-unit)
  const txnFeeBase = parseFloat((markupAmount - igst).toFixed(2));

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
      amount:         txnFeeBase,
      passengerNames,
      travelDate:     booking.travelDate,
      type:           booking.type,
    },
  ];
}
