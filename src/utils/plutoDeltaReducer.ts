// apps/backend/src/utils/plutoDeltaReducer.ts

import type { PlutoReplyV1 } from "../types/pluto.js";

/**
 * Reduce a Pluto reply to DELTA-ONLY output.
 * Only fields that changed compared to lastReply are returned.
 */
export function reduceToDelta(
  next: PlutoReplyV1,
  prev?: PlutoReplyV1
): Partial<PlutoReplyV1> {
  // First response → send full payload
  if (!prev) {
    return next;
  }

  const delta: Partial<PlutoReplyV1> = {};

  // title
  if (next.title !== prev.title) {
    delta.title = next.title;
  }

  // context
  if (next.context !== prev.context) {
    delta.context = next.context;
  }

  // tripType
  if (next.tripType !== prev.tripType) {
    delta.tripType = next.tripType;
  }

  // itinerary (deep compare)
  if (
    JSON.stringify(next.itinerary) !==
    JSON.stringify(prev.itinerary)
  ) {
    if (next.itinerary) {
      delta.itinerary = next.itinerary;
    }
  }

  // hotels (deep compare)
  if (
    JSON.stringify(next.hotels) !==
    JSON.stringify(prev.hotels)
  ) {
    if (next.hotels) {
      delta.hotels = next.hotels;
    }
  }

  // nextSteps (usually evolve)
  if (
    JSON.stringify(next.nextSteps) !==
    JSON.stringify(prev.nextSteps)
  ) {
    delta.nextSteps = next.nextSteps;
  }

  // handoff is mandatory for frontend
  delta.handoff = true;

  return delta;
}