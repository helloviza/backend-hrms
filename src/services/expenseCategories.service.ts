// apps/backend/src/services/expenseCategories.service.ts
//
// Shared category seeding + classification. The default-category list and its
// lazy-seed used to live inline in routes/expenseCategories.ts; they are hoisted
// here so the WhatsApp capture worker can seed + resolve a category without
// duplicating the list (single source of truth for both channels).

import mongoose from "mongoose";
import ExpenseCategory from "../models/ExpenseCategory.js";
import { fuzzyMatchCategory } from "../utils/categoryMatch.js";

export const DEFAULT_CATEGORIES = [
  "Meals & Entertainment",
  "Travel",
  "Lodging",
  "Local Conveyance",
  "Fuel",
  "Office Supplies",
  "Telecom/Internet",
  "Professional Fees",
  "Training",
  "Miscellaneous",
];

/** Insert the 10 defaults for a workspace. Dup-key races are ignored — a
 *  concurrent first-load could hit the unique (workspaceId, name) index. */
export async function seedDefaultCategories(workspaceId: mongoose.Types.ObjectId) {
  const docs = DEFAULT_CATEGORIES.map((name, i) => ({
    workspaceId,
    name,
    glCode: null,
    active: true,
    sortOrder: i,
    isDefault: true,
  }));
  try {
    await ExpenseCategory.insertMany(docs, { ordered: false });
  } catch {
    // ignore dup-key errors; the rows we need will exist either way.
  }
}

/** Seed defaults only when the workspace has no categories yet. */
export async function ensureCategoriesSeeded(
  workspaceId: mongoose.Types.ObjectId | string,
): Promise<void> {
  const ws = new mongoose.Types.ObjectId(String(workspaceId));
  const count = await ExpenseCategory.countDocuments({ workspaceId: ws });
  if (count === 0) await seedDefaultCategories(ws);
}

/**
 * Resolve a free-text AI category hint to a managed categoryId for a workspace,
 * using the same fuzzy logic as the web reviewer. Seeds defaults first so a
 * brand-new (e.g. WhatsApp-only) workspace can still classify. Returns null when
 * nothing matches — the caller keeps suggestedCategory as the fallback.
 */
export async function resolveCategoryId(
  workspaceId: mongoose.Types.ObjectId | string,
  suggestion: string | null | undefined,
): Promise<string | null> {
  if (!suggestion || !String(suggestion).trim()) return null;
  const ws = new mongoose.Types.ObjectId(String(workspaceId));
  await ensureCategoriesSeeded(ws);
  const cats = await ExpenseCategory.find({ workspaceId: ws, active: true })
    .select("_id name")
    .lean();
  return fuzzyMatchCategory(suggestion, cats as any);
}
