// apps/backend/src/models/ExpenseCategory.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../plugins/workspaceScope.plugin.js";

/**
 * ExpenseCategory
 * ---------------
 * Tenant-scoped expense category (Layer 1 of the expense module). Replaces the
 * free-text `suggestedCategory` hint on Expense with a managed, GL-mappable list.
 *
 * Each workspace gets its own set; a workspace with none is LAZY-SEEDED with 10
 * defaults on first GET (see routes/expenseCategories.ts). Categories are never
 * hard-deleted — they are retired via `active = false` so historical expenses
 * keep resolving their name.
 *
 * BOT LIMIT (per-category auto-approve ceiling)
 * --------------------------------------------
 * `botLimitMode` is MANDATORY on create/update from the Categories screen:
 *   "amount" + botLimitBase ≥ 1 → a single-category claim of this category
 *                                 auto-approves under that amount (base ccy)
 *   "na"                        → this category NEVER auto-approves
 * A category created before this field existed carries mode `null`. The engine
 * reads `null` as "na" (categoryBotLimit() below) — the SAFE default: nothing
 * auto-approves until an admin has made the call. The Categories screen flags
 * those rows so the admin knows which ones still need setting.
 *
 * A claim spanning MORE THAN ONE category does not use this at all — it is
 * governed by the workspace-wide bot threshold on the Rulebook tab.
 */

export type BotLimitMode = "amount" | "na";

export interface IExpenseCategory extends Document {
  workspaceId: mongoose.Types.ObjectId;
  name: string;
  glCode?: string | null;
  active: boolean;
  sortOrder: number;
  isDefault: boolean;
  /** null = never set (legacy) → read as "na". */
  botLimitMode: BotLimitMode | null;
  /** Base-currency ceiling; only meaningful when botLimitMode === "amount". */
  botLimitBase: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const ExpenseCategorySchema = new Schema<IExpenseCategory>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },
    name: { type: String, required: true, trim: true },
    glCode: { type: String, trim: true, default: null },
    active: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
    isDefault: { type: Boolean, default: false },
    botLimitMode: { type: String, enum: ["amount", "na", null], default: null },
    botLimitBase: { type: Number, default: null },
  },
  { timestamps: true },
);

// Uniqueness is per-tenant: the same category name may exist in two workspaces.
ExpenseCategorySchema.index({ workspaceId: 1, name: 1 }, { unique: true });

ExpenseCategorySchema.plugin(workspaceScopePlugin);

/**
 * The engine's single reading of a category's bot limit. Unset (legacy) and an
 * explicit "Not Applicable" are the SAME answer — never auto-approve — so no
 * caller has to remember the legacy case. `set` distinguishes them for the UI.
 */
export function categoryBotLimit(cat: any): { mode: BotLimitMode; amountBase: number | null; set: boolean } {
  const mode = cat?.botLimitMode === "amount" || cat?.botLimitMode === "na" ? (cat.botLimitMode as BotLimitMode) : null;
  if (mode === "amount") {
    const n = Number(cat?.botLimitBase);
    // An "amount" with no usable number cannot auto-approve anything either.
    if (Number.isFinite(n) && n >= 1) return { mode: "amount", amountBase: n, set: true };
    return { mode: "na", amountBase: null, set: true };
  }
  return { mode: "na", amountBase: null, set: mode === "na" };
}

const ExpenseCategory =
  (mongoose.models.ExpenseCategory as mongoose.Model<IExpenseCategory>) ||
  mongoose.model<IExpenseCategory>("ExpenseCategory", ExpenseCategorySchema);

export default ExpenseCategory;
