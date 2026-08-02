// apps/backend/src/services/extractVisaChecklistGemini.ts
//
// Phase 10c (checklist-PDF extraction) — mirrors services/
// voucherExtractorGemini.ts / extractPassportGemini.ts exactly: same
// @google/genai SDK, same singleton client, same schema-constrained
// (responseSchema + responseMimeType:"application/json") call shape, same
// utils/geminiRetry.ts transient-retry wrapper, same "retry once more on
// invalid JSON" fallback. No new dependency.
//
// This is the RAW extraction stage — it transcribes what the PDF literally
// says (document names, row descriptions, conditions, template
// references, questionnaire rows) — PLUS, since this follow-up pass (the
// pilot showed the string matcher alone leaves most real documents
// unmatched — "Employement contract" (source typo), "NOC from the
// employer" (word order), "National ID" (means Aadhaar) — none of which a
// string comparison can bridge), the model's own best guess at which
// VisaDocumentType catalogue entry each document matches. The FULL
// catalogue (codes, names, categories, aliases) is included in the prompt
// below, and documentTypeCode is schema-constrained to that exact code
// list or null — the model can decline to match, but it can never emit a
// code that isn't real. documentTypeConfidence/documentTypeReasoning make
// that judgement call reviewable rather than an opaque decision (task
// brief §3).
//
// This is still NOT the final say: utils/visaChecklistCatalogueMatcher.ts's
// deterministic string matcher runs independently as a CROSS-CHECK on the
// same source name — where the two disagree, both are reported, never
// silently reconciled (task brief §4). This file never structures a
// condition into an appliesWhen predicate and never resolves a template
// reference against VisaTemplate — those stay the matcher's job.
//
// One PDF can hold several checklists (task brief §2): France/UK/China
// print separate Tourist and Business tables in one document; Canada
// prints a standard table AND a second, much shorter table for a US-visa-
// holder variant. Both cases are just multiple entries in `checklists[]`
// — nothing here decides variantKey/applicability, that's the matcher's
// job too, working off `variantLabel`.
import { GoogleGenAI, Type } from "@google/genai";
import { withGeminiTransientRetry } from "../utils/geminiRetry.js";
import { VISA_DOCUMENT_TYPE_CATALOGUE } from "../config/visaDocumentTypeCatalogue.js";
import { VISA_PURPOSES } from "../models/VisaRule.js";

let _ai: GoogleGenAI | null = null;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`${name} is missing. Set it in apps/backend/.env and restart.`);
  }
  return v.trim();
}

function getAI(): GoogleGenAI {
  const key = requireEnv("GEMINI_API_KEY");
  if (!_ai) _ai = new GoogleGenAI({ apiKey: key });
  return _ai;
}

const DEFAULT_MODEL = "gemini-2.5-flash";

/* ───────────────────────── RAW contract ───────────────────────── */

export const VISA_CHECKLIST_MATCH_CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW"] as const;
export type VisaChecklistMatchConfidence = (typeof VISA_CHECKLIST_MATCH_CONFIDENCE_LEVELS)[number];

// The full set of codes the model is allowed to emit — anything else is a
// schema violation, not just a discouraged answer. Computed once from the
// same catalogue utils/visaChecklistCatalogueMatcher.ts matches against,
// so the two can never drift onto different code lists.
const DOCUMENT_TYPE_CODES = VISA_DOCUMENT_TYPE_CATALOGUE.map((d) => d.code);

export interface RawExtractedDocument {
  name: string;
  description: string | null;
  // The model's own best match against the VisaDocumentType catalogue
  // embedded in the prompt below — one of DOCUMENT_TYPE_CODES, or null when
  // it isn't confident enough that any entry is the same real document.
  // Schema-constrained (enum + nullable) so a fabricated code is not just
  // discouraged, it's impossible — see file header.
  documentTypeCode: string | null;
  documentTypeConfidence: VisaChecklistMatchConfidence | null; // null iff documentTypeCode is null
  documentTypeReasoning: string | null; // one line, always filled in — why this code, or why none
}

export const VISA_CHECKLIST_REQUIREMENT_LEVELS = ["REQUIRED", "CONDITIONAL"] as const;
export type RawRequirementLevel = (typeof VISA_CHECKLIST_REQUIREMENT_LEVELS)[number];

export interface RawExtractedRequirementGroup {
  label: string; // the row's own title, VERBATIM — never paraphrased, even when the title itself IS the condition (e.g. Canada's "If retired")
  requirement: RawRequirementLevel;
  conditionText: string | null; // the conditional phrase, verbatim, when requirement === "CONDITIONAL"
  specificationText: string | null; // verbatim spec/threshold text — only meaningful for a single-document row (see SYSTEM_PROMPT)
  templateReference: string | null; // verbatim, e.g. "Employer NOC Template"
  documents: RawExtractedDocument[]; // one entry per physically distinct document this row asks for
}

export interface RawExtractedQuestion {
  prompt: string; // verbatim
  detailsText: string | null; // verbatim guidance/answer-shape text from the same row
}

export interface RawExtractedChecklist {
  purposeLabel: string; // verbatim, e.g. "Tourist", "Business", "Visitor"
  // The model's own classification of this SAME checklist's travel
  // purpose — grounded in the full title AND content, not a keyword scan
  // of the title alone (utils/visaChecklistCatalogueMatcher.ts's
  // matchPurposeLabel does that, as an independent cross-check/fallback).
  // Schema-constrained to a real VisaPurpose or null — the model can
  // decline (a title like "Document Checklist" that states nothing), but
  // it can never emit a value that isn't a real purpose.
  purposeGuess: string | null;
  purposeReasoning: string | null; // one line, always filled in — why this purpose, or why none
  variantLabel: string | null; // verbatim, e.g. "For USA visa holder" — null for the primary/standard checklist of this purpose
  requirementGroups: RawExtractedRequirementGroup[];
  questions: RawExtractedQuestion[]; // [] when the PDF has no questionnaire section at all
}

export interface RawExtractedVisaChecklistDocument {
  destinationName: string; // best read of the destination country's name
  checklists: RawExtractedChecklist[];
}

/* ───────────────────────── Gemini schema ───────────────────────── */

const documentSchema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    description: { type: Type.STRING, nullable: true },
    // Constrained to the REAL catalogue code list (+ null) — the model
    // cannot emit anything else, so a "fabricated code" is a schema
    // violation the SDK itself would reject, not just an instruction it
    // could ignore (task brief §2).
    documentTypeCode: { type: Type.STRING, enum: DOCUMENT_TYPE_CODES, nullable: true },
    documentTypeConfidence: { type: Type.STRING, enum: [...VISA_CHECKLIST_MATCH_CONFIDENCE_LEVELS], nullable: true },
    documentTypeReasoning: { type: Type.STRING, nullable: true },
  },
  required: ["name"],
} as const;

const requirementGroupSchema = {
  type: Type.OBJECT,
  properties: {
    label: { type: Type.STRING },
    requirement: { type: Type.STRING, enum: [...VISA_CHECKLIST_REQUIREMENT_LEVELS] },
    conditionText: { type: Type.STRING, nullable: true },
    specificationText: { type: Type.STRING, nullable: true },
    templateReference: { type: Type.STRING, nullable: true },
    documents: { type: Type.ARRAY, items: documentSchema },
  },
  required: ["label", "requirement", "documents"],
} as const;

const questionSchema = {
  type: Type.OBJECT,
  properties: {
    prompt: { type: Type.STRING },
    detailsText: { type: Type.STRING, nullable: true },
  },
  required: ["prompt"],
} as const;

const checklistSchema = {
  type: Type.OBJECT,
  properties: {
    purposeLabel: { type: Type.STRING },
    purposeGuess: { type: Type.STRING, enum: [...VISA_PURPOSES], nullable: true },
    purposeReasoning: { type: Type.STRING, nullable: true },
    variantLabel: { type: Type.STRING, nullable: true },
    requirementGroups: { type: Type.ARRAY, items: requirementGroupSchema },
    questions: { type: Type.ARRAY, items: questionSchema },
  },
  required: ["purposeLabel", "requirementGroups", "questions"],
} as const;

const visaChecklistDocumentSchema = {
  type: Type.OBJECT,
  properties: {
    destinationName: { type: Type.STRING },
    checklists: { type: Type.ARRAY, items: checklistSchema },
  },
  required: ["destinationName", "checklists"],
} as const;

function buildCatalogueListing(): string {
  return VISA_DOCUMENT_TYPE_CATALOGUE.map((d) => {
    const aliasText = d.aliases.length ? ` | also known as: ${d.aliases.join(", ")}` : "";
    return `- ${d.code} — ${d.name} (${d.category}): ${d.defaultDescription}${aliasText}`;
  }).join("\n");
}

const SYSTEM_PROMPT = `
You are transcribing a country's visa document checklist PDF. Return ONLY
valid JSON matching the provided response schema. Never invent a value you
cannot actually see in the document — every string you output must be
something the PDF actually says, or null if it isn't there.

DOCUMENT TYPE MAPPING — the platform's existing document-type catalogue is
below. For EVERY document you extract, also decide whether it is the SAME
real-world document as one of these catalogue entries, even when the
wording differs:
- a source typo or word-order difference ("Employement contract" / "NOC
  from the employer") still counts as the same document as "Employment
  Contract" / "Employer NOC" if you're confident that's what it means.
- a locally-known name for the same real thing counts too — e.g. "National
  ID" on an Indian applicant's checklist means the Aadhaar card, which is
  the same underlying document concept as a national identity proof, if a
  catalogue entry for that exists; if it doesn't, say so (null) rather than
  picking the closest-sounding but substantively different entry.
- pick documentTypeCode ONLY when you are genuinely confident it is the
  same document — a related-but-different document (e.g. a bank statement
  belonging to a SPONSOR vs. the applicant's own) is NOT a match just
  because both are "a bank statement". When in doubt, use null.
- documentTypeCode must be one of the codes listed below, or null — never a
  code you make up, never a code that isn't in this list.
- documentTypeConfidence: "HIGH" for an unambiguous alias/synonym match or
  an unmistakable real-world equivalence (e.g. Aadhaar = national ID);
  "MEDIUM" when you believe it's the same document but the wording leaves
  some real doubt; "LOW" when you are only guessing. Always null when
  documentTypeCode is null.
- documentTypeReasoning: ONE short line explaining your call, ALWAYS
  filled in — both when you matched something ("alias match" / "Aadhaar is
  India's national ID") and when you didn't ("no catalogue entry covers a
  previous/expired passport copy").

Catalogue (code — name (category): description | aliases):
${buildCatalogueListing()}

STRUCTURE:
- One PDF can contain SEVERAL distinct checklists — for example a separate
  table for "Tourist" and "Business" purposes, or a standard checklist
  PLUS a second, much shorter checklist for applicants who already hold
  another country's visa (a "variant"). Each distinct checklist table
  becomes its own entry in checklists[].
- purposeLabel is that table's own heading/purpose (e.g. "Tourist",
  "Business", "Visitor"), verbatim.
- purposeGuess classifies that SAME checklist's travel purpose into one of
  TOURIST, BUSINESS, TOURIST_OR_BUSINESS, TRANSIT, or null. Base this on
  the checklist's heading AND its content (row labels/descriptions), not
  the heading alone:
  - TOURIST: leisure, holiday, sightseeing, or general "visitor" travel.
  - BUSINESS: commercial/business travel (meetings, conferences, trade).
  - TOURIST_OR_BUSINESS: ONLY when the checklist is explicitly for a
    single COMBINED visa category naming both at once — e.g. a US "B1/B2"
    visitor visa, which by definition covers business (B1) and tourism
    (B2) together. This is not a vague "not sure" fallback — use it only
    when the checklist itself names a combined category like that.
  - TRANSIT: airport/onward-travel transit only.
  - null: the heading and content genuinely state or imply none of the
    above (e.g. a generic "Document Checklist" with no purpose-specific
    language anywhere in the table) — do not guess.
  Worked examples: "UAE (Dubai)Tourist Visa Checklist" is TOURIST even
  though the heading has no space before "Tourist" — read the whole word,
  not a tokenised split. "United States B1/B2 Visa Checklist" is
  TOURIST_OR_BUSINESS because B1/B2 is literally the US combined
  business/tourist visitor-visa category, not an unresolved guess.
- purposeReasoning: ONE short line explaining the purposeGuess call,
  ALWAYS filled in (e.g. "heading says Tourist" / "B1/B2 is the US
  combined business/tourist visitor visa" / "no purpose stated anywhere in
  this document").
- variantLabel is null for the primary/standard checklist of a purpose.
  Set it (verbatim) ONLY when the table itself is explicitly a variant of
  an already-covered purpose for a specific kind of applicant — e.g. a
  table titled "Visitor Visa Checklist (For USA visa holder)" is the
  SAME purpose ("Visitor") as the standard one, with variantLabel "For
  USA visa holder".
- If the PDF has a separate "Additional Information Required" or
  questionnaire-style table (a list of questions, not documents), and it
  is not clearly tied to only one of the checklists above, attach its
  questions to EVERY checklist you extracted from this document.

REQUIREMENT ROWS:
- label is the row's own title/name, VERBATIM — do not paraphrase or
  clean it up, even when the title itself IS a condition (e.g. a row
  literally titled "If retired" keeps that exact text as its label).
- requirement is "CONDITIONAL" when the row only applies in some
  circumstance (its title starts with "If ...", or its description says
  "if applicable", "if sponsored", etc.). Otherwise "REQUIRED".
- conditionText: when CONDITIONAL, the exact conditional phrase — often
  the label itself, or a phrase from the description (e.g. "If self
  employed", "if requested by immigration on arrival"). null when REQUIRED.
- documents: when a row's description lists SEVERAL distinct physical
  documents (e.g. "Last 3 months salary slips, Employment contract, NOC
  from the employer and Form 16"), split them into SEPARATE entries here —
  one per physical document, each with its own short name and a
  description ONLY if the source text gives that specific document its
  own distinguishing detail. When a row asks for only ONE physical
  document, documents has exactly one entry, and its own description
  should usually be null — put the row's descriptive/threshold text in
  specificationText instead (see below).
- specificationText: verbatim country-specific instructions or thresholds
  for the row as a whole — photo dimensions, bank-balance-per-day amounts,
  validity windows, page counts, etc. Populate this for a single-document
  row; leave it null for a multi-document row (each document's own name
  already says what it is).
- templateReference: verbatim, only when the PDF names or links a
  specific template/form for this row (e.g. "Employer NOC Template",
  "Cover Letter Template"). null otherwise.

QUESTIONS (only if the PDF has a questionnaire/"additional information"
section):
- prompt: the question, verbatim.
- detailsText: the verbatim guidance in the same row about how to answer
  it (options, conditional sub-fields, format) — null if there is none.

Never invent a checklist, a document, a condition, or a question that
isn't actually printed in this PDF. If a PDF has only one checklist and no
questionnaire, checklists has exactly one entry with questions: [].
`.trim();

async function generateRawCandidate(args: {
  ai: GoogleGenAI;
  model: string;
  base64: string;
  mimeType: string;
  sourceFile: string;
  repairFocus?: string | null;
}): Promise<{ raw: RawExtractedVisaChecklistDocument; rawText: string }> {
  const { ai, model, base64, mimeType, sourceFile, repairFocus } = args;

  const userText = repairFocus
    ? `Previous attempt failed: ${repairFocus}\nRe-read the checklist carefully and try again.`
    : `Extract every checklist (and questionnaire, if present) from this visa document checklist PDF (source file: ${sourceFile}).`;

  const resp = await withGeminiTransientRetry(
    () =>
      ai.models.generateContent({
        model,
        contents: {
          parts: [{ text: userText }, { inlineData: { data: base64, mimeType } }],
        },
        config: {
          systemInstruction: SYSTEM_PROMPT,
          responseMimeType: "application/json",
          responseSchema: visaChecklistDocumentSchema as any,
        },
      }),
    (attempt, delayMs, err) => {
      console.warn(
        `[extractVisaChecklistGemini] Gemini ${err.status} — retrying (attempt ${attempt}/3) in ${delayMs}ms`,
      );
    },
  );

  const text = (resp.text || "").trim();
  if (!text) throw new Error("No response from model");

  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Model returned invalid JSON");
  }

  return { raw: parsed as RawExtractedVisaChecklistDocument, rawText: text };
}

export interface VisaChecklistExtractionResult {
  raw: RawExtractedVisaChecklistDocument;
  model: string;
  rawText: string;
}

export async function extractVisaChecklistViaGemini(opts: {
  buffer: Buffer;
  mimeType: string;
  sourceFile: string;
}): Promise<VisaChecklistExtractionResult> {
  const ai = getAI();
  const modelName = (process.env.GEMINI_MODEL && process.env.GEMINI_MODEL.trim()) || DEFAULT_MODEL;
  const base64 = opts.buffer.toString("base64");

  let raw: RawExtractedVisaChecklistDocument;
  let rawText: string;

  try {
    const r1 = await generateRawCandidate({
      ai,
      model: modelName,
      base64,
      mimeType: opts.mimeType,
      sourceFile: opts.sourceFile,
      repairFocus: null,
    });
    raw = r1.raw;
    rawText = r1.rawText;
  } catch (err: any) {
    // A transient-upstream error already ran its own 3-attempt backoff
    // retry inside generateRawCandidate; if it's still here, that's
    // exhausted (or a non-retryable error to begin with) — same "don't
    // reinterpret a real failure as a JSON problem" posture as
    // extractPassportGemini.ts.
    if (err?.name === "ApiError") throw err;

    // Retry once for JSON stability — mirrors voucherExtractorGemini.ts /
    // extractPassportGemini.ts's convention.
    const r2 = await generateRawCandidate({
      ai,
      model: modelName,
      base64,
      mimeType: opts.mimeType,
      sourceFile: opts.sourceFile,
      repairFocus: "Previous attempt returned invalid JSON. Output strictly valid JSON only.",
    });
    raw = r2.raw;
    rawText = r2.rawText;
  }

  return { raw, model: modelName, rawText };
}
