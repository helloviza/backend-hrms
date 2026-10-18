// apps/backend/src/models/cstep/CstepTallySettings.ts
import mongoose, { Schema, type Document } from "mongoose";
import { workspaceScopePlugin } from "../../plugins/workspaceScope.plugin.js";

/**
 * CstepTallySettings
 * ------------------
 * One per workspace, CSTEP-Admin edited: what the Finance "Export to Tally"
 * sheet (routes/cstep.tally.ts) writes into Company Name / Voucher Type, and
 * which expense ledger a paid vendor line is debited to — by the vendor's
 * type (CstepVendorType), falling back to defaultLedger for a type with no
 * mapping. The credit side is always the vendor's own ledger (its name).
 */
export interface ICstepTallySettings extends Document {
  workspaceId: mongoose.Types.ObjectId;
  companyName: string;
  voucherType: string;
  defaultLedger: string;
  ledgerMap: Array<{ vendorTypeId: mongoose.Types.ObjectId; ledger: string }>;
  updatedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const CstepTallySettingsSchema = new Schema<ICstepTallySettings>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "CustomerWorkspace", required: true, unique: true },
    companyName: { type: String, trim: true, default: "" },
    voucherType: { type: String, trim: true, default: "Journal" },
    defaultLedger: { type: String, trim: true, default: "" },
    ledgerMap: {
      type: [
        {
          _id: false,
          vendorTypeId: { type: Schema.Types.ObjectId, ref: "CstepVendorType", required: true },
          ledger: { type: String, trim: true, required: true },
        },
      ],
      default: [],
    },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

CstepTallySettingsSchema.plugin(workspaceScopePlugin);

const CstepTallySettings =
  (mongoose.models.CstepTallySettings as mongoose.Model<ICstepTallySettings>) ||
  mongoose.model<ICstepTallySettings>("CstepTallySettings", CstepTallySettingsSchema);

export default CstepTallySettings;
