// apps/backend/src/routes/mySpace.ts
//
// GET /api/my-space/upcoming-trip — the caller's next FUTURE confirmed SBT
// flight (sorted by departure, audit H2) plus a confirmed SBT hotel booking
// overlapping its date.
//
// Sources: SBTBooking + SBTHotelBooking only. ManualBooking / TravelBooking
// were checked (2026-11-08) and carry no ID link to the traveller —
// ManualBooking.passengers[] is name/email only and the mirrored
// TravelBooking.userId is the staff booker, not the traveller
// (ManualBooking.ts mirror, TravelBooking.ts travellerName comment). Matching
// by name is forbidden, so they are excluded.
//
// departureTime is a timezone-less airport-local string (SBTBooking.ts). The
// "future" cut compares it against the current IST wall clock, which is exact
// for domestic flights and approximate (± the airport's offset) for
// international ones; the UI labels times "local time".
import { Router, Request, Response } from "express";
import requireAuth from "../middleware/auth.js";
import { requireWorkspace } from "../middleware/requireWorkspace.js";
import { resolveSelfWorkspace } from "../middleware/resolveSelfWorkspace.js";
import SBTBooking from "../models/SBTBooking.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import { toCustomerSafeFlight, toCustomerSafeHotel } from "../utils/customerSafeBooking.js";
import { featureOn, plumboxMounted } from "../services/mySpaceFeatures.js";
import { IST_OFFSET_MS } from "../utils/dateIST.js";

const router = Router();
router.use(requireAuth as any, requireWorkspace as any, resolveSelfWorkspace as any);

function flat(v: any): any[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((x) => (Array.isArray(x) ? x : [x])).filter((x) => x && typeof x === "object");
}

function nonEmpty(v: any): string | undefined {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s ? s : undefined;
}

/**
 * Display-only facts from the stored TBO payload. Every field is optional and
 * only returned when actually present — nothing is inferred.
 */
export function extractRawDisplay(raw: any, originCode?: string, destCode?: string) {
  if (!raw || typeof raw !== "object") return {};
  const fi = raw?.Response?.Response?.FlightItinerary ?? raw?.Response?.FlightItinerary ?? raw?.FlightItinerary ?? null;
  const segs = flat(fi?.Segments ?? raw?.Segments);
  if (!segs.length) return {};
  // Outbound journey = segments up to the one that lands at the booked destination.
  let outbound = segs;
  if (destCode) {
    const idx = segs.findIndex((s) => String(s?.Destination?.Airport?.AirportCode || "").toUpperCase() === destCode.toUpperCase());
    if (idx >= 0) outbound = segs.slice(0, idx + 1);
  }
  const first = outbound[0];
  const last = outbound[outbound.length - 1];
  const out: Record<string, any> = {};
  if (!originCode || String(first?.Origin?.Airport?.AirportCode || "").toUpperCase() === originCode.toUpperCase()) {
    const an = nonEmpty(first?.Origin?.Airport?.AirportName);
    const t = nonEmpty(first?.Origin?.Airport?.Terminal);
    if (an) out.originAirport = an;
    if (t) out.originTerminal = t;
  }
  {
    const an = nonEmpty(last?.Destination?.Airport?.AirportName);
    const t = nonEmpty(last?.Destination?.Airport?.Terminal);
    if (an) out.destinationAirport = an;
    if (t) out.destinationTerminal = t;
  }
  out.stops = outbound.length - 1;
  const durations = outbound.map((s) => Number(s?.Duration));
  if (outbound.length === 1 && Number.isFinite(durations[0]) && durations[0] > 0) {
    out.durationMinutes = durations[0];
  } else if (outbound.length > 1) {
    const gt = Number(last?.AccumulatedDuration);
    if (Number.isFinite(gt) && gt > 0) out.durationMinutes = gt;
  }
  const bag = nonEmpty(first?.Baggage);
  const cabinBag = nonEmpty(first?.CabinBaggage);
  if (bag) out.baggage = bag;
  if (cabinBag) out.cabinBaggage = cabinBag;
  const pax = flat(fi?.Passenger);
  const lead = pax.find((p) => p?.IsLeadPax) ?? pax[0];
  const seat = nonEmpty(flat(lead?.SeatDynamic)[0]?.Code) ?? nonEmpty(lead?.Seat?.Code);
  if (seat && seat.toUpperCase() !== "NOSEAT") out.seat = seat;
  return out;
}

/** Current IST wall clock as "YYYY-MM-DDTHH:mm:ss" (comparable to departureTime). */
function nowIstWall(now = Date.now()): string {
  return new Date(now + IST_OFFSET_MS).toISOString().slice(0, 19);
}

router.get("/upcoming-trip", async (req: Request, res: Response) => {
  try {
    const ws: any = req.workspace;
    if (!plumboxMounted() || !featureOn(req, ws, "flightBookingEnabled")) {
      return res.status(403).json({ success: false, error: "Feature 'flightBookingEnabled' not enabled for this workspace" });
    }
    const user: any = (req as any).user || {};
    const userId = user._id ?? user.id ?? user.sub;
    // Same clause the SBT booking lists use (sbt.flights.ts / sbt.hotels.ts):
    // demo users see demo bookings only; internal test bookings never appear.
    const demo = { ...(user.isDemoUser ? { isDemo: true } : { isDemo: { $ne: true } }), isTest: { $ne: true } };

    const flightDoc: any = await SBTBooking.findOne({
      userId,
      workspaceId: req.workspaceObjectId,
      status: "CONFIRMED",
      departureTime: { $gte: nowIstWall() },
      ...demo,
    })
      .sort({ departureTime: 1 })
      .lean();

    if (!flightDoc) {
      res.setHeader("Cache-Control", "no-store");
      return res.json({ ok: true, flight: null, hotel: null });
    }

    const flight = {
      ...toCustomerSafeFlight(flightDoc),
      ticketingStatus: flightDoc.ticketingStatus || "NOT_ATTEMPTED",
      display: extractRawDisplay(flightDoc.raw, flightDoc.origin?.code, flightDoc.destination?.code),
    };

    // Hotel overlapping the flight date: checkIn <= day after departure,
    // checkOut >= departure day. Dates compared as YYYY-MM-DD.
    const depDay = String(flightDoc.departureTime || "").slice(0, 10);
    const dayAfter = new Date(`${depDay}T00:00:00Z`);
    dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
    const dayAfterStr = dayAfter.toISOString().slice(0, 10);
    const hotels: any[] = await SBTHotelBooking.find({
      userId,
      workspaceId: req.workspaceObjectId,
      status: "CONFIRMED",
      ...demo,
    })
      .select("bookingId confirmationNo bookingRefNo hotelName cityName countryCode checkIn checkOut status rooms roomTypeName")
      .lean();
    const hotelDoc = hotels
      .filter((h) => {
        const ci = String(h.checkIn || "").slice(0, 10);
        const co = String(h.checkOut || "").slice(0, 10);
        return ci && co && ci <= dayAfterStr && co >= depDay;
      })
      .sort((a, b) => String(a.checkIn).localeCompare(String(b.checkIn)))[0];

    let hotel: any = null;
    if (hotelDoc) {
      const safe = toCustomerSafeHotel(hotelDoc);
      const ci = new Date(`${String(hotelDoc.checkIn).slice(0, 10)}T00:00:00Z`).getTime();
      const co = new Date(`${String(hotelDoc.checkOut).slice(0, 10)}T00:00:00Z`).getTime();
      const nights = Math.round((co - ci) / 86400000);
      hotel = {
        _id: safe._id,
        hotelName: safe.hotelName,
        cityName: safe.cityName,
        checkIn: safe.checkIn,
        checkOut: (safe as any).checkOut ?? hotelDoc.checkOut,
        nights: Number.isFinite(nights) && nights > 0 ? nights : null,
      };
    }

    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, flight, hotel });
  } catch (err) {
    console.error("[my-space/upcoming-trip] failed:", err);
    return res.status(500).json({ error: "Failed to load upcoming trip" });
  }
});

export default router;
