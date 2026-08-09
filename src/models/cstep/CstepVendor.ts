// apps/backend/src/models/cstep/CstepVendor.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepVendor
 * -----------
 * CSTEP Travel & Claim Portal — the vendor master (airlines, hotels, cab
 * operators, etc.) that CstepExpenseLine and CstepVendorInvoice rows point
 * at.
 *
 * Tenant isolation reuses the standard workspaceScopePlugin, same as
 * Expense.ts.
 */

export type CstepVendorCategory =
  | "AIR"
  | "HOTEL"
  | "CAB"
  | "RAIL"
  | "VISA"
  | "INSURANCE"
  | "REGISTRATION"
  | "FOREX"
  | "OTHER";

export interface ICstepVendor extends Document {
  workspaceId: mongoose.Types.ObjectId;

  name: string;
  category: CstepVendorCategory;

  gstin?: string;
  tdsSection?: string;
  tdsRate?: number;
  plumtripsLinked: boolean;
  paymentTerms?: string;
  isActive: boolean;

  createdBy: mongoose.Types.ObjectId; // ref User

  createdAt: Date;
  updatedAt: Date;
}

const CstepVendorSchema = new Schema<ICstepVendor>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },

    name: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ["AIR", "HOTEL", "CAB", "RAIL", "VISA", "INSURANCE", "REGISTRATION", "FOREX", "OTHER"],
      required: true,
      index: true,
    },

    gstin: { type: String, trim: true },
    tdsSection: { type: String, trim: true },
    tdsRate: { type: Number },
    plumtripsLinked: { type: Boolean, default: false },
    paymentTerms: { type: String, trim: true },
    isActive: { type: Boolean, default: true, index: true },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

// Vendor name is unique per tenant, mirroring ExpenseCategory's
// { workspaceId, name } uniqueness pattern.
CstepVendorSchema.index({ workspaceId: 1, name: 1 }, { unique: true });

CstepVendorSchema.plugin(workspaceScopePlugin);

const CstepVendor =
  (mongoose.models.CstepVendor as mongoose.Model<ICstepVendor>) ||
  mongoose.model<ICstepVendor>("CstepVendor", CstepVendorSchema);

export default CstepVendor;
