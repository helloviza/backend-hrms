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
 */

export interface IExpenseCategory extends Document {
  workspaceId: mongoose.Types.ObjectId;
  name: string;
  glCode?: string | null;
  active: boolean;
  sortOrder: number;
  isDefault: boolean;
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
  },
  { timestamps: true },
);

// Uniqueness is per-tenant: the same category name may exist in two workspaces.
ExpenseCategorySchema.index({ workspaceId: 1, name: 1 }, { unique: true });

ExpenseCategorySchema.plugin(workspaceScopePlugin);

const ExpenseCategory =
  (mongoose.models.ExpenseCategory as mongoose.Model<IExpenseCategory>) ||
  mongoose.model<IExpenseCategory>("ExpenseCategory", ExpenseCategorySchema);

export default ExpenseCategory;
