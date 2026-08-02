// apps/backend/src/services/extractVisaChecklistGemini.ts
//
// Phase 10c (checklist-PDF extraction) — mirrors services/
// voucherExtractorGemini.ts / extractPassportGemini.ts exactly: same
// @google/genai SDK, same singleton client, same schema-constrained
// (responseSchema + responseMimeType:"application/json") call shape, same
// utils/geminiRetry.ts transient-retry wrapper, same "retry once more on
// invalid JSON" fallback. No new dependency.
//
// This is the RAW extraction stage only — it transcribes what the PDF
// literally says (document names, row descriptions, conditions, template
// references, questionnaire rows) and nothing else. It NEVER maps a
// document name to a VisaDocumentType code, never structures a condition
// into an appliesWhen predicate, and never resolves a template reference
// against VisaTemplate — that is utils/visaChecklistCatalogueMatcher.ts's
// job, a separate, deterministic (non-LLM) step, exactly so a taxonomy
// decision ("is this the same document as X, under a different name?")
// is never made by a model that could be wrong in a way nobody reviews.
//
// One PDF can hold several checklists (task brief §2): France/UK/China
// print separate Tourist and Business tables in one document; Canada
// prints a standard table AND a second, much shorter table for a US-visa-
// holder variant. Both cases are just multiple entries in `checklists[]`
// — nothing here decides variantKey/applicability, that's the matcher's
// job too, working off `variantLabel`.
import { GoogleGenAI, Type } from "@google/genai";
import { withGeminiTransientRetry } from "../utils/geminiRetry.js";

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

export interface RawExtractedDocument {
  name: string;
  description: string | null;
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

const SYSTEM_PROMPT = `
You are transcribing a country's visa document checklist PDF. Return ONLY
valid JSON matching the provided response schema. Never invent a value you
cannot actually see in the document — every string you output must be
something the PDF actually says, or null if it isn't there.

STRUCTURE:
- One PDF can contain SEVERAL distinct checklists — for example a separate
  table for "Tourist" and "Business" purposes, or a standard checklist
  PLUS a second, much shorter checklist for applicants who already hold
  another country's visa (a "variant"). Each distinct checklist table
  becomes its own entry in checklists[].
- purposeLabel is that table's own heading/purpose (e.g. "Tourist",
  "Business", "Visitor"), verbatim.
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
