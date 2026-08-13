// apps/backend/src/utils/visaDocumentTypeResolver.ts
//
// Phase 10a compatibility bridge — resolves a docCode in EITHER form (an
// old "DOC-01" style code still sitting in every pre-migration
// VisaApplication.ruleSnapshot.documentRequirements[] row, or a new
// semantic code like "PASSPORT_ORIGINAL") back to a document-type
// definition, without ever rewriting the stored value. ruleSnapshot is
// immutable history (models/VisaApplication.ts's file header) — ANY
// existing application's snapshot, migrated or not, must keep resolving
// through here exactly as it did before this phase.
//
// resolveVisaDocumentRequirements is the one most relevant to "old-shape
// snapshot rendering": pure and synchronous (catalogue lookup only, no DB
// round trip), safe to call from a hot response-shaping path the same way
// routes/visa.ts's own hydrateDocumentRequirements() does today.
// resolveVisaDocumentType additionally checks the live VisaDocumentType
// collection first (the DB is the source of truth going forward; the
// static catalogue is the fallback for a type not yet seeded there).
import VisaDocumentType from "../models/VisaDocumentType.js";
import {
  canonicalizeVisaDocumentCode,
  getVisaDocumentTypeSeed,
  type VisaDocumentTypeCategory,
} from "../config/visaDocumentTypeCatalogue.js";

export interface ResolvedVisaDocumentType {
  code: string; // canonical (new) semantic code
  name: string;
  category: VisaDocumentTypeCategory;
  defaultDescription: string;
  ocrExtractable: boolean;
  queriedCode: string; // whatever code (old or new) the caller actually passed in
}

export async function resolveVisaDocumentType(code: string): Promise<ResolvedVisaDocumentType | null> {
  const canonical = canonicalizeVisaDocumentCode(code);

  const dbHit = await VisaDocumentType.findOne({ $or: [{ code: canonical }, { legacyCode: code }] }).lean();
  if (dbHit) {
    return {
      code: dbHit.code,
      name: dbHit.name,
      category: dbHit.category,
      defaultDescription: dbHit.defaultDescription,
      ocrExtractable: dbHit.ocrExtractable,
      queriedCode: code,
    };
  }

  const seed = getVisaDocumentTypeSeed(canonical);
  if (!seed) return null;
  return {
    code: seed.code,
    name: seed.name,
    category: seed.category,
    defaultDescription: seed.defaultDescription,
    ocrExtractable: seed.ocrExtractable,
    queriedCode: code,
  };
}

export interface LegacyDocumentRequirementLike {
  docCode: string;
  requirement: string;
  condition?: string;
}

export interface HydratedLegacyDocumentRequirement extends LegacyDocumentRequirementLike {
  resolvedCode: string | null; // canonical semantic code, or null if totally unknown
  resolvedName: string; // falls back to the raw docCode so a stale/unknown code never disappears from the UI
  resolvedCategory: VisaDocumentTypeCategory | null;
  resolvedDescription: string | null;
}

/**
 * Synchronous, catalogue-only hydration of an OLD-SHAPE (or new-shape)
 * VisaRule.documentRequirements / VisaApplication.ruleSnapshot.documentRequirements
 * array — never touches the DB, never mutates the input. An unknown docCode
 * (neither a legacy nor a semantic match) degrades to the raw code as its
 * own display name rather than throwing or dropping the row — a console
 * rendering an old snapshot must never orphan a requirement it doesn't
 * recognise.
 */
export function resolveVisaDocumentRequirements(
  requirements: LegacyDocumentRequirementLike[] | null | undefined,
): HydratedLegacyDocumentRequirement[] {
  return (requirements || []).map((r) => {
    const canonical = canonicalizeVisaDocumentCode(r.docCode);
    const seed = getVisaDocumentTypeSeed(canonical);
    return {
      ...r,
      resolvedCode: seed?.code ?? null,
      resolvedName: seed?.name ?? r.docCode,
      resolvedCategory: seed?.category ?? null,
      resolvedDescription: seed?.defaultDescription ?? null,
    };
  });
}
