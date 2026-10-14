// The request the shared voucher extractor sends to Gemini, pinned byte for
// byte. Manual-bookings autofill (documentExtraction.service → extractDocument)
// and GeminiService call extractVoucherViaGemini WITHOUT a prompt variant, so
// their request must be exactly what it was before the voucher-only variant
// existed. The golden file was captured from the extractor before that change
// (RECORD_GEMINI_GOLDEN=1 rewrites it — only ever do that on purpose).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const calls: any[] = [];
let replies: string[] = [];

vi.mock("@google/genai", async (importOriginal) => {
  const real: any = await importOriginal();
  class GoogleGenAI {
    models = {
      generateContent: async (args: any) => {
        calls.push(JSON.parse(JSON.stringify(args)));
        return { text: replies.shift() ?? VALID_FLIGHT };
      },
    };
    constructor(_opts: unknown) {}
  }
  return { ...real, GoogleGenAI };
});

const VALID_FLIGHT = JSON.stringify({
  detected_type: "flight",
  booking_info: { pnr: "8RLUYX" },
  policies: { notes: [] },
  flight: { segments: [{ origin: { code: "MNL" }, destination: { code: "DEL" } }], passengers: [{ name: "Mr A" }] },
});

const { extractVoucherViaGemini } = await import("./voucherExtractorGemini.js");
const { extractVoucherData } = await import("./GeminiService.js");

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "geminiVoucherRequest.default.json");
const buffer = Buffer.from("%PDF-1.4 golden request fixture");

/** Every default-variant call shape that exists in the codebase today. */
async function captureDefaultRequests() {
  const out: Record<string, any[]> = {};
  const run = async (name: string, fn: () => Promise<unknown>, scripted: string[] = []) => {
    calls.length = 0;
    replies = [...scripted];
    await fn();
    out[name] = [...calls];
  };
  // documentExtraction.service.extractDocument (manual-bookings autofill + worker)
  await run("manualBookings.flightHint", () => extractVoucherViaGemini({ buffer, mimeType: "application/pdf", voucherType: "flight" }));
  await run("manualBookings.hotelHint", () => extractVoucherViaGemini({ buffer, mimeType: "image/png", voucherType: "hotel" }));
  // the extractor's own invalid-JSON retry, on the same call
  await run("manualBookings.invalidJsonRetry", () => extractVoucherViaGemini({ buffer, mimeType: "application/pdf", voucherType: "flight" }), ["not json"]);
  // GeminiService.extractVoucherData (logo + portal hint passed through)
  await run("geminiService.withHints", () =>
    extractVoucherData({ fileBuffer: buffer, mimeType: "application/pdf", voucherType: "hotel", customLogoUrl: "https://example.com/logo.png", portalHint: "Agoda" }),
  );
  return out;
}

beforeEach(() => {
  delete process.env.GEMINI_MODEL;
  process.env.GEMINI_API_KEY = "test-key";
});

describe("default prompt (no variant) — unchanged for manual-bookings", () => {
  it("sends byte-for-byte the request captured before the voucher variant existed", async () => {
    const now = JSON.stringify(await captureDefaultRequests(), null, 2);
    if (process.env.RECORD_GEMINI_GOLDEN === "1") writeFileSync(GOLDEN, now + "\n");
    expect(existsSync(GOLDEN)).toBe(true);
    // CRLF-normalised: core.autocrlf checks the golden file out with CRLF on
    // Windows. Newlines inside the request are JSON-escaped, so only the
    // pretty-print line breaks are affected.
    expect(now + "\n").toBe(readFileSync(GOLDEN, "utf8").replace(/\r\n/g, "\n"));
  });

  it("the voucher variant only appends its rules and sets temperature 0 — nothing else differs", async () => {
    calls.length = 0;
    replies = [];
    await extractVoucherViaGemini({ buffer, mimeType: "application/pdf", voucherType: "hotel" });
    const base = calls[0];
    calls.length = 0;
    await extractVoucherViaGemini({ buffer, mimeType: "application/pdf", voucherType: "hotel", promptVariant: "voucher" });
    const voucher = calls[0];

    const sys = voucher.config.systemInstruction as string;
    expect(sys.startsWith(base.config.systemInstruction + "\n\nVoucher rules")).toBe(true);
    expect(sys).toContain("copy every date and time exactly as printed on the document, including any weekday");
    expect(sys).toContain("Never reformat a date, and never add, guess or infer a year");
    expect(sys).not.toContain("YYYY-MM-DD");
    expect(sys).not.toContain("year_inferred");
    expect(sys).toMatch(/early check-in, late check-out, Wi-Fi, meals/);
    expect(sys).toMatch(/pay-by date.*is NOT a cancellation deadline/);
    expect(voucher.config.temperature).toBe(0);
    expect("temperature" in base.config).toBe(false);
    expect(voucher.config.responseSchema).toEqual(base.config.responseSchema);
    expect({ ...voucher, config: { ...voucher.config, systemInstruction: null, temperature: undefined } }).toEqual({
      ...base,
      config: { ...base.config, systemInstruction: null, temperature: undefined },
    });
  });

  it("an explicit 'default' variant is the same request as passing none", async () => {
    calls.length = 0;
    replies = [];
    await extractVoucherViaGemini({ buffer, mimeType: "application/pdf", voucherType: "flight" });
    const none = JSON.stringify(calls);
    calls.length = 0;
    await extractVoucherViaGemini({ buffer, mimeType: "application/pdf", voucherType: "flight", promptVariant: "default" } as any);
    expect(JSON.stringify(calls)).toBe(none);
  });
});
