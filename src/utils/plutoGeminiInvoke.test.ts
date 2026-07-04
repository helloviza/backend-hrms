import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mock handle so the factory (hoisted by vitest) can reference it.
const { generateContentMock } = vi.hoisted(() => ({ generateContentMock: vi.fn() }));

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: () => ({ generateContent: generateContentMock }),
  })),
}));

import { invokePlutoGemini, GEMINI_FALLBACK_INVALID } from "./plutoGeminiInvoke.js";

function geminiText(obj: unknown) {
  return { response: { text: () => JSON.stringify(obj) } };
}

beforeEach(() => {
  generateContentMock.mockReset();
});

describe("invokePlutoGemini — fallback validation", () => {
  it("valid reply passes through on the first attempt (no retry)", async () => {
    generateContentMock.mockResolvedValueOnce(geminiText({ handoff: false, context: "ok" }));

    const reply = await invokePlutoGemini("plan a trip");

    expect(reply.handoff).toBe(false);
    expect(reply.context).toBe("ok");
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it("invalid → retry once → valid: returns the corrected reply", async () => {
    generateContentMock
      .mockResolvedValueOnce(geminiText({ nope: 1 })) // invalid: no meaningful field
      .mockResolvedValueOnce(geminiText({ handoff: true, title: "Fixed" }));

    const reply = await invokePlutoGemini("plan a trip");

    expect(reply.title).toBe("Fixed");
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("invalid twice → throws the GEMINI_FALLBACK_INVALID marker", async () => {
    generateContentMock
      .mockResolvedValueOnce(geminiText({ nope: 1 }))
      .mockResolvedValueOnce(geminiText({ still: "bad" }));

    await expect(invokePlutoGemini("plan a trip")).rejects.toThrow(GEMINI_FALLBACK_INVALID);
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("transport/parse failure throws the generic engines-unavailable error", async () => {
    generateContentMock.mockRejectedValueOnce(new Error("network down"));

    await expect(invokePlutoGemini("plan a trip")).rejects.toThrow(
      "Both AI engines are currently unavailable.",
    );
  });
});
