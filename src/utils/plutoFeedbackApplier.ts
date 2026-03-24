import type { PlutoRmFeedback } from "../types/plutoFeedback.js";
import type { PlutoConversationState } from "../types/plutoConversationState.js";

/**
 * Authoritative RM Feedback Applier
 */
export function applyRmFeedback(
  currentLocked: Record<string, any>,
  currentState: PlutoConversationState,
  feedback: PlutoRmFeedback
) {
  const updatedLocked = { ...currentLocked };
  let updatedState = currentState;

  // Authoritative Overwrites
  if (feedback.tripType) updatedLocked.tripType = feedback.tripType;
  if (feedback.destination) updatedLocked.destination = feedback.destination;
  if (feedback.dates) updatedLocked.dates = feedback.dates;
  
  if (Array.isArray(feedback.hotels)) {
    updatedLocked.hotels = feedback.hotels;
  }

  if (feedback.itineraryLocked !== undefined) {
    updatedLocked.itineraryLocked = feedback.itineraryLocked;
  }

  // Force state change
  if (feedback.advanceStateTo) {
    updatedState = feedback.advanceStateTo;
  }

  // Store the RM note for the next Pluto turn
  if (feedback.notes) {
    updatedLocked.lastRmNote = feedback.notes;
  }

  return { updatedLocked, updatedState };
}