// SBT Flow 1 — an L2 / Workspace Leader books an L1's request through the SAME
// flow as any SBT booking: fare validation → server quote → checkout (card or
// company wallet) → server-side fulfilment. The request only links to the
// booking and moves to BOOKED once that booking is paid and ticketed / vouchered.
//
//   requestBookingRefusal   who may book a request (checked at checkout, before
//                           any money moves, and again when the booking is saved)
//   markRequestBooked       PENDING → BOOKED, once, plus the itinerary and
//                           trip-watch hooks the old direct route used to run
import SBTRequest from "../models/SBTRequest.js";
import User from "../models/User.js";
import { propagateItineraryBooked } from "./itineraryStatus.js";
import { maybeCreateTripWatch } from "./tripWatchCreate.js";
import { sbtLogger } from "../utils/logger.js";

type AnyObj = Record<string, any>;

export const REQUEST_NOT_BOOKABLE = {
  status: 403,
  code: "REQUEST_NOT_BOOKABLE",
  error: "This request is not open for you to book",
} as const;

const isHexId = (v: unknown) => typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);
const norm = (r: unknown) => String(r || "").toUpperCase().replace(/[\s\-_]/g, "");

/**
 * The PENDING request `requestId`, if the caller may book it: the request's
 * assigned L2 / BOTH booker, or a Workspace Leader of the same company — the
 * same rule the request inbox uses. Scoped to the caller's workspace, and the
 * request type must match the product being booked. Otherwise null.
 */
export async function bookableRequest(
  req: AnyObj,
  requestId: unknown,
  product: "flight" | "hotel",
): Promise<AnyObj | null> {
  if (!isHexId(requestId)) return null;
  const uid = String(req.user?._id ?? req.user?.id ?? req.user?.sub ?? "");
  if (!isHexId(uid)) return null;
  const request = (await SBTRequest.findOne({
    _id: requestId, workspaceId: req.workspaceObjectId, status: "PENDING", type: product,
  }).lean()) as AnyObj | null;
  if (!request) return null;
  const user = (await User.findById(uid).select("sbtRole roles customerId").lean()) as AnyObj | null;
  if (!user) return null;
  // The workspace filter above already scopes the request; the legacy customerId
  // must also agree when both sides carry it.
  if (request.customerId && user.customerId && String(user.customerId) !== String(request.customerId)) return null;
  const isWL = (Array.isArray(user.roles) ? user.roles : []).map(norm).includes("WORKSPACELEADER");
  if (isWL) return request;
  if (user.sbtRole !== "L2" && user.sbtRole !== "BOTH") return null;
  return String(request.assignedBookerId ?? "") === uid ? request : null;
}

/** The request a checkout's `save` names (single booking or multi-city). */
export function requestIdOfSave(save: AnyObj | undefined): unknown {
  return save?.sbtRequestId ?? save?.common?.sbtRequestId;
}

/** Refusal for a checkout that names a request the caller may not book. */
export async function requestBookingRefusal(
  req: AnyObj,
  save: AnyObj | undefined,
  product: "flight" | "hotel",
): Promise<typeof REQUEST_NOT_BOOKABLE | null> {
  const id = requestIdOfSave(save);
  if (id == null || id === "") return null;
  return (await bookableRequest(req, id, product)) ? null : REQUEST_NOT_BOOKABLE;
}

/**
 * Move the request PENDING → BOOKED for a paid, ticketed / vouchered booking —
 * exactly once (conditional update) — then run the itinerary and trip-watch
 * hooks. Never throws: the booking itself already exists.
 */
export async function markRequestBooked(
  requestId: unknown,
  workspaceId: unknown,
  link: { bookingId?: unknown; hotelBookingId?: unknown },
  booking?: AnyObj,
): Promise<AnyObj | null> {
  try {
    if (!isHexId(String(requestId ?? ""))) return null;
    const request = (await SBTRequest.findOneAndUpdate(
      { _id: requestId, workspaceId, status: "PENDING" },
      { $set: {
        status: "BOOKED",
        actedAt: new Date(),
        ...(link.bookingId ? { bookingId: link.bookingId } : {}),
        ...(link.hotelBookingId ? { hotelBookingId: link.hotelBookingId } : {}),
      } },
      { new: true },
    ).lean()) as AnyObj | null;
    if (!request) return null;
    try {
      await propagateItineraryBooked(request);
    } catch (e: any) {
      sbtLogger.warn("[SBT] itinerary BOOKED propagation failed", { message: e?.message });
    }
    try {
      await maybeCreateTripWatch(request, booking);
    } catch { /* metric emitted inside */ }
    sbtLogger.info("SBT request marked BOOKED", { sbtRequestId: String(requestId), ...link });
    return request;
  } catch (err: any) {
    sbtLogger.warn("Failed to mark SBT request BOOKED", { sbtRequestId: String(requestId), error: err?.message });
    return null;
  }
}
