// Coverage for extractPassportMrzViaGemini's error handling — specifically
// that the transient-upstream retry (utils/geminiRetry.ts) and the
// existing "retry once for invalid JSON" stay DISTINCT and don't compound.
// The @google/genai SDK itself is mocked; utils/geminiRetry.ts is REAL
// (not mocked) so this also proves the two modules actually wire together
// — but fake timers are used throughout so backoff delays don't slow the
// suite down.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { generateContentMock } = vi.hoisted(() => ({
  generateContentMock: vi.fn(),
}));

vi.mock("@google/genai", () => {
  class ApiError extends Error {
    status: number;
    constructor({ message, status }: { message: string; status: number }) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }
  return {
    GoogleGenAI: vi.fn().mockImplementation(() => ({
      models: { generateContent: (...args: any[]) => generateContentMock(...args) },
    })),
    ApiError,
    Type: { OBJECT: "OBJECT", STRING: "STRING", BOOLEAN: "BOOLEAN" },
  };
});

import { ApiError } from "@google/genai";
import { extractPassportMrzViaGemini } from "./extractPassportGemini.js";

function apiError(status: number): ApiError {
  return new ApiError({ message: "upstream error", status });
}

function okResponse(overrides: Record<string, any> = {}) {
  return {
    text: JSON.stringify({
      mrz_found: true,
      // Content only, no trailing filler — the real prompt no longer asks
      // for a filler count; extractPassportMrzViaGemini right-pads this to
      // 44 chars, reproducing the same full line as before this change.
      line1_content: "P<UTOERIKSSON<<ANNA<MARIA",
      line2: "L898902C36UTO7408122F1204159ZE184226B<<<<<10",
      viz_found: false,
      viz: null,
      ...overrides,
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  generateContentMock.mockReset();
  process.env.GEMINI_API_KEY = "test-key";
});

afterEach(() => {
  vi.useRealTimers();
});

// Drains pending timers (real backoff sleeps under fake timers) until the
// given promise settles — same approach as utils/geminiRetry.test.ts.
async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) {
    await vi.advanceTimersByTimeAsync(5000);
  }
  return promise;
}

describe("extractPassportMrzViaGemini — transient-upstream retry", () => {
  it("recovers from a single 503 via the transient retry, without touching the JSON-stability path", async () => {
    generateContentMock.mockRejectedValueOnce(apiError(503)).mockResolvedValueOnce(okResponse());

    const result = await runWithTimers(
      extractPassportMrzViaGemini({ buffer: Buffer.from("x"), mimeType: "image/jpeg" }),
    );

    expect(result.found).toBe(true);
    expect(result.line1).toBe("P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<");
    expect(generateContentMock).toHaveBeenCalledTimes(2); // 1 failed + 1 recovered — no extra JSON-stability attempt
  });

  it("recovers from a 429 the same way", async () => {
    generateContentMock.mockRejectedValueOnce(apiError(429)).mockResolvedValueOnce(okResponse());

    const result = await runWithTimers(
      extractPassportMrzViaGemini({ buffer: Buffer.from("x"), mimeType: "image/jpeg" }),
    );

    expect(result.found).toBe(true);
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("a persistent 503 exhausts exactly 3 attempts and rethrows the ApiError — no fourth JSON-stability attempt on top", async () => {
    generateContentMock.mockRejectedValue(apiError(503));

    const outcome = runWithTimers(
      extractPassportMrzViaGemini({ buffer: Buffer.from("x"), mimeType: "image/jpeg" }).catch((e) => e),
    );
    const err = await outcome;

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    // Exactly 3 — the transient retry's own cap. If the JSON-stability
    // catch also fired, this would be 6.
    expect(generateContentMock).toHaveBeenCalledTimes(3);
  });

  it("a non-retryable 400 fails on the very first attempt — no retry loop, no JSON-stability attempt either", async () => {
    generateContentMock.mockRejectedValue(apiError(400));

    await expect(
      extractPassportMrzViaGemini({ buffer: Buffer.from("x"), mimeType: "image/jpeg" }),
    ).rejects.toMatchObject({ status: 400 });

    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });
});

describe("extractPassportMrzViaGemini — JSON-stability retry stays distinct", () => {
  it("still retries once, immediately, when the model call succeeds but returns unparseable JSON", async () => {
    generateContentMock.mockResolvedValueOnce({ text: "not valid json{{{" }).mockResolvedValueOnce(okResponse());

    const result = await extractPassportMrzViaGemini({ buffer: Buffer.from("x"), mimeType: "image/jpeg" });

    expect(result.found).toBe(true);
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("still retries once when the model returns an empty response", async () => {
    generateContentMock.mockResolvedValueOnce({ text: "" }).mockResolvedValueOnce(okResponse());

    const result = await extractPassportMrzViaGemini({ buffer: Buffer.from("x"), mimeType: "image/jpeg" });

    expect(result.found).toBe(true);
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("fails if both the original AND the JSON-stability retry return unparseable JSON", async () => {
    generateContentMock.mockResolvedValue({ text: "still not json" });

    await expect(
      extractPassportMrzViaGemini({ buffer: Buffer.from("x"), mimeType: "image/jpeg" }),
    ).rejects.toThrow(/invalid JSON/i);

    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });
});
