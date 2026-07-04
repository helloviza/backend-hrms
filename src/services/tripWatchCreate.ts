// apps/backend/src/services/tripWatchCreate.ts
//
// Creates a TripWatch at the BOOKED transition — ONLY for concierge-sourced
// requests whose traveler explicitly opted in. No opt-in → no watch, ever.
// Any failure is swallowed (metric) so the booking transition never fails.

import TripWatch from "../models/TripWatch.js";
import { emitMetric } from "../utils/plutoMetricsSink.js";
import { watchMetric } from "../utils/plutoMetricsBuilder.js";
import { isValidWhatsAppNumber } from "../utils/waNumber.js";

const CONCIERGE_SOURCES = new Set(["CONCIERGE", "CONCIERGE_AI"]);

// Parse SBTBooking.departureTime (string) ONCE into a Date (Amendment I).
function parseDepartDate(s: any): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export async function maybeCreateTripWatch(request: any, booking: any): Promise<any | null> {
  try {
    if (request?.type !== "flight") return null;
    if (!CONCIERGE_SOURCES.has(request?.source)) return null;
    const consent = request?.tripBundle?.consent;
    if (!consent?.watchOptIn) return null;

    const departDate = parseDepartDate(booking?.departureTime);
    if (!departDate) {
      void emitMetric(
        watchMetric("pluto.watch.create_failed", { workspaceId: String(request.workspaceId), reason: "departdate_parse_failed" }, "error"),
      );
      return null;
    }

    // The explicitly captured opt-in number is the only notify target; never
    // silently trust passengers[].phone. Email is the fallback target.
    const wa = consent.whatsappNumber;
    const email = request?.contactDetails?.email || booking?.contactEmail || null;
    let notifyChannel: "WHATSAPP" | "EMAIL";
    let notifyTarget: string;
    if (isValidWhatsAppNumber(wa)) {
      notifyChannel = "WHATSAPP";
      notifyTarget = wa;
    } else if (email) {
      notifyChannel = "EMAIL";
      notifyTarget = email;
    } else {
      void emitMetric(
        watchMetric("pluto.watch.create_failed", { workspaceId: String(request.workspaceId), reason: "no_notify_target" }, "error"),
      );
      return null;
    }

    const flightNo = `${booking?.airlineCode || ""}-${booking?.flightNumber || ""}`.replace(/^-|-$/g, "");
    return await TripWatch.create({
      workspaceId: request.workspaceId,
      bookingId: booking?._id,
      sbtRequestId: request._id,
      flightNo,
      carrier: booking?.airlineCode || "",
      origin: booking?.origin?.code || "",
      destination: booking?.destination?.code || "",
      departDate,
      travelerUserId: request?.requesterId,
      notifyChannel,
      notifyTarget,
      fallbackEmail: email,
      status: "ACTIVE",
    });
  } catch (e: any) {
    void emitMetric(
      watchMetric("pluto.watch.create_failed", { workspaceId: String(request?.workspaceId), reason: e?.message }, "error"),
    );
    return null;
  }
}
