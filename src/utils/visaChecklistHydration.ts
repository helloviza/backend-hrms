// apps/backend/src/utils/visaChecklistHydration.ts
//
// Phase 10b — turns resolveVisaChecklistItems' output into the two things
// routes/visa.ts's consumers actually need:
//   - `documents`: one row per PHYSICAL document (unchanged wire shape from
//     the pre-Phase-10b hydrateDocumentRequirements — docCode/name/category/
//     notes/requirement/condition/satisfiedByBooking/conciergeArrangeable),
//     because uploading, linking a booking, or offering a concierge arrange
//     all happen per physical document, never per logical requirement. A
//     multi-document group (e.g. France's four-document "proof of
//     occupation") becomes one row per document, same as before.
//   - `documentGroups`: one entry per LOGICAL requirement — this is the new
//     piece Phase 10b adds, and what completeness now counts against
//     ("counts groups as one requirement, not N").
//
// Legacy document codes stay exactly as stored (task brief §4) —
// LINKABLE_DOC_CODE_SERVICE / CONCIERGE_ARRANGEABLE_DOC_CODES are keyed on
// the original "DOC-NN" codes AND, additively, their new semantic
// equivalents (config/visaDocumentTypeCatalogue.ts's OLD_TO_NEW_DOC_CODE_MAP)
// — so a hypothetical future rule whose documentGroups reference
// "HOTEL_BOOKING" directly (rather than the legacy "DOC-07") still gets
// satisfiedByBooking/conciergeArrangeable right, without this module ever
// rewriting a stored docCode value.
import {
  resolveVisaChecklistItems,
  itemCountsTowardCompleteness,
  type ResolvedChecklistItem,
  type VisaChecklistSource,
} from "./visaChecklistResolver.js";
import { getVisaDocumentCodeDef } from "../config/visaDocumentCodes.js";
import { OLD_TO_NEW_DOC_CODE_MAP } from "../config/visaDocumentTypeCatalogue.js";
import type { VisaApplicantProfile } from "../models/visaAttributes.js";

const LINKABLE_DOC_CODE_SERVICE_BASE: Record<string, "FLIGHT" | "HOTEL"> = {
  "DOC-08": "FLIGHT",
  "DOC-07": "HOTEL",
};
const CONCIERGE_ARRANGEABLE_DOC_CODES_BASE = new Set(["DOC-07", "DOC-08", "DOC-09"]);

function withCanonicalAliases<T>(base: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = { ...base };
  for (const [oldCode, newCode] of Object.entries(OLD_TO_NEW_DOC_CODE_MAP)) {
    if (oldCode in base) out[newCode] = base[oldCode];
  }
  return out;
}

function withCanonicalAliasSet(base: ReadonlySet<string>): Set<string> {
  const out = new Set(base);
  for (const [oldCode, newCode] of Object.entries(OLD_TO_NEW_DOC_CODE_MAP)) {
    if (base.has(oldCode)) out.add(newCode);
  }
  return out;
}

// Both old ("DOC-07") and new ("HOTEL_BOOKING") forms resolve to the same
// service/arrangeability — see file header.
export const LINKABLE_DOC_CODE_SERVICE = withCanonicalAliases(LINKABLE_DOC_CODE_SERVICE_BASE);
export const CONCIERGE_ARRANGEABLE_DOC_CODES = withCanonicalAliasSet(CONCIERGE_ARRANGEABLE_DOC_CODES_BASE);

export interface HydratedChecklistDocumentRow {
  docCode: string;
  name: string | null;
  category: string | null;
  notes: string | null;
  requirement: "REQUIRED" | "CONDITIONAL";
  condition?: string;
  satisfiedByBooking: boolean;
  conciergeArrangeable: boolean;
}

export interface HydratedChecklistGroupSummary {
  key: string;
  label: string;
  requirement: "REQUIRED" | "CONDITIONAL";
  docCodes: string[];
  condition?: string;
  specification?: string;
  templateCode?: string;
  // Whether a completeness/"outstanding" calculation should count this
  // requirement at all — see itemCountsTowardCompleteness. Lets the
  // frontend (documents/completeness.ts, review/completeness.ts,
  // track/OutstandingDocumentsTile.tsx) count correctly without needing to
  // know anything about appliesWhen/predicates itself.
  countsTowardCompleteness: boolean;
}

export interface HydratedVisaChecklist {
  documents: HydratedChecklistDocumentRow[];
  documentGroups: HydratedChecklistGroupSummary[];
}

function hydrateDocumentRow(
  item: ResolvedChecklistItem,
  docCode: string,
  linkedServices: ReadonlySet<string> | undefined,
): HydratedChecklistDocumentRow {
  const def = getVisaDocumentCodeDef(docCode);
  const service = LINKABLE_DOC_CODE_SERVICE[docCode];
  const row: HydratedChecklistDocumentRow = {
    docCode,
    name: def?.name ?? null,
    category: def?.category ?? null,
    // A group's `specification` overrides the doc type's own default
    // description (task brief, Phase 10a §4 — photo size, bank-balance
    // thresholds, etc. vary per destination for the "same" document type).
    notes: item.specification ?? def?.notes ?? null,
    requirement: item.requirement,
    satisfiedByBooking: !!(service && linkedServices?.has(service)),
    conciergeArrangeable: CONCIERGE_ARRANGEABLE_DOC_CODES.has(docCode),
  };
  if (item.condition) row.condition = item.condition;
  return row;
}

/**
 * The one hydration call every checklist-reading route makes. `applicantProfile`
 * is forwarded to resolveVisaChecklistItems verbatim — pass `undefined` for
 * the pre-traveller rule preview (GET /rules, GET /rules/:id), or the real
 * (possibly empty) VisaApplication.applicantProfile for every per-application
 * consumer.
 */
export function hydrateVisaChecklist(
  source: VisaChecklistSource,
  opts: {
    applicantProfile?: Partial<VisaApplicantProfile> | null;
    linkedServices?: ReadonlySet<string>;
  } = {},
): HydratedVisaChecklist {
  const items = resolveVisaChecklistItems(source, opts.applicantProfile);

  const documents: HydratedChecklistDocumentRow[] = [];
  const documentGroups: HydratedChecklistGroupSummary[] = [];

  for (const item of items) {
    const group: HydratedChecklistGroupSummary = {
      key: item.key,
      label: item.label,
      requirement: item.requirement,
      docCodes: [...item.docTypeCodes],
      countsTowardCompleteness: itemCountsTowardCompleteness(item),
    };
    if (item.condition) group.condition = item.condition;
    if (item.specification) group.specification = item.specification;
    if (item.templateCode) group.templateCode = item.templateCode;
    documentGroups.push(group);

    for (const docCode of item.docTypeCodes) {
      documents.push(hydrateDocumentRow(item, docCode, opts.linkedServices));
    }
  }

  return { documents, documentGroups };
}

/**
 * Completeness (task brief §1/§2) — one requirement (one `ResolvedChecklistItem`,
 * whether legacy-single-doc or a real multi-document group) counts as ONE,
 * satisfied only when EVERY one of its docTypeCodes is uploaded or linked.
 * Never counts a CONDITIONAL item whose applicability couldn't be
 * structurally verified (no `appliesWhen` at all — free text only) — same
 * conservative posture computeOutstandingRequiredDocCodes always took;
 * anything WITH an `appliesWhen` only reaches this function already having
 * matched the applicant (resolveVisaChecklistItems filtered it in), so it
 * counts like any other applicable requirement.
 */
export function computeOutstandingRequirements(
  source: VisaChecklistSource,
  applicantProfile: Partial<VisaApplicantProfile> | null | undefined,
  ctx: { uploadedDocCodes: ReadonlySet<string>; linkedServices: ReadonlySet<string> },
): ResolvedChecklistItem[] {
  // Always evaluate for real here (never the "no applicant known yet"
  // bypass mode) — completeness is only ever computed for a real
  // application. Coercing null/undefined to {} guarantees normal
  // evaluation; it degrades to "show everything" only where the source
  // itself has no structured appliesWhen to filter by (every existing
  // ruleSnapshot, by construction — see visaChecklistResolver.ts).
  const items = resolveVisaChecklistItems(source, applicantProfile ?? {});

  return items.filter((item) => {
    if (!itemCountsTowardCompleteness(item)) return false;
    return !item.docTypeCodes.every((code) => isDocTypeSatisfied(code, ctx));
  });
}

function isDocTypeSatisfied(
  docCode: string,
  ctx: { uploadedDocCodes: ReadonlySet<string>; linkedServices: ReadonlySet<string> },
): boolean {
  if (ctx.uploadedDocCodes.has(docCode)) return true;
  const service = LINKABLE_DOC_CODE_SERVICE[docCode];
  return !!(service && ctx.linkedServices.has(service));
}
