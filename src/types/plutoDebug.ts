// apps/backend/src/types/plutoDebug.ts

import type { PlutoConversationState } from "./plutoConversationState.js";
import type { PlutoReplyV1 } from "./pluto.js";

export interface PlutoDebugSnapshot {
  timestamp: string;
  prompt: string;

  intent: string;

  state: {
    before: PlutoConversationState;
    after: PlutoConversationState;
  };

  locked: {
    before: Record<string, any>;
    after: Record<string, any>;
  };

  reply: {
    full: PlutoReplyV1;
    delta: Partial<PlutoReplyV1>;
  };

  handoff: boolean;
}