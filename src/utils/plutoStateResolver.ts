import type { PlutoConversationState } from "../types/plutoConversationState.js";

// 1. Added PIVOT intent
export type PlutoIntent = "DISCOVERY" | "PLANNING" | "REFINEMENT" | "PIVOT";

export function resolvePlutoState(
  currentState: PlutoConversationState,
  intent: PlutoIntent
): PlutoConversationState {
  // If user pivots (changes destination/core idea), always reset to DISCOVERY
  if (intent === "PIVOT") {
    return "DISCOVERY";
  }

  if (currentState === "DISCOVERY" && intent === "PLANNING") {
    return "PLANNING";
  }

  // Allow movement from PLANNING to EXECUTION if intent is high-commitment
  // (You can expand this logic as needed)

  return currentState;
}