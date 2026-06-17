// apps/backend/src/services/receiptExtractorGemini.ts
import { GoogleGenAI, Type } from "@google/genai";
import { getObjectBuffer } from "../utils/s3Upload.js";

/**
 * Receipt extraction (Expense Management — Sprint 2).
 *
 * Mirrors the schema-constrained approach of voucherExtractorGemini.ts: ask
 * Gemini for a permissive RAW contract, then normalize/validate in code so the
 * model never has to emit our final shape. Single provider (Gemini, already
 * wired via GEMINI_API_KEY) — no new dependency.
 *
 * Vision input is the captured receipt image/PDF passed inline as base64. The
 * caller may hand us raw bytes OR an S3 imageKey (we re-fetch); on any model /
 * parse failure we THROW so the worker keeps the captured image and degrades
 * to manual correction rather than dropping the receipt.
 */

export type ReceiptFields = {
  merchant: string | null;
  date: string | null; // ISO yyyy-mm-dd
  amount: number | null;
  currency: string; // ISO 4217, defaults to INR
  taxAmount: number | null;
  gstin: string | null;
  suggestedCategory: string | null;
  perFieldConfidence: Record<string, number>;
};

export type ReceiptExtraction = {
  fields: ReceiptFields;
  raw: { raw_candidate: any; raw_text: string; model: string };
};

let _ai: GoogleGenAI | null = null;

function getAI(): GoogleGenAI {
  const key = (process.env.GEMINI_API_KEY || "").trim();
  if (!key) throw new Error("GEMINI_API_KEY is missing. Set it in apps/backend/.env and restart.");
  if (!_ai) _ai = new GoogleGenAI({ apiKey: key });
  return _ai;
}

const DEFAULT_MODEL = "gemini-2.5-flash";

/* ───────────────────────── helpers ───────────────────────── */

function isNonEmptyString(v: any): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function toNullString(v: any): string | null {
  if (!isNonEmptyString(v)) return null;
  const s = v.trim();
  const lower = s.toLowerCase();
  if (lower === "null" || lower === "n/a" || lower === "na" || lower === "-" || lower === "none")
    return null;
  return s;
}

function toNullNumber(v: any): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    // strip currency symbols, thousands separators, spaces
    const cleaned = v.replace(/[^0-9.\-]/g, "");
    const n = Number(cleaned);
    if (cleaned !== "" && Number.isFinite(n)) return n;
  }
  return null;
}

/** Coerce common receipt date strings to ISO yyyy-mm-dd; null if unrecognizable. */
function toIsoDate(v: any): string | null {
  const s = toNullString(v);
  if (!s) return null;
  // Already ISO-ish
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // dd/mm/yyyy or dd-mm-yyyy (Indian receipts) — assume day-first
  const dmy = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(s);
  if (dmy) {
    let [, d, m, y] = dmy;
    if (y.length === 2) y = `20${y}`;
    const dd = d.padStart(2, "0");
    const mm = m.padStart(2, "0");
    if (Number(mm) >= 1 && Number(mm) <= 12 && Number(dd) >= 1 && Number(dd) <= 31)
      return `${y}-${mm}-${dd}`;
  }
  return null;
}

function clampConfidence(v: any): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/* ───────────────────────── RAW contract + Gemini schema ───────────────────────── */

const nstr = { type: Type.STRING, nullable: true } as const;
const nnum = { type: Type.NUMBER, nullable: true } as const;

const rawSchema = {
  type: Type.OBJECT,
  properties: {
    merchant: nstr,
    date: nstr, // prefer ISO yyyy-mm-dd
    amount: nnum, // grand total paid
    currency: nstr, // ISO 4217 code, e.g. INR, USD
    tax_amount: nnum, // total tax / GST if shown
    gstin: nstr, // 15-char Indian GSTIN if printed
    suggested_category: nstr, // e.g. Meals, Travel, Lodging, Fuel, Office
    confidence: {
      type: Type.OBJECT,
      nullable: true,
      properties: {
        merchant: nnum,
        date: nnum,
        amount: nnum,
        currency: nnum,
        tax_amount: nnum,
        gstin: nnum,
        suggested_category: nnum,
      },
    },
  },
  required: ["amount"],
} as const;

const SYSTEM_PROMPT = `
You are an expense receipt extractor. Return ONLY valid JSON matching the response schema.

Rules:
- Missing scalars: null. Never output empty strings or the literal "null".
- merchant: the vendor/business name on the receipt.
- date: the transaction/invoice date as ISO yyyy-mm-dd. If only dd/mm/yyyy is shown, still return ISO.
- amount: the GRAND TOTAL actually paid (tax inclusive), as a plain number with no currency symbol.
- currency: ISO 4217 code. If the receipt is clearly Indian (₹, Rs, INR, a GSTIN), use INR.
- tax_amount: total tax / GST amount if present, else null.
- gstin: the 15-character Indian GSTIN only if printed, else null.
- suggested_category: one of Meals, Travel, Lodging, Fuel, Transport, Office, Other — best guess.
- confidence: your 0..1 confidence per field. Be honest; low confidence for guessed/blurry values.
Never invent values.
`.trim();

/* ───────────────────────── public API ───────────────────────── */

export async function extractReceipt(opts: {
  buffer?: Buffer;
  imageKey?: string;
  mime: string;
}): Promise<ReceiptExtraction> {
  const ai = getAI();
  const model = (process.env.GEMINI_MODEL && process.env.GEMINI_MODEL.trim()) || DEFAULT_MODEL;

  const buffer = opts.buffer ?? (opts.imageKey ? await getObjectBuffer(opts.imageKey) : null);
  if (!buffer) throw new Error("extractReceipt: provide buffer or imageKey");
  const base64 = buffer.toString("base64");

  const call = async (repair: boolean): Promise<{ raw: any; text: string }> => {
    const userText = repair
      ? "Previous attempt returned invalid JSON. Output strictly valid JSON only."
      : "Extract this receipt into the response schema.";
    const resp = await ai.models.generateContent({
      model,
      contents: { parts: [{ text: userText }, { inlineData: { data: base64, mimeType: opts.mime } }] },
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: rawSchema as any,
      },
    });
    const text = (resp.text || "").trim();
    if (!text) throw new Error("No response from model");
    return { raw: JSON.parse(text), text };
  };

  // One retry purely for JSON stability (matches voucher extractor behavior).
  let raw: any;
  let rawText: string;
  try {
    const r = await call(false);
    raw = r.raw;
    rawText = r.text;
  } catch {
    const r = await call(true);
    raw = r.raw;
    rawText = r.text;
  }

  const conf = raw?.confidence ?? {};
  const fields: ReceiptFields = {
    merchant: toNullString(raw?.merchant),
    date: toIsoDate(raw?.date),
    amount: toNullNumber(raw?.amount),
    currency: (toNullString(raw?.currency) || "INR").toUpperCase(),
    taxAmount: toNullNumber(raw?.tax_amount),
    gstin: toNullString(raw?.gstin),
    suggestedCategory: toNullString(raw?.suggested_category),
    perFieldConfidence: {
      merchant: clampConfidence(conf?.merchant),
      date: clampConfidence(conf?.date),
      amount: clampConfidence(conf?.amount),
      currency: clampConfidence(conf?.currency),
      taxAmount: clampConfidence(conf?.tax_amount),
      gstin: clampConfidence(conf?.gstin),
      suggestedCategory: clampConfidence(conf?.suggested_category),
    },
  };

  // A receipt with no amount at all is not usable — force the manual path.
  if (fields.amount == null) throw new Error("Extraction produced no amount");

  return { fields, raw: { raw_candidate: raw, raw_text: rawText, model } };
}
