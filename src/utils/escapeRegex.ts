/**
 * Escapes every regex metacharacter in a user-supplied string so it can be
 * embedded in a `new RegExp(...)` as a literal.
 *
 * Moved here verbatim from routes/customerUsers.ts (where it was a module-local
 * helper) so a second consumer — the invoice-number search in routes/invoices.ts
 * — can share the one definition rather than importing a 3000-line router module
 * for a one-liner, or growing a second copy that drifts from this one.
 *
 * Why it matters beyond tidiness: an unescaped user string passed to `new RegExp`
 * throws on input as ordinary as "(" — which surfaces as an HTTP 500 on a search
 * box — and treats input like ".*" as a pattern rather than as text.
 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default escapeRegex;
