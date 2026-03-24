// apps/backend/src/types/plutoDelta.ts

import type { PlutoReplyV1 } from "./pluto.js";

/**
 * Delta reply: partial Pluto reply with mandatory handoff flag
 */
export type PlutoDeltaReply =
  Partial<Omit<PlutoReplyV1, "handoff">> & {
    handoff: boolean;
  };