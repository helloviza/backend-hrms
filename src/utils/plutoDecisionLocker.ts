import type { PlutoReplyV1 } from "../types/pluto.js";
import type { PlutoIntent } from "./plutoIntentClassifier.js";

export function lockDecisions(
  reply: PlutoReplyV1,
  locked: Record<string, any>,
  intent: PlutoIntent
) {
  /* ─────────────────────────────────────────────
   * 🔒 HARD RULE
   * If destination is video-locked, it is FINAL.
   * Planner can NEVER override it.
   * ───────────────────────────────────────────── */
  if (locked.destination?.source === "video") {
    // Still allow secondary locks
    if (Array.isArray(reply.hotels) && reply.hotels.length > 0) {
      locked.hotels = reply.hotels.map((h) => h.name);
    }

    if (Array.isArray(reply.itinerary) && reply.itinerary.length > 0) {
      locked.itineraryLocked = true;
    }

    return locked;
  }

  /* ─────────────────────────────────────────────
   * PIVOT handling
   * ───────────────────────────────────────────── */
  if (intent === "PIVOT") {
    delete locked.destination;
    delete locked.hotels;
    delete locked.itineraryLocked;
    delete locked.dates;
  }

  /* ─────────────────────────────────────────────
   * Normalize legacy destination shapes
   * ───────────────────────────────────────────── */
  if (typeof locked.destination === "string") {
    locked.destination = {
      name: locked.destination,
      source: "unknown",
    };
  }

  if (
    locked.destination &&
    typeof locked.destination === "object" &&
    locked.destination.value &&
    !locked.destination.name
  ) {
    locked.destination.name = locked.destination.value;
  }

  /* ─────────────────────────────────────────────
   * Planner-driven locks (SAFE ONLY)
   * ───────────────────────────────────────────── */
  if (!locked.tripType && reply.tripType) {
    locked.tripType = reply.tripType;
  }

  // ❌ NEVER infer destination from reply.title
  // Titles like “Detailed Itinerary Planning” are not destinations

  if (Array.isArray(reply.hotels) && reply.hotels.length > 0) {
    locked.hotels = reply.hotels.map((h) => h.name);
  }

  if (Array.isArray(reply.itinerary) && reply.itinerary.length > 0) {
    locked.itineraryLocked = true;
  }

  return locked;
}