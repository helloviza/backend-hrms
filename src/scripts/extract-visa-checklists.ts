// apps/backend/src/scripts/extract-visa-checklists.ts
//
// Phase 10c (checklist-PDF extraction), step 1 of 2 — "a script that
// extracts to JSON... nothing touches the database on this pass" (task
// brief §6). Reads country checklist PDFs from docs/data/visa-checklists/,
// runs each through services/extractVisaChecklistGemini.ts (RAW
// transcription) then utils/visaChecklistCatalogueMatcher.ts (deterministic
// matching against the existing document-type/question/template
// catalogues — never inventing a new one), and writes ONE reviewable JSON
// file per DISTINCT PDF to docs/data/visa-checklists/extracted/.
//
// "Per distinct PDF", not literally "per file on disk": the three
// France-document-checklist*.pdf files in this directory are BYTE-IDENTICAL
// duplicates (confirmed via MD5 before this script was written — an
// artefact of how they were saved, not three different checklists).
// Extracting all three would silently produce three redundant JSON files
// that, if all imported, would try to create the same rule three times.
// This script content-hashes every PDF first and only extracts the
// alphabetically-first name in each duplicate group, recording the skipped
// duplicate names on the surviving file's own `duplicateOfSourceFiles`.
//
// This step NEVER decides a document is a NEW catalogue entry, a
// condition IS a given attribute, or a template reference matches a real
// VisaTemplate row — every one of those is either an exact match against
// an existing, importable static catalogue, or reported as unmatched for a
// human (ops) to resolve by hand-editing the JSON before step 2
// (scripts/import-visa-checklist-rules.ts) reads it.
//
// Usage (run from apps/backend):
//   pnpm exec tsx src/scripts/extract-visa-checklists.ts                       # every PDF
//   pnpm exec tsx src/scripts/extract-visa-checklists.ts --only=Laos,France,Canada   # a subset, by filename prefix
import "dotenv/config";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractVisaChecklistViaGemini,
  type RawExtractedDocument,
  type RawExtractedRequirementGroup,
  type RawExtractedQuestion,
} from "../services/extractVisaChecklistGemini.js";
import {
  resolveDocumentTypeMapping,
  matchQuestion,
  suggestQuestions,
  matchTemplate,
  structureChecklistCondition,
  slugifyChecklistLabel,
  type CatalogueSuggestion,
} from "../utils/visaChecklistCatalogueMatcher.js";
import { normaliseToIso2 } from "../utils/countryCodes.js";
import { VISA_PURPOSES, type VisaPurpose } from "../models/VisaRule.js";
import type { VisaApplicantPredicate } from "../models/visaAttributes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/backend/src/scripts -> repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const CHECKLISTS_DIR = path.join(REPO_ROOT, "docs", "data", "visa-checklists");
const OUTPUT_DIR = path.join(CHECKLISTS_DIR, "extracted");

// Every rule this platform has ever seeded is for Indian applicants — and
// these PDFs themselves confirm that audience directly (ITR, Aadhaar card,
// GST certificate are Indian-specific tax/ID terms appearing throughout).
// Fixed, not extracted from the PDF — there is no other nationality any of
// this content could plausibly be for.
const NATIONALITY = "IN";

const PURPOSE_LABEL_MAP: Record<string, VisaPurpose> = {
  tourist: "TOURIST",
  visitor: "TOURIST",
  business: "BUSINESS",
  transit: "TRANSIT",
};

function mapPurposeLabel(label: string): VisaPurpose | null {
  const norm = label.trim().toLowerCase();
  if (PURPOSE_LABEL_MAP[norm]) return PURPOSE_LABEL_MAP[norm];
  // A handful of PDFs may phrase it as e.g. "Tourist Visa" — try each known
  // word as a whole-word match rather than a blind substring (so
  // "Transitional" never accidentally maps to TRANSIT).
  for (const word of norm.split(/\s+/)) {
    if (PURPOSE_LABEL_MAP[word]) return PURPOSE_LABEL_MAP[word];
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────────────
 * Reviewable JSON shape — what ops actually edits before step 2.
 * ───────────────────────────────────────────────────────────────────── */
interface ExtractedDocumentEntry {
  sourceName: string;
  sourceDescription: string | null;
  // PRIMARY — the model's own catalogue mapping (services/
  // extractVisaChecklistGemini.ts), schema-constrained to a real
  // VisaDocumentType.code or null, then re-validated here
  // (resolveDocumentTypeMapping) before being trusted at all.
  matchedCode: string | null;
  matchConfidence: string | null; // "HIGH" | "MEDIUM" | "LOW", null iff matchedCode is null
  matchReasoning: string | null; // the model's own one-line explanation, kept regardless of outcome
  // Cross-check only (task brief §4) — the ORIGINAL deterministic exact/
  // alias string matcher, run independently. Never overrides matchedCode;
  // a difference is surfaced via matchesAgree, never silently reconciled.
  stringMatchCode: string | null;
  matchesAgree: boolean;
  suggestions: CatalogueSuggestion[]; // informational only, never auto-applied
}

interface ExtractedRequirementGroupEntry {
  key: string;
  label: string;
  requirement: "REQUIRED" | "CONDITIONAL";
  conditionText: string | null;
  appliesWhen: VisaApplicantPredicate | null; // structured, only when confidently mapped
  specification: string | null;
  templateReference: string | null;
  matchedTemplateCode: string | null; // always null today — see visaChecklistCatalogueMatcher.ts's KNOWN_VISA_TEMPLATES
  documents: ExtractedDocumentEntry[];
  // True only when every one of this group's documents matched a real
  // VisaDocumentType — a quick per-group "ready to import as-is" signal for
  // whoever reviews the JSON; false doesn't block import, it just means
  // some docTypeCodes will be missing until ops fills them in.
  allDocumentsMatched: boolean;
}

interface ExtractedQuestionEntry {
  sourcePrompt: string;
  detailsText: string | null;
  matchedQuestionCode: string | null;
  suggestions: CatalogueSuggestion[];
}

interface ExtractedChecklistEntry {
  purposeLabel: string;
  purpose: VisaPurpose | null; // null means ops must set this before import
  variantLabel: string | null;
  variantKey: string; // "DEFAULT" or a slug derived from variantLabel
  applicability: VisaApplicantPredicate | null;
  // None of these four appear in ANY checklist PDF — a real gap the schema
  // still can't fill from this source (see the extraction report).
  // visaCategory is left null deliberately: it changes what the product
  // actually IS (STICKER vs E_VISA vs VOA vs VISA_FREE) and this pass will
  // not guess it — scripts/import-visa-checklist-rules.ts refuses to
  // create a rule until ops sets it here. productClass/entryType/
  // serviceTier are pre-filled with the same structural defaults every
  // rule needs and none of these PDFs contradict (no service-tier variant,
  // no stated entry-type, no non-VISA product ever appears) — override
  // here if a real one is known.
  visaCategory: null;
  productClass: "VISA";
  entryType: "UNSPECIFIED";
  serviceTier: "STANDARD";
  requirementGroups: ExtractedRequirementGroupEntry[];
  questions: ExtractedQuestionEntry[];
}

export interface ExtractedVisaChecklistFile {
  sourceFile: string;
  duplicateOfSourceFiles: string[];
  destinationName: string;
  destinationIso2: string | null;
  nationality: string;
  extractedAt: string;
  model: string;
  checklists: ExtractedChecklistEntry[];
}

/* ─────────────────────────────────────────────────────────────────────
 * Matching pass — RAW extraction in, reviewable entries out.
 * ───────────────────────────────────────────────────────────────────── */
function resolveDocument(raw: RawExtractedDocument): ExtractedDocumentEntry {
  const mapping = resolveDocumentTypeMapping({
    sourceName: raw.name,
    llmCode: raw.documentTypeCode,
    llmConfidence: raw.documentTypeConfidence,
    llmReasoning: raw.documentTypeReasoning,
  });
  return {
    sourceName: raw.name,
    sourceDescription: raw.description ?? null,
    matchedCode: mapping.matchedCode,
    matchConfidence: mapping.confidence,
    matchReasoning: mapping.reasoning,
    stringMatchCode: mapping.stringMatchCode,
    matchesAgree: mapping.matchesAgree,
    suggestions: mapping.suggestions,
  };
}

function resolveRequirementGroup(raw: RawExtractedRequirementGroup): ExtractedRequirementGroupEntry {
  const documents = raw.documents.map(resolveDocument);
  const template = raw.templateReference ? matchTemplate(raw.templateReference) : null;
  return {
    key: slugifyChecklistLabel(raw.label),
    label: raw.label,
    requirement: raw.requirement,
    conditionText: raw.conditionText ?? null,
    appliesWhen: structureChecklistCondition(raw.conditionText),
    specification: raw.specificationText ?? null,
    templateReference: raw.templateReference ?? null,
    matchedTemplateCode: template?.code ?? null,
    documents,
    allDocumentsMatched: documents.length > 0 && documents.every((d) => d.matchedCode !== null),
  };
}

function resolveQuestion(raw: RawExtractedQuestion): ExtractedQuestionEntry {
  const matched = matchQuestion(raw.prompt);
  return {
    sourcePrompt: raw.prompt,
    detailsText: raw.detailsText ?? null,
    matchedQuestionCode: matched?.code ?? null,
    suggestions: matched ? [] : suggestQuestions(raw.prompt),
  };
}

export function buildExtractedFile(
  sourceFile: string,
  duplicateOfSourceFiles: string[],
  extraction: { raw: { destinationName: string; checklists: any[] }; model: string },
  extractedAt: string,
): ExtractedVisaChecklistFile {
  const destinationIso2 = normaliseToIso2(extraction.raw.destinationName);

  const checklists: ExtractedChecklistEntry[] = extraction.raw.checklists.map((c: any) => {
    const variantLabel: string | null = c.variantLabel ?? null;
    return {
      purposeLabel: c.purposeLabel,
      purpose: mapPurposeLabel(c.purposeLabel),
      variantLabel,
      variantKey: variantLabel ? slugifyChecklistLabel(variantLabel) : "DEFAULT",
      applicability: variantLabel ? structureChecklistCondition(variantLabel) : null,
      visaCategory: null,
      productClass: "VISA",
      entryType: "UNSPECIFIED",
      serviceTier: "STANDARD",
      requirementGroups: (c.requirementGroups || []).map(resolveRequirementGroup),
      questions: (c.questions || []).map(resolveQuestion),
    };
  });

  return {
    sourceFile,
    duplicateOfSourceFiles,
    destinationName: extraction.raw.destinationName,
    destinationIso2,
    nationality: NATIONALITY,
    extractedAt,
    model: extraction.model,
    checklists,
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * File discovery + dedup.
 * ───────────────────────────────────────────────────────────────────── */
function hashFile(buf: Buffer): string {
  return createHash("md5").update(buf).digest("hex");
}

interface DedupedFile {
  canonicalName: string;
  duplicateNames: string[];
}

function discoverFiles(onlyPrefixes: string[] | null): DedupedFile[] {
  const names = readdirSync(CHECKLISTS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .sort();

  const byHash = new Map<string, string[]>();
  for (const name of names) {
    const buf = readFileSync(path.join(CHECKLISTS_DIR, name));
    const hash = hashFile(buf);
    const list = byHash.get(hash) || [];
    list.push(name);
    byHash.set(hash, list);
  }

  const deduped: DedupedFile[] = [...byHash.values()].map((names) => ({
    canonicalName: names[0],
    duplicateNames: names.slice(1),
  }));

  if (!onlyPrefixes) return deduped.sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));

  return deduped
    .filter((d) => onlyPrefixes.some((p) => d.canonicalName.toLowerCase().startsWith(p.toLowerCase())))
    .sort((a, b) => a.canonicalName.localeCompare(b.canonicalName));
}

/* ─────────────────────────────────────────────────────────────────────
 * Report — printed to console, not written anywhere (the JSON files ARE
 * the durable artefact).
 * ───────────────────────────────────────────────────────────────────── */
function printFileSummary(file: ExtractedVisaChecklistFile): void {
  console.log(`\n${file.sourceFile} -> ${file.destinationName} (${file.destinationIso2 ?? "ISO2 UNRESOLVED"})`);
  if (file.duplicateOfSourceFiles.length) {
    console.log(`  duplicate content also found in: ${file.duplicateOfSourceFiles.join(", ")} (skipped, not re-extracted)`);
  }
  console.log(`  ${file.checklists.length} checklist(s) -> ${file.checklists.length} rule(s)`);

  for (const c of file.checklists) {
    const groupCount = c.requirementGroups.length;
    const allDocs = c.requirementGroups.flatMap((g) => g.documents);
    const unmatchedDocs = allDocs.filter((d) => !d.matchedCode);
    const disagreements = allDocs.filter((d) => !d.matchesAgree);
    const unstructuredConditions = c.requirementGroups.filter((g) => g.conditionText && !g.appliesWhen);
    const unmatchedTemplates = c.requirementGroups.filter((g) => g.templateReference && !g.matchedTemplateCode);
    const unmatchedQuestions = c.questions.filter((q) => !q.matchedQuestionCode);

    const label = c.variantLabel ? `${c.purposeLabel} [variant: ${c.variantLabel}]` : c.purposeLabel;
    console.log(
      `  - ${label}: ${groupCount} requirement group(s), ${allDocs.length} document(s), ` +
        `${unmatchedDocs.length} unmatched, ${disagreements.length} LLM/string-matcher disagreement(s), ` +
        `${unstructuredConditions.length} unstructured condition(s), ${unmatchedTemplates.length} unmatched template(s), ` +
        `${c.questions.length} question(s) (${unmatchedQuestions.length} unmatched)` +
        (c.purpose ? "" : " — purpose NOT resolved, ops must set it") +
        " — visaCategory not in the PDF, ops must set it before import",
    );
    for (const d of disagreements) {
      console.log(
        `      disagreement: "${d.sourceName}" — LLM: ${d.matchedCode ?? "null"} (${d.matchConfidence ?? "n/a"}), string matcher: ${d.stringMatchCode ?? "null"}`,
      );
    }
  }
}

/* ─────────────────────────────────────────────────────────────────────
 * Entry point.
 * ───────────────────────────────────────────────────────────────────── */
async function main() {
  const onlyArg = process.argv.find((a) => a.startsWith("--only="));
  const onlyPrefixes = onlyArg ? onlyArg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean) : null;

  const files = discoverFiles(onlyPrefixes);
  if (files.length === 0) {
    console.error(onlyPrefixes ? `No PDFs matched --only=${onlyPrefixes.join(",")}` : "No PDFs found in docs/data/visa-checklists/");
    process.exit(1);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log(`=== Extracting ${files.length} checklist PDF(s) ===`);
  console.log(`Source: ${CHECKLISTS_DIR}`);
  console.log(`Output: ${OUTPUT_DIR}`);

  let totalRules = 0;

  for (const { canonicalName, duplicateNames } of files) {
    const buf = readFileSync(path.join(CHECKLISTS_DIR, canonicalName));
    console.log(`\nExtracting ${canonicalName}...`);

    const extraction = await extractVisaChecklistViaGemini({
      buffer: buf,
      mimeType: "application/pdf",
      sourceFile: canonicalName,
    });

    const extractedFile = buildExtractedFile(canonicalName, duplicateNames, extraction, new Date().toISOString());
    totalRules += extractedFile.checklists.length;

    const outName = canonicalName.replace(/\.pdf$/i, "").replace(/[^a-zA-Z0-9._-]+/g, "_") + ".json";
    writeFileSync(path.join(OUTPUT_DIR, outName), JSON.stringify(extractedFile, null, 2), "utf8");

    printFileSummary(extractedFile);
  }

  console.log(`\n=== Done: ${files.length} PDF(s) -> ${totalRules} draft rule(s) total (nothing written to the database) ===`);
}

// Guards against exactly the bug this same phase found in
// migrations/2026-08-02-visa-checklist-model-v2.ts: a NODE_ENV/VITEST-only
// guard protects against the test runner but not against another module
// importing this file for one of its exported functions/types — that
// import silently ran main() (a real Gemini extraction, here; a DB dry-run
// there) as a side effect. This checks whether THIS file is the actual
// process entry point instead — true only when run directly (tsx/node),
// never true for an import, regardless of NODE_ENV/VITEST.
const isDirectRun = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((err) => {
    console.error("Extraction failed:", err);
    process.exit(1);
  });
}
