/**
 * Shared query-param coercion for the admin list/export filter builders.
 *
 * Lives here rather than in either route file because the bookings and
 * invoices filters now share the same conventions (see the table in
 * infra/audit/manual-bookings-invoices-filter-audit.md §D3) and two
 * hand-copied versions of "parse a CSV of enum values" would drift.
 */

/**
 * CSV multi-select → a Mongo equality or `$in`, validated against an enum.
 *
 * RETURN CONTRACT — three distinct outcomes, and the difference matters:
 *
 *   undefined      the caller supplied nothing. Do not add a clause at all.
 *   {$in: []}      the caller supplied ONLY values outside the enum. Match
 *                  nothing. This is deliberate and is NOT the same as "no
 *                  filter": a request for status=BOGUS must return zero rows,
 *                  not every row. It also preserves the pre-existing
 *                  behaviour of the dead `DONE` option, which exact-matched
 *                  a non-enum value and returned nothing.
 *   value / {$in}  one or more valid values.
 *
 * Unknown values inside an otherwise-valid list are dropped silently, so
 * `status=PAID,BOGUS` behaves as `status=PAID` — a stale bookmark or an
 * option removed from the UI degrades instead of erroring.
 *
 * A single value returns a bare scalar rather than a one-element `$in` so the
 * planner sees the same shape it always has for the single-select case, and
 * so existing compound indexes keyed on equality are unaffected.
 */
export function enumFilter<T extends string>(
  raw: unknown,
  allowed: readonly T[],
): T | { $in: T[] } | undefined {
  if (raw === undefined || raw === null) return undefined;
  const parts = String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return undefined;

  const allowedSet = new Set<string>(allowed as readonly string[]);
  const valid = [...new Set(parts.filter((p) => allowedSet.has(p)))] as T[];

  if (valid.length === 0) return { $in: [] };
  if (valid.length === 1) return valid[0];
  return { $in: valid };
}

/**
 * Picks one of a fixed set of field names from user input, falling back to a
 * default. For params that choose WHICH FIELD to filter on (invoices'
 * `dateField`), where passing the raw string through would let a caller
 * redirect the query at any field in the document.
 */
export function whitelistField<T extends string>(
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const v = String(raw ?? "").trim();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}
