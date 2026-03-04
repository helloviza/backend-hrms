// apps/backend/src/services/GeminiService.ts
import type { PlumtripsVoucher, VoucherType } from "../types/voucher.js";
import { extractVoucherViaGemini } from "./voucherExtractorGemini.js";

/**
 * Gemini Voucher Extraction (Enterprise Pipeline Wrapper)
 *
 * This file is kept for backward compatibility with older callers that import
 * extractVoucherData() from GeminiService.ts.
 *
 * IMPORTANT:
 * - We intentionally DO NOT use the legacy "@google/generative-ai" flow here.
 * - Voucher extraction is centralized in voucherExtractorGemini.ts using "@google/genai"
 *   with schema-safe RAW -> normalize -> validate -> optional repair-pass.
 * - This prevents schema drift and minimizes 422s.
 */

type ExtractInput = {
  fileBuffer: Buffer;
  mimeType: string; // e.g. application/pdf, image/png
  voucherType: VoucherType; // "hotel" | "flight"
  customLogoUrl?: string | null;
  portalHint?: string | null; // Agoda, Cleartrip, TBO, Goibibo, IndiGo, Akasa, etc.
};

export async function extractVoucherData(
  input: ExtractInput
): Promise<PlumtripsVoucher> {
  const { parsed } = await extractVoucherViaGemini({
    buffer: input.fileBuffer,
    mimeType: input.mimeType,
    voucherType: input.voucherType,
    customLogoUrl: input.customLogoUrl ?? null,
    portalHint: input.portalHint ?? null,
  });

  return parsed;
}
