// apps/backend/src/config/visaDocumentCodes.ts
//
// Phase 10a — this file is now a COMPATIBILITY SHIM, derived from
// config/visaDocumentTypeCatalogue.ts (the real, single source of truth for
// the document-type catalogue — see that file's header for the full
// rationale). It exists only because routes/admin.visa.rules.ts and
// routes/visa.ts import VISA_DOCUMENT_CODE_SET / getVisaDocumentCodeDef
// synchronously to validate the LEGACY, still-in-production
// VisaRule.documentRequirements[].docCode / VisaDocument.docCode flat
// fields, and this phase is schema/migration only — no route changes.
//
// VISA_DOCUMENT_CODES / VISA_DOCUMENT_CODE_SET below are a SUPERSET of the
// original DOC-01..DOC-10 list: every catalogue entry (old numeric codes
// AND new semantic codes) is valid here, so existing rows/routes keep
// resolving unchanged (old codes still work) while new semantic codes are
// also accepted (additive, never a breaking narrowing of what validates).
import {
  VISA_DOCUMENT_TYPE_CATALOGUE,
  OLD_TO_NEW_DOC_CODE_MAP,
  canonicalizeVisaDocumentCode,
  type VisaDocumentTypeCategory,
} from "./visaDocumentTypeCatalogue.js";

export type VisaDocumentCategory = VisaDocumentTypeCategory;

export interface VisaDocumentCodeDef {
  code: string;
  name: string;
  category: VisaDocumentCategory;
  notes?: string;
}

// Original shape/order preserved exactly: one entry per legacy DOC-NN code
// (unchanged from the pre-Phase-10a file), so anything iterating this array
// the way the old code did sees no difference.
export const VISA_DOCUMENT_CODES: readonly VisaDocumentCodeDef[] = VISA_DOCUMENT_TYPE_CATALOGUE.filter(
  (d) => d.legacyCode,
).map((d) => ({
  code: d.legacyCode as string,
  name: d.name,
  category: d.category,
  notes: d.defaultDescription,
}));

// Superset: BOTH the legacy DOC-NN codes and their new semantic equivalents
// validate — see file header.
export const VISA_DOCUMENT_CODE_SET: ReadonlySet<string> = new Set([
  ...VISA_DOCUMENT_CODES.map((d) => d.code),
  ...VISA_DOCUMENT_TYPE_CATALOGUE.map((d) => d.code),
]);

// Resolves either form of a code (legacy "DOC-01" or semantic
// "PASSPORT_ORIGINAL") to a definition — the returned `code` always echoes
// back whichever form was queried with, so a legacy-code caller keeps
// seeing legacy codes and a semantic-code caller sees semantic codes.
export function getVisaDocumentCodeDef(code: string): VisaDocumentCodeDef | undefined {
  const legacyHit = VISA_DOCUMENT_CODES.find((d) => d.code === code);
  if (legacyHit) return legacyHit;

  const bySeed = VISA_DOCUMENT_TYPE_CATALOGUE.find((d) => d.code === code);
  if (bySeed) {
    return { code: bySeed.code, name: bySeed.name, category: bySeed.category, notes: bySeed.defaultDescription };
  }
  return undefined;
}

export { OLD_TO_NEW_DOC_CODE_MAP, canonicalizeVisaDocumentCode };
