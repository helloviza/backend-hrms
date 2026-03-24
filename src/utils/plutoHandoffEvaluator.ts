// apps/backend/src/utils/plutoHandoffEvaluator.ts

import type { PlutoConversationState } from "../types/plutoConversationState.js";

interface LockedDecisions {
  tripType?: string;
  destination?: string;
  dates?: { start: string; end: string };
  itineraryLocked?: boolean;
}

/**
 * Determines if conversation is READY for human / execution handoff.
 */
export function isHandoffReady(
  state: PlutoConversationState,
  locked: LockedDecisions,
  nextSteps?: string[]
): boolean {
  // Must be at least EXECUTION stage
  if (state !== "EXECUTION" && state !== "LOGISTICS") {
    return false;
  }

  // Core decisions must be locked
  if (!locked.tripType) return false;
  if (!locked.destination) return false;

  // Either dates or itinerary must exist
  if (!locked.dates && !locked.itineraryLocked) {
    return false;
  }

  // Must have at least one actionable next step
  if (!Array.isArray(nextSteps) || nextSteps.length === 0) {
    return false;
  }

  return true;
}