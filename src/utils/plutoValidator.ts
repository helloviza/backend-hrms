// apps/backend/src/utils/plutoValidator.ts

import type { PlutoReplyV1 } from "../types/pluto.js";
import type { PlutoConversationState } from "../types/plutoConversationState.js";

/**
 * Shape validator for Pluto.ai responses
 *
 * Design principles:
 * - DELTA-SAFE
 * - STATE-AGNOSTIC
 * - FRONTEND-SAFE
 *
 * This validator accepts PARTIAL replies.
 */
export function isValidPlutoReply(obj: unknown): obj is Partial<PlutoReplyV1> {
  if (!obj || typeof obj !== "object") return false;

  const r = obj as any;

  /**
   * handoff MUST always exist and be boolean
   */
  if (typeof r.handoff !== "boolean") {
    return false;
  }

  /**
   * At least ONE meaningful field must exist
   * (prevents empty {} responses)
   */
  const hasContent =
    typeof r.title === "string" ||
    typeof r.context === "string" ||
    typeof r.tripType === "string" ||
    Array.isArray(r.itinerary) ||
    Array.isArray(r.hotels) ||
    Array.isArray(r.nextSteps);

  if (!hasContent) {
    return false;
  }

  /**
   * tripType (if present)
   */
  if (r.tripType !== undefined) {
    const allowedTripTypes = ["business", "holiday", "mice", "event"];
    if (!allowedTripTypes.includes(r.tripType)) {
      return false;
    }
  }

  /**
   * itinerary (if present)
   */
  if (r.itinerary !== undefined) {
    if (!Array.isArray(r.itinerary) || r.itinerary.length === 0) return false;

    for (const day of r.itinerary) {
      if (
        typeof day.day !== "number" ||
        typeof day.heading !== "string" ||
        !Array.isArray(day.details) ||
        day.details.length === 0
      ) {
        return false;
      }

      for (const d of day.details) {
        if (typeof d !== "string") return false;
      }
    }
  }

  /**
   * hotels (if present)
   */
  if (r.hotels !== undefined) {
    if (!Array.isArray(r.hotels)) return false;

    for (const h of r.hotels) {
      if (
        typeof h.name !== "string" ||
        typeof h.area !== "string" ||
        typeof h.approxPrice !== "string" ||
        typeof h.whyGood !== "string"
      ) {
        return false;
      }
    }
  }

  /**
   * nextSteps (if present)
   */
  if (r.nextSteps !== undefined) {
    if (!Array.isArray(r.nextSteps) || r.nextSteps.length === 0) return false;

    for (const step of r.nextSteps) {
      if (typeof step !== "string") return false;
    }
  }

  return true;
}

/**
 * State-aware validator
 *
 * Enforces conversation discipline WITHOUT schema rigidity.
 */
export function validatePlutoReplyForState(
  reply: Partial<PlutoReplyV1>,
  state: PlutoConversationState
): void {
  // DISCOVERY must never contain itineraries
  if (state === "DISCOVERY" && reply.itinerary) {
    throw new Error(
      "Invalid Pluto response: itinerary not allowed in DISCOVERY state"
    );
  }

  // HANDOFF should not introduce new planning
  if (state === "HANDOFF" && reply.itinerary) {
    throw new Error(
      "Invalid Pluto response: itinerary not allowed in HANDOFF state"
    );
  }
}