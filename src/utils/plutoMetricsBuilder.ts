// apps/backend/src/utils/plutoMetricsBuilder.ts

import type { PlutoMetricEvent } from "../types/plutoMetrics.js";
import type { PlutoConversationState } from "../types/plutoConversationState.js";

/* ────────────────────────────────────────────────────────────
 * Failure / degradation event builders (Phase 1 — visibility)
 *
 * These carry { workspaceId, requestId, reason } and a severity so the sink
 * always surfaces them (error/warn) even when PLUTO_METRICS analytics is off.
 * ──────────────────────────────────────────────────────────── */

interface FailureArgs {
  workspaceId?: string;
  requestId?: string;
  reason?: string;
  conversationId?: string;
}

export function searchError(args: FailureArgs): PlutoMetricEvent {
  return {
    type: "pluto.search.error",
    severity: "error",
    timestamp: new Date().toISOString(),
    ...args,
  };
}

export function aiFallback(args: FailureArgs): PlutoMetricEvent {
  return {
    type: "pluto.ai.fallback",
    severity: "warn",
    timestamp: new Date().toISOString(),
    ...args,
  };
}

export function aiError(args: FailureArgs): PlutoMetricEvent {
  return {
    type: "pluto.ai.error",
    severity: "error",
    timestamp: new Date().toISOString(),
    ...args,
  };
}

export function aiFallbackInvalid(args: FailureArgs): PlutoMetricEvent {
  return {
    type: "pluto.ai.fallback_invalid",
    severity: "error",
    timestamp: new Date().toISOString(),
    ...args,
  };
}

export function multicityDowngraded(args: FailureArgs): PlutoMetricEvent {
  return {
    type: "pluto.multicity.downgraded",
    severity: "warn",
    timestamp: new Date().toISOString(),
    ...args,
  };
}

// A reply was still thin AFTER the corrective substance retry and was accepted
// rather than failed (Step 3). warn so it always surfaces for prompt tuning.
export function replyThinAccepted(args: FailureArgs): PlutoMetricEvent {
  return {
    type: "pluto.reply.thin_accepted",
    severity: "warn",
    timestamp: new Date().toISOString(),
    ...args,
  };
}

// Conversation memory (Capstone) — a DB blip must not kill the turn; these
// surface the degradation. severity error so the sink always logs them.
export function memoryReadFailed(args: FailureArgs): PlutoMetricEvent {
  return { type: "pluto.memory.read_failed", severity: "error", timestamp: new Date().toISOString(), ...args };
}

export function memoryWriteFailed(args: FailureArgs): PlutoMetricEvent {
  return { type: "pluto.memory.write_failed", severity: "error", timestamp: new Date().toISOString(), ...args };
}

export function fareObsWriteFailed(args: FailureArgs): PlutoMetricEvent {
  return {
    type: "pluto.fareobs.write_failed",
    severity: "error",
    timestamp: new Date().toISOString(),
    ...args,
  };
}

// Watcher + notifier + weather (Phase 3). type is passed so a single helper
// covers the family; severity defaults to info unless overridden.
export function watchMetric(
  type:
    | "pluto.watch.checked"
    | "pluto.watch.alerted"
    | "pluto.watch.check_failed"
    | "pluto.watch.create_failed"
    | "pluto.notify.sent"
    | "pluto.notify.failed"
    | "pluto.weather.failed",
  args: FailureArgs = {},
  severity: "info" | "warn" | "error" = "info",
): PlutoMetricEvent {
  return { type, severity, timestamp: new Date().toISOString(), ...args };
}

// Arrival concierge (Phase 4). One helper for the whole pluto.arrive.* family;
// severity defaults to info unless overridden (greeting/escalation failures pass
// "error"; rate-limit passes "warn").
export function arriveMetric(
  type:
    | "pluto.arrive.session_opened"
    | "pluto.arrive.expired"
    | "pluto.arrive.message_handled"
    | "pluto.arrive.escalated"
    | "pluto.arrive.unknown_sender"
    | "pluto.arrive.greeting_failed"
    | "pluto.arrive.escalation_failed"
    | "pluto.arrive.rate_limited",
  args: FailureArgs = {},
  severity: "info" | "warn" | "error" = "info",
): PlutoMetricEvent {
  return { type, severity, timestamp: new Date().toISOString(), ...args };
}

export function handoffDelivered(args: FailureArgs): PlutoMetricEvent {
  return {
    type: "pluto.handoff.delivered",
    severity: "info",
    timestamp: new Date().toISOString(),
    ...args,
  };
}

export function handoffFailed(args: FailureArgs): PlutoMetricEvent {
  return {
    type: "pluto.handoff.failed",
    severity: "error",
    timestamp: new Date().toISOString(),
    ...args,
  };
}

export function policyEvaluated(args: {
  workspaceId?: string;
  requestId?: string;
  inPolicyCount: number;
  totalCount: number;
}): PlutoMetricEvent {
  return {
    type: "pluto.policy.evaluated",
    severity: "info",
    timestamp: new Date().toISOString(),
    workspaceId: args.workspaceId,
    requestId: args.requestId,
    metadata: { inPolicyCount: args.inPolicyCount, totalCount: args.totalCount },
  };
}

export function routeInsightsServed(args: {
  workspaceId?: string;
  requestId?: string;
  observationCount: number;
  sufficient: boolean;
}): PlutoMetricEvent {
  return {
    type: "pluto.routeinsights.served",
    severity: "info",
    timestamp: new Date().toISOString(),
    workspaceId: args.workspaceId,
    requestId: args.requestId,
    metadata: { observationCount: args.observationCount, sufficient: args.sufficient },
  };
}

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