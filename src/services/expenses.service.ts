// apps/backend/src/services/expenses.service.ts
//
// Single source of truth for creating a confirmed Expense. Both the WhatsApp
// capture worker and the web POST /api/expenses route call this, so the two
// channels never diverge — ref generation, status, currency default and date
// coercion all live here (mirrors the original inline worker logic exactly).

import mongoose from "mongoose";
import Expense, { type IExpense } from "../models/Expense.js";
import {
  getWorkspaceBaseCurrency,
  normalizeCurrency,
  resolveFxAtEntry,
} from "./expenseFx.service.js";
import { findExtractionByKey } from "./receiptExtractions.service.js";

export type CreateExpenseInput = {
  workspaceId: mongoose.Types.ObjectId | string;
  employeeId: mongoose.Types.ObjectId | string;
  sourceChannel: string; // "whatsapp" | "web"

  merchant?: string | null;
  date?: string | Date | null; // ISO yyyy-mm-dd or Date
  amount: number;
  currency?: string | null;
  taxAmount?: number | null;
  gstin?: string | null;
  suggestedCategory?: string | null; // AI hint
  categoryId?: mongoose.Types.ObjectId | string | null; // managed category (Layer 1)
  // Optional report linkage at creation (Layer 2). When set, the caller is
  // responsible for propagateReportLifecycle() — this writes reportId only.
  reportId?: mongoose.Types.ObjectId | string | null;

  imageKey?: string;
  s3Bucket?: string;

  // WhatsApp capture link. OMITTED entirely for web expenses — never set to
  // null: a sparse unique index only skips documents where the field is ABSENT,
  // so a null would be indexed and two web expenses would collide.
  expenseCaptureId?: mongoose.Types.ObjectId | string;

  rawExtraction?: any;
  perFieldConfidence?: any;
  extractionModel?: string;
};

export class ExpenseInputError extends Error {
  status = 400;
}

export async function createExpense(input: CreateExpenseInput): Promise<IExpense> {
  // A bill is a positive amount — for BOTH channels (audit F-11: a ≤0 line
  // silently lowered a claim total). Thrown, not defaulted: the web route maps
  // it to a 400 and the WhatsApp worker to a "couldn't read the amount" reply.
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ExpenseInputError("amount must be a positive number");
  }
  // An unparseable date (extractor noise) is stored as null — the claim
  // submit gate asks for a date later — rather than failing the save with a
  // cast error.
  const parsedDate = input.date ? new Date(input.date) : null;
  const date = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null;

  // FX freeze at entry (slice 0). The receipt currency defaults to the
  // workspace base (was a hard-coded "INR"); a non-ISO string from the
  // extractor also falls back to the base rather than being stored verbatim.
  const baseCurrency = await getWorkspaceBaseCurrency(input.workspaceId);
  const currency = normalizeCurrency(input.currency) || baseCurrency;
  const fx = await resolveFxAtEntry({ amount: Number(input.amount), currency, baseCurrency });

  // Receipt verification: link the SERVER-held read of this receipt (written by
  // the upload route / capture worker at extraction time). When one exists its
  // copy of the extraction fields is what gets stored on the line — the
  // client-echoed rawExtraction / perFieldConfidence are only a fallback for a
  // receipt the server never read (legacy uploads). The bot gate reads the
  // linked row, so neither copy on the Expense is trusted for approval.
  const serverRead = input.imageKey ? await findExtractionByKey(input.workspaceId, input.imageKey) : null;

  const doc: Record<string, any> = {
    workspaceId: input.workspaceId,
    employeeId: input.employeeId,
    sourceChannel: input.sourceChannel,
    imageKey: input.imageKey,
    s3Bucket: input.s3Bucket,
    merchant: input.merchant ?? null,
    date,
    amount,
    currency,
    exchangeRate: fx.exchangeRate,
    rateDate: fx.rateDate,
    rateSource: fx.rateSource,
    amountBase: fx.amountBase,
    baseCurrency: fx.baseCurrency,
    // A resolved entry-time rate is the first history row; a pending line has
    // none until a person supplies the rate.
    rateHistory:
      fx.rateSource && fx.amountBase != null
        ? [
            {
              exchangeRate: fx.exchangeRate,
              rateDate: fx.rateDate,
              rateSource: fx.rateSource,
              amountBase: fx.amountBase,
              setBy: null,
              setAt: new Date(),
              reason: fx.rateSource === "base" ? "Same as workspace base currency" : "Live rate at entry",
            },
          ]
        : [],
    taxAmount: input.taxAmount ?? null,
    gstin: input.gstin ?? null,
    suggestedCategory: input.suggestedCategory ?? null,
    categoryId: input.categoryId ?? null,
    reportId: input.reportId ?? null,
    status: "submitted",
    rawExtraction: serverRead ? serverRead.rawCandidate : input.rawExtraction,
    perFieldConfidence: serverRead ? serverRead.perFieldConfidence : input.perFieldConfidence,
    extractionModel: serverRead ? (serverRead.extractionModel ?? undefined) : input.extractionModel,
    receiptExtractionId: serverRead ? serverRead._id : null,
  };

  // Only set when present — never write null (see note on the field above).
  if (input.expenseCaptureId != null) {
    doc.expenseCaptureId = input.expenseCaptureId;
  }

  const expense = new Expense(doc);
  // _id is assigned by Mongoose at construction, so ref derives without a
  // post-insert round-trip (identical to the original worker logic).
  expense.ref = `EXP-${String(expense._id).slice(-6).toUpperCase()}`;
  await expense.save();
  return expense;
}
