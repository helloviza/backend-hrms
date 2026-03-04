// apps/backend/src/utils/plutoDebugBuilder.ts

import type { PlutoDeltaReply } from "../types/plutoDelta.js";
import type { PlutoConversationState } from "../types/plutoConversationState.js";

export function buildDebugSnapshot(input: {
  prompt: string;
  intent: string;

  stateBefore: PlutoConversationState;
  stateAfter: PlutoConversationState;

  lockedBefore: Record<string, any>;
  lockedAfter: Record<string, any>;

  fullReply: PlutoDeltaReply;
  deltaReply: Partial<PlutoDeltaReply>;

  handoff: boolean;
}) {
  return {
    timestamp: new Date().toISOString(),
    ...input,
  };
}