// Coverage for extractVisaChecklistViaGemini — mirrors
// extractPassportGemini.test.ts's mocking approach: @google/genai is
// mocked, utils/geminiRetry.ts is REAL (fake timers keep backoff fast),
// proving the transient-retry and invalid-JSON-retry stay distinct.
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
    Type: {
      OBJECT: "OBJECT", STRING: "STRING", BOOLEAN: "BOOLEAN", ARRAY: "ARRAY",
    },
  };
});

import { ApiError } from "@google/genai";
import { extractVisaChecklistViaGemini } from "./extractVisaChecklistGemini.js";

function apiError(status: number): ApiError {
  return new ApiError({ message: "upstream error", status });
}

function okResponse(overrides: Record<string, any> = {}) {
  return {
    text: JSON.stringify({
      destinationName: "Laos",
      checklists: [
        {
          purposeLabel: "Tourist",
          variantLabel: null,
          requirementGroups: [
            {
              label: "Passport Front Page",
              requirement: "REQUIRED",
              conditionText: null,
              specificationText: "Clear picture of passport front page",
              templateReference: null,
              documents: [{ name: "Passport Front Page", description: null }],
            },
          ],
          questions: [],
        },
      ],
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
    await vi.advanceTimersByTimeAsync(1000);
  }
  return promise;
}

describe("extractVisaChecklistViaGemini", () => {
  it("parses a well-formed response into the RAW contract", async () => {
    generateContentMock.mockResolvedValueOnce(okResponse());

    const result = await extractVisaChecklistViaGemini({
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      sourceFile: "Laos-document-checklist.pdf",
    });

    expect(result.raw.destinationName).toBe("Laos");
    expect(result.raw.checklists).toHaveLength(1);
    expect(result.raw.checklists[0].requirementGroups[0].documents[0].name).toBe("Passport Front Page");
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient (429/5xx) error with backoff, then succeeds", async () => {
    generateContentMock.mockRejectedValueOnce(apiError(503)).mockResolvedValueOnce(okResponse());

    const result = await runWithTimers(
      extractVisaChecklistViaGemini({
        buffer: Buffer.from("fake-pdf"),
        mimeType: "application/pdf",
        sourceFile: "Laos-document-checklist.pdf",
      }),
    );

    expect(result.raw.destinationName).toBe("Laos");
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("retries once on invalid JSON — a DIFFERENT retry from the transient one", async () => {
    generateContentMock.mockResolvedValueOnce({ text: "not json" }).mockResolvedValueOnce(okResponse());

    const result = await extractVisaChecklistViaGemini({
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      sourceFile: "Laos-document-checklist.pdf",
    });

    expect(result.raw.destinationName).toBe("Laos");
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("rethrows a transient error immediately once its own retries are exhausted — never a third invalid-JSON attempt", async () => {
    generateContentMock
      .mockRejectedValueOnce(apiError(503))
      .mockRejectedValueOnce(apiError(503))
      .mockRejectedValueOnce(apiError(503));

    await expect(
      runWithTimers(
        extractVisaChecklistViaGemini({
          buffer: Buffer.from("fake-pdf"),
          mimeType: "application/pdf",
          sourceFile: "Laos-document-checklist.pdf",
        }),
      ),
    ).rejects.toThrow("upstream error");

    expect(generateContentMock).toHaveBeenCalledTimes(3);
  });

  it("supports multiple checklists in one PDF (e.g. Tourist + Business + a variant)", async () => {
    generateContentMock.mockResolvedValueOnce(
      okResponse({
        destinationName: "Canada",
        checklists: [
          { purposeLabel: "Tourist", variantLabel: null, requirementGroups: [], questions: [] },
          { purposeLabel: "Tourist", variantLabel: "For USA visa holder", requirementGroups: [], questions: [] },
        ],
      }),
    );

    const result = await extractVisaChecklistViaGemini({
      buffer: Buffer.from("fake-pdf"),
      mimeType: "application/pdf",
      sourceFile: "Canada-document-checklist.pdf",
    });

    expect(result.raw.checklists).toHaveLength(2);
    expect(result.raw.checklists[1].variantLabel).toBe("For USA visa holder");
  });
});
