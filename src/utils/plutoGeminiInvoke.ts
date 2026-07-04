// apps/backend/src/utils/plutoGeminiInvoke.ts
import { GoogleGenerativeAI } from "@google/generative-ai";
import { isValidPlutoReply } from "./plutoValidator.js";

// Distinct marker thrown when Gemini returns a schema-invalid reply even after
// a corrective retry. The caller uses it to emit pluto.ai.fallback_invalid
// (vs pluto.ai.error for a transport/parse failure) and to return a loud 500,
// rather than passing malformed JSON into lockDecisions/nextSteps downstream.
export const GEMINI_FALLBACK_INVALID = "GEMINI_FALLBACK_INVALID";

// Set up Gemini with your key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Mirrors the corrective retry instruction used by the OpenAI path
// (plutoInvoke.ts) so the fallback gets a comparable second chance.
const RETRY_INSTRUCTION = `
Your previous response failed validation.

Rules:
- Return ONLY a valid JSON object
- You MAY return a PARTIAL (delta) response
- Include ONLY fields relevant to the user request
- "handoff" MUST be present and MUST be a boolean
- "itinerary" is OPTIONAL and allowed ONLY if explicitly requested
- Do NOT include markdown, explanations, or extra keys
`;

function extractGeminiJson(text: string): any {
  // Gemini sometimes wraps JSON in ```json fences.
  const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
  return JSON.parse(cleaned);
}

// DELTA-SAFE normalization (mirrors plutoInvoke): handoff must always be a
// boolean; optional fields stay optional.
function normalize(parsed: any): any {
  return {
    ...parsed,
    handoff: typeof parsed.handoff === "boolean" ? parsed.handoff : false,
    itinerary: parsed.itinerary ?? undefined,
    hotels: parsed.hotels ?? undefined,
    nextSteps: parsed.nextSteps ?? undefined,
  };
}

export async function invokePlutoGemini(prompt: string): Promise<any> {
  let currentPrompt = prompt;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let parsed: any;
    try {
      const result = await model.generateContent(currentPrompt);
      const response = await result.response;
      const text = response.text();
      parsed = extractGeminiJson(text);
    } catch (error) {
      // Transport / non-JSON failure — not a schema problem.
      console.error("Gemini invocation failed:", error);
      throw new Error("Both AI engines are currently unavailable.");
    }

    const normalized = normalize(parsed);
    if (isValidPlutoReply(normalized)) {
      return normalized;
    }

    // Schema-invalid — retry ONCE with a corrective instruction, then give up.
    if (attempt === 1) {
      console.warn("[Pluto] Gemini fallback failed validation — retrying once");
      currentPrompt = `${prompt}\n\n${RETRY_INSTRUCTION}`;
      continue;
    }
  }

  // Still invalid after the retry — throw the distinct marker so the caller can
  // classify it and fail loudly instead of returning malformed JSON.
  throw new Error(GEMINI_FALLBACK_INVALID);
}
