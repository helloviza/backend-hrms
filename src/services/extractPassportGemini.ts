// apps/backend/src/services/extractPassportGemini.ts
//
// Phase 4b, Stage 1 — mirrors services/voucherExtractorGemini.ts's SDK
// usage (same @google/genai singleton, same base64-image + schema-
// constrained JSON call shape, same retry-once-on-invalid-JSON pattern)
// but asks Gemini for exactly ONE thing per zone: the two raw MRZ lines,
// verbatim, as strings — it does NOT ask the model to interpret, split, or
// structure those fields, since that is deliberately deterministic code,
// see utils/mrz.ts. A passport's MRZ carries five check digits; asking the
// model to read structured fields directly would throw that verification
// away.
//
// Visual Inspection Zone (VIZ) follow-up (2026-07-29): the bio-data page
// also prints fields that never make it into the MRZ at all — date of
// issue, place of birth, place of issue — plus printed versions of most MRZ
// fields. Unlike the MRZ, VIZ has no check digits, so there is nothing to
// verify deterministically; the model's structured read IS the data, for
// better or worse. Requested in the SAME call as the MRZ (one image, one
// round trip) but kept in a clearly separate `viz` branch of the response
// schema — never flattened together with the MRZ fields — because
// services/visaPassportExtraction.ts needs to know, per field, which zone a
// value came from: MRZ fields stay check-digit-verified; VIZ fields are
// ALWAYS unverified, and the two zones get cross-checked against each other
// where they overlap (utils/passportCrossCheck.ts).
//
// Transient-upstream follow-up (2026-07-30): a real extraction hit a Gemini
// 503 ("model is currently experiencing high demand") that just propagated
// straight out — no transcription, no repair attempt, nothing retried. The
// actual `generateContent` call below is now wrapped in
// utils/geminiRetry.ts's withGeminiTransientRetry (429/5xx, exponential
// backoff + jitter, 3 attempts total) — a DIFFERENT retry from the
// "invalid JSON" one a few lines down, with a different cause (a network/
// upstream-availability problem, not a bad response) and different needs
// (backoff, not an instant reprompt). Kept distinct in
// extractPassportMrzViaGemini's catch block too: a transient error that
// already exhausted its own retries is rethrown immediately there, never
// given a second "maybe it's invalid JSON" attempt — that framing wouldn't
// even be true, and the caller (services/visaPassportExtraction.ts) needs
// this to surface as SERVICE_ERROR, not get silently absorbed into another
// retry cycle.
import { GoogleGenAI, Type, ApiError } from "@google/genai";
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

const vizField = { type: Type.STRING, nullable: true } as const;

const mrzVizSchema = {
  type: Type.OBJECT,
  properties: {
    mrz_found: { type: Type.BOOLEAN },
    line1: { type: Type.STRING, nullable: true },
    line2: { type: Type.STRING, nullable: true },
    viz_found: { type: Type.BOOLEAN },
    viz: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        surname: vizField,
        givenNames: vizField,
        dateOfBirth: vizField,
        documentNumber: vizField,
        dateOfExpiry: vizField,
        sex: vizField,
        nationality: vizField,
        dateOfIssue: vizField,
        placeOfBirth: vizField,
        placeOfIssue: vizField,
      },
    },
  },
  required: ["mrz_found", "viz_found"],
} as const;

type RawVizFields = {
  surname?: string | null;
  givenNames?: string | null;
  dateOfBirth?: string | null;
  documentNumber?: string | null;
  dateOfExpiry?: string | null;
  sex?: string | null;
  nationality?: string | null;
  dateOfIssue?: string | null;
  placeOfBirth?: string | null;
  placeOfIssue?: string | null;
};

type RawMrzResponse = {
  mrz_found: boolean;
  line1?: string | null;
  line2?: string | null;
  viz_found?: boolean;
  viz?: RawVizFields | null;
};

const SYSTEM_PROMPT = `
You are reading a passport's photo/bio-data page. It has two DISTINCT zones
printed on it, and you must report them separately, never blending one
zone's reading into the other's — even if they appear to disagree with each
other, report each exactly as it is printed in its own zone.

1. The Machine Readable Zone (MRZ) — the two lines of OCR-B text at the very
   bottom of the page.
2. The Visual Inspection Zone (VIZ) — the ordinary printed fields elsewhere
   on the page, each next to its own printed label (surname, given names,
   dates, passport number, sex, nationality, date of issue, place of birth,
   place of issue, etc).

Return ONLY valid JSON matching the provided response schema.

MRZ rules:
- Transcribe the two MRZ lines EXACTLY as printed, character for character.
- Do NOT interpret, split, translate, or reformat the lines.
- Do NOT expand abbreviations. Do NOT convert "<" fillers to spaces.
- Each line, once transcribed, should read as a string of only capital
  letters A-Z, digits 0-9, and the "<" filler character.
- If the MRZ is not visible, unreadable, or this is not a passport photo
  page, set mrz_found to false and leave line1/line2 null.

VIZ rules:
- Read every VIZ field directly from its own printed label — never copy or
  derive a value from the MRZ, even for fields that also appear there.
- Report dateOfBirth, dateOfExpiry and dateOfIssue as ISO 8601
  "YYYY-MM-DD", regardless of how they're printed (e.g. both "11/01/1993"
  and "11 JAN 1993" become "1993-01-11").
- sex should be "M" or "F" as printed.
- If a VIZ field isn't printed, isn't legible, or the whole VIZ isn't
  visible, leave that specific field null. Only set viz_found to false if
  NONE of the VIZ fields could be read at all.

Never invent a value you cannot actually see, in either zone.
`.trim();

async function generateMrzCandidate(args: {
  ai: GoogleGenAI;
  model: string;
  base64: string;
  mimeType: string;
  repairFocus?: string | null;
}): Promise<{ raw: RawMrzResponse; rawText: string }> {
  const { ai, model, base64, mimeType, repairFocus } = args;

  const userText = repairFocus
    ? `Previous attempt failed: ${repairFocus}\nRe-read the MRZ lines carefully and try again.`
    : "Read this passport's photo page: transcribe the two MRZ lines, and separately capture the printed (visual inspection zone) fields.";

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
          responseSchema: mrzVizSchema as any,
        },
      }),
    (attempt, delayMs, err) => {
      console.warn(
        `[extractPassportGemini] Gemini ${err.status} — retrying (attempt ${attempt}/3) in ${delayMs}ms`,
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

  return { raw: parsed as RawMrzResponse, rawText: text };
}

// VIZ has no check digits — every one of these is inherently unverified, no
// matter how confident the model sounds. See utils/passportCrossCheck.ts for
// how these get compared against the MRZ where the two overlap.
export interface PassportVizFields {
  surname: string | null;
  givenNames: string | null;
  dateOfBirth: string | null; // "YYYY-MM-DD", as instructed in SYSTEM_PROMPT
  documentNumber: string | null;
  dateOfExpiry: string | null; // "YYYY-MM-DD"
  sex: string | null;
  nationality: string | null;
  dateOfIssue: string | null; // "YYYY-MM-DD" — NOT on the MRZ at all
  placeOfBirth: string | null; // NOT on the MRZ at all
  placeOfIssue: string | null; // NOT on the MRZ at all
}

export interface PassportMrzExtractionResult {
  found: boolean;
  line1: string | null;
  line2: string | null;
  // vizFound is independent of `found` — either zone can read while the
  // other fails (glare over the MRZ but a clean bio-data read, or vice
  // versa). A VIZ miss must never affect the MRZ result.
  vizFound: boolean;
  viz: PassportVizFields | null;
  model: string;
  rawText: string;
}

function cleanVizString(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export async function extractPassportMrzViaGemini(opts: {
  buffer: Buffer;
  mimeType: string;
  // Set by services/visaPassportExtraction.ts's own retry-once-on-parse-
  // failure (a DIFFERENT retry from the invalid-JSON one below): when a
  // first attempt transcribed an MRZ that failed the deterministic TD3
  // parse, this carries a prompt stressing exact-44-char lines and
  // preserving trailing "<" filler, used for the one-and-only re-attempt
  // instead of the default "just transcribe" prompt.
  repairHint?: string;
}): Promise<PassportMrzExtractionResult> {
  const ai = getAI();
  const modelName = (process.env.GEMINI_MODEL && process.env.GEMINI_MODEL.trim()) || DEFAULT_MODEL;
  const base64 = opts.buffer.toString("base64");

  let raw: RawMrzResponse;
  let rawText: string;

  try {
    const r1 = await generateMrzCandidate({ ai, model: modelName, base64, mimeType: opts.mimeType, repairFocus: opts.repairHint });
    raw = r1.raw;
    rawText = r1.rawText;
  } catch (err) {
    // A transient-upstream error (ApiError — 429/5xx) already ran its own
    // 3-attempt backoff retry inside generateMrzCandidate above; if it's
    // still here, that's exhausted (or was a non-retryable 4xx to begin
    // with). Either way this is NOT "the call succeeded but returned bad
    // JSON" — rethrow immediately rather than spending another attempt (and
    // a misleading "previous attempt returned invalid JSON" prompt) on a
    // problem a reprompt can't fix. Lets this surface as SERVICE_ERROR up
    // in services/visaPassportExtraction.ts, not get reinterpreted here.
    if (err instanceof ApiError) throw err;

    // Retry once for JSON stability — mirrors voucherExtractorGemini.ts's convention.
    const r2 = await generateMrzCandidate({
      ai,
      model: modelName,
      base64,
      mimeType: opts.mimeType,
      repairFocus: "Previous attempt returned invalid JSON. Output strictly valid JSON only.",
    });
    raw = r2.raw;
    rawText = r2.rawText;
  }

  const line1 = typeof raw.line1 === "string" && raw.line1.trim() ? raw.line1.trim() : null;
  const line2 = typeof raw.line2 === "string" && raw.line2.trim() ? raw.line2.trim() : null;
  const found = raw.mrz_found === true && !!line1 && !!line2;

  const vizRaw = raw.viz && typeof raw.viz === "object" ? raw.viz : null;
  const viz: PassportVizFields | null = vizRaw
    ? {
        surname: cleanVizString(vizRaw.surname),
        givenNames: cleanVizString(vizRaw.givenNames),
        dateOfBirth: cleanVizString(vizRaw.dateOfBirth),
        documentNumber: cleanVizString(vizRaw.documentNumber),
        dateOfExpiry: cleanVizString(vizRaw.dateOfExpiry),
        sex: cleanVizString(vizRaw.sex),
        nationality: cleanVizString(vizRaw.nationality),
        dateOfIssue: cleanVizString(vizRaw.dateOfIssue),
        placeOfBirth: cleanVizString(vizRaw.placeOfBirth),
        placeOfIssue: cleanVizString(vizRaw.placeOfIssue),
      }
    : null;
  // Require at least one non-null field, not just the model's own
  // viz_found=true claim — guards against the model reporting "found" over
  // an otherwise-empty object.
  const vizFound = raw.viz_found === true && !!viz && Object.values(viz).some((v) => v !== null);

  return { found, line1, line2, vizFound, viz, model: modelName, rawText };
}
