// Post-AI guardrails (state v2 S3, design §4.1 and §4.3). PURE.
//
//   claimsResultsWithoutCards  "These hotel options balance comfort…" when the
//                              reply carries no cards (C2-guard)
//   stripClaimSentences        removes those sentences
//   staleDestinationIn         a reply about a city the user has left (E3)
//   replaceStaleDestination    rebuilds the title / drops the stale sentences

const CLAIM_RX =
  /\b(?:these|the\s+following|here\s+are|below\s+are|i(?:'ve|\s+have)\s+(?:found|shortlisted|picked|pulled)|i\s+found)\b[^.!?]{0,40}\b(?:hotels?|options?|flights?|properties|stays?|fares?|rooms?)\b/i;

export function hasCards(reply: any): boolean {
  return Boolean(reply?.flightSearch?.flights?.length || reply?.hotelSearch?.hotels?.length);
}

function sentences(text: string): string[] {
  return String(text || "").match(/[^.!?\n]+(?:[.!?]+(?=\s|$)|[.!?]*$)|\n+/g) || [];
}

export function claimsResultsWithoutCards(reply: any): boolean {
  if (hasCards(reply)) return false;
  return CLAIM_RX.test(String(reply?.title || "")) || CLAIM_RX.test(String(reply?.context || ""));
}

export function stripClaimSentences(text: string): string {
  return sentences(text)
    .filter((s) => !CLAIM_RX.test(s))
    .join("")
    .replace(/^\s+/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (name: string) => new RegExp(String.raw`\b${esc(name)}\b`, "i");
const cityOf = (s: string) => String(s || "").split(",")[0].trim();

/**
 * The previous destination a reply talks about, when it does so and does not
 * name the current one in the same field. null when the reply is clean.
 */
export function staleDestinationIn(reply: any, previous: string[], current: string | null | undefined): string | null {
  const cur = cityOf(current || "");
  if (!cur || !Array.isArray(previous) || !previous.length) return null;
  for (const raw of previous) {
    const old = cityOf(raw);
    if (!old || old.toLowerCase() === cur.toLowerCase()) continue;
    for (const field of [reply?.title, reply?.context]) {
      const t = String(field || "");
      if (word(old).test(t) && !word(cur).test(t)) return old;
    }
  }
  return null;
}

/**
 * Rebuilt in code after the retry also failed: the title gets the current
 * city in place of the old one ("Must-See Places in Dubai" → "… in
 * Singapore"), and context sentences naming only the old city are dropped.
 */
export function replaceStaleDestination(reply: any, old: string, current: string): void {
  const cur = cityOf(current);
  if (reply?.title && word(old).test(reply.title)) {
    reply.title = String(reply.title).replace(new RegExp(String.raw`\b${esc(old)}\b`, "gi"), cur);
  }
  if (reply?.context && word(old).test(reply.context)) {
    const kept = sentences(reply.context).filter((s) => !word(old).test(s) || word(cur).test(s));
    reply.context = kept.join("").replace(/^\s+/, "").trim();
  }
}

/** Corrective instruction for the one retry (design §4.3). */
export function staleDestinationRetry(old: string, current: string): string {
  return `\nCORRECTION: The traveller's destination is now ${cityOf(current)}. They are no longer going to ${old}. ` +
    `Answer ONLY about ${cityOf(current)} — do not mention ${old} anywhere in "title" or "context". Return ONLY the JSON object.\n`;
}

export function claimsRetry(): string {
  return `\nCORRECTION: This reply carries NO live hotel or flight results. Do not say "these options", "here are", ` +
    `"I found" or anything that presents results. Give guidance only; live results come from a search the user can start. Return ONLY the JSON object.\n`;
}
