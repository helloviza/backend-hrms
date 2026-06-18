// apps/backend/src/utils/categoryMatch.ts
//
// Server-side mirror of the web CategorySelect fuzzy matcher
// (apps/frontend/src/pages/expenses/CategorySelect.tsx). Keeping the algorithm
// identical means a WhatsApp capture lands on the SAME managed category the web
// reviewer would have been shown for a given AI hint.

export type CategoryLike = { _id: unknown; name: string };

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/**
 * Pick the category whose name best matches a free-text suggestion.
 * Strategy (case-insensitive): exact → substring (either direction) → max token
 * overlap. Returns the category _id as a string, or null when nothing overlaps.
 */
export function fuzzyMatchCategory(
  suggestion: string | null | undefined,
  categories: CategoryLike[],
): string | null {
  const s = String(suggestion || "").trim().toLowerCase();
  if (!s || categories.length === 0) return null;

  // 1. exact
  const exact = categories.find((c) => c.name.trim().toLowerCase() === s);
  if (exact) return String(exact._id);

  // 2. substring either direction
  const contains = categories.find((c) => {
    const n = c.name.trim().toLowerCase();
    return n.includes(s) || s.includes(n);
  });
  if (contains) return String(contains._id);

  // 3. token overlap
  const sTokens = new Set(tokens(s));
  let best: { id: string; score: number } | null = null;
  for (const c of categories) {
    const overlap = tokens(c.name).filter((t) => sTokens.has(t)).length;
    if (overlap > 0 && (!best || overlap > best.score)) {
      best = { id: String(c._id), score: overlap };
    }
  }
  return best?.id ?? null;
}
