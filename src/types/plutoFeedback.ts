// apps/backend/src/types/plutoFeedback.ts

import type { PlutoTripType } from "./pluto.js";
import type { PlutoConversationState } from "./plutoConversationState.js";

export interface PlutoRmFeedback {
  conversationId: string;

  // Optional authoritative updates
  tripType?: PlutoTripType;
  destination?: string;

  dates?: {
    start: string;
    end: string;
  };

  hotels?: string[];

  itineraryLocked?: boolean;

  notes?: string; // RM notes for context

  // Optional forced state move
  advanceStateTo?: PlutoConversationState;
}