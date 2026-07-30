// apps/backend/src/utils/geminiRetry.ts
//
// Retries a Gemini call on a TRANSIENT upstream failure — 429 (rate
// limited) or any 5xx (503 "the model is currently experiencing high
// demand" being the real, observed case that prompted this) — with
// exponential backoff and jitter, three attempts total (one initial call
// plus two retries). Any other error is rethrown immediately, unretried:
// a non-429 4xx (bad request, auth) will not improve on retry, and neither
// will a non-HTTP failure (JSON parsing, a missing response) — those are
// different failure classes with different fixes, handled by their own
// retry logic at the call site (see services/extractPassportGemini.ts).
//
// No existing shared retry/backoff helper was found to reuse for this:
//   - services/receiptExtractorGemini.ts and services/voucherExtractorGemini.ts
//     each have their own "retry once on ANY thrown error, no backoff"
//     block — tailored to JSON-parse stability only (a bad/unparseable
//     response), not HTTP-status-aware, and would immediately re-hit an
//     upstream that's already returning 503.
//   - services/tbo.hotel.search.service.ts has an inline 429/503 backoff
//     loop, but it's written directly against a raw fetch() Response
//     object (`.status`, `.headers.get('retry-after')`) inside its own
//     batch-search loop — a different shape from @google/genai's ApiError,
//     and not exported/reusable as-is.
// This is a new, small, generic helper — not a copy of either.
import { ApiError } from "@google/genai";

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 4000;

function isTransientApiError(err: unknown): err is ApiError {
  return err instanceof ApiError && (err.status === 429 || (err.status >= 500 && err.status < 600));
}

// "Equal jitter": half the exponential value is guaranteed, the other half
// is randomised — avoids both the thundering-herd problem of no jitter at
// all and the near-zero-delay risk of "full jitter" (random(0, exp)).
// Capped at MAX_DELAY_MS before jitter is applied.
function backoffDelayMs(attemptIndex: number): number {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attemptIndex);
  return Math.floor(exponential / 2 + Math.random() * (exponential / 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs fn(), retrying up to MAX_ATTEMPTS (3) total when it throws a
 * transient @google/genai ApiError (429 or any 5xx), with exponential
 * backoff + jitter between attempts. Any other thrown value — a
 * non-transient ApiError (e.g. 400/401), or a non-ApiError exception
 * entirely — is rethrown on the first occurrence, never retried here.
 *
 * onRetry, if given, fires just before each backoff sleep (not on the
 * final exhausted attempt, which throws instead) — for the caller to log
 * without this module needing its own logger dependency.
 */
export async function withGeminiTransientRetry<T>(
  fn: () => Promise<T>,
  onRetry?: (attempt: number, delayMs: number, err: ApiError) => void,
): Promise<T> {
  for (let attemptIndex = 0; ; attemptIndex++) {
    try {
      return await fn();
    } catch (err) {
      if (!isTransientApiError(err) || attemptIndex >= MAX_ATTEMPTS - 1) throw err;
      const delayMs = backoffDelayMs(attemptIndex);
      onRetry?.(attemptIndex + 2, delayMs, err); // +2: this failed attempt was #1 or #2, the retry about to run is #2 or #3
      await sleep(delayMs);
    }
  }
}
