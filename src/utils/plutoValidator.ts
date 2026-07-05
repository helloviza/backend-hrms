// apps/backend/src/utils/plutoValidator.ts

import type { PlutoReplyV1 } from "../types/pluto.js";
import type { PlutoConversationState } from "../types/plutoConversationState.js";

/**
 * Shape validator for Pluto.ai responses
 *
 * Design principles:
 * - DELTA-SAFE
 * - STATE-AGNOSTIC
 * - FRONTEND-SAFE
 *
 * This validator accepts PARTIAL replies.
 */
export function isValidPlutoReply(obj: unknown): obj is Partial<PlutoReplyV1> {
  if (!obj || typeof obj !== "object") return false;

  const r = obj as any;

  /**
   * handoff MUST always exist and be boolean
   */
  if (typeof r.handoff !== "boolean") {
    return false;
  }

  /**
   * At least ONE meaningful field must exist
   * (prevents empty {} responses)
   */
  const hasContent =
    typeof r.title === "string" ||
    typeof r.context === "string" ||
    typeof r.tripType === "string" ||
    Array.isArray(r.itinerary) ||
    Array.isArray(r.hotels) ||
    Array.isArray(r.nextSteps);

  if (!hasContent) {
    return false;
  }

  /**
   * tripType (if present)
   */
  if (r.tripType !== undefined) {
    const allowedTripTypes = ["business", "holiday", "mice", "event"];
    if (!allowedTripTypes.includes(r.tripType)) {
      return false;
    }
  }

  /**
   * itinerary (if present)
   */
  if (r.itinerary !== undefined) {
    if (!Array.isArray(r.itinerary) || r.itinerary.length === 0) return false;

    for (const day of r.itinerary) {
      if (
        typeof day.day !== "number" ||
        typeof day.heading !== "string" ||
        !Array.isArray(day.details) ||
        day.details.length === 0
      ) {
        return false;
      }

      for (const d of day.details) {
        if (typeof d !== "string") return false;
      }
    }
  }

  /**
   * hotels (if present)
   */
  if (r.hotels !== undefined) {
    if (!Array.isArray(r.hotels)) return false;

    for (const h of r.hotels) {
      if (
        typeof h.name !== "string" ||
        typeof h.area !== "string" ||
        typeof h.approxPrice !== "string" ||
        typeof h.whyGood !== "string"
      ) {
        return false;
      }
    }
  }

  /**
   * nextSteps (if present)
   */
  if (r.nextSteps !== undefined) {
    if (!Array.isArray(r.nextSteps) || r.nextSteps.length === 0) return false;

    for (const step of r.nextSteps) {
      if (typeof step !== "string") return false;
    }
  }

  return true;
}

/**
 * SUBSTANCE check (not schema). A reply is "thin" when the trip is already
 * plannable (destination + duration known — the CALLER decides that and only
 * then applies this) yet the model returned no draft itinerary OR a context that
 * is not real prose (a bare place name / single fragment instead of 2–3
 * sentences). Used by the invoke loop to trigger ONE corrective retry.
 */
export function isThinReply(reply: Partial<PlutoReplyV1>): boolean {
  const hasItinerary = Array.isArray(reply.itinerary) && reply.itinerary.length > 0;
  const ctx = typeof reply.context === "string" ? reply.context.trim() : "";
  // Count sentence terminators as a cheap proxy for "2–3 sentences".
  const sentences = (ctx.match(/[.!?](\s|$)/g) || []).length;
  const substantiveContext = ctx.length >= 40 && sentences >= 2;
  return !hasItinerary || !substantiveContext;
}

// Locked facts (with their values) that a reply must NOT re-ask. Defined here
// (not in plutoInvoke) so both the invoke loop and this validator can share it
// without an import cycle.
export interface LockedFactsForReask {
  destination?: string;
  dates?: string;
  origin?: string;
  duration?: string;
}

// Per-fact "you're re-asking me" patterns — cover both interrogatives and the
// observed "I need to know your travel destination first" phrasing. Kept fairly
// tight; a false positive only costs ONE corrective retry (never an error).
const REASK_PATTERNS: Record<keyof LockedFactsForReask, RegExp> = {
  destination: /need to know your (?:travel )?destination|your (?:travel )?destination\b|where (?:are|would|do) you (?:going|travel(?:l)?ing|head)|which (?:city|destination)\b|where would you like to (?:go|stay|travel)/i,
  dates: /need to know your (?:travel )?dates|your travel dates|what (?:are your|dates)|which dates|when (?:are|would|do|will) you (?:travel|go|arrive|check)|when would you like/i,
  origin: /where are you (?:flying|departing|travel(?:l)?ing|coming) from|which city are you (?:flying|departing) from|your (?:departure|origin) (?:city|airport)/i,
  duration: /how (?:long|many nights|many days)|trip (?:length|duration)|how many (?:nights|days)/i,
};

/**
 * Detects when a reply asks the user for a fact that is ALREADY locked. Only
 * facts present in `locked` are checked (against the reply's context +
 * nextSteps). Used by the invoke loop to trigger ONE corrective retry.
 */
export function isReaskedLockedReply(
  reply: Partial<PlutoReplyV1>,
  locked: LockedFactsForReask | null | undefined
): boolean {
  if (!locked) return false;
  const parts: string[] = [];
  if (typeof reply.context === "string") parts.push(reply.context);
  if (Array.isArray(reply.nextSteps)) {
    for (const s of reply.nextSteps) if (typeof s === "string") parts.push(s);
  }
  const blob = parts.join(" \n ");
  if (!blob.trim()) return false;
  for (const fact of ["destination", "dates", "origin", "duration"] as const) {
    if (locked[fact] && REASK_PATTERNS[fact].test(blob)) return true;
  }
  return false;
}

/**
 * State-aware validator
 *
 * Enforces conversation discipline WITHOUT schema rigidity.
 */
export function validatePlutoReplyForState(
  reply: Partial<PlutoReplyV1>,
  state: PlutoConversationState
): void {
  // DISCOVERY must never contain itineraries
  if (state === "DISCOVERY" && reply.itinerary) {
    throw new Error(
      "Invalid Pluto response: itinerary not allowed in DISCOVERY state"
    );
  }

  // HANDOFF should not introduce new planning
  if (state === "HANDOFF" && reply.itinerary) {
    throw new Error(
      "Invalid Pluto response: itinerary not allowed in HANDOFF state"
    );
  }
}