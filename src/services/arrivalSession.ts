// apps/backend/src/services/arrivalSession.ts
//
// Phase 4 (Arrive) — opens a WhatsApp arrival concierge session when a
// WHATSAPP-channel TripWatch lands, and sends the greeting. Called from the
// existing tripWatchWorker cycle (no new worker). All failures are swallowed
// with a metric so a bad session never breaks a worker cycle.
//
// Idempotency: exactly one ArrivalSession per TripWatch (unique index). The
// first landed cycle creates it (PENDING) and greets; a successful greeting
// flips it ACTIVE so later cycles no-op. A failed greeting retries ONCE next
// cycle, then EXPIRES.

import ArrivalSession from "../models/ArrivalSession.js";
import SBTRequest from "../models/SBTRequest.js";
import SBTHotelBooking from "../models/SBTHotelBooking.js";
import User from "../models/User.js";
import {
  sendTemplateMessage,
  sendTextMessageResult,
  sendButtonMessage,
} from "./whatsappCloud.service.js";
import { toWaRecipient } from "../utils/waNumber.js";
import { emitMetric } from "../utils/plutoMetricsSink.js";
import { arriveMetric } from "../utils/plutoMetricsBuilder.js";

const EXPIRY_CAP_MS = 48 * 60 * 60 * 1000; // openedAt + 48h hard cap
const CHECKIN_GRACE_MS = 24 * 60 * 60 * 1000; // hotel checkInDate + 1 day

// The exactly-3 arrival menu buttons (ids prefixed arr_ for inbound routing).
export const ARRIVAL_BUTTONS = [
  { id: "arr_hotel", title: "Hotel info" },
  { id: "arr_booker", title: "Contact my booker" },
  { id: "arr_help", title: "Help" },
];

export interface ArrivalContext {
  destinationIata: string;
  destinationCity: string;
  hotel: { name: string | null; address: string | null; phone: string | null; checkInDate: string | null } | null;
  bookerUserId: any | null;
  bookerName: string | null;
  bookerEmail: string | null;
  bookerPhone: string | null;
}

/** min(hotel checkInDate + 1 day, base + 48h); base + 48h when no valid checkIn. */
export function computeExpiry(checkInDate: string | null | undefined, base: Date): Date {
  const cap = new Date(base.getTime() + EXPIRY_CAP_MS);
  if (checkInDate) {
    const ci = new Date(checkInDate);
    if (!isNaN(ci.getTime())) {
      const ciPlus1 = new Date(ci.getTime() + CHECKIN_GRACE_MS);
      return ciPlus1.getTime() < cap.getTime() ? ciPlus1 : cap;
    }
  }
  return cap;
}

/**
 * Resolve hotel + booker + destination for a landed watch. Hotel comes from the
 * SBTRequest.tripBundle.hotel handoff, else the SBTHotelBooking linked by
 * sbtRequestId. Booker (assignedBookerId → User) is resolved ONCE here so the
 * inbound path never does per-message User lookups.
 */
export async function resolveArrivalContext(watch: any, info: any): Promise<ArrivalContext> {
  const destinationIata = watch?.destination || info?.arrival?.iata || "";
  const destinationCity = info?.arrival?.city || watch?.destination || "";

  let hotel: ArrivalContext["hotel"] = null;
  let bookerUserId: any = null;

  const req: any = watch?.sbtRequestId
    ? await SBTRequest.findById(watch.sbtRequestId).select("assignedBookerId tripBundle").lean()
    : null;

  if (req) {
    bookerUserId = req.assignedBookerId || null;
    const h = req?.tripBundle?.hotel;
    if (h) {
      hotel = {
        name: h.name || h.hotelName || null,
        address: h.address || h.hotelAddress || h.cityName || null,
        phone: h.phone || h.hotelPhone || null,
        checkInDate: h.checkInDate || h.checkIn || null,
      };
    }
  }

  if (!hotel && watch?.sbtRequestId) {
    const hb: any = await SBTHotelBooking.findOne({ sbtRequestId: watch.sbtRequestId })
      .select("hotelName cityName checkIn")
      .lean();
    if (hb) {
      hotel = {
        name: hb.hotelName || null,
        address: hb.cityName || null,
        phone: null,
        checkInDate: hb.checkIn || null,
      };
    }
  }

  let bookerName: string | null = null;
  let bookerEmail: string | null = null;
  let bookerPhone: string | null = null;
  if (bookerUserId) {
    const u: any = await User.findById(bookerUserId)
      .select("name firstName email phone personalContact")
      .lean();
    if (u) {
      bookerName = u.name || u.firstName || null;
      bookerEmail = u.email || null;
      bookerPhone = u.phone || u.personalContact || null;
    }
  }

  return { destinationIata, destinationCity, hotel, bookerUserId, bookerName, bookerEmail, bookerPhone };
}

/**
 * Send the arrival greeting. Template (WA_ARRIVAL_TEMPLATE, vars {city,
 * hotelName}) when configured, else a free-form line for dev/open-window — both
 * via the outcome-returning senders so we know if it truly delivered. On success
 * we follow with the interactive 3-button menu (best-effort). Returns delivery.
 */
export async function sendArrivalGreeting(session: any): Promise<boolean> {
  const to = toWaRecipient(session.phone);
  const city = session.destinationCity || "your destination";
  const hotelName = session?.hotel?.name || "your hotel";

  const template = process.env.WA_ARRIVAL_TEMPLATE;
  let ok = false;
  if (template) {
    ok = await sendTemplateMessage(to, template, [city, hotelName]);
  } else {
    ok = await sendTextMessageResult(
      to,
      `Welcome to ${city}! This is your Plumtrips concierge. I can share your hotel details, connect you with your booker, or help in an emergency. Reply STOP to opt out.`,
    );
  }

  if (ok) {
    await sendButtonMessage(to, "How can I help?", ARRIVAL_BUTTONS);
  }
  return ok;
}

/**
 * Open (or resume) the arrival session for a landed watch and greet the
 * traveler. Only WHATSAPP-channel watches get a session (EMAIL → nothing).
 */
export async function openArrivalSession(watch: any, info: any, now: Date = new Date()): Promise<void> {
  const workspaceId = String(watch?.workspaceId || "");
  try {
    if (watch?.notifyChannel !== "WHATSAPP") return;

    let session: any = await ArrivalSession.findOne({ tripWatchId: watch._id });
    if (session && session.status !== "PENDING") return; // ACTIVE / EXPIRED / OPTED_OUT — done

    if (!session) {
      const ctx = await resolveArrivalContext(watch, info);
      const expiresAt = computeExpiry(ctx.hotel?.checkInDate, now);
      try {
        session = await ArrivalSession.create({
          workspaceId: watch.workspaceId,
          tripWatchId: watch._id,
          bookingId: watch.bookingId || null,
          sbtRequestId: watch.sbtRequestId || null,
          travelerUserId: watch.travelerUserId || null,
          phone: watch.notifyTarget,
          destinationIata: ctx.destinationIata,
          destinationCity: ctx.destinationCity,
          hotel: ctx.hotel,
          bookerUserId: ctx.bookerUserId,
          bookerName: ctx.bookerName,
          bookerEmail: ctx.bookerEmail,
          bookerPhone: ctx.bookerPhone,
          status: "PENDING",
          greetingAttempts: 0,
          expiresAt,
          messageCount: 0,
          rateWindowCount: 0,
          menuCount: 0,
          processedMessageIds: [],
        });
      } catch (e: any) {
        // Concurrent create from another instance won the unique index — the
        // other instance owns the greeting; nothing to do here.
        if (e?.code === 11000) return;
        throw e;
      }
    }

    const ok = await sendArrivalGreeting(session);
    if (ok) {
      session.status = "ACTIVE";
      session.openedAt = now;
      session.expiresAt = computeExpiry(session?.hotel?.checkInDate, now);
      await session.save();
      void emitMetric(arriveMetric("pluto.arrive.session_opened", { workspaceId }));
    } else {
      session.greetingAttempts = (session.greetingAttempts || 0) + 1;
      if (session.greetingAttempts >= 2) {
        session.status = "EXPIRED";
        void emitMetric(arriveMetric("pluto.arrive.greeting_failed", { workspaceId }, "error"));
      }
      await session.save();
    }
  } catch (e: any) {
    void emitMetric(
      arriveMetric("pluto.arrive.greeting_failed", { workspaceId, reason: e?.message }, "error"),
    );
  }
}

/**
 * Lifecycle sweep (Step 5) — run inside the existing tripWatchWorker cycle (no
 * new worker). EXPIRE PENDING/ACTIVE sessions past their expiresAt. A polite
 * goodbye is sent ONLY when the traveler actually engaged (lastInboundAt set);
 * otherwise we expire silently. One bad session never breaks the sweep.
 */
export async function expireArrivalSessions(now: Date = new Date()): Promise<void> {
  const due: any[] = await ArrivalSession.find({
    status: { $in: ["PENDING", "ACTIVE"] },
    expiresAt: { $lt: now },
  }).limit(200);

  for (const session of due) {
    try {
      session.status = "EXPIRED";
      await session.save();
      if (session.lastInboundAt) {
        await sendTextMessageResult(
          toWaRecipient(session.phone),
          "Your Plumtrips arrival concierge is now closing. Safe travels — your travel desk is always here if you need anything.",
        );
      }
      void emitMetric(arriveMetric("pluto.arrive.expired", { workspaceId: String(session.workspaceId) }));
    } catch (e: any) {
      // swallow — one session must not stop the sweep
      console.error("[arrivalSession] expire failed", { id: String(session?._id), message: e?.message });
    }
  }
}
