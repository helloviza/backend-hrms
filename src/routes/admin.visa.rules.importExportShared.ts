// apps/backend/src/routes/admin.visa.rules.importExportShared.ts
//
// Column definitions and cell serialization for the RULES/REQUIREMENTS
// export+import pair (routes/admin.visa.rules.importExport.ts). Deliberately
// its OWN module, imported by both the export and the import code paths,
// rather than each having its own copy: the round-trip-losslessness
// property this feature is built around ("export, re-import unchanged, and
// nothing changes") only HOLDS if serialize and deserialize are exact
// inverses of each other — which is only structurally guaranteed if they're
// literally the same function, not two hand-written copies that could drift.
//
// documentGroups (VisaRule.ts's Phase 10a group-based checklist structure)
// is what the REQUIREMENTS sheet round-trips — NOT the legacy flat
// `documentRequirements` field routes/admin.visa.rules.ts's own
// EDITABLE_FIELDS still covers. The 43 checklist-import DRAFT rules this
// feature exists to review store their real content in documentGroups; the
// legacy field is untouched by this file, same as it's untouched by
// scripts/import-visa-checklist-rules.ts.
//
// SNAPSHOT semantics, not PATCH semantics: a blank cell means "this field is
// unset", full stop — never "leave whatever was there". There is no way for
// a spreadsheet cell to represent "don't touch this", so every editable
// column in an uploaded file is applied as the field's new complete value.
// This is what makes an unmodified re-upload a true no-op: a blank cell for
// an already-unset field resolves to "still unset" and registers as no
// change (see diffFields()'s own `?? null` normalisation in
// routes/admin.visa.rules.ts, reused here).
import mongoose from "mongoose";
import { VISA_CATEGORIES, VISA_ETA_BASES, VISA_DOC_REQUIREMENT_LEVELS, type VisaCategory, type VisaEtaBasis } from "../models/VisaRule.js";
import { VISA_APPLICANT_ATTRIBUTE_FIELDS, type VisaApplicantPredicate } from "../models/visaAttributes.js";
import { VISA_DOCUMENT_TYPE_CATALOGUE } from "../config/visaDocumentTypeCatalogue.js";
import { slugifyChecklistLabel } from "../utils/visaChecklistCatalogueMatcher.js";

export const DOC_TYPE_CODE_SET: ReadonlySet<string> = new Set(VISA_DOCUMENT_TYPE_CATALOGUE.map((d) => d.code));

/* ─────────────────────────────────────────────────────────────────────
 * Cell primitives — one implementation each, used for BOTH directions.
 * ───────────────────────────────────────────────────────────────────── */

/** Any ExcelJS cell value (rich text, formula result, Date, number, string, null) OR a raw CSV string, into a plain trimmed string. */
export function cellToString(v: any): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    if (Array.isArray((v as any).richText)) return (v as any).richText.map((t: any) => t.text).join("");
    if (typeof (v as any).text === "string") return (v as any).text;
    if ("result" in (v as any)) return String((v as any).result ?? "");
    return "";
  }
  return String(v).trim();
}

export function normalizeHeader(h: string): string {
  return String(h || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface NumberOut {
  value?: number;
  error?: string;
}

/** Blank cell -> absent (field should be unset). Non-blank -> a validated non-negative number, or an error. */
export function numberIn(raw: string, label: string): NumberOut {
  const s = (raw ?? "").trim();
  if (s === "") return {};
  const n = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(n) || n < 0) return { error: `${label} must be a non-negative number` };
  return { value: n };
}

export function numberOut(v: number | null | undefined): number | string {
  return v == null ? "" : v;
}

/** Blank cell -> absent (field should be unset). Non-blank -> the trimmed string. */
export function stringIn(raw: string): string | undefined {
  const s = (raw ?? "").trim();
  return s === "" ? undefined : s;
}

export function stringOut(v: string | null | undefined): string {
  return v ?? "";
}

export interface AppliesWhenResult {
  value?: VisaApplicantPredicate;
  error?: string;
}

export function appliesWhenOut(v: VisaApplicantPredicate | null | undefined): string {
  return v && v.length ? JSON.stringify(v) : "";
}

export function appliesWhenIn(raw: string): AppliesWhenResult {
  const s = (raw ?? "").trim();
  if (s === "") return {};
  let parsed: any;
  try {
    parsed = JSON.parse(s);
  } catch {
    return { error: "appliesWhen is not valid JSON" };
  }
  if (!Array.isArray(parsed)) return { error: "appliesWhen must be a JSON array" };
  for (const c of parsed) {
    if (!c || typeof c !== "object" || typeof c.field !== "string" || !(VISA_APPLICANT_ATTRIBUTE_FIELDS as readonly string[]).includes(c.field)) {
      return { error: `appliesWhen: each condition needs a valid "field" (one of ${VISA_APPLICANT_ATTRIBUTE_FIELDS.join(", ")})` };
    }
    if (c.equals === undefined && !Array.isArray(c.in)) {
      return { error: `appliesWhen: condition on "${c.field}" needs either "equals" or "in"` };
    }
  }
  return { value: parsed as VisaApplicantPredicate };
}

export interface DocCodesResult {
  value?: string[];
  error?: string;
}

export function docCodesOut(codes: string[] | null | undefined): string {
  return (codes || []).join(", ");
}

export function docCodesIn(raw: string): DocCodesResult {
  const parts = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // Blank is no longer an error here on its own — a group flagged Needs
  // Catalogue Mapping legitimately has none yet (2026-08-03). The
  // "at least one, unless flagged" rule lives in resolveRequirementRow,
  // which is the one place that knows about the flag.
  if (parts.length === 0) return { value: [] };
  for (const c of parts) {
    if (!DOC_TYPE_CODE_SET.has(c)) return { error: `"${c}" is not a known document type code` };
  }
  return { value: parts };
}

/** Blank/"FALSE"/anything else -> false; "TRUE"/"YES"/"Y"/"1" (any case) -> true. */
export function boolIn(raw: string): boolean {
  const s = (raw ?? "").trim().toLowerCase();
  return s === "true" || s === "yes" || s === "y" || s === "1";
}

export function boolOut(v: boolean | null | undefined): string {
  return v ? "TRUE" : "";
}

/** Blank cell -> absent (no names recorded). Non-blank -> a trimmed, comma-split list, order preserved. */
export function namesIn(raw: string): string[] | undefined {
  const parts = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length === 0 ? undefined : parts;
}

export function namesOut(names: string[] | null | undefined): string {
  return (names || []).join(", ");
}

/* ─────────────────────────────────────────────────────────────────────
 * RULES sheet — column order is the export column order; HEADER_FIELD_MAP
 * is keyed by normalizeHeader() of that same text, so a header the import
 * doesn't recognise (typo, extra ops-added column) is reported, never
 * silently guessed at.
 * ───────────────────────────────────────────────────────────────────── */
export const RULES_COLUMNS = [
  "Rule Id",
  "Destination ISO2",
  "Destination Name",
  "Purpose",
  "Entry Type",
  "Service Tier",
  "Variant Key",
  "Status",
  "Visa Category",
  "ETA Min Days",
  "ETA Max Days",
  "ETA Basis",
  "Embassy Fee INR",
  "VFS Fee INR",
  "Plumtrips Service Fee INR",
  "Indicative Visa Cost INR",
  "Price Note",
  "Ops Notes",
  "Last Reviewed At",
] as const;

// Context columns are exported for readability/review but NEVER read back
// on import — destination/purpose/entryType/serviceTier/variantKey are the
// rule's identity (immutable via ANY route except clone, see
// routes/admin.visa.rules.ts's own IDENTITY_FIELDS comment); status is
// read-only here by design (task brief §2); lastReviewedAt isn't in this
// feature's editable-field list either. Matching is on ruleId alone.
export const RULES_CONTEXT_FIELDS = new Set([
  "ruleid", "destinationiso2", "destinationname", "purpose", "entrytype",
  "servicetier", "variantkey", "status", "lastreviewedat",
]);

export const RULES_HEADER_FIELD_MAP: Record<string, string> = {
  ruleid: "ruleId",
  destinationiso2: "destinationIso2",
  destinationname: "destinationName",
  purpose: "purpose",
  entrytype: "entryType",
  servicetier: "serviceTier",
  variantkey: "variantKey",
  status: "status",
  visacategory: "visaCategory",
  etamindays: "etaMinDays",
  etamaxdays: "etaMaxDays",
  etabasis: "etaBasis",
  embassyfeeinr: "embassyFeeInr",
  vfsfeeinr: "vfsFeeInr",
  plumtripsservicefeeinr: "plumtripsServiceFeeInr",
  indicativevisacostinr: "indicativeVisaCostInr",
  pricenote: "priceNote",
  opsnotes: "opsNotes",
  lastreviewedat: "lastReviewedAt",
};

export function serializeRuleRow(r: any): (string | number)[] {
  return [
    String(r._id),
    r.destinationIso2,
    r.destinationName,
    r.purpose,
    r.entryType,
    r.serviceTier,
    r.variantKey,
    r.status,
    stringOut(r.visaCategory),
    numberOut(r.etaMinDays),
    numberOut(r.etaMaxDays),
    stringOut(r.etaBasis),
    numberOut(r.embassyFeeInr),
    numberOut(r.vfsFeeInr),
    numberOut(r.plumtripsServiceFeeInr),
    numberOut(r.indicativeVisaCostInr),
    stringOut(r.priceNote),
    stringOut(r.opsNotes),
    r.lastReviewedAt ? new Date(r.lastReviewedAt).toISOString().slice(0, 10) : "",
  ];
}

export interface ResolvedRuleEdit {
  ruleId: string;
  visaCategory?: VisaCategory;
  etaMinDays?: number;
  etaMaxDays?: number;
  etaBasis?: VisaEtaBasis;
  embassyFeeInr?: number;
  vfsFeeInr?: number;
  plumtripsServiceFeeInr?: number;
  indicativeVisaCostInr?: number;
  priceNote?: string;
  opsNotes?: string;
}

export function resolveRuleRow(
  mapped: Record<string, string>,
  rowNumber: number,
): { ok: true; edit: ResolvedRuleEdit } | { ok: false; reason: string } {
  const ruleId = (mapped.ruleId || "").trim();
  if (!ruleId) return { ok: false, reason: "Rule Id is required" };
  if (!mongoose.isValidObjectId(ruleId)) return { ok: false, reason: `Rule Id "${ruleId}" is not a valid id` };

  const visaCategoryRaw = stringIn(mapped.visaCategory);
  if (visaCategoryRaw !== undefined && !(VISA_CATEGORIES as readonly string[]).includes(visaCategoryRaw)) {
    return { ok: false, reason: `Visa Category "${visaCategoryRaw}" must be one of ${VISA_CATEGORIES.join(", ")}` };
  }

  const etaMin = numberIn(mapped.etaMinDays, "ETA Min Days");
  if (etaMin.error) return { ok: false, reason: etaMin.error };
  const etaMax = numberIn(mapped.etaMaxDays, "ETA Max Days");
  if (etaMax.error) return { ok: false, reason: etaMax.error };
  if ((etaMin.value === undefined) !== (etaMax.value === undefined)) {
    return { ok: false, reason: "ETA Min Days and ETA Max Days must both be present or both be blank" };
  }
  if (etaMin.value !== undefined && etaMax.value !== undefined && etaMin.value > etaMax.value) {
    return { ok: false, reason: `ETA Min Days (${etaMin.value}) is greater than ETA Max Days (${etaMax.value})` };
  }

  const etaBasisRaw = stringIn(mapped.etaBasis);
  if (etaBasisRaw !== undefined && !(VISA_ETA_BASES as readonly string[]).includes(etaBasisRaw)) {
    return { ok: false, reason: `ETA Basis "${etaBasisRaw}" must be one of ${VISA_ETA_BASES.join(", ")}` };
  }

  const embassyFee = numberIn(mapped.embassyFeeInr, "Embassy Fee INR");
  if (embassyFee.error) return { ok: false, reason: embassyFee.error };
  const vfsFee = numberIn(mapped.vfsFeeInr, "VFS Fee INR");
  if (vfsFee.error) return { ok: false, reason: vfsFee.error };
  const serviceFee = numberIn(mapped.plumtripsServiceFeeInr, "Plumtrips Service Fee INR");
  if (serviceFee.error) return { ok: false, reason: serviceFee.error };
  const indicativeCost = numberIn(mapped.indicativeVisaCostInr, "Indicative Visa Cost INR");
  if (indicativeCost.error) return { ok: false, reason: indicativeCost.error };

  // Every key is ALWAYS assigned — including to `undefined` for a blank
  // cell — never conditionally omitted. This is what makes the snapshot
  // semantics work: `{...before, ...edit}` must overwrite a field to unset
  // when its cell is blank, not silently preserve whatever was already
  // there because the key was never present on `edit` to begin with.
  const edit: ResolvedRuleEdit = {
    ruleId,
    visaCategory: visaCategoryRaw as VisaCategory | undefined,
    etaMinDays: etaMin.value,
    etaMaxDays: etaMax.value,
    etaBasis: etaBasisRaw as VisaEtaBasis | undefined,
    embassyFeeInr: embassyFee.value,
    vfsFeeInr: vfsFee.value,
    plumtripsServiceFeeInr: serviceFee.value,
    indicativeVisaCostInr: indicativeCost.value,
    priceNote: stringIn(mapped.priceNote),
    opsNotes: stringIn(mapped.opsNotes),
  };

  return { ok: true, edit };
}

/* ─────────────────────────────────────────────────────────────────────
 * REQUIREMENTS sheet — one row per documentGroups[] entry. `key` and
 * `requirement` and `legacyConditionNote` are ADDED beyond the task
 * brief's own listed columns (rule id, group label, appliesWhen, document
 * codes, specification, template code) — every one of VisaDocumentRequirement
 * Group's fields must round-trip, or dropping them on export would corrupt
 * data the moment an untouched row is re-imported.
 * ───────────────────────────────────────────────────────────────────── */
export const REQUIREMENTS_COLUMNS = [
  "Rule Id",
  "Group Key",
  "Group Label",
  "Requirement",
  "Applies When",
  "Document Codes",
  "Specification",
  "Template Code",
  "Legacy Condition Note",
  "Needs Catalogue Mapping",
  "Unmatched Document Names",
  "Unmatched Template Reference",
] as const;

export const REQUIREMENTS_HEADER_FIELD_MAP: Record<string, string> = {
  ruleid: "ruleId",
  groupkey: "groupKey",
  grouplabel: "groupLabel",
  requirement: "requirement",
  applieswhen: "appliesWhen",
  documentcodes: "documentCodes",
  specification: "specification",
  templatecode: "templateCode",
  legacyconditionnote: "legacyConditionNote",
  needscataloguemapping: "needsCatalogueMapping",
  unmatcheddocumentnames: "unmatchedDocumentNames",
  unmatchedtemplatereference: "unmatchedTemplateReference",
};

export function serializeRequirementRow(ruleId: string, g: any): (string | number)[] {
  return [
    ruleId,
    g.key,
    g.label,
    g.requirement,
    appliesWhenOut(g.appliesWhen),
    docCodesOut(g.docTypeCodes),
    stringOut(g.specification),
    stringOut(g.templateCode),
    stringOut(g.legacyConditionNote),
    boolOut(g.needsCatalogueMapping),
    namesOut(g.unmatchedDocumentNames),
    stringOut(g.unmatchedTemplateReference),
  ];
}

export interface ResolvedRequirementGroup {
  key: string;
  label: string;
  requirement: "REQUIRED" | "CONDITIONAL";
  appliesWhen?: VisaApplicantPredicate;
  docTypeCodes: string[];
  specification?: string;
  templateCode?: string;
  legacyConditionNote?: string;
  needsCatalogueMapping?: boolean;
  unmatchedDocumentNames?: string[];
  unmatchedTemplateReference?: string;
}

export function resolveRequirementRow(
  mapped: Record<string, string>,
  rowNumber: number,
): { ok: true; ruleId: string; group: ResolvedRequirementGroup } | { ok: false; reason: string } {
  const ruleId = (mapped.ruleId || "").trim();
  if (!ruleId) return { ok: false, reason: "Rule Id is required" };
  if (!mongoose.isValidObjectId(ruleId)) return { ok: false, reason: `Rule Id "${ruleId}" is not a valid id` };

  const label = (mapped.groupLabel || "").trim();
  if (!label) return { ok: false, reason: "Group Label is required" };

  const requirement = (mapped.requirement || "").trim().toUpperCase();
  if (!(VISA_DOC_REQUIREMENT_LEVELS as readonly string[]).includes(requirement)) {
    return { ok: false, reason: `Requirement "${mapped.requirement}" must be one of ${VISA_DOC_REQUIREMENT_LEVELS.join(", ")}` };
  }

  const appliesWhen = appliesWhenIn(mapped.appliesWhen);
  if (appliesWhen.error) return { ok: false, reason: appliesWhen.error };

  const docCodes = docCodesIn(mapped.documentCodes);
  if (docCodes.error) return { ok: false, reason: docCodes.error };

  // A blank Document Codes cell is only valid when this row is explicitly
  // flagged Needs Catalogue Mapping (2026-08-03) — otherwise it's the same
  // "forgot to fill this in" error this column has always guarded against.
  const needsCatalogueMapping = boolIn(mapped.needsCatalogueMapping);
  if ((docCodes.value?.length ?? 0) === 0 && !needsCatalogueMapping) {
    return { ok: false, reason: "at least one document code is required (or set Needs Catalogue Mapping to TRUE for a requirement with none mapped yet)" };
  }

  const keyRaw = stringIn(mapped.groupKey);
  const key = keyRaw ? keyRaw.toUpperCase() : slugifyChecklistLabel(label);

  const group: ResolvedRequirementGroup = {
    key,
    label,
    requirement: requirement as "REQUIRED" | "CONDITIONAL",
    docTypeCodes: docCodes.value as string[],
  };
  if (appliesWhen.value !== undefined) group.appliesWhen = appliesWhen.value;
  const specification = stringIn(mapped.specification);
  if (specification !== undefined) group.specification = specification;
  const templateCode = stringIn(mapped.templateCode);
  if (templateCode !== undefined) group.templateCode = templateCode.toUpperCase();
  const legacyConditionNote = stringIn(mapped.legacyConditionNote);
  if (legacyConditionNote !== undefined) group.legacyConditionNote = legacyConditionNote;
  if (needsCatalogueMapping) group.needsCatalogueMapping = true;
  const unmatchedDocumentNames = namesIn(mapped.unmatchedDocumentNames);
  if (unmatchedDocumentNames !== undefined) group.unmatchedDocumentNames = unmatchedDocumentNames;
  const unmatchedTemplateReference = stringIn(mapped.unmatchedTemplateReference);
  if (unmatchedTemplateReference !== undefined) group.unmatchedTemplateReference = unmatchedTemplateReference;

  return { ok: true, ruleId, group };
}

/* ─────────────────────────────────────────────────────────────────────
 * Header mapping — shared by the XLSX and CSV readers so both produce the
 * identical internal shape (mapped-by-field, not by raw header text).
 * Returns the set of raw headers that didn't map to any known field, for
 * the "columns it doesn't recognise" report.
 * ───────────────────────────────────────────────────────────────────── */
export function mapSheetRow(
  raw: Record<string, string>,
  headerFieldMap: Record<string, string>,
): { mapped: Record<string, string>; unrecognized: string[] } {
  const mapped: Record<string, string> = {};
  const unrecognized: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const field = headerFieldMap[normalizeHeader(key)];
    if (field) mapped[field] = value;
    else if (key.trim()) unrecognized.push(key.trim());
  }
  return { mapped, unrecognized };
}
