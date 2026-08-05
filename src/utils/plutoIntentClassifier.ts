// Add 'export' to the type definition
export type PlutoIntent = "DISCOVERY" | "PLANNING" | "REFINEMENT" | "PIVOT";

/**
 * GATE 2 of 2 on the SAME prompt text a fresh conversation's message has to
 * clear on the frontend first (see hasPlanningIntent, apps/frontend/src/
 * pages/concierge/ConciergePage.tsx) — and this one runs in the opposite
 * direction. Frontend gate: must MATCH a planning-ish pattern or the message
 * never reaches this function at all (short-circuited to a canned reply).
 * This gate: the prompt must NOT contain "itinerary" or the word "plan"
 * (in any of its plan/plans/planning/planned forms) — or the conversation
 * jumps straight into PLANNING state (resolvePlutoState,
 * plutoStateResolver.ts) and the reply drafts a full day-by-day itinerary
 * immediately, however little the conversation actually knows (PLANNING's
 * own "always give value / draft skeleton" rule — see the state-graduation
 * comment in routes/copilot.travel.ts). Confirmed live: a place-naming
 * prompt with those two words drafted a full itinerary on the very first
 * turn; the same prompt with "recommend"/"visit" instead stayed DISCOVERY.
 *
 * The "plan" check is WORD-BOUNDED (\b...\b), not a raw substring match —
 * text.includes("plan") used to fire on "Hotels in Plano, Texas" and on any
 * mention of a "plane"/"airplane"/"planet", none of which are planning
 * intent. "itinerary" is bounded too for the same reason, though no real
 * collision is known for it. The OTHER keywords below (pivotKeywords,
 * "add"/"update") are still plain substring matches and were NOT audited/
 * fixed here — see the 2026-08 intent-gate audit for known collisions on
 * those ("add" ⊂ "address"/"additional", "change to" ⊂ "exchange to",
 * "forget" ⊂ "unforgettable") that a future pass should word-bound too.
 */
export function classifyPlutoIntent(prompt: string): PlutoIntent {
  const text = prompt.toLowerCase();

  const pivotKeywords = ["instead", "actually", "change to", "forget", "nevermind"];
  if (pivotKeywords.some(k => text.includes(k))) return "PIVOT";

  if (/\bitinerary\b|\bplan(?:s|ning|ned)?\b/.test(text)) return "PLANNING";
  if (text.includes("add") || text.includes("update")) return "REFINEMENT";

  return "DISCOVERY";
}