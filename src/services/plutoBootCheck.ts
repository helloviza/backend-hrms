// apps/backend/src/services/plutoBootCheck.ts
//
// Startup verification for the Pluto AI provider tiers. NEVER crashes the
// server — a missing fallback only produces a loud warning. The optional Gemini
// boot ping (behind PLUTO_BOOT_PING=true) uses an injected caller so the check
// logic is testable without a network call.

export interface AiKeyCheck {
  openaiPresent: boolean;
  geminiPresent: boolean;
  warnings: string[];
}

/** Pure: inspect the env for the two AI keys and produce warnings. */
export function checkAiProviderKeys(
  env: Record<string, string | undefined> = process.env,
): AiKeyCheck {
  const openaiPresent = Boolean(env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim());
  const geminiPresent = Boolean(env.GEMINI_API_KEY && env.GEMINI_API_KEY.trim());
  const warnings: string[] = [];

  if (!openaiPresent && !geminiPresent) {
    warnings.push(
      "Both OPENAI_API_KEY and GEMINI_API_KEY are missing — Pluto concierge AI is fully UNAVAILABLE.",
    );
  } else if (!openaiPresent) {
    warnings.push(
      "OPENAI_API_KEY missing — Pluto PRIMARY tier unavailable; starting on the Gemini fallback only.",
    );
  } else if (!geminiPresent) {
    warnings.push(
      "GEMINI_API_KEY missing — Pluto FALLBACK tier unavailable; no backup if OpenAI fails.",
    );
  }

  return { openaiPresent, geminiPresent, warnings };
}

export interface BootCheckOptions {
  env?: Record<string, string | undefined>;
  /** Injected minimal Gemini caller for the optional boot ping. */
  pingGemini?: (prompt: string) => Promise<unknown>;
  logger?: Pick<Console, "warn" | "log">;
}

/**
 * runPlutoBootCheck — logs a loud warning naming the missing tier, and, behind
 * PLUTO_BOOT_PING=true, performs one minimal Gemini call (warn on failure).
 * Always resolves; never throws.
 */
export async function runPlutoBootCheck(opts: BootCheckOptions = {}): Promise<AiKeyCheck> {
  const env = opts.env ?? process.env;
  const log = opts.logger ?? console;
  const check = checkAiProviderKeys(env);

  if (check.warnings.length === 0) {
    log.log("[PLUTO BOOT] AI providers configured (OpenAI primary + Gemini fallback).");
  } else {
    for (const w of check.warnings) log.warn(`[PLUTO BOOT] ⚠ ${w}`);
  }

  if (env.PLUTO_BOOT_PING === "true" && check.geminiPresent && opts.pingGemini) {
    try {
      await opts.pingGemini("ping");
      log.log("[PLUTO BOOT] Gemini boot ping OK.");
    } catch (e: any) {
      log.warn(`[PLUTO BOOT] ⚠ Gemini boot ping FAILED: ${e?.message || e}`);
    }
  }

  return check;
}
