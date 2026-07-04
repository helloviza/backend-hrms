// apps/backend/src/utils/plutoInvoke.ts

import OpenAI from "openai";
import { isValidPlutoReply } from "./plutoValidator.js";
import { PLUTO_AI_SYSTEM_PROMPT } from "../prompts/plutoSystemPrompt.js";
import type { PlutoDeltaReply } from "../types/plutoDelta.js";


// Lazy OpenAI client — constructing it eagerly at import throws when
// OPENAI_API_KEY is unset (the SDK rejects an empty key), which would crash boot.
// Deferring construction lets the server BOOT without the primary key (the boot
// check warns) and DEGRADE to the Gemini fallback: invokePluto then rejects at
// call time and the concierge handler's catch switches to Gemini.
let _client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not configured — Pluto primary (OpenAI) tier unavailable");
    }
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

/**
 * Extract first JSON object from LLM output safely
 */
function extractJson(text: string): unknown {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("No JSON object found in Pluto response");
  }
  const jsonText = text.slice(firstBrace, lastBrace + 1);
  return JSON.parse(jsonText);
}

export async function invokePluto(prompt: string): Promise<PlutoDeltaReply> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const messages = [
      {
        role: "system" as const,
        content: PLUTO_AI_SYSTEM_PROMPT,
      },
      {
        role: "user" as const,
        content: prompt,
      },
    ];

    /**
     * 🔁 Retry instruction (DELTA-AWARE, FIX #3/#4 SAFE)
     */
    if (attempt === 2) {
      messages.push({
        role: "system" as const,
        content: `
Your previous response failed validation.

Rules:
- Return ONLY a valid JSON object
- You MAY return a PARTIAL (delta) response
- Include ONLY fields relevant to the user request
- "handoff" MUST be present and MUST be a boolean
- "itinerary" is OPTIONAL and allowed ONLY if explicitly requested
- Do NOT include markdown, explanations, or extra keys
`,
      });
    }

    try {
      const res = await getClient().chat.completions.create({
        model: "gpt-4.1-mini",
        temperature: 0.25,
        max_tokens: 1200,
        messages,
      });

      const text = res.choices[0]?.message?.content;
      if (!text) throw new Error("Empty Pluto.ai response");

      let parsed: any;
      try {
        parsed = extractJson(text);
      } catch (err) {
        lastError = err;
        continue; // retry
      }

      /**
       * 🧹 Normalization (DELTA-SAFE)
       * Do NOT force empty arrays — that breaks delta semantics
       */
     const normalized: PlutoDeltaReply = {
  ...parsed,

        // handoff must always exist (Fix #4)
        handoff:
    typeof parsed.handoff === "boolean"
      ? parsed.handoff
      : false,

        // optional fields stay optional
        itinerary: parsed.itinerary ?? undefined,
        hotels: parsed.hotels ?? undefined,
        nextSteps: parsed.nextSteps ?? undefined,
      };

      if (isValidPlutoReply(normalized)) {
        return normalized;
      }

      lastError = "Schema validation failed";
    } catch (err) {
      lastError = err;
    }
  }

  throw new Error(
    lastError instanceof Error
      ? lastError.message
      : "Pluto.ai returned an invalid response format"
  );
}