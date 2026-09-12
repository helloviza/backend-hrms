// apps/backend/src/utils/companyName.ts
//
// THE company-name dedupe key. One function, one module, no imports — so the
// CRMCompany model (pre-validate hook), utils/crmCompany.ts (lead-side
// resolve-or-create), routes/crm.companies.ts (manual create / rename) and the
// backfill script all derive `nameNormalized` from exactly the same rule.
//
// Lives in its own leaf module rather than in crmCompany.ts because the model
// needs it and crmCompany.ts imports the model — putting the key here breaks
// that cycle. crmCompany.ts re-exports it so existing imports keep working.
//
// Rule: trim → collapse internal whitespace to one space → lowercase.
// Punctuation is deliberately KEPT ("acme.com" ≠ "acme") — collapsing legal
// suffixes / punctuation is a human-approved alias decision, not a key rule
// (see ALIAS_MAP in scripts/backfill-lead-companyId.ts).
//
// The prod unique index on crmcompanies.nameNormalized is PARTIAL over
// non-empty strings, so "" (the schema default for rows written before this
// key was set on every path) never collides.

export function normalizeCompanyName(s: unknown): string {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}
