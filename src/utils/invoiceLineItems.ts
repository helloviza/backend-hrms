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

function computeQty(booking: any): number {
  const t: string = booking.type;

  if (t === "HOTEL" || t === "DUMMY_HOTEL") {
    const nights = booking.itinerary?.nights || 1;
    const rooms  = booking.itinerary?.roomCount || 1;
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
    const nights = booking.itinerary?.nights || 1;
    const rooms  = booking.itinerary?.roomCount || 1;
    const nightLabel = nights === 1 ? "Night" : "Nights";
    const roomLabel  = rooms  === 1 ? "Room"  : "Rooms";
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
  if (t === "FOREX" || t === "ESIM") {
    return `${paxCount} Unit(s)`;
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

  // ON_MARKUP (default): 2 lines — COST (no GST) + SERVICE_FEE (GST embedded in markup, tax-inclusive back-calc)
  const igst = parseFloat(((diff * gstPercent) / (100 + gstPercent)).toFixed(2));

  const qty      = computeQty(booking);
  const costRate = parseFloat((supplierCost / qty).toFixed(2));
  const svcRate  = parseFloat((markupAmount  / qty).toFixed(2));
  const costAmtRaw = parseFloat((costRate * qty).toFixed(2));
  const svcAmtRaw  = parseFloat((svcRate  * qty).toFixed(2));

  // Absorb cent-level rounding drift: amounts use authoritative totals.
  const costAmt = Math.abs(costAmtRaw - supplierCost) <= 1
    ? parseFloat(supplierCost.toFixed(2))
    : costAmtRaw;
  const svcAmt  = Math.abs(svcAmtRaw  - markupAmount) <= 1
    ? parseFloat(markupAmount.toFixed(2))
    : svcAmtRaw;

  if (Math.abs(costAmt - supplierCost) > 1) {
    logger.warn("[invoiceLineItems] COST row drift > ±1", {
      bookingRef: booking.bookingRef, expected: supplierCost, got: costAmt,
    });
  }
  if (Math.abs(svcAmt - markupAmount) > 1) {
    logger.warn("[invoiceLineItems] SERVICE_FEE row drift > ±1", {
      bookingRef: booking.bookingRef, expected: markupAmount, got: svcAmt,
    });
  }

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
      qty,
      rate:           svcRate,
      igst,
      amount:         svcAmt,
      passengerNames,
      travelDate:     booking.travelDate,
      type:           booking.type,
    },
  ];
}
