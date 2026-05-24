// apps/backend/src/utils/plutoIntentGuard.ts

import type { PlutoReplyV1 } from "../types/pluto.js";

/**
 * HR / payroll / admin terms that signal a message may be off-domain.
 * NOTE: matched as WHOLE WORDS (\bword\b), never as substrings — otherwise
 * "hr" would match inside "Bahrain"/"through", "leave" inside travel phrasing, etc.
 */
const BLOCKED_KEYWORDS = [
  "salary",
  "payroll",
  "leave",
  "attendance",
  "hr",
  "policy",
  "employee",
  "admin",
  "approval",
  "timesheet",
];

/**
 * Travel signals. If ANY of these appears, the message is treated as a
 * legitimate travel question even when it also contains a blocked keyword
 * (e.g. "when should I LEAVE for the airport", "baggage POLICY",
 * "trip APPROVAL"). This is the guard against false-positive redirects.
 */
const TRAVEL_SIGNALS = [
  "travel", "trip", "trips", "tour", "tours", "journey",
  "flight", "flights", "fly", "flying", "flew", "airline", "airlines",
  "airport", "airfare", "fare", "ticket", "tickets", "booking", "book",
  "hotel", "hotels", "resort", "resorts", "stay", "accommodation", "lodging",
  "holiday", "holidays", "vacation", "getaway", "honeymoon",
  "itinerary", "destination", "destinations", "city", "country",
  "baggage", "luggage", "visa", "passport", "boarding", "check-in", "checkin",
  "departure", "arrival", "layover", "transit", "lounge", "cabin", "seat",
  "mice", "event", "events", "conference", "offsite", "off-site", "summit",
  "cruise", "beach", "sightseeing", "excursion", "package", "weekend",
];

const hasWholeWord = (lower: string, word: string): boolean => {
  // Escape regex specials in the keyword, then bound it on word boundaries.
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(lower);
};

/**
 * Returns true ONLY when the message is genuinely off-domain:
 * it contains an HR/payroll/admin keyword (whole word) AND carries no
 * travel signal at all. A travel question that merely mentions a flagged
 * word (e.g. "leave for the airport") returns false.
 */
export function isOffDomainQuery(prompt: string): boolean {
  const lower = prompt.toLowerCase();

  const hasBlocked = BLOCKED_KEYWORDS.some((w) => hasWholeWord(lower, w));
  if (!hasBlocked) return false;

  const hasTravelSignal = TRAVEL_SIGNALS.some((w) => hasWholeWord(lower, w));
  return !hasTravelSignal;
}

/**
 * Polite, non-throwing redirect rendered by the frontend exactly like any
 * other Pluto reply (title / context / nextSteps). Returned with HTTP 200 so
 * an off-domain question never produces a 500 / page error.
 */
export function buildOffDomainRedirect(): PlutoReplyV1 {
  return {
    title: "I'm your travel concierge",
    context:
      "I handle travel, holidays, business trips, MICE & events. For HR, payroll, " +
      "leave, attendance or admin matters, please use your HRMS dashboard. " +
      "Is there anything travel-related I can help you with?",
    tripType: "business",
    nextSteps: [
      "Plan a business trip",
      "Find flights or hotels",
      "Build an itinerary",
    ],
    handoff: false,
  };
}
