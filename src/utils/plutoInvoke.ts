// apps/backend/src/utils/plutoInvoke.ts

import OpenAI from "openai";
import { isValidPlutoReply, isThinReply } from "./plutoValidator.js";
import { PLUTO_AI_SYSTEM_PROMPT } from "../prompts/plutoSystemPrompt.js";
import type { PlutoDeltaReply } from "../types/plutoDelta.js";

// Enforcement options (Step 3 — substance). requireSubstance is set by the
// caller ONLY when the trip is already plannable (destination + duration known);
// then a shape-valid-but-thin reply earns ONE corrective retry. If it is STILL
// thin after the retry we ACCEPT it (enforcement must never turn a thin reply
// into a user-facing error) and call onThinAccepted so the caller can emit
// pluto.reply.thin_accepted.
export interface PlutoInvokeOptions {
  requireSubstance?: boolean;
  onThinAccepted?: () => void;
}

// Corrective instruction when a reply failed SCHEMA validation.
const SCHEMA_RETRY_INSTRUCTION = `
Your previous response failed validation.

Rules:
- Return ONLY a valid JSON object
- You MAY return a PARTIAL (delta) response
- Include ONLY fields relevant to the user request
- "handoff" MUST be present and MUST be a boolean
- "itinerary" is OPTIONAL and allowed ONLY if explicitly requested
- Do NOT include markdown, explanations, or extra keys
`;

// Corrective instruction when a reply was shape-valid but THIN (Step 3).
const SUBSTANCE_RETRY_INSTRUCTION = `
Your previous reply was too thin. The destination and trip duration are already
known, so you MUST now return:
- an "itinerary" array: a draft day-by-day skeleton the user can refine (label it
  clearly as a draft).
- a "context" of at least 2-3 substantive sentences (never a bare destination echo).
- in "nextSteps", ask ONLY the highest-priority missing detail(s) as direct
  questions (travel dates and origin city come before anything else).
Return ONLY the JSON object.
`;

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

export async function invokePluto(
  prompt: string,
  opts: PlutoInvokeOptions = {}
): Promise<PlutoDeltaReply> {
  const requireSubstance = opts.requireSubstance === true;
  let lastError: unknown = null;
  // Which corrective instruction (if any) to prepend on the 2nd attempt.
  let corrective: "schema" | "substance" | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const messages = [
      { role: "system" as const, content: PLUTO_AI_SYSTEM_PROMPT },
      { role: "user" as const, content: prompt },
    ];

    if (attempt === 2 && corrective === "schema") {
      messages.push({ role: "system" as const, content: SCHEMA_RETRY_INSTRUCTION });
    }
    if (attempt === 2 && corrective === "substance") {
      messages.push({ role: "system" as const, content: SUBSTANCE_RETRY_INSTRUCTION });
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
        corrective = "schema";
        continue; // retry
      }

      /**
       * 🧹 Normalization (DELTA-SAFE)
       * Do NOT force empty arrays — that breaks delta semantics
       */
      const normalized: PlutoDeltaReply = {
        ...parsed,
        // handoff must always exist (Fix #4)
        handoff: typeof parsed.handoff === "boolean" ? parsed.handoff : false,
        // optional fields stay optional
        itinerary: parsed.itinerary ?? undefined,
        hotels: parsed.hotels ?? undefined,
        nextSteps: parsed.nextSteps ?? undefined,
      };

      if (!isValidPlutoReply(normalized)) {
        lastError = "Schema validation failed";
        corrective = "schema";
        continue; // retry with schema instruction
      }

      // Shape-valid. Enforce SUBSTANCE only when the caller asked for it.
      if (requireSubstance && isThinReply(normalized)) {
        if (attempt === 1) {
          lastError = "Thin reply";
          corrective = "substance";
          continue; // ONE corrective retry
        }
        // Still thin after the retry → ACCEPT (never a user-facing error).
        opts.onThinAccepted?.();
        return normalized;
      }

      return normalized;
    } catch (err) {
      lastError = err;
      // A transport error on attempt 1 still earns a plain retry.
      corrective = corrective ?? "schema";
    }
  }

  throw new Error(
    lastError instanceof Error
      ? lastError.message
      : "Pluto.ai returned an invalid response format"
  );
}
