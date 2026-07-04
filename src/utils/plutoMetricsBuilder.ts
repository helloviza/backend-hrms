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