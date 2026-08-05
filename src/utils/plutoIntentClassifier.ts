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
 * EVERY keyword below is WORD-BOUNDED (\b...\b), not a raw substring match —
 * plain .includes() used to fire on any word that happens to CONTAIN a
 * keyword, not just the keyword itself. Confirmed real collisions (2026-08
 * audit), all fixed here:
 *   - "plan"      ⊂ "Plano", "plane"/"airplane", "planet"
 *   - "add"       ⊂ "address", "additional"       — the urgent one: both are
 *                   constant in travel copy ("what's the hotel's address?"),
 *                   so this was misclassifying REFINEMENT on ordinary
 *                   questions.
 *   - "change to" ⊂ "exchange to"
 *   - "forget"    ⊂ "unforgettable"
 * "itinerary", "update", "instead", "actually", "nevermind" have no known
 * real-world collision but are bounded too, for the same reason and at the
 * same cost: cheap insurance against a future false positive, not a fix for
 * anything currently broken.
 *
 * Each bound keyword still matches its ordinary inflected forms — "add"
 * matches add/adds/adding/added, "plan" matches plan/plans/planning/
 * planned, "forget" matches forget/forgetting — so this narrows FALSE
 * positives (a keyword embedded in an unrelated longer word) without
 * narrowing genuine matches the old substring check already caught.
 */
export function classifyPlutoIntent(prompt: string): PlutoIntent {
  const text = prompt.toLowerCase();

  const PIVOT_RE = /\binstead\b|\bactually\b|\bchange to\b|\bforget(?:ting)?\b|\bnevermind\b/;
  if (PIVOT_RE.test(text)) return "PIVOT";

  if (/\bitinerary\b|\bplan(?:s|ning|ned)?\b/.test(text)) return "PLANNING";

  const REFINEMENT_RE = /\badd(?:s|ing|ed)?\b|\bupdate(?:s|d|ing)?\b/;
  if (REFINEMENT_RE.test(text)) return "REFINEMENT";

  return "DISCOVERY";
}