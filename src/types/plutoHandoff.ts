// apps/backend/src/types/plutoHandoff.ts

import type { PlutoTripType } from "./pluto.js";

export type PlutoPriority = "P0" | "P1" | "P2";

export interface PlutoHandoffPayload {
  source: "pluto.ai";
  timestamp: string;

  tripType: PlutoTripType;
  destination?: string;

  itineraryLocked: boolean;
  hotels?: string[];

  state: string;

  summary: string;
  nextSteps: string[];

  // SLA intelligence (Fix #7)
  priority: PlutoPriority;
  targetSLA: string; // human-readable, e.g. "15 minutes"
  slaReason: string;

  lockedDecisions: Record<string, any>;
}