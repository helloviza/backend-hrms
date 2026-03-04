// apps/backend/src/types/plutoMetrics.ts

import type { PlutoConversationState } from "./plutoConversationState.js";

export type PlutoMetricEventType =
  | "CONVERSATION_STARTED"
  | "STATE_TRANSITION"
  | "HANDOFF_TRIGGERED"
  | "CONVERSATION_DROPPED";

export interface PlutoMetricEvent {
  type: PlutoMetricEventType;
  timestamp: string;

  conversationId: string;

  // Optional dimensions
  state?: PlutoConversationState;
  fromState?: PlutoConversationState;
  toState?: PlutoConversationState;

  turnNumber?: number;

  metadata?: Record<string, any>;
}