// apps/backend/src/services/expenseClaimNaming.ts
//
// The claim's DISPLAY name — "<Category>: <what the employee typed>".
//
// The employee owns the descriptive half only ("Dubai Sept Trip"); the system
// owns the prefix and recomputes it from the bills the claim holds RIGHT NOW:
//
//   all bills one category → "Meals: Dubai Sept Trip"   (the real category name)
//   bills span >1 category → "Mixed: Dubai Sept Trip"
//   no bills yet           → "Dubai Sept Trip"
//
// Nothing is stored: `Report.name` keeps the descriptive text exactly as typed
// and the prefix is derived on every read, so it can never drift from the
// contents. Adding a second-category bill flips the prefix on the next read;
// removing it flips back.
//
// `stripSystemPrefix` makes that idempotent. A name may already carry a prefix —
// a claim renamed while the old behaviour was live, a WhatsApp-created claim, or
// simply an employee who typed "Meals: lunch" by hand — and prefixing again
// would give "Meals: Meals: lunch". The strip is deliberately narrow: it only
// removes a leading "<known category name>: " or "Mixed: ", so a descriptive
// name that merely contains a colon ("Q3: final push") is left alone.

const MIXED = "Mixed";

/** Remove a leading system-style prefix so re-prefixing is idempotent. */
export function stripSystemPrefix(name: string, knownCategoryNames: string[] = []): string {
  const raw = String(name ?? "").trim();
  const idx = raw.indexOf(":");
  if (idx <= 0) return raw;
  const head = raw.slice(0, idx).trim().toLowerCase();
  const rest = raw.slice(idx + 1).trim();
  if (!rest) return raw; // "Meals:" alone is the whole name the employee gave
  const known = new Set([MIXED.toLowerCase(), ...knownCategoryNames.map((n) => String(n).trim().toLowerCase())]);
  return known.has(head) ? rest : raw;
}

/**
 * The display name for a claim holding bills of `categoryNames` (the distinct
 * category names, in any order; unnamed/uncategorised bills contribute nothing).
 */
export function claimDisplayName(name: string, categoryNames: (string | null | undefined)[]): string {
  const distinct = [...new Set(categoryNames.map((n) => String(n ?? "").trim()).filter(Boolean))];
  const descriptive = stripSystemPrefix(name, distinct);
  if (distinct.length === 0) return descriptive;
  if (distinct.length === 1) return `${distinct[0]}: ${descriptive}`;
  return `${MIXED}: ${descriptive}`;
}

/** Attach `displayName` to a plain report object without touching `name`. */
export function withDisplayName<T extends { name?: string }>(report: T, categoryNames: (string | null | undefined)[]): T & { displayName: string } {
  return { ...report, displayName: claimDisplayName(String(report?.name ?? ""), categoryNames) };
}
