// apps/backend/src/types/plutoMetrics.ts

import type { PlutoConversationState } from "./plutoConversationState.js";

export type PlutoMetricEventType =
  | "CONVERSATION_STARTED"
  | "STATE_TRANSITION"
  | "HANDOFF_TRIGGERED"
  | "CONVERSATION_DROPPED"
  // Failure / degradation events (Phase 1 — visibility)
  | "pluto.search.error"
  | "pluto.ai.fallback"
  | "pluto.ai.error"
  | "pluto.ai.fallback_invalid"
  | "pluto.multicity.downgraded"
  // Policy evaluation (Phase 2)
  | "pluto.policy.evaluated"
  // Richer handoff delivery (Phase 2)
  | "pluto.handoff.delivered"
  | "pluto.handoff.failed"
  // Route intelligence + watchers (Phase 3)
  | "pluto.fareobs.write_failed"
  | "pluto.routeinsights.served"
  | "pluto.watch.checked"
  | "pluto.watch.alerted"
  | "pluto.watch.check_failed"
  | "pluto.watch.create_failed"
  | "pluto.notify.sent"
  | "pluto.notify.failed"
  | "pluto.weather.failed"
  // Conversation memory migration (Capstone)
  | "pluto.memory.read_failed"
  | "pluto.memory.write_failed"
  // Reply substance enforcement (Step 3) — a thin reply accepted after a
  // corrective retry (never fails the turn; visible so we can tune the prompt)
  | "pluto.reply.thin_accepted"
  // Arrival concierge (Phase 4 — Arrive)
  | "pluto.arrive.session_opened"
  | "pluto.arrive.expired"
  | "pluto.arrive.message_handled"
  | "pluto.arrive.escalated"
  | "pluto.arrive.unknown_sender"
  | "pluto.arrive.greeting_failed"
  | "pluto.arrive.escalation_failed"
  | "pluto.arrive.rate_limited";

// Severity drives sink routing: "error"/"warn" events always surface (console
// error/warn) regardless of the PLUTO_METRICS analytics flag; "info" events
// stay gated behind it. Absent severity is treated as "info".
export type PlutoMetricSeverity = "info" | "warn" | "error";

export interface PlutoMetricEvent {
  type: PlutoMetricEventType;
  timestamp: string;

  // Optional — failure events may fire before a conversation context exists
  // (e.g. a chat flight search that fails during the pre-context guard).
  conversationId?: string;

  severity?: PlutoMetricSeverity;

  // Tenant + correlation
  workspaceId?: string;
  requestId?: string;
  reason?: string;

  // Optional dimensions
  state?: PlutoConversationState;
  fromState?: PlutoConversationState;
  toState?: PlutoConversationState;

  turnNumber?: number;

  metadata?: Record<string, any>;
}