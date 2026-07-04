import { describe, it, expect, vi } from "vitest";
import { checkAiProviderKeys, runPlutoBootCheck } from "./plutoBootCheck.js";

describe("checkAiProviderKeys", () => {
  it("both present → no warnings", () => {
    const r = checkAiProviderKeys({ OPENAI_API_KEY: "a", GEMINI_API_KEY: "b" });
    expect(r).toEqual({ openaiPresent: true, geminiPresent: true, warnings: [] });
  });

  it("OpenAI missing → primary-tier warning", () => {
    const r = checkAiProviderKeys({ GEMINI_API_KEY: "b" });
    expect(r.openaiPresent).toBe(false);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/PRIMARY tier unavailable/);
  });

  it("Gemini missing → fallback-tier warning", () => {
    const r = checkAiProviderKeys({ OPENAI_API_KEY: "a" });
    expect(r.geminiPresent).toBe(false);
    expect(r.warnings[0]).toMatch(/FALLBACK tier unavailable/);
  });

  it("both missing → fully-unavailable warning", () => {
    const r = checkAiProviderKeys({});
    expect(r.warnings[0]).toMatch(/fully UNAVAILABLE/);
  });

  it("blank/whitespace keys count as missing", () => {
    const r = checkAiProviderKeys({ OPENAI_API_KEY: "   ", GEMINI_API_KEY: "" });
    expect(r.openaiPresent).toBe(false);
    expect(r.geminiPresent).toBe(false);
  });
});

describe("runPlutoBootCheck", () => {
  const logger = { warn: vi.fn(), log: vi.fn() };

  it("logs warnings but never throws for a missing tier", async () => {
    await expect(
      runPlutoBootCheck({ env: { OPENAI_API_KEY: "a" }, logger }),
    ).resolves.toMatchObject({ geminiPresent: false });
  });

  it("runs the Gemini ping only when PLUTO_BOOT_PING=true and gemini present", async () => {
    const ping = vi.fn().mockResolvedValue({});
    await runPlutoBootCheck({ env: { OPENAI_API_KEY: "a", GEMINI_API_KEY: "b", PLUTO_BOOT_PING: "true" }, pingGemini: ping, logger });
    expect(ping).toHaveBeenCalledTimes(1);

    ping.mockClear();
    await runPlutoBootCheck({ env: { GEMINI_API_KEY: "b" }, pingGemini: ping, logger }); // flag off
    expect(ping).not.toHaveBeenCalled();
  });

  it("a failing ping is caught (no throw)", async () => {
    const ping = vi.fn().mockRejectedValue(new Error("gemini down"));
    await expect(
      runPlutoBootCheck({ env: { GEMINI_API_KEY: "b", PLUTO_BOOT_PING: "true" }, pingGemini: ping, logger }),
    ).resolves.toBeTruthy();
    expect(ping).toHaveBeenCalled();
  });
});
