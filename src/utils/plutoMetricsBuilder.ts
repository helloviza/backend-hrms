// apps/backend/src/utils/plutoMetricsBuilder.ts

import type { PlutoMetricEvent } from "../types/plutoMetrics.js";
import type { PlutoConversationState } from "../types/plutoConversationState.js";

export function conversationStarted(
  conversationId: string
): PlutoMetricEvent {
  return {
    type: "CONVERSATION_STARTED",
    timestamp: new Date().toISOString(),
    conversationId,
  };
}

export function stateTransition(
  conversationId: string,
  fromState: PlutoConversationState,
  toState: PlutoConversationState,
  turnNumber: number
): PlutoMetricEvent {
  return {
    type: "STATE_TRANSITION",
    timestamp: new Date().toISOString(),
    conversationId,
    fromState,
    toState,
    turnNumber,
  };
}

export function handoffTriggered(
  conversationId: string,
  turnNumber: number
): PlutoMetricEvent {
  return {
    type: "HANDOFF_TRIGGERED",
    timestamp: new Date().toISOString(),
    conversationId,
    turnNumber,
  };
}

export function conversationDropped(
  conversationId: string,
  lastState: PlutoConversationState,
  turnNumber: number
): PlutoMetricEvent {
  return {
    type: "CONVERSATION_DROPPED",
    timestamp: new Date().toISOString(),
    conversationId,
    state: lastState,
    turnNumber,
  };
}