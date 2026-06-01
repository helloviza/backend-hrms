import mongoose from "mongoose";
import CRMCompany from "../models/CRMCompany.js";

/**
 * Canonical company-name normalization: trim, collapse internal whitespace to a
 * single space, lowercase. This is the dedupe key (CRMCompany.nameNormalized)
 * and the only thing resolve-or-create matches on.
 */
export function normalizeCompanyName(s: string): string {
  return String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
}

export interface ResolveCompanyInput {
  name: string;
  industry?: string;
  companySize?: string;
  /** Maps to CRMCompany.city (the schema has no `location` field). */
  location?: string;
  website?: string;
  /** Accepted for caller symmetry; CRMCompany has no gstin field, not persisted. */
  gstin?: string;
}

/**
 * Resolve a CRMCompany by normalized name, creating it if absent. Atomic upsert
 * keyed on nameNormalized — this replaces the case-insensitive `name` regex that
 * /win and /convert used (and kills the /win regex-injection bug: no regex here).
 *
 * $setOnInsert ONLY: an existing company's attributes are NEVER overwritten by a
 * later lead's values. Seed attributes only populate a freshly-created company.
 *
 * HOUSE-scoped: CRMCompany is a global HOUSE-only collection with no workspaceId —
 * callers must never use this to write across workspaces.
 *
 * Returns the company doc, or null when the name normalizes to empty.
 *
 * NOTE: nameNormalized is non-unique until the migration's --apply builds the
 * unique index. Until then two truly-concurrent upserts for the same name could
 * race into duplicates; the unique index closes that window.
 */
export async function resolveOrCreateCompany(
  input: ResolveCompanyInput,
  createdBy?: mongoose.Types.ObjectId
): Promise<any | null> {
  const name = String(input.name || "").trim();
  const nameNormalized = normalizeCompanyName(name);
  if (!nameNormalized) return null;

  const company = await CRMCompany.findOneAndUpdate(
    { nameNormalized },
    {
      $setOnInsert: {
        name,
        nameNormalized,
        industry: input.industry || "",
        companySize: input.companySize || "",
        city: input.location || "",
        website: input.website || "",
        createdBy,
        isPrivate: false,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return company;
}
