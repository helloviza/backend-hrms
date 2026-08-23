// apps/backend/src/utils/plutoCityNormalize.ts
//
// STAGE 2 of city resolution: turn free text the catalog could not match into a
// CANONICAL CITY NAME to try again with.
//
// WHAT THIS IS FOR. The deterministic ladder in plutoHotelDestination handles
// exact / prefix / token matching against `tbocities`. What it cannot do is
// spelling: Mongo's $text index is not fuzzy, so "Vishakhapatnam" (one extra
// 'h') scores literally zero hits against "vizag visakhapatnam andhra pradesh".
// A model is good at exactly that one job and bad at everything else here.
//
// THE HARD RULE: this returns a NAME, never a cityCode, never a countryCode,
// never coordinates. Its output is fed straight back through the same catalog
// ladder and is only believed if the catalog confirms it. A model that
// hallucinates "Vishakhapatnam" as a real city we can book is therefore
// harmless — the catalog says no and the turn hands off honestly. The model can
// influence WHICH row we look up; it can never invent a bookable destination.
//
// It is also the LAST resort, not a first pass: it runs only when every
// deterministic stage returned zero, so the common path never pays for it and
// never depends on it.

import { GoogleGenerativeAI } from "@google/generative-ai";

/** Bounded so a slow model can't hold a chat turn open. */
const NORMALIZE_TIMEOUT_MS = 4000;

/** Guardrail on the reply: a city name, not a sentence. */
const MAX_NAME_LEN = 60;

/**
 * NOT gemini-1.5-flash. That model is RETIRED — the endpoint answers 404
 * ("is not found for API version v1beta"), so anything still pointing at it
 * fails silently on every call. gemini-2.5-flash is pinned rather than an
 * auto-updating `-latest` alias, so this step cannot change behaviour under us
 * without a deliberate edit.
 *
 * (utils/plutoGeminiInvoke.ts and services/ticketIngestion.ts were still on
 * gemini-1.5-flash when this note was first written — both repointed here too,
 * so no live call site targets the retired model any more.)
 */
const MODEL = "gemini-2.5-flash";

let client: GoogleGenerativeAI | null = null;
function genAI(): GoogleGenerativeAI | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  if (!client) client = new GoogleGenerativeAI(key);
  return client;
}

const PROMPT = (raw: string) => `You correct place names for a hotel booking system.

The user typed: "${raw}"

If this is a misspelling, abbreviation, nickname or alternate name of a REAL city,
reply with that city's most common English name. Examples of the transformation:
  "Vishakhapatnam" -> Visakhapatnam
  "Bangalore" -> Bangalore
  "NYC" -> New York
  "Bombay" -> Mumbai

Rules:
- Reply with ONLY the city name. No country, no state, no punctuation, no explanation.
- If it is not a place at all, or you are not confident it is a real city, reply exactly: UNKNOWN
- Never invent a city. UNKNOWN is always better than a guess.`;

/**
 * Free text → a candidate city NAME, or null.
 *
 * Never throws: a model outage, a missing API key or a junk reply all degrade to
 * null, which leaves the caller exactly where it was (an honest UNSUPPORTED)
 * rather than failing the turn.
 */
export async function normalizeCityNameWithLLM(raw: string): Promise<string | null> {
  const input = String(raw || "").trim();
  if (!input || input.length > MAX_NAME_LEN) return null;

  const ai = genAI();
  if (!ai) return null;

  try {
    const model = ai.getGenerativeModel({ model: MODEL });

    const result = await Promise.race([
      model.generateContent(PROMPT(input)),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), NORMALIZE_TIMEOUT_MS)),
    ]);
    if (!result) return null;

    const text = String((result as any)?.response?.text?.() ?? "").trim();
    if (!text) return null;

    // Take the first line only — the instruction says name-only, but a model
    // that adds a sentence must not poison the catalog lookup with it.
    const first = text.split(/\r?\n/)[0].replace(/^["'`]+|["'`.,]+$/g, "").trim();

    if (!first || first.length > MAX_NAME_LEN) return null;
    if (/^unknown$/i.test(first)) return null;

    // Must look like a place name, not prose. Letters, spaces, hyphens and
    // apostrophes only; reject anything with digits or sentence punctuation.
    if (!/^[\p{L}][\p{L}\s'\-.]*$/u.test(first)) return null;

    // A reply identical to the input tells us nothing the catalog didn't
    // already reject — treat it as no answer rather than looping on it.
    if (first.toLowerCase() === input.toLowerCase()) return null;

    return first;
  } catch {
    return null;
  }
}
