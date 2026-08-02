// apps/backend/src/utils/visaChecklistCatalogueMatcher.ts
//
// Phase 10c (checklist-PDF extraction) — the deterministic, non-LLM step
// between services/extractVisaChecklistGemini.ts's RAW transcription and a
// reviewable JSON artefact. Gemini reads what a PDF says; this module
// decides whether that matches something the platform already knows about
// — and NEVER invents a new VisaDocumentType code, VisaQuestion, or
// VisaTemplate when it doesn't. "Never invent" (task brief §3) means this
// file's job is narrowing (does X already exist under a name/alias we
// know?), not classification (what SHOULD X be called?) — that decision
// belongs to ops, working from the `unmatched` list this produces.
//
// Three catalogues, three static (DB-free) sources — extraction "touches
// no database" (task brief §6), so every match here is against a plain,
// importable array, exactly like config/visaDocumentTypeCatalogue.ts
// already is for the document-type catalogue:
//   - documents -> config/visaDocumentTypeCatalogue.ts's VISA_DOCUMENT_TYPE_CATALOGUE
//   - questions -> config/visaQuestionBankSeed.ts's VISA_QUESTION_BANK_SEED
//   - templates -> KNOWN_VISA_TEMPLATES below, currently empty (VisaTemplate
//     has never been seeded — see that model's own file header) — every
//     template reference will legitimately report as unmatched until ops
//     seeds real templates and this list (or a real DB-backed pass) grows.
//
// Document-type matching follow-up: matchDocumentType/suggestDocumentTypes
// below are the original deterministic string matcher — kept, but no
// longer the primary signal for documents. resolveDocumentTypeMapping is
// now the actual entry point scripts/extract-visa-checklists.ts calls: it
// treats the model's OWN catalogue mapping (from
// services/extractVisaChecklistGemini.ts, schema-constrained to a real
// code or null) as primary, and runs this string matcher only as an
// independent cross-check, surfacing a disagreement rather than resolving
// it silently. Questions and templates are unaffected — the pilot's
// unmatched rate there wasn't a string-matching problem the model could
// meaningfully improve on the same way.
import { VISA_DOCUMENT_TYPE_CATALOGUE, type VisaDocumentTypeSeed } from "../config/visaDocumentTypeCatalogue.js";
import { VISA_QUESTION_BANK_SEED, type VisaQuestionSeed } from "../config/visaQuestionBankSeed.js";
import type { VisaApplicantPredicate } from "../models/visaAttributes.js";
import type { VisaChecklistMatchConfidence } from "../services/extractVisaChecklistGemini.js";

/* ─────────────────────────────────────────────────────────────────────
 * Normalisation + scoring — shared by every catalogue below.
 * ───────────────────────────────────────────────────────────────────── */

export function normalizeChecklistText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Words too short/common to be meaningful on their own (a bare "of"/"the"
// overlap should never count as a match signal) — deliberately small; this
// is a scoring aid for SUGGESTIONS only, never for an auto-applied match.
const STOPWORDS = new Set(["of", "the", "a", "an", "for", "and", "or", "your", "to", "in", "on", "with"]);

function tokenSet(s: string): Set<string> {
  return new Set(normalizeChecklistText(s).split(" ").filter((w) => w.length > 1 && !STOPWORDS.has(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = new Set([...a, ...b]).size;
  return intersection / union;
}

export interface CatalogueSuggestion {
  code: string;
  label: string;
  score: number; // 0..1, Jaccard token overlap — informational only, never auto-applied
}

/* ─────────────────────────────────────────────────────────────────────
 * Document types.
 * ───────────────────────────────────────────────────────────────────── */

// Every candidate string (code, name, aliases) a document type can be
// exactly matched against, pre-normalised once.
const DOCUMENT_TYPE_INDEX: { seed: VisaDocumentTypeSeed; normalizedCandidates: string[] }[] =
  VISA_DOCUMENT_TYPE_CATALOGUE.map((seed) => ({
    seed,
    normalizedCandidates: [seed.code, seed.name, ...seed.aliases].map(normalizeChecklistText),
  }));

/**
 * Exact match only (after normalisation) against a VisaDocumentType's code,
 * name, or one of its aliases. Returns null — never a best-effort guess —
 * when nothing matches exactly; see suggestDocumentTypes for informational
 * near-misses a human can act on.
 */
export function matchDocumentType(sourceName: string): VisaDocumentTypeSeed | null {
  const norm = normalizeChecklistText(sourceName);
  if (!norm) return null;
  const hit = DOCUMENT_TYPE_INDEX.find((entry) => entry.normalizedCandidates.includes(norm));
  return hit ? hit.seed : null;
}

export function suggestDocumentTypes(sourceName: string, limit = 2): CatalogueSuggestion[] {
  const sourceTokens = tokenSet(sourceName);
  return DOCUMENT_TYPE_INDEX.map(({ seed }) => ({
    code: seed.code,
    label: seed.name,
    score: Math.max(...[seed.name, ...seed.aliases].map((c) => jaccard(sourceTokens, tokenSet(c)))),
  }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Follow-up (task brief §1/§4) — the pilot showed the string matcher above
 * leaves most real documents unmatched (a source typo, word order, or a
 * locally-known name for the same document all defeat string comparison).
 * services/extractVisaChecklistGemini.ts now asks the model itself for a
 * catalogue code per document, schema-constrained to a real code or null —
 * that becomes the PRIMARY result here. The string matcher still runs, but
 * only as an independent CROSS-CHECK: when the two disagree, both are
 * reported (never silently reconciled) so a reviewer can tell "the model
 * found something the string matcher couldn't" from "the model's mapping
 * doesn't even match under a lenient string comparison — look closer".
 */
export interface DocumentTypeMappingResult {
  matchedCode: string | null; // PRIMARY — the model's own mapping, validated against the real catalogue
  confidence: VisaChecklistMatchConfidence | null; // null whenever matchedCode is null
  reasoning: string | null; // the model's own one-line explanation, kept regardless of the outcome
  stringMatchCode: string | null; // the deterministic exact/alias matcher's independent result
  matchesAgree: boolean; // matchedCode === stringMatchCode (true when both are null too)
  suggestions: CatalogueSuggestion[]; // informational near-misses — only populated when matchedCode is null
}

export function resolveDocumentTypeMapping(input: {
  sourceName: string;
  llmCode: string | null | undefined;
  llmConfidence: string | null | undefined;
  llmReasoning: string | null | undefined;
}): DocumentTypeMappingResult {
  // Defensive validation — the Gemini response schema constrains
  // documentTypeCode to an enum of real codes, but this never trusts that
  // blindly: a schema-violating or unrecognised code is treated exactly
  // like null rather than silently accepted as a fabricated catalogue
  // entry (task brief §2 — "a fabricated code is worse than an unmatched
  // one"). The model's own reasoning text is still kept either way, since
  // it's useful evidence of what went wrong.
  const llmCodeIsReal = !!input.llmCode && VISA_DOCUMENT_TYPE_CATALOGUE.some((d) => d.code === input.llmCode);
  const matchedCode = llmCodeIsReal ? (input.llmCode as string) : null;

  const stringMatch = matchDocumentType(input.sourceName);
  const stringMatchCode = stringMatch?.code ?? null;

  return {
    matchedCode,
    confidence: matchedCode ? ((input.llmConfidence as VisaChecklistMatchConfidence) ?? null) : null,
    reasoning: input.llmReasoning ?? null,
    stringMatchCode,
    matchesAgree: matchedCode === stringMatchCode,
    suggestions: matchedCode ? [] : suggestDocumentTypes(input.sourceName),
  };
}

/* ─────────────────────────────────────────────────────────────────────
 * Questions.
 * ───────────────────────────────────────────────────────────────────── */

const QUESTION_INDEX: { seed: VisaQuestionSeed; normalizedPrompt: string }[] = VISA_QUESTION_BANK_SEED.map((seed) => ({
  seed,
  normalizedPrompt: normalizeChecklistText(seed.prompt),
}));

/** Exact match only, against the shared VisaQuestion bank's own prompt text. */
export function matchQuestion(prompt: string): VisaQuestionSeed | null {
  const norm = normalizeChecklistText(prompt);
  if (!norm) return null;
  const hit = QUESTION_INDEX.find((entry) => entry.normalizedPrompt === norm);
  return hit ? hit.seed : null;
}

export function suggestQuestions(prompt: string, limit = 2): CatalogueSuggestion[] {
  const promptTokens = tokenSet(prompt);
  return QUESTION_INDEX.map(({ seed }) => ({
    code: seed.code,
    label: seed.prompt,
    score: jaccard(promptTokens, tokenSet(seed.prompt)),
  }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/* ─────────────────────────────────────────────────────────────────────
 * Templates — VisaTemplate has never been seeded (models/VisaTemplate.ts's
 * own file header: "Nothing uploads templates yet"), so this list starts
 * empty. Every template reference this phase extracts will legitimately
 * report as unmatched — that's the correct, honest result, not a matcher
 * bug — until ops seeds real VisaTemplate rows and this list (or a real
 * DB-backed lookup, once a future phase allows it) grows to match.
 * ───────────────────────────────────────────────────────────────────── */
export interface KnownVisaTemplate {
  code: string;
  name: string;
}
export const KNOWN_VISA_TEMPLATES: readonly KnownVisaTemplate[] = [];

export function matchTemplate(reference: string): KnownVisaTemplate | null {
  const norm = normalizeChecklistText(reference);
  if (!norm) return null;
  return KNOWN_VISA_TEMPLATES.find((t) => normalizeChecklistText(t.name) === norm || normalizeChecklistText(t.code) === norm) ?? null;
}

/* ─────────────────────────────────────────────────────────────────────
 * Conditions -> structured appliesWhen. A small, hand-curated whitelist of
 * KNOWN phrases mapping to a single applicant-attribute condition — never
 * a parser that tries to derive a predicate from arbitrary text. A
 * condition not on this list stays free text (legacyConditionNote) rather
 * than risk a wrong guess — same posture Phase 10b's migration took for
 * the one legacy condition it could structure ("if self-employed or a
 * business owner"). Evaluated as: exact match on the normalised phrase
 * first, then a same-topic "contains" trigger for common real-world
 * variants (e.g. a longer sentence that still clearly turns on
 * "if employed" somewhere in it).
 * ───────────────────────────────────────────────────────────────────── */
interface ConditionRule {
  // Exact normalised phrases this rule fires on.
  exact: string[];
  // OR: fires if the normalised text CONTAINS this substring anywhere —
  // used only for single, unambiguous trigger words/phrases.
  contains?: string[];
  predicate: VisaApplicantPredicate;
}

const CONDITION_RULES: ConditionRule[] = [
  { exact: ["if employed"], contains: ["if employed"], predicate: [{ field: "employmentStatus", equals: "EMPLOYED" }] },
  {
    exact: ["if self employed", "if self employed or a business owner"],
    contains: ["self employed"],
    predicate: [{ field: "employmentStatus", equals: "SELF_EMPLOYED" }],
  },
  { exact: ["if retired"], contains: ["if retired"], predicate: [{ field: "employmentStatus", equals: "RETIRED" }] },
  { exact: ["if student"], contains: ["if student"], predicate: [{ field: "employmentStatus", equals: "STUDENT" }] },
  { exact: ["if married"], contains: ["if married"], predicate: [{ field: "maritalStatus", equals: "MARRIED" }] },
  { exact: ["if divorced"], contains: ["if divorced"], predicate: [{ field: "maritalStatus", equals: "DIVORCED" }] },
  { exact: ["if single"], contains: ["if single"], predicate: [{ field: "maritalStatus", equals: "SINGLE" }] },
  { exact: ["if widowed"], contains: ["if widowed"], predicate: [{ field: "maritalStatus", equals: "WIDOWED" }] },
  {
    exact: ["if sponsored", "if trip sponsored by someone else", "if sponsored by someone else"],
    contains: ["sponsored by someone else", "if sponsored"],
    predicate: [{ field: "isSponsored", equals: true }],
  },
  { exact: ["if minor"], contains: ["if minor", "minor is travelling"], predicate: [{ field: "isMinor", equals: true }] },
  {
    exact: ["for usa visa holder", "for us visa holder", "usa visa holder", "us visa holder"],
    contains: ["usa visa holder", "us visa holder"],
    predicate: [{ field: "holdsUsVisa", equals: true }],
  },
  {
    exact: ["for schengen visa holder", "schengen visa holder"],
    contains: ["schengen visa holder"],
    predicate: [{ field: "holdsSchengenVisa", equals: true }],
  },
];

/**
 * Structures a free-text condition into a VisaApplicantPredicate ONLY when
 * it matches a known, unambiguous phrase — returns null otherwise, so the
 * caller keeps the original text as an unstructured legacyConditionNote
 * instead of guessing.
 */
export function structureChecklistCondition(conditionText: string | null | undefined): VisaApplicantPredicate | null {
  if (!conditionText) return null;
  const norm = normalizeChecklistText(conditionText);
  if (!norm) return null;

  for (const rule of CONDITION_RULES) {
    if (rule.exact.includes(norm)) return rule.predicate;
  }
  for (const rule of CONDITION_RULES) {
    if (rule.contains?.some((c) => norm.includes(c))) return rule.predicate;
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────────────
 * Group-key slugging — stable, deterministic, derived from the label the
 * PDF actually printed (never invented) so re-extracting the same PDF
 * produces the same key (idempotency for the import step downstream).
 * ───────────────────────────────────────────────────────────────────── */
export function slugifyChecklistLabel(label: string): string {
  return normalizeChecklistText(label).replace(/\s+/g, "_").toUpperCase().slice(0, 64) || "REQUIREMENT";
}
