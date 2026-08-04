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

  // hotelSearch (deep compare) — same treatment as hotels above, added
  // alongside routes/copilot.travel.ts's new "Itinerary hotel section"
  // block, which sets this field on fullReply AFTER the model call (the
  // model never produces it itself). Not currently reachable as a live bug
  // — the frontend (ConciergePage.tsx) never sends `lastReply` in its
  // request body, so `prev` here is always undefined in production today
  // and every reply takes the `if (!prev) return next` branch above,
  // unfiltered. But this function's whole design is an explicit field
  // list — anything not named here would silently vanish the moment any
  // caller (a future frontend change, a different client) DOES start
  // passing `lastReply`, the same latent gap `handoffError` already has a
  // few lines up. Named explicitly so hotelSearch doesn't join it.
  if (
    JSON.stringify(next.hotelSearch) !==
    JSON.stringify(prev.hotelSearch)
  ) {
    if (next.hotelSearch) {
      delta.hotelSearch = next.hotelSearch;
    }
  }

  // hotelsAwaitingDates — same additive-field treatment as hotelSearch above.
  if (
    JSON.stringify(next.hotelsAwaitingDates) !==
    JSON.stringify(prev.hotelsAwaitingDates)
  ) {
    if (next.hotelsAwaitingDates) {
      delta.hotelsAwaitingDates = next.hotelsAwaitingDates;
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