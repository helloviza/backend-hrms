// apps/backend/src/services/expenses.service.ts
//
// Single source of truth for creating a confirmed Expense. Both the WhatsApp
// capture worker and the web POST /api/expenses route call this, so the two
// channels never diverge — ref generation, status, currency default and date
// coercion all live here (mirrors the original inline worker logic exactly).

import mongoose from "mongoose";
import Expense, { type IExpense } from "../models/Expense.js";

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
  suggestedCategory?: string | null;

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

export async function createExpense(input: CreateExpenseInput): Promise<IExpense> {
  const doc: Record<string, any> = {
    workspaceId: input.workspaceId,
    employeeId: input.employeeId,
    sourceChannel: input.sourceChannel,
    imageKey: input.imageKey,
    s3Bucket: input.s3Bucket,
    merchant: input.merchant ?? null,
    date: input.date ? new Date(input.date) : null,
    amount: input.amount,
    currency: input.currency || "INR",
    taxAmount: input.taxAmount ?? null,
    gstin: input.gstin ?? null,
    suggestedCategory: input.suggestedCategory ?? null,
    status: "submitted",
    rawExtraction: input.rawExtraction,
    perFieldConfidence: input.perFieldConfidence,
    extractionModel: input.extractionModel,
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
