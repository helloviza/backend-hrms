// apps/backend/src/services/receiptExtractions.service.ts
//
// The receipt-verification half of the Approval Bot's pre-checks.
//
//   recordReceiptExtraction()  write the server-held copy of a read (or of a
//                              failed read) — called by the upload route and
//                              the WhatsApp worker right after extractReceipt.
//   loadExtractionsForLines()  the records for a claim's lines, by imageKey.
//   verifyReceiptLine()        ONE line's verdict: ok / missing / unreadable /
//                              mismatch / currency_mismatch, with the numbers.
//   receiptVerdictForLines()   the claim-level roll-up the routing input uses:
//                              every line ok → the `receipt` pre-check passes.
//
// The verdict never blocks a submit; it only decides whether the bot may
// approve. Anything short of a readable, matching bill on EVERY line hands the
// claim to a person — the failure direction is always "human", never "refuse".
import mongoose from "mongoose";
import ReceiptExtraction, { type IReceiptExtraction } from "../models/ReceiptExtraction.js";
import type { ReceiptExtraction as ExtractorResult } from "./receiptExtractorGemini.js";

const oid = (v: any) => new mongoose.Types.ObjectId(String(v));
const round2 = (n: number) => Math.round(n * 100) / 100;

export type ReceiptMatchTolerance = {
  /** Absolute slack, in the workspace BASE currency (default 10). */
  absToleranceBase: number;
  /** Percentage slack of the receipt's amount, 0–100 (default 5). */
  pctTolerance: number;
};
export const DEFAULT_RECEIPT_TOLERANCE: ReceiptMatchTolerance = { absToleranceBase: 10, pctTolerance: 5 };

export async function recordReceiptExtraction(params: {
  workspaceId: mongoose.Types.ObjectId | string;
  employeeId: mongoose.Types.ObjectId | string;
  imageKey: string;
  s3Bucket?: string | null;
  mime?: string | null;
  sourceChannel: "web" | "whatsapp";
  result?: ExtractorResult | null; // a successful read
  error?: string | null; // …or why the reader gave up
}): Promise<IReceiptExtraction> {
  const f = params.result?.fields;
  const readable = !!f && f.amount != null && Number.isFinite(Number(f.amount));
  const doc = {
    workspaceId: oid(params.workspaceId),
    employeeId: oid(params.employeeId),
    imageKey: params.imageKey,
    s3Bucket: params.s3Bucket ?? null,
    mime: params.mime ?? null,
    sourceChannel: params.sourceChannel,
    readable,
    errorMessage: readable ? null : (params.error || "Extraction produced no amount"),
    merchant: f?.merchant ?? null,
    date: f?.date ?? null,
    amount: readable ? Number(f!.amount) : null,
    currency: f?.currency ? String(f.currency).toUpperCase() : null,
    taxAmount: f?.taxAmount ?? null,
    gstin: f?.gstin ?? null,
    suggestedCategory: f?.suggestedCategory ?? null,
    perFieldConfidence: f?.perFieldConfidence ?? {},
    extractionModel: params.result?.raw?.model ?? null,
    rawCandidate: params.result?.raw?.raw_candidate,
    extractedAt: new Date(),
  };
  const saved = await ReceiptExtraction.findOneAndUpdate(
    { workspaceId: doc.workspaceId, imageKey: doc.imageKey },
    { $set: doc },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  return saved!;
}

export async function findExtractionByKey(workspaceId: any, imageKey: string): Promise<IReceiptExtraction | null> {
  if (!imageKey) return null;
  return ReceiptExtraction.findOne({ workspaceId: oid(workspaceId), imageKey }).lean() as any;
}

export async function loadExtractionsForLines(workspaceId: any, lines: { imageKey?: string | null }[]): Promise<Map<string, IReceiptExtraction>> {
  const keys = [...new Set(lines.map((l) => l.imageKey).filter(Boolean) as string[])];
  if (keys.length === 0) return new Map();
  const rows: any[] = await ReceiptExtraction.find({ workspaceId: oid(workspaceId), imageKey: { $in: keys } }).lean();
  return new Map(rows.map((r) => [String(r.imageKey), r]));
}

/**
 * What the RECEIPT said, for a reviewer (F-30). This is the server-held read —
 * never the values on the Expense line, which the submitter can edit — so a
 * claim page can put "receipt ₹1,400" next to "claimed ₹500" and the approver
 * sees the exact gap the bot flagged. `null` when the server never read this
 * key (no receipt, or a line older than the ReceiptExtraction store).
 */
export type ReceiptReadView = {
  readable: boolean;
  errorMessage: string | null;
  merchant: string | null;
  date: string | null;
  amount: number | null;
  currency: string | null;
  taxAmount: number | null;
  gstin: string | null;
  suggestedCategory: string | null;
  extractedAt: Date | null;
};

export function receiptReadView(extraction: IReceiptExtraction | null | undefined): ReceiptReadView | null {
  if (!extraction) return null;
  return {
    readable: !!extraction.readable,
    errorMessage: extraction.errorMessage ?? null,
    merchant: extraction.merchant ?? null,
    date: extraction.date ?? null,
    amount: extraction.amount ?? null,
    currency: extraction.currency ?? null,
    taxAmount: extraction.taxAmount ?? null,
    gstin: extraction.gstin ?? null,
    suggestedCategory: extraction.suggestedCategory ?? null,
    extractedAt: extraction.extractedAt ?? null,
  };
}

export type ReceiptLineStatus = "ok" | "missing" | "unreadable" | "mismatch" | "currency_mismatch";
export type ReceiptLineVerdict = {
  expenseId: string;
  ref: string | null;
  status: ReceiptLineStatus;
  claimedAmount: number | null;
  claimedCurrency: string | null;
  extractedAmount: number | null;
  extractedCurrency: string | null;
  /** The slack that applied, in the LINE's currency. */
  toleranceApplied: number | null;
  reason: string;
};

function money(n: number | null | undefined, ccy: string | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `${(ccy || "").toUpperCase()} ${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
}

/**
 * One bill against its own receipt. The tolerance is the LARGER of the
 * absolute slack and pct% of the receipt's amount. The absolute slack is
 * defined in the workspace base currency; for a foreign-currency line it is
 * converted at the line's frozen exchange rate (₹10 ≈ $0.12), so a $100 bill
 * is not given ₹10 = $10 of slack.
 */
export function verifyReceiptLine(
  line: { _id: any; ref?: string | null; amount: any; currency?: string | null; imageKey?: string | null; exchangeRate?: number | null; baseCurrency?: string | null },
  extraction: IReceiptExtraction | null | undefined,
  tolerance: ReceiptMatchTolerance,
  baseCurrency: string,
): ReceiptLineVerdict {
  const claimed = Number(line.amount);
  const lineCcy = String(line.currency || baseCurrency).toUpperCase();
  const label = line.ref ? String(line.ref) : String(line._id);
  const base: Omit<ReceiptLineVerdict, "status" | "reason"> = {
    expenseId: String(line._id),
    ref: line.ref ? String(line.ref) : null,
    claimedAmount: Number.isFinite(claimed) ? claimed : null,
    claimedCurrency: lineCcy,
    extractedAmount: extraction?.amount ?? null,
    extractedCurrency: extraction?.currency ?? null,
    toleranceApplied: null,
  };

  if (!line.imageKey) return { ...base, status: "missing", reason: `${label}: no receipt attached` };
  if (!extraction || !extraction.readable || extraction.amount == null) {
    return { ...base, status: "unreadable", reason: `${label}: receipt not readable` };
  }
  const extCcy = String(extraction.currency || baseCurrency).toUpperCase();
  if (extCcy !== lineCcy) {
    return {
      ...base,
      status: "currency_mismatch",
      reason: `${label}: receipt currency ${extCcy} differs from claimed ${lineCcy}`,
    };
  }
  const rate = lineCcy === baseCurrency.toUpperCase() ? 1 : Number(line.exchangeRate) || null;
  const absInLine = rate ? tolerance.absToleranceBase / rate : tolerance.absToleranceBase;
  const slack = round2(Math.max(absInLine, (Math.abs(extraction.amount) * tolerance.pctTolerance) / 100));
  const diff = round2(Math.abs(claimed - Number(extraction.amount)));
  if (!Number.isFinite(claimed) || diff > slack) {
    return {
      ...base,
      toleranceApplied: slack,
      status: "mismatch",
      reason: `${label}: receipt amount ${money(extraction.amount, extCcy)} doesn't match claimed ${money(claimed, lineCcy)} (tolerance ${money(slack, lineCcy)})`,
    };
  }
  return { ...base, toleranceApplied: slack, status: "ok", reason: `${label}: receipt matches (${money(extraction.amount, extCcy)})` };
}

export type ReceiptVerdict = {
  /** true only when EVERY line is a readable, matching bill. */
  pass: boolean;
  lines: ReceiptLineVerdict[];
  /** The failing lines' reasons, ready for the trail. Empty when pass. */
  failures: string[];
};

export function receiptVerdictForLines(
  lines: any[],
  extractions: Map<string, IReceiptExtraction>,
  tolerance: ReceiptMatchTolerance,
  baseCurrency: string,
): ReceiptVerdict {
  const verdicts = lines.map((l) => verifyReceiptLine(l, l.imageKey ? extractions.get(String(l.imageKey)) : null, tolerance, baseCurrency));
  const failures = verdicts.filter((v) => v.status !== "ok").map((v) => v.reason);
  return { pass: lines.length > 0 && failures.length === 0, lines: verdicts, failures };
}
