// Add 'export' to the type definition
export type PlutoIntent = "DISCOVERY" | "PLANNING" | "REFINEMENT" | "PIVOT";

/**
 * GATE 2 of 2 on the SAME prompt text a fresh conversation's message has to
 * clear on the frontend first (see hasPlanningIntent, apps/frontend/src/
 * pages/concierge/ConciergePage.tsx) — and this one runs in the opposite
 * direction. Frontend gate: must MATCH a planning-ish pattern or the message
 * never reaches this function at all (short-circuited to a canned reply).
 * This gate: the prompt must NOT contain "itinerary" or "plan" — a plain,
 * case-insensitive SUBSTRING match, not a whole-word one — or the
 * conversation jumps straight into PLANNING state (resolvePlutoState,
 * plutoStateResolver.ts) and the reply drafts a full day-by-day itinerary
 * immediately, however little the conversation actually knows (PLANNING's
 * own "always give value / draft skeleton" rule — see the state-graduation
 * comment in routes/copilot.travel.ts). Confirmed live: a place-naming
 * prompt with those two words drafted a full itinerary on the very first
 * turn; the same prompt with "recommend"/"visit" instead stayed DISCOVERY.
 *
 * Being a raw substring match also means it's not word-bounded: any prompt
 * containing "plan" as part of a LONGER word — e.g. a place named "Plano"
 * — matches too. Composing a prefilled message anywhere in the app means
 * checking it against BOTH gates, not just this one.
 */
export function classifyPlutoIntent(prompt: string): PlutoIntent {
  const text = prompt.toLowerCase();

  const pivotKeywords = ["instead", "actually", "change to", "forget", "nevermind"];
  if (pivotKeywords.some(k => text.includes(k))) return "PIVOT";

  if (text.includes("itinerary") || text.includes("plan")) return "PLANNING";
  if (text.includes("add") || text.includes("update")) return "REFINEMENT";

  return "DISCOVERY";
}