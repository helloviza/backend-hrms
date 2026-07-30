// Unit coverage for withGeminiTransientRetry (utils/geminiRetry.ts). Fake
// timers throughout — this test suite must not actually wait out real
// backoff delays. Math.random is stubbed for deterministic jitter
// assertions where the exact delay matters.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiError } from "@google/genai";
import { withGeminiTransientRetry } from "./geminiRetry.js";

function apiError(status: number, message = "upstream error"): ApiError {
  return new ApiError({ message, status });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Runs fn to completion while draining every pending timer it schedules —
// needed because withGeminiTransientRetry's internal `await sleep(...)`
// won't resolve under fake timers unless something advances the clock.
async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  // .then with BOTH handlers, not .finally — .finally's derived promise
  // re-rejects on a rejected input and, left unawaited, that derived
  // promise itself reports as an unhandled rejection even though the
  // ORIGINAL promise is properly awaited/caught below.
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) {
    await vi.advanceTimersByTimeAsync(MAX_DELAY_MS_FOR_TEST);
  }
  return promise;
}
const MAX_DELAY_MS_FOR_TEST = 5000; // comfortably above the module's own 4000ms cap

describe("withGeminiTransientRetry", () => {
  it("returns the result on the first try without ever retrying when nothing throws", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withGeminiTransientRetry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a 503 and succeeds on the second attempt", async () => {
    const fn = vi.fn().mockRejectedValueOnce(apiError(503)).mockResolvedValueOnce("ok");
    const result = await runWithTimers(withGeminiTransientRetry(fn));
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 the same way as a 503", async () => {
    const fn = vi.fn().mockRejectedValueOnce(apiError(429)).mockResolvedValueOnce("ok");
    const result = await runWithTimers(withGeminiTransientRetry(fn));
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries any 5xx, not just 503 (e.g. 500, 502)", async () => {
    const fn = vi.fn().mockRejectedValueOnce(apiError(502)).mockResolvedValueOnce("ok");
    const result = await runWithTimers(withGeminiTransientRetry(fn));
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("makes three attempts total, then throws, on a persistent 503", async () => {
    const fn = vi.fn().mockRejectedValue(apiError(503));
    const outcome = runWithTimers(withGeminiTransientRetry(fn)).catch((e) => e);
    const err = await outcome;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("never retries a non-429 4xx — fails on the first attempt", async () => {
    const fn = vi.fn().mockRejectedValue(apiError(400));
    await expect(withGeminiTransientRetry(fn)).rejects.toMatchObject({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("never retries a 401 either", async () => {
    const fn = vi.fn().mockRejectedValue(apiError(401));
    await expect(withGeminiTransientRetry(fn)).rejects.toMatchObject({ status: 401 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("never retries a non-ApiError exception (e.g. a JSON-parsing failure) — a different failure class entirely", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Model returned invalid JSON"));
    await expect(withGeminiTransientRetry(fn)).rejects.toThrow("Model returned invalid JSON");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls onRetry before each backoff sleep, with an increasing attempt number, but not on the final exhausted failure", async () => {
    const fn = vi.fn().mockRejectedValue(apiError(503));
    const onRetry = vi.fn();
    await runWithTimers(withGeminiTransientRetry(fn, onRetry)).catch(() => {});

    expect(onRetry).toHaveBeenCalledTimes(2); // 2 retries before the 3rd, final, unretried failure
    expect(onRetry.mock.calls[0][0]).toBe(2); // about to run attempt #2
    expect(onRetry.mock.calls[1][0]).toBe(3); // about to run attempt #3
  });

  it("backoff is exponential with jitter, capped, per attempt (Math.random stubbed for determinism)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // isolates the guaranteed (non-jittered) half of each delay
    const delays: number[] = [];
    const fn = vi.fn().mockRejectedValue(apiError(503));
    const onRetry = vi.fn((_attempt: number, delayMs: number) => delays.push(delayMs));

    await runWithTimers(withGeminiTransientRetry(fn, onRetry)).catch(() => {});

    // Base 500ms, doubling: 500 -> 1000, each halved by the "equal jitter"
    // floor when Math.random() is 0.
    expect(delays).toEqual([250, 500]);
  });
});
