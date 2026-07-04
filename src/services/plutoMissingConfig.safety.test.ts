// Step 2 — MISSING-CONFIG SAFETY PROOF. With all Pluto-optional vars (and the
// OpenAI primary key) unset, the Pluto pieces must DEGRADE, not crash: the boot
// check warns, the AI client no longer crashes at import (degrades to Gemini),
// WhatsApp sends fall back, and the worker/stream defaults hold.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkAiProviderKeys, runPlutoBootCheck } from "./plutoBootCheck.js";

const PLUTO_OPTIONAL = [
  "OPENAI_API_KEY", "WA_APP_SECRET", "WA_ACCESS_TOKEN", "WA_PHONE_NUMBER_ID", "WA_VERIFY_TOKEN",
  "WA_DISRUPTION_TEMPLATE", "WA_ARRIVAL_TEMPLATE", "PLUTO_CONVERSATION_TTL_DAYS",
  "WATCH_MAX_CALLS_PER_CYCLE", "CONCIERGE_SSE_HEARTBEAT_MS", "PLUTO_METRICS", "PLUTO_DEBUG",
  "PLUTO_BOOT_PING", "FLIGHTAWARE_API_KEY",
];

beforeEach(() => {
  for (const k of PLUTO_OPTIONAL) delete process.env[k];
});

describe("missing-config safety proof — Pluto degrades, never crashes", () => {
  it("AI boot check WARNS (does not throw) when the primary key is missing", async () => {
    const chk = checkAiProviderKeys({ GEMINI_API_KEY: "g" }); // OpenAI missing, Gemini present
    expect(chk.openaiPresent).toBe(false);
    expect(chk.warnings.join(" ")).toMatch(/OPENAI_API_KEY missing.*Gemini fallback/i);
    const log = { warn: vi.fn(), log: vi.fn() };
    await expect(runPlutoBootCheck({ env: { GEMINI_API_KEY: "g" }, logger: log })).resolves.toBeDefined();
    expect(log.warn).toHaveBeenCalled(); // loud warning, no throw
  });

  it("plutoInvoke imports WITHOUT the key (no boot crash) and rejects only at call time", async () => {
    // The fix: lazy OpenAI client — importing must not construct it.
    const mod = await import("../utils/plutoInvoke.js");
    expect(typeof mod.invokePluto).toBe("function"); // import succeeded with OPENAI_API_KEY unset
    // Calling it degrades with a clear error (the concierge handler's catch → Gemini).
    await expect(mod.invokePluto("hi")).rejects.toThrow(/OPENAI_API_KEY is not configured/);
  });

  it("WhatsApp sends fall back safely when the Cloud API is unconfigured", async () => {
    const wa = await import("./whatsappCloud.service.js");
    expect(wa.isWhatsAppCloudConfigured()).toBe(false);
    // Outcome-returning senders report false (→ notifier falls back to email); the
    // fire-and-forget senders resolve without throwing.
    await expect(wa.sendTemplateMessage("919", "t", [])).resolves.toBe(false);
    await expect(wa.sendTextMessageResult("919", "hi")).resolves.toBe(false);
    await expect(wa.sendTextMessage("919", "hi")).resolves.toBeUndefined();
    await expect(wa.sendButtonMessage("919", "hi", [{ id: "x", title: "X" }])).resolves.toBeUndefined();
  });

  it("arrival greeting uses the FREE-FORM path when WA_ARRIVAL_TEMPLATE is unset", async () => {
    // With no template env, sendArrivalGreeting must take the free-form sender.
    const { sendArrivalGreeting } = await import("./arrivalSession.js");
    const wa = await import("./whatsappCloud.service.js");
    const tpl = vi.spyOn(wa, "sendTemplateMessage");
    const free = vi.spyOn(wa, "sendTextMessageResult").mockResolvedValue(true);
    vi.spyOn(wa, "sendButtonMessage").mockResolvedValue(undefined);
    await sendArrivalGreeting({ phone: "+919876543210", destinationCity: "Mumbai", hotel: null });
    expect(tpl).not.toHaveBeenCalled();      // template path skipped (unset)
    expect(free).toHaveBeenCalledTimes(1);   // free-form fallback used
  });
});
