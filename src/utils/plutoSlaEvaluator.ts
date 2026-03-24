// apps/backend/src/utils/plutoSlaEvaluator.ts

import type { PlutoTripType } from "../types/pluto.js";
import type { PlutoPriority } from "../types/plutoHandoff.js";

export function evaluateSla(tripType: PlutoTripType): {
  priority: PlutoPriority;
  targetSLA: string;
  reason: string;
} {
  switch (tripType) {
    case "business":
      return {
        priority: "P0",
        targetSLA: "15 minutes",
        reason: "Business travel is time-critical",
      };

    case "mice":
      return {
        priority: "P0",
        targetSLA: "30 minutes",
        reason: "MICE trips involve multiple stakeholders",
      };

    case "event":
      return {
        priority: "P1",
        targetSLA: "1 hour",
        reason: "Event coordination requires timely follow-up",
      };

    case "holiday":
    default:
      return {
        priority: "P2",
        targetSLA: "4 hours",
        reason: "Leisure travel is flexible",
      };
  }
}