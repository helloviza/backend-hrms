// apps/backend/src/utils/plutoHandoffBuilder.ts

import type { PlutoReplyV1 } from "../types/pluto.js";
import type { PlutoConversationState } from "../types/plutoConversationState.js";
import type { PlutoHandoffPayload } from "../types/plutoHandoff.js";

import { evaluateSla } from "./plutoSlaEvaluator.js";

export function buildHandoffPayload(
  reply: PlutoReplyV1,
  state: PlutoConversationState,
  locked: Record<string, any>
): PlutoHandoffPayload {
  // 1. Determine priority based on Trip Type (Business = High Priority)
  const sla = evaluateSla(locked.tripType || reply.tripType);

  return {
    source: "pluto.ai",
    timestamp: new Date().toISOString(),

    // Use locked data first as it is "Human-Verified" or "Decision-Locked"
    tripType: locked.tripType || reply.tripType,
    destination: locked.destination,

    itineraryLocked: Boolean(locked.itineraryLocked),
    hotels: locked.hotels || [],

    state,

    // The 'summary' gives the RM a 2-line brief of the whole chat
    summary: reply.context || "User ready for booking assistance.",
    nextSteps: reply.nextSteps || [],

    // Critical for the Dashboard: Priority and Timing
    priority: sla.priority,
    targetSLA: sla.targetSLA,
    slaReason: sla.reason,

    // Pass all locked data so the RM sees the "Fact Sheet"
    lockedDecisions: locked,
  };
}