// apps/backend/src/config/navGroups.ts
//
// Per-user "visible menu groups" (docs/audits/nav-visible-groups-audit.md).
//
// A DISPLAY preference, not a security control. User.visibleNavGroups only
// trims which Header groups a person sees; every backend permission gate is
// untouched and every direct URL keeps working. null / missing / [] = no
// change.
//
// The ONLY list of allowed keys on the server. The frontend mirrors it in
// components/layout/navVisibleGroups.ts; navGroups.parity.test.ts fails if the
// two drift.
export const NAV_GROUP_KEYS = [
  "travelAnalytics", // synthetic head: /dashboard/travel-spend
  "travelbox",       // Header id "bookings"  (Travelbox.ai)
  "spendbox",        // Header id "expenses"  (Spendbox.ai)
  "helloviza",       // Header id "visa"      (Helloviza.ai)
  "workspace",
  "approvals",
  "vendor",          // Header id "atelier"
  "travelClaims",    // Header id "cstep"
  "mySpace",         // Header id "me"
  "learningHub",     // Header id "learning"
  "peopleCulture",   // Header id "people-culture"
  "visaConsole",     // Header id "visa-admin"
  "bookingsOps",     // Header id "bookings-billing"
  "crm",
  "admin",
  "control",         // App.tsx "⚙ CONTROL" second row
] as const;

export type NavGroupKey = (typeof NAV_GROUP_KEYS)[number];

const KEY_SET = new Set<string>(NAV_GROUP_KEYS);

export type NavGroupsParse =
  | { ok: true; value: NavGroupKey[] | null }
  | { ok: false; error: string; unknown?: string[] };

/**
 * Validates an incoming value. null / undefined / [] → null (clear). Otherwise
 * an array of known keys; duplicates are dropped, first occurrence wins, and
 * order is kept (the first key is the landing group).
 */
export function parseVisibleNavGroups(input: unknown): NavGroupsParse {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (!Array.isArray(input)) return { ok: false, error: "visibleNavGroups must be an array of keys or null" };
  if (input.some((k) => typeof k !== "string")) return { ok: false, error: "visibleNavGroups must contain strings only" };
  const keys = (input as string[]).map((k) => k.trim());
  const unknown = keys.filter((k) => !KEY_SET.has(k));
  if (unknown.length) return { ok: false, error: `Unknown nav group key(s): ${unknown.join(", ")}`, unknown };
  const out: NavGroupKey[] = [];
  for (const k of keys) if (!out.includes(k as NavGroupKey)) out.push(k as NavGroupKey);
  return { ok: true, value: out.length ? out : null };
}

/** The stored value as the API reports it: a non-empty array, or null. */
export function normalizeStoredNavGroups(stored: unknown): string[] | null {
  return Array.isArray(stored) && stored.length ? stored.map(String) : null;
}
