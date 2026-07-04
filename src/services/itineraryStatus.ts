// apps/backend/src/services/itineraryStatus.ts
//
// Phase 5 — propagate a booked SBTRequest to its linked itinerary. Called at the
// existing SBTRequest → BOOKED transition. Swallowed by the caller so an
// itinerary update can never fail the booking.

import Itinerary from "../models/Itinerary.js";

/** When the booked request carries tripBundle.itineraryId, mark that itinerary BOOKED. */
export async function propagateItineraryBooked(request: any): Promise<void> {
  const itineraryId = request?.tripBundle?.itineraryId;
  if (!itineraryId) return;
  await Itinerary.updateOne(
    { _id: itineraryId, workspaceId: request.workspaceId },
    { $set: { status: "BOOKED" } },
  );
}
