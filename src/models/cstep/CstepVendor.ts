// apps/backend/src/models/cstep/CstepVendor.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepVendor
 * -----------
 * CSTEP Travel & Claim Portal — the vendor master (airlines, hotels, cab
 * operators, etc.) that CstepExpenseLine and CstepVendorInvoice rows point
 * at. Maintained on the Vendor Master page (routes/cstep.vendors.ts).
 *
 * vendorCode ("CSTEPVEN0001") is the unique key: issued from the
 * continuous VENDOR series in utils/cstepSequence.ts on create and on
 * import-create, never edited. The name is NOT unique — two vendors can
 * share a trading name — so an exact duplicate is warned about at create,
 * not refused. The type is a CstepVendorType the workspace edits, not a
 * fixed enum.
 *
 * Tenant isolation reuses the standard workspaceScopePlugin, same as
 * Expense.ts.
 */

export interface ICstepVendor extends Document {
  workspaceId: mongoose.Types.ObjectId;

  vendorCode: string;
  name: string;
  vendorTypeId: mongoose.Types.ObjectId; // ref CstepVendorType
  mobile?: string;
  email?: string;
  address?: string;
  city?: string;

  gstin?: string;
  tdsSection?: string;
  tdsRate?: number;
  plumtripsLinked: boolean;
  paymentTerms?: string;
  isActive: boolean;

  createdBy: mongoose.Types.ObjectId; // ref User
  updatedBy?: mongoose.Types.ObjectId; // ref User

  createdAt: Date;
  updatedAt: Date;
}

const CstepVendorSchema = new Schema<ICstepVendor>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, index: true },

    vendorCode: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    vendorTypeId: { type: Schema.Types.ObjectId, ref: "CstepVendorType", required: true, index: true },
    mobile: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    address: { type: String, trim: true },
    city: { type: String, trim: true },

    gstin: { type: String, trim: true, uppercase: true },
    tdsSection: { type: String, trim: true },
    tdsRate: { type: Number },
    plumtripsLinked: { type: Boolean, default: false },
    paymentTerms: { type: String, trim: true },
    isActive: { type: Boolean, default: true, index: true },

    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

// vendorCode is the unique key per tenant. The name is only indexed (the
// duplicate-name warning looks it up), no longer unique.
CstepVendorSchema.index({ workspaceId: 1, vendorCode: 1 }, { unique: true });
CstepVendorSchema.index({ workspaceId: 1, name: 1 });

CstepVendorSchema.plugin(workspaceScopePlugin);

const CstepVendor =
  (mongoose.models.CstepVendor as mongoose.Model<ICstepVendor>) ||
  mongoose.model<ICstepVendor>("CstepVendor", CstepVendorSchema);

export default CstepVendor;
